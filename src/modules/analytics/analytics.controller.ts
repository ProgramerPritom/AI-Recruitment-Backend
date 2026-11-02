import { Request, Response, NextFunction } from 'express';
import { AnalyticsService } from './analytics.service';

export class AnalyticsController {
  public static async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const stats = await AnalyticsService.getFunnelStats(jobId);
      res.status(200).json({ data: stats });
    } catch (err) {
      next(err);
    }
  }

  public static async getSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const summary = await AnalyticsService.generateSummary(jobId);
      res.status(200).json({ data: summary });
    } catch (err) {
      next(err);
    }
  }
}

