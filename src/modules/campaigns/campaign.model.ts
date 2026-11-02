import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaignStep {
  stepNumber: number;
  delayDays: number;
  subject: string;
  body: string;
}

export interface ICampaign extends Document {
  jobId: mongoose.Types.ObjectId;
  name: string;
  steps: ICampaignStep[];
  status: 'draft' | 'approved' | 'running' | 'paused' | 'completed';
  payloadHash?: string;
  approvedAt?: Date;
  approvedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignStepSchema = new Schema<ICampaignStep>(
  {
    stepNumber: { type: Number, required: true },
    delayDays: { type: Number, required: true, default: 0 },
    subject: { type: String, required: true },
    body: { type: String, required: true },
  },
  { _id: false }
);

const CampaignSchema = new Schema<ICampaign>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    name: { type: String, required: true, trim: true },
    steps: { type: [CampaignStepSchema], required: true },
    status: {
      type: String,
      enum: ['draft', 'approved', 'running', 'paused', 'completed'],
      default: 'draft',
      index: true,
    },
    payloadHash: { type: String },
    approvedAt: { type: Date },
    approvedBy: { type: String },
  },
  {
    timestamps: true,
  }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);

