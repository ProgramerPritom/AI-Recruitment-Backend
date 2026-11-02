import mongoose, { Schema, Document } from 'mongoose';

export interface IActivity extends Document {
  jobId: mongoose.Types.ObjectId;
  candidateId?: mongoose.Types.ObjectId;
  actor: 'recruiter' | 'agent' | 'system';
  action: string;
  previousValue?: any;
  newValue?: any;
  metadata?: Record<string, any>;
  timestamp: Date;
  createdAt: Date;
}

const ActivitySchema = new Schema<IActivity>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', index: true },
    actor: {
      type: String,
      enum: ['recruiter', 'agent', 'system'],
      required: true,
      default: 'recruiter',
    },
    action: { type: String, required: true },
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Append-only audit record
  }
);

export const Activity = mongoose.model<IActivity>('Activity', ActivitySchema);

