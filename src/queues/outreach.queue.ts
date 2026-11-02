import { Queue } from 'bullmq';
import { defaultQueueOptions } from './queue.config';

export interface OutreachJobData {
  taskId: string;
  campaignId: string;
  stepNumber?: number;
}

export const outreachQueue = new Queue<OutreachJobData>('outreach-queue', defaultQueueOptions);

