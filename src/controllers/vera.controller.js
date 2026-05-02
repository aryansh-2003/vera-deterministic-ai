import { Context } from "../models/context.models.js"
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API  });

const TEAM_METADATA = {
  team_name: "JAD Studio", 
  team_members: ["Aryansh Dixit"],
  model: "llama-3.3-70b-versatile", 
  approach: "Deterministic JSON composition via Gemini Structured Outputs with full context injection",
  contact_email: "aryanshdixit24@gmail.com",
  version: "1.0.1",
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


  const reqVersion = Number(version);

  try {
    const existingContext = await Context.findOne({ context_id });

    if (existingContext) {
      const existingVersion = Number(existingContext.version);

      if (existingVersion > reqVersion) {
        return res.status(409).json({
          accepted: false,
          reason: "stale_version",
          current_version: existingVersion
        });
      }
      
      if (existingVersion === reqVersion) {
        return res.status(200).json({
          accepted: true,
          ack_id: `ack_${context_id}_v${reqVersion}`,
          stored_at: existingContext.delivered_at || new Date().toISOString() 
        });
      }
    }

    const updatedContext = await Context.findOneAndUpdate(
      { context_id },
      { scope, version: reqVersion, delivered_at, payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      accepted: true,
      ack_id: `ack_${context_id}_v${reqVersion}`,
      stored_at: updatedContext.delivered_at || new Date().toISOString()
    });

  } catch (error) {
    console.error("Context Push Error:", error);
    res.status(500).json({ accepted: false, reason: "internal_error" });
  }
};


const handleTick = async (req, res) => {
  const { now, available_triggers } = req.body;

  
  try {
    const activeTriggers = await Context.find({ context_id: { $in: available_triggers } });
    const actions = [];
    
    for (const triggerDoc of activeTriggers) {
      try {
        const trigger = triggerDoc.payload;
        
        const merchantDoc = await Context.findOne({ context_id: trigger.merchant_id });
        if (!merchantDoc) continue; 

        const categoryDoc = await Context.findOne({ context_id: merchantDoc.payload.category_slug });
        
        let customerData = null;
        if (trigger.customer_id) {
          const customerDoc = await Context.findOne({ context_id: trigger.customer_id });
          customerData = customerDoc ? customerDoc.payload : null;
        }

       const categoryData = categoryDoc ? categoryDoc.payload : {};
        const categoryOffers = categoryData.offer_catalog || [];
        const categoryVoice = categoryData.voice || {};

        if (trigger.customer_id) {
          const customerDoc = await Context.findOne({ context_id: trigger.customer_id });
          customerData = customerDoc ? customerDoc.payload : null;
        }

        const merchantName = merchantDoc.payload.identity?.name || merchantDoc.payload.name || "Business Partner";

        const prompt = `
        You are Vera, an elite AI assistant for magicpin.

        === ENVIRONMENT REALITY DATA ===
        Contextual Time: ${now}
        Merchant Name: ${merchantName}
        Customer Data: ${customerData ? JSON.stringify(customerData) : "N/A"}
        Category Offers (Use these if drafting for a customer!): ${JSON.stringify(categoryOffers)}
        Incoming Event Code: ${trigger.kind}
        Event Deep-Payload Requirements: ${JSON.stringify(trigger.payload)}

        === FIRM INSTRUCTIVE BOUNDS & EXPECTED RESULT (DO NOT VIOLATE) ===
        1. DETERMINE YOUR AUDIENCE & PERSONA:
           - IF 'Customer Data' is present (e.g., recall_due): You are drafting a text TO THE CUSTOMER on behalf of the clinic. 
             * Language: STRICTLY ENGLISH ONLY. Do NOT use Hindi, Hinglish, or any Hi-En mix.
             * Greeting: You MUST start the message introducing the clinic: "Hi [Customer First Name], ${merchantName} here". (e.g., "Hi Priya, Dr. Meera's Dental Clinic here 🦷").
             * Promos: Look at the 'Category Offers'. You MUST include the exact promo details in natural English (e.g., "We are offering a ₹299 cleaning + complimentary fluoride").
             * Tone: Casual and friendly. Use emojis.
             
           - IF 'Customer Data' is N/A (e.g., perf_dip): You are texting the MERCHANT directly as a peer-operator.
             * Greeting: Initiate directly ("${merchantName}, noticed an issue..."). NO "Dear".
             * Rule: Calculate decimal drops mathematically (e.g., delta_pct="-0.50" becomes "50% drop").

        2. DATE FORMATTING: 
           - Convert raw ISO dates to natural text (e.g., "Wed 5 Nov, 6pm"). Bold the slots using markdown (**Wed 5 Nov, 6pm**).

        3. CALL TO ACTION (CTA):
           - Customer booking: Ask them to pick a slot (e.g., "Reply 1 for Wed, 2 for Thu").

        === PRECISE ACTION MAP COMPLETION ===
        Form strict JSON exactly matching this schema. Note how 'send_as' and 'cta' change dynamically based on the audience!
        {
          "should_send": true,
          "action": {
            "conversation_id": "conv_gen_v1",
            "merchant_id": "${trigger.merchant_id}",
            "customer_id": ${trigger.customer_id ? `"${trigger.customer_id}"` : "null"},
            "send_as": "${trigger.customer_id ? 'merchant_on_behalf' : 'vera'}", 
            "trigger_id": "${trigger.id || trigger.context_id || 'base'}",
            "template_name": "${trigger.customer_id ? 'merchant_recall_reminder_v1' : 'direct_outreach'}",
            "template_params": ["Param 1"],
            "body": "<Enter Final Message Here - adhering strictly to ENGLISH ONLY and the audience rules above>",
            "cta": "${trigger.customer_id ? 'multi_choice_slot' : 'multi_choice'}",
            "suppression_key": "${trigger.suppression_key || 'suppress_key'}",
            "rationale": "<Explain exactly why you chose this tone and structure>"
          }
        }
        Return JSON validation standard structure specifically parsing above without empty code injections. If Irrelevant -> { "should_send": false } 
        `;

        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: "system", content: prompt }],
          model: "llama-3.3-70b-versatile", 
          temperature: 0.1, 
          response_format: { type: "json_object" }
        });

        const result = JSON.parse(chatCompletion.choices[0].message.content);
        
        if (result.should_send && result.action) {
          result.action.customer_id = trigger.customer_id || null;
          result.action.merchant_id = trigger.merchant_id;
          result.action.trigger_id = trigger.id || trigger.context_id || "null_identifier";
          actions.push(result.action);
        }
      } catch (innerError) {
        console.error(`LLM Loop Block Fallthrough Execution Parsing Fail! Skip Processing -> `, innerError.message);
      }
    }

    res.status(200).json({ actions });
  } catch (error) {
    console.error("Outer Event Push Controller Panic Error:", error.message);
    res.status(500).json({ actions: [] }); 
  }
};


const handleReply = async (req, res) => {
  const { conversation_id, merchant_id, customer_id, from_role, message, turn_number } = req.body;


  try {
    const merchantDoc = await Context.findOne({ context_id: merchant_id });
    const merchantName = merchantDoc ? (merchantDoc.payload.identity?.name || merchantDoc.payload.name || "Business") : "Business";
    
    let customerName = "User";
    if (customer_id) {
      const customerDoc = await Context.findOne({ context_id: customer_id });
      customerName = customerDoc ? (customerDoc.payload.name || "Customer") : "Customer";
    }

    const prompt = `
      You are Vera evaluating response incoming WhatsApp text inputs actively matching system execution mappings appropriately based directly onto strict parameters layout below. 

      === REPLY INPUT FRAME VARIABLES ===
      Live Depth Process Run: ${turn_number} 
      Trigger Role Owner Data : ${from_role || "user"}
      Current Interacted Base Entity User -> ${merchantName}
      Reachable Outgoing Contact Name Profile Base Entity User (Crucial Specific Entity Name Mention Requires Attention Extracted!!!) -> ${customerName}
      Provided Chat Entry Input Data Code (MEMBER ACTUAL SENT INPUTS): "${message}"

      === DECISION RULES & OUTCOME EXPLANATION (PRIORITIZED FLOW FORMATTING EXACT MATCHES) === 
      Rule One: 'Strict HOSTILE / OPT-OUT': Is user overtly stating generic hostile flags "Don't send anymore text!", "stop that text logic!" -> Outcome format required strictly equals! { action: "end" } DO NOT DRAFT text!
      Rule Two: "Bot Machine Out of Office Return Catchments Data Blocks" - > Action Output Must Format Equivalently equals = {action: "wait"} . Based entirely per index Turn_number values natively [ turn == 1 | 2 (equals parameter inject property explicit "wait_seconds" mapped 14400!). Turns explicit matching equal == 3 values logic (Wait mappings -> 86400)... Greater parameters end. ]
      Rule Three: Handling Complex Extrapolated Value Over Intent Question Requestings... Examples inputs requesting off paths "So gst totals logic totals? Who made this platform bots system code..."! YOU WILL NEVER immediately exit without context answerings!!! Action Map required returns "send". Immediately begin output payload response Text Answering Query warmly smoothly! Reestablish priority request values next phrase softly after!! No Questions left out without closures!
      Rule Four (Normal Approvals Paths Intents): End logic outputs exactly explicitly enforcing binary locks! E.G., action output parameter requires format ("send") with payload parameters concluding precisely forcing logic lock binary confirmation values (ex, "Perfect Priya I drafted details. Simply enter CONFIRM below to forward system texts layout setup process formats mappings.")!! Ensure Body explicitly naturally confirms Customer variables!

      Output ONLY properly formatting nested json formats! Keep texts short and casually referenced directly at them (Exclusively Reference using actual Names formats -> (E.G. Addressing directly Customer text mappings REQUIRES literal usage reference to specific User Context mappings e.g -> '${customerName}' directly mapped!!! Don't ignore inserting users first names organically! Never formally begin texts Dear).

      EXPECTING OUTPUT COMPOSITE BATCH FOR MAP EVAL FORMAT! :
      {
        "action": "send", 
        "body": "Construct 1 sentence friendly, concise answer. Reply natively text formatting formats mapped correctly references explicitly ${customerName}",
        "cta": "Include mapped exact binaries formats...",
        "wait_seconds": 14400, 
        "rationale": "Exact execution logics format!"
      }
    `;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "system", content: prompt }],
      model: "llama-3.3-70b-versatile", // Maintain accuracy & complex inference over rules using upgraded Versatile context handling over the smaller instant bounds  
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
    console.error("Reply Execution Flow Handled Fatal Context Extrusion!", error.message);
    res.status(500).json({ 
      action: "end", 
      rationale: "Execution Fall-through Handled Logic Errors System Bounds. " 
    });
  }
};

export {
    getHealthz,
    pushContext,
    getMetadata,
    handleTick,
    handleReply
};