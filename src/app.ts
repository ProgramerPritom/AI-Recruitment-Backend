import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { getRedisClient } from './config/redis';
import { errorHandler } from './middleware/errorHandler';

import jobRoutes from './modules/jobs/job.routes';
import candidateRoutes from './modules/candidates/candidate.routes';
import activityRoutes from './modules/activity/activity.routes';
import taskRoutes from './modules/tasks/task.routes';
import campaignRoutes from './modules/campaigns/campaign.routes';
import replyRoutes from './modules/replies/reply.routes';
import meetingRoutes from './modules/meetings/meeting.routes';
import chatRoutes from './modules/chat/chat.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';

export function createApp(): Application {
  const app: Application = express();

  // Middleware
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Health Check Endpoint
  const healthHandler = (_req: Request, res: Response) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const redis = getRedisClient();
    const redisStatus = redis.status === 'ready' || redis.status === 'connect' ? 'connected' : redis.status;

    res.status(200).json({
      status: 'ok',
      service: 'aironauts-recruitment-backend',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      redis: redisStatus,
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // API Routes
  app.use('/api', jobRoutes);
  app.use('/api', candidateRoutes);
  app.use('/api', activityRoutes);
  app.use('/api', taskRoutes);
  app.use('/api', campaignRoutes);
  app.use('/api', replyRoutes);
  app.use('/api', meetingRoutes);
  app.use('/api', chatRoutes);
  app.use('/api', analyticsRoutes);

  // 404 Handler for undefined routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`,
      },
    });
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}
