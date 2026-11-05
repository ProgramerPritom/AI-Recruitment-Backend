import mongoose, { Schema, Document } from 'mongoose';

export interface IMeeting extends Document {
  candidateId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  slotTime: string;
  status: 'requested' | 'confirmed' | 'cancelled';
  confirmedAt?: Date;
  invitationStatus: 'not_sent' | 'sending' | 'sent' | 'failed';
  invitationSentAt?: Date;
  invitationError?: string;
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
    invitationStatus: {
      type: String,
      enum: ['not_sent', 'sending', 'sent', 'failed'],
      default: 'not_sent',
    },
    invitationSentAt: { type: Date },
    invitationError: { type: String },
    notes: { type: String },
  },
  {
    timestamps: true,
  }
);

export const Meeting = mongoose.model<IMeeting>('Meeting', MeetingSchema);
