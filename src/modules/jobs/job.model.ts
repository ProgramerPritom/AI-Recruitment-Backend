import mongoose, { Schema, Document } from 'mongoose';

export interface IJob extends Document {
  title: string;
  description: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  seniority?: string;
  experience?: string;
  minExperienceYears?: number;
  responsibilities?: string[];
  qualifications?: string[];
  location?: string;
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
  };
  remotePolicy?: string;
  status: 'draft' | 'active' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    mustHaveSkills: { type: [String], required: true, default: [] },
    niceToHaveSkills: { type: [String], default: [] },
    seniority: { type: String, trim: true },
    experience: { type: String, trim: true },
    minExperienceYears: { type: Number, min: 0 },
    responsibilities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    location: { type: String, trim: true },
    salaryRange: {
      min: { type: Number },
      max: { type: Number },
      currency: { type: String, default: 'USD' },
    },
    remotePolicy: { type: String, default: 'Remote' },
    status: {
      type: String,
      enum: ['draft', 'active', 'closed'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Job = mongoose.model<IJob>('Job', JobSchema);

