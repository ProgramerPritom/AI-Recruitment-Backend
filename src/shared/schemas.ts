import { z } from 'zod';
import { VALID_CANDIDATE_STATUSES } from './stateMachine';

export const CreateJobSchema = z.object({
  title: z.string().trim().min(2, 'Job title must be at least 2 characters').max(200),
  description: z.string().trim().min(10, 'Job description must be at least 10 characters').max(50000),
  mustHaveSkills: z.array(z.string().trim().min(1)).min(1, 'At least one must-have skill is required'),
  niceToHaveSkills: z.array(z.string().trim().min(1)).default([]),
  seniority: z.string().trim().max(100).optional(),
  location: z.string().trim().max(200).optional(),
  salaryRange: z
    .object({
      min: z.number().nonnegative().optional(),
      max: z.number().nonnegative().optional(),
      currency: z.string().default('USD'),
    })
    .optional(),
  remotePolicy: z.enum(['Remote', 'Hybrid', 'Onsite', 'Flexible']).optional().default('Remote'),
});

export const ExtractJobSchema = z.object({
  content: z.string().trim().min(10, 'Content must be at least 10 characters'),
  isUrl: z.boolean().optional().default(false),
});

export const UpdateCandidateStatusSchema = z.object({
  status: z.enum(VALID_CANDIDATE_STATUSES as [string, ...string[]]),
  actor: z.enum(['recruiter', 'agent', 'system']).default('recruiter'),
  metadata: z.record(z.unknown()).optional(),
});

export const BulkReviewCandidatesSchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1, 'At least one candidate ID is required'),
  decision: z.enum(['accept', 'reject']),
  actor: z.enum(['recruiter', 'agent']).default('recruiter'),
});

export const CreateCampaignSchema = z.object({
  name: z.string().trim().min(2).max(200),
  steps: z
    .array(
      z.object({
        stepNumber: z.number().int().positive(),
        delayDays: z.number().int().nonnegative(),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(10000),
      })
    )
    .min(1, 'At least one campaign step is required'),
});

export const ApproveCampaignSchema = z.object({
  approvedBy: z.string().default('recruiter'),
  payloadHash: z.string().min(1, 'Payload hash is required for verification'),
});

export const SimulateReplySchema = z.object({
  content: z.string().trim().min(1, 'Reply message content is required').max(5000),
});

export const BookMeetingSchema = z.object({
  slotTime: z.string().trim().min(1, 'Selected slot time is required'),
});

export const ChatMessageInputSchema = z.object({
  sessionId: z.string().trim().min(1, 'Session ID is required'),
  message: z.string().trim().min(1, 'Message cannot be empty'),
  jobId: z.string().optional(),
});

