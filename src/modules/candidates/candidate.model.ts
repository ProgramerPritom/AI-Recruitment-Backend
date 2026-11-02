import mongoose, { Schema, Document } from 'mongoose';
import { CandidateStatus, VALID_CANDIDATE_STATUSES } from '../../shared/stateMachine';

export interface ICandidate extends Document {
  jobId: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  normalizedEmail?: string;
  profileUrl?: string;
  normalizedProfileUrl?: string;
  source: 'web' | 'csv';
  skills: string[];
  experienceSummary?: string;
  score?: number;
  scoreReason?: string;
  status: CandidateStatus;
  createdAt: Date;
  updatedAt: Date;
}

const CandidateSchema = new Schema<ICandidate>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    normalizedEmail: { type: String, trim: true, lowercase: true, index: true },
    profileUrl: { type: String, trim: true },
    normalizedProfileUrl: { type: String, trim: true, index: true },
    source: { type: String, enum: ['web', 'csv'], required: true, default: 'csv' },
    skills: { type: [String], default: [] },
    experienceSummary: { type: String },
    score: { type: Number, min: 0, max: 100, index: true },
    scoreReason: { type: String },
    status: {
      type: String,
      enum: VALID_CANDIDATE_STATUSES,
      default: 'sourced',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Indexes for Deduplication within a specific Job
CandidateSchema.index(
  { jobId: 1, normalizedEmail: 1 },
  { unique: true, partialFilterExpression: { normalizedEmail: { $type: 'string', $gt: '' } } }
);

CandidateSchema.index(
  { jobId: 1, normalizedProfileUrl: 1 },
  { unique: true, partialFilterExpression: { normalizedProfileUrl: { $type: 'string', $gt: '' } } }
);

export const Candidate = mongoose.model<ICandidate>('Candidate', CandidateSchema);

