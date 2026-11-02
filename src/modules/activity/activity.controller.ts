import { Request, Response, NextFunction } from 'express';
import { ActivityService } from './activity.service';

export class ActivityController {
  public static async getByJobId(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const activities = await ActivityService.getByJobId(jobId, limit);
      res.status(200).json({ data: activities });
    } catch (err) {
      next(err);
    }
  }
}
