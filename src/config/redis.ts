import Redis, { RedisOptions } from 'ioredis';
import { config } from './index';

export const redisConnectionOptions: RedisOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    return delay;
  },
};

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisConnectionOptions);

    redisClient.on('connect', () => {
      console.log(`[Redis] Connected to Redis at ${config.REDIS_HOST}:${config.REDIS_PORT}`);
    });

    redisClient.on('error', (err) => {
      // Avoid spamming logs if local Redis is starting up
      console.warn('[Redis] Connection warning:', err.message);
    });
  }
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch {}
    redisClient = null;
    console.log('[Redis] Disconnected gracefully.');
  }
}

