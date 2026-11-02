import mongoose, { Schema, Document } from 'mongoose';

export type ReplyClassification =
  | 'Interested'
  | 'Not interested'
  | 'Question'
  | 'Wants a meeting'
  | 'Unsubscribe';

export const VALID_REPLY_CLASSIFICATIONS: ReplyClassification[] = [
  'Interested',
  'Not interested',
  'Question',
  'Wants a meeting',
  'Unsubscribe',
];

export interface IReply extends Document {
  candidateId: mongoose.Types.ObjectId;
  jobId: mongoose.Types.ObjectId;
  content: string;
  classification: ReplyClassification;
  responseDraft?: string;
  isApproved: boolean;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReplySchema = new Schema<IReply>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    content: { type: String, required: true },
    classification: {
      type: String,
      enum: VALID_REPLY_CLASSIFICATIONS,
      required: true,
      index: true,
    },
    responseDraft: { type: String },
    isApproved: { type: Boolean, default: false },
    receivedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

export const Reply = mongoose.model<IReply>('Reply', ReplySchema);

