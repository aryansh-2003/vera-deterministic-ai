import {Context} from "../models/context.models.js"
import Groq from "groq-sdk";



const groq = new Groq({ apiKey: process.env.GROQ_API });


const TEAM_METADATA = {
  team_name: "JAD Studio", 
  team_members: ["Aryansh Dixit"],
  model: "llama-3.3-70b-versatile", 
  approach: "Deterministic JSON composition via Gemini Structured Outputs with full context injection",
  contact_email: "aryanshdixit24@gmail.com",
  version: "1.0.0",
  submitted_at: new Date().toISOString()
};

const getHealthz = async (req, res) => {
  try {
    const [category, merchant, customer, trigger] = await Promise.all([
      Context.countDocuments({ scope: 'category' }),
      Context.countDocuments({ scope: 'merchant' }),
      Context.countDocuments({ scope: 'customer' }),
      Context.countDocuments({ scope: 'trigger' })
    ]);

    res.status(200).json({
      status: "ok",
      uptime_seconds: Math.floor(process.uptime()),
      contexts_loaded: { category, merchant, customer, trigger }
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
};

const getMetadata = (req, res) => {
  res.status(200).json(TEAM_METADATA);
};

const pushContext = async (req, res) => {
  const { scope, context_id, version, delivered_at, payload } = req.body;

  if( !scope || !context_id || !version || !delivered_at || !payload ) {
    return res.status(409).json({
        accepted: false,
        reason: "incomeplete_data",
      });
  }

  try {
    const existingContext = await Context.findOne({ context_id });

    if (existingContext && existingContext.version >= version) {
      return res.status(409).json({
        accepted: false,
        reason: "stale_version",
        current_version: existingContext.version
      });
    }

    await Context.findOneAndUpdate(
      { context_id },
      { scope, version, delivered_at, payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      accepted: true,
      ack_id: `ack_${context_id}_v${version}`,
      stored_at: new Date().toISOString()
    });

  } catch (error) {
    console.error("Context Push Error:", error);
    res.status(500).json({ accepted: false, reason: "internal_error" });
  }
};

const handleTick = async (req, res) => {
  const { now, available_triggers } = req.body;

  if( !now || !available_triggers ) {
    return res.status(409).json({
        accepted: false,
        reason: "incomeplete_data",
      });
  }
  
  try {
    const activeTriggers = await Context.find({ context_id: { $in: available_triggers } });
    const actions = [];
    
    const triggerPromises = activeTriggers.map(async (triggerDoc) => {
      try {
        const trigger = triggerDoc.payload;
        const merchantDoc = await Context.findOne({ context_id: trigger.merchant_id });
        if (!merchantDoc) return null;

        const categoryDoc = await Context.findOne({ context_id: merchantDoc.payload.category_slug });
        
        let customerData = null;
        if (trigger.customer_id) {
          const customerDoc = await Context.findOne({ context_id: trigger.customer_id });
          customerData = customerDoc ? customerDoc.payload : null;
        }

        const prompt = `
        You are Vera, an elite AI assistant for merchant growth on the magicpin platform. 
        Goal: Evaluate context and compose a highly compelling, specific, actionable message.

        === CONTEXT ===
        Time: ${now}
        Trigger Kind: ${trigger.kind}
        Trigger Data: ${JSON.stringify(trigger.payload)}
        Merchant Name: ${merchantDoc.payload.name}
        Category: ${categoryDoc ? categoryDoc.payload.name : "Local Business"}
        Customer: ${customerData ? customerData.name : "None"}

        === COMPOSITION DIRECTIVES ===
        1. SPECIFICITY: Use exact numbers, dates, and names from the Trigger Data. No hallucinating.
        2. TONE: Professional, strict operator-to-operator.
        3. VALUE: Interpret the trigger (e.g., frame seasonal dips as normal, push alternatives).
        4. CTA: Only ONE low-friction Call-to-Action (e.g., "Reply YES" or "Reply 1 or 2").

        === OUTPUT REQUIREMENTS ===
        Return ONLY a valid JSON object. 
        If irrelevant: { "should_send": false }
        
        If sending, use exactly this structure:
        {
          "should_send": true,
          "action": {
            "conversation_id": "conv_gen_v1",
            "merchant_id": "${trigger.merchant_id}",
            "customer_id": ${trigger.customer_id ? `"${trigger.customer_id}"` : "null"},
            "send_as": "vera", 
            "trigger_id": "${trigger.id}",
            "template_name": "direct_outreach",
            "template_params": ["Param 1"],
            "body": "Write the specific, compelling message here.",
            "cta": "binary_yes_no",
            "suppression_key": "${trigger.suppression_key || 'suppress_key'}",
            "rationale": "Explain exactly why you chose this message."
          }
        }
        `;

        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: "system", content: prompt }],
          model: "llama-3.1-8b-instant",
          temperature: 0,
          response_format: { type: "json_object" }
        });

        const result = JSON.parse(chatCompletion.choices[0].message.content);
        
        if (result.should_send && result.action) {
          result.action.customer_id = trigger.customer_id || null;
          result.action.merchant_id = trigger.merchant_id;
          result.action.trigger_id = trigger.id;
          return result.action;
        }
        return null;
      } catch (innerError) {
        console.error(`Groq Error:`, innerError.message);
        return null;
      }
    });

    
    const results = await Promise.all(triggerPromises);
    results.forEach(action => { if (action) actions.push(action); });

    res.status(200).json({ actions });
  } catch (error) {
    console.error("Tick Outer Error:", error.message);
    res.status(500).json({ actions: [] }); 
  }
};

const handleReply = async (req, res) => {
  const { conversation_id, merchant_id, customer_id, from_role, message, turn_number } = req.body;

  if( !message || !turn_number ) {
    return res.status(409).json({
        accepted: false,
        reason: "incomeplete_data",
      });
  }

  try {
    const merchantDoc = await Context.findOne({ context_id: merchant_id });
    const merchantData = merchantDoc ? merchantDoc.payload : {};

   const prompt = `
      You are Vera, evaluating a reply from a merchant.
      
      Analyze the merchant's message and decide the exact next action.
      
      Rules for classification:
      1. Auto-reply detected (e.g., "Thank you for contacting..."): 
         - If turn_number is 1 or 2, Action = "wait", wait_seconds = 14400.
         - If turn_number is 3, Action = "wait", wait_seconds = 86400.
         - If turn_number is 4 or higher, Action = "end".
      2. Hostile/Opt-out ("stop", "useless", "don't bother"): Action = "end".
      3. Intent transition ("let's do it", "yes send it"): Action = "send". Provide concrete next steps (e.g., "Drafting the WhatsApp now"). DO NOT ask qualifying questions. Provide a strict binary commit (e.g., "Reply CONFIRM to send").
      4. Off-topic: Politely redirect to the main objective. Action = "send".
      
      Current Turn: ${turn_number}
      Merchant ID: ${merchant_id}
      Incoming Message: "${message}"
      Merchant Context: ${JSON.stringify(merchantData)}

      === OUTPUT REQUIREMENTS ===
      You MUST output ONLY a valid JSON object matching this EXACT structure.
      Do not include any outside text.

      {
        "action": "send", // MUST be one of: "send", "wait", or "end"
        "body": "Write the reply message here (Only include if action is 'send')",
        "cta": "Write the call to action here (Only include if action is 'send')",
        "wait_seconds": 14400, // (Only include if action is 'wait')
        "rationale": "Explain exactly why you chose this action based on the rules."
      }
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "system", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      response_format: { type: "json_object" }, 
    });

    const result = JSON.parse(chatCompletion.choices[0].message.content);

    if (result.action !== "send") {
      delete result.body;
      delete result.cta;
    }
    if (result.action !== "wait") {
      delete result.wait_seconds;
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Reply Error:", error.message);

    res.status(500).json({ 
      action: "end", 
      rationale: "Internal server error during reply processing; closing thread safely." 
    });
  }
};

export {
    getHealthz,
    pushContext,
    getMetadata,
    handleTick,
    handleReply
}