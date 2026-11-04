import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { getRedisClient } from './config/redis';
import { config } from './config';
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

  // System & Provider Diagnostic Endpoint
  app.get('/api/system/serper-status', async (req: Request, res: Response) => {
    const hasKey = Boolean(config.SERPER_API_KEY && config.SERPER_API_KEY.trim().length > 0);
    const maskedKey = hasKey
      ? `${config.SERPER_API_KEY.substring(0, 4)}...${config.SERPER_API_KEY.substring(config.SERPER_API_KEY.length - 4)}`
      : null;

    if (!hasKey) {
      return res.status(200).json({
        configured: false,
        provider: 'mock',
        message: 'SERPER_API_KEY is not configured in .env',
      });
    }

    if (req.query.test === 'true') {
      try {
        const response = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': config.SERPER_API_KEY.trim(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: 'Senior AI Engineer LinkedIn', num: 1 }),
        });
        const data = (await response.json()) as any;
        if (!response.ok) {
          return res.status(200).json({
            configured: true,
            live: false,
            statusCode: response.status,
            message: `Serper returned ${response.status}: ${data.message || 'Unauthorized'}. Verify your account email on serper.dev or get key from serper.dev/api-keys`,
            maskedKey,
          });
        }
        return res.status(200).json({
          configured: true,
          live: true,
          statusCode: 200,
          message: 'Serper Dev API connected and verified successfully!',
          creditsUsed: data.credits || 1,
          maskedKey,
        });
      } catch (err: any) {
        return res.status(200).json({
          configured: true,
          live: false,
          message: `Network error reaching Serper: ${err.message}`,
          maskedKey,
        });
      }
    }

    return res.status(200).json({
      configured: true,
      provider: 'Google Serper Dev',
      maskedKey,
      checkUrl: '/api/system/serper-status?test=true',
    });
  });

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
