import mongoose, { Schema, Document } from 'mongoose';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface IChatMessage extends Document {
  sessionId: string;
  jobId?: mongoose.Types.ObjectId;
  role: ChatRole;
  content: string;
  cardPayload?: Record<string, any>;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
  toolResults?: Array<{
    name: string;
    result: Record<string, any>;
  }>;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    sessionId: { type: String, required: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', index: true },
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: { type: String, required: true },
    cardPayload: { type: Schema.Types.Mixed },
    toolCalls: { type: [Schema.Types.Mixed] },
    toolResults: { type: [Schema.Types.Mixed] },
    timestamp: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

ChatMessageSchema.index({ sessionId: 1, timestamp: 1 });

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

