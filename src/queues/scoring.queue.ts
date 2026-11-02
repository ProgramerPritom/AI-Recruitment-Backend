import { Queue } from 'bullmq';
import { defaultQueueOptions } from './queue.config';

export interface ScoringJobData {
  taskId: string;
  jobId: string;
  candidateIds: string[];
}

export const scoringQueue = new Queue<ScoringJobData>('scoring-queue', defaultQueueOptions);

