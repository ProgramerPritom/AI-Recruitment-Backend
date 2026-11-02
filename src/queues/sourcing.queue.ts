import { Queue } from 'bullmq';
import { defaultQueueOptions } from './queue.config';

export interface SourcingJobData {
  taskId: string;
  jobId: string;
  limit?: number;
}

export const sourcingQueue = new Queue<SourcingJobData>('sourcing-queue', defaultQueueOptions);

