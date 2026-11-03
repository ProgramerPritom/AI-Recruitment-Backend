import { createApp } from './app';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './config/database';
import { disconnectRedis } from './config/redis';
import { startSourcingWorker } from './workers/sourcing.worker';
import { startScoringWorker } from './workers/scoring.worker';
import { startOutreachWorker } from './workers/outreach.worker';

async function bootstrap() {
  console.log(`[Bootstrap] Starting Aironauts Backend in ${config.NODE_ENV} mode...`);

  // Connect to Database
  await connectDatabase();

  // Initialize BullMQ Workers for Redis Queues
  try {
    startSourcingWorker();
    startScoringWorker();
    startOutreachWorker();
    console.log('[Workers] BullMQ asynchronous queue workers initialized.');
  } catch (workerErr: any) {
    console.warn('[Workers] BullMQ worker startup warning:', workerErr.message);
  }

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    console.log(`[Server] Aironauts Recruitment API running on http://localhost:${config.PORT}`);
    console.log(`[Server] Health check available at http://localhost:${config.PORT}/health`);
  });

  // Graceful Shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Commencing graceful shutdown...`);

    server.close(async () => {
      console.log('[Server] HTTP server closed.');
      await disconnectDatabase();
      await disconnectRedis();
      console.log('[Server] Graceful shutdown complete. Exiting.');
      process.exit(0);
    });

    // Force exit if shutdown takes too long
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal startup failure:', err);
  process.exit(1);
});

