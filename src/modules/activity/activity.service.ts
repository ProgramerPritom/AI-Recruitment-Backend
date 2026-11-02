import mongoose from 'mongoose';
import { Activity, IActivity } from './activity.model';

export interface RecordActivityInput {
  jobId: string | mongoose.Types.ObjectId;
  candidateId?: string | mongoose.Types.ObjectId;
  actor: 'recruiter' | 'agent' | 'system';
  action: string;
  previousValue?: any;
  newValue?: any;
  metadata?: Record<string, any>;
}

export class ActivityService {
  public static async record(input: RecordActivityInput): Promise<IActivity> {
    try {
      const activity = new Activity({
        jobId: new mongoose.Types.ObjectId(input.jobId),
        candidateId: input.candidateId ? new mongoose.Types.ObjectId(input.candidateId) : undefined,
        actor: input.actor,
        action: input.action,
        previousValue: input.previousValue,
        newValue: input.newValue,
        metadata: input.metadata,
        timestamp: new Date(),
      });
      return await activity.save();
    } catch (err) {
      console.error('[ActivityService] Failed to record activity:', err);
      // Fail safely without blocking core domain mutation
      return {} as IActivity;
    }
  }

  public static async getByJobId(jobId: string, limit = 50): Promise<IActivity[]> {
    return Activity.find({ jobId: new mongoose.Types.ObjectId(jobId) })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
  }
}

