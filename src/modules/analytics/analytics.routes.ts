import { Router } from 'express';
import { AnalyticsController } from './analytics.controller';

const router = Router();

router.get('/jobs/:jobId/stats', AnalyticsController.getStats);
router.get('/jobs/:jobId/summary', AnalyticsController.getSummary);

export default router;

