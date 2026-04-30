import mongoose,{Schema} from "mongoose";


const contextSchema = new mongoose.Schema({
  scope: { 
    type: String, 
    required: true,
    enum: ['merchant', 'customer', 'trigger', 'category'] 
  },
  context_id: { 
    type: String, 
    required: true,
    unique: true,
    index: true 
  },
  version: { 
    type: Number, 
    required: true 
  },
  delivered_at: { 
    type: Date, 
    required: true 
  },
  payload: { 
    type: mongoose.Schema.Types.Mixed, 
    required: true 
  }
}, { timestamps: true });


export const Context = mongoose.model("Context", contextSchema)