import { Request, Response, NextFunction } from 'express';
import { TaskService } from './task.service';
import { sourcingQueue } from '../../queues/sourcing.queue';
import { scoringQueue } from '../../queues/scoring.queue';
import { Candidate } from '../candidates/candidate.model';
import { processSourcingJob } from '../../workers/sourcing.worker';
import { processScoringJob } from '../../workers/scoring.worker';
import { AppError } from '../../middleware/errorHandler';

export class TaskController {
  public static async startSourcing(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const limit = Math.min(req.body.limit ? parseInt(req.body.limit, 10) : 8, 8);

      const task = await TaskService.createTask(jobId, 'sourcing', limit);

      // Attempt enqueue in BullMQ, with resilient fallback to asynchronous in-process execution
      try {
        await sourcingQueue.add(`sourcing_${task.taskId}`, {
          taskId: task.taskId,
          jobId,
          limit,
        });
      } catch (err: any) {
        console.warn('[TaskController] BullMQ queue unavailable, running sourcing worker asynchronously:', err.message);
        // Fire and forget in-process execution
        setImmediate(() => {
          processSourcingJob({ taskId: task.taskId, jobId, limit }).catch((e) =>
            TaskService.failTask(task.taskId, e.message)
          );
        });
      }

      res.status(202).json({
        message: 'Candidate sourcing job initiated successfully',
        data: {
          taskId: task.taskId,
          status: task.status,
          sseUrl: `/api/tasks/${task.taskId}/events`,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  public static async startScoring(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      let candidateIds: string[] = req.body.candidateIds;

      if (!candidateIds || candidateIds.length === 0) {
        const candidates = await Candidate.find({ jobId }).select('_id').exec();
        candidateIds = candidates.map((c) => c._id.toString());
      }

      if (candidateIds.length === 0) {
        throw new AppError('No candidates found to score for this job.', 400, 'NO_CANDIDATES');
      }

      const task = await TaskService.createTask(jobId, 'scoring', candidateIds.length);

      try {
        await scoringQueue.add(`scoring_${task.taskId}`, {
          taskId: task.taskId,
          jobId,
          candidateIds,
        });
      } catch (err: any) {
        console.warn('[TaskController] BullMQ queue unavailable, running scoring worker asynchronously:', err.message);
        setImmediate(() => {
          processScoringJob({ taskId: task.taskId, jobId, candidateIds }).catch((e) =>
            TaskService.failTask(task.taskId, e.message)
          );
        });
      }

      res.status(202).json({
        message: 'Candidate scoring job initiated successfully',
        data: {
          taskId: task.taskId,
          status: task.status,
          sseUrl: `/api/tasks/${task.taskId}/events`,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const taskId = req.params.taskId as string;
      const task = await TaskService.getByTaskId(taskId);
      res.status(200).json({ data: task });
    } catch (err) {
      next(err);
    }
  }

  public static async getLatestActive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const task = await TaskService.getLatestActiveTask(jobId);
      res.status(200).json({ data: task });
    } catch (err) {
      next(err);
    }
  }

  public static subscribeEvents(req: Request, res: Response): void {
    const taskId = req.params.taskId as string;
    TaskService.subscribeSSE(taskId, res);
  }
}

