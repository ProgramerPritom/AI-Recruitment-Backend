import { QueueOptions, WorkerOptions } from 'bullmq';
import { redisConnectionOptions } from '../config/redis';

export const defaultQueueOptions: QueueOptions = {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
};

export const defaultWorkerOptions: WorkerOptions = {
  connection: redisConnectionOptions,
  concurrency: 5,
};

