import mongoose, { Schema, Document } from 'mongoose';

export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'revoked';

export interface IApproval extends Document {
  actionType: string; // e.g. 'job_create', 'campaign_send', 'sourcing_start'
  resourceId?: string;
  payloadHash: string;
  payload: Record<string, any>;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: Date;
  consumedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApprovalSchema = new Schema<IApproval>(
  {
    actionType: { type: String, required: true, index: true },
    resourceId: { type: String },
    payloadHash: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'consumed', 'revoked'],
      default: 'pending',
      index: true,
    },
    approvedBy: { type: String },
    approvedAt: { type: Date },
    consumedAt: { type: Date },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
      index: { expires: '24h' },
    },
  },
  {
    timestamps: true,
  }
);

export const Approval = mongoose.model<IApproval>('Approval', ApprovalSchema);

