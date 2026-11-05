import { Request, Response, NextFunction } from 'express';
import { CampaignService } from './campaign.service';
import { TaskService } from '../tasks/task.service';
import { outreachQueue } from '../../queues/outreach.queue';
import { processOutreachJob } from '../../workers/outreach.worker';
import { EmailProvider } from '../../integrations/email/emailProvider';

export class CampaignController {
  public static async createDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const { name } = req.body;
      const result = await CampaignService.createDraft(jobId, name);
      res.status(201).json({
        message: 'Campaign sequence draft created. Please review, edit, and approve before sending.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getByJobId(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const campaigns = await CampaignService.getByJobId(jobId);
      res.status(200).json({ data: campaigns });
    } catch (err) {
      next(err);
    }
  }

  public static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaignId = req.params.campaignId as string;
      const campaign = await CampaignService.getById(campaignId);
      res.status(200).json({ data: campaign });
    } catch (err) {
      next(err);
    }
  }

  public static async updateDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaignId = req.params.campaignId as string;
      const updated = await CampaignService.updateDraft(campaignId, req.body);
      res.status(200).json({
        message: 'Campaign updated. Note: any modifications reset approval status to draft.',
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async approve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaignId = req.params.campaignId as string;
      const approvedBy = (req.body.approvedBy as string) || 'recruiter';
      const approved = await CampaignService.approveCampaign(campaignId, approvedBy);
      res.status(200).json({
        message: 'Campaign approved successfully. It is now authorized for safe dispatch.',
        data: approved,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async send(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaignId = req.params.campaignId as string;
      const stepNumber = req.body.stepNumber ? parseInt(req.body.stepNumber, 10) : 1;

      // 1. Enforce strict approval check
      const campaign = await CampaignService.verifyApprovalForSend(campaignId, stepNumber);

      // 2. Create tracked background task
      const task = await TaskService.createTask(campaign.jobId.toString(), 'outreach');

      // 3. Enqueue sending job with in-process fallback
      try {
        await outreachQueue.add(`outreach_${task.taskId}`, {
          taskId: task.taskId,
          campaignId,
          stepNumber,
        });
      } catch (err: any) {
        console.warn('[CampaignController] BullMQ unavailable, running outreach worker asynchronously:', err.message);
        setImmediate(() => {
          processOutreachJob({ taskId: task.taskId, campaignId, stepNumber }).catch((e) =>
            TaskService.failTask(task.taskId, e.message)
          );
        });
      }

      res.status(202).json({
        message: 'Approved outreach campaign dispatch initiated.',
        data: {
          taskId: task.taskId,
          status: 'running',
          sseUrl: `/api/tasks/${task.taskId}/events`,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getDeliveries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const campaignId = req.params.campaignId as string;
      const deliveries = await CampaignService.getDeliveries(campaignId);
      res.status(200).json({ data: deliveries });
    } catch (err) {
      next(err);
    }
  }

  public static async getDeliveriesByJobId(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const deliveries = await CampaignService.getDeliveriesByJobId(jobId);
      res.status(200).json({ data: deliveries });
    } catch (err) {
      next(err);
    }
  }

  public static async getOutbox(_req: Request, res: Response): Promise<void> {
    const messages = EmailProvider.getVirtualOutbox();
    res.status(200).json({ data: messages });
  }
}
