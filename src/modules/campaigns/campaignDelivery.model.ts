import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaignDelivery extends Document {
  campaignId: mongoose.Types.ObjectId;
  candidateId: mongoose.Types.ObjectId;
  stepNumber: number;
  recipientEmail: string;
  subject: string;
  body: string;
  sentAt?: Date;
  status: 'sent' | 'failed' | 'suppressed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignDeliverySchema = new Schema<ICampaignDelivery>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, index: true },
    stepNumber: { type: Number, required: true },
    recipientEmail: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    sentAt: { type: Date },
    status: {
      type: String,
      enum: ['sent', 'failed', 'suppressed'],
      required: true,
      default: 'sent',
      index: true,
    },
    error: { type: String },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: prevents candidate from receiving the same step more than once!
CampaignDeliverySchema.index(
  { campaignId: 1, candidateId: 1, stepNumber: 1 },
  { unique: true }
);

export const CampaignDelivery = mongoose.model<ICampaignDelivery>(
  'CampaignDelivery',
  CampaignDeliverySchema
);

