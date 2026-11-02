import { Request, Response, NextFunction } from 'express';
import { JobService } from './job.service';
import { ExtractJobSchema } from '../../shared/schemas';

export class JobController {
  public static async extract(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = ExtractJobSchema.parse(req.body);
      const draft = await JobService.extractJobFromText(validated.content, validated.isUrl);
      res.status(200).json({
        message: 'Job requirements extracted successfully. Please review and confirm before creating.',
        data: draft,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const job = await JobService.createJob(req.body);
      res.status(201).json({
        message: 'Job confirmed and created successfully',
        data: job,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getAll(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobs = await JobService.getJobs();
      res.status(200).json({ data: jobs });
    } catch (err) {
      next(err);
    }
  }

  public static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const job = await JobService.getJobById(jobId as string);
      res.status(200).json({ data: job });
    } catch (err) {
      next(err);
    }
  }
}
