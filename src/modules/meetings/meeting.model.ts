import mongoose, { Schema, Document } from 'mongoose';

export interface IMeeting extends Document {
  candidateId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  slotTime: string;
  status: 'requested' | 'confirmed' | 'cancelled';
  confirmedAt?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MeetingSchema = new Schema<IMeeting>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    slotTime: { type: String, required: true },
    status: {
      type: String,
      enum: ['requested', 'confirmed', 'cancelled'],
      default: 'confirmed',
      index: true,
    },
    confirmedAt: { type: Date, default: Date.now },
    notes: { type: String },
  },
  {
    timestamps: true,
  }
);

export const Meeting = mongoose.model<IMeeting>('Meeting', MeetingSchema);

