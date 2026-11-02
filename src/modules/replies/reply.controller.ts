import { Request, Response, NextFunction } from 'express';
import { ReplyService } from './reply.service';
import { SimulateReplySchema } from '../../shared/schemas';

export class ReplyController {
  public static async simulateReply(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const candidateId = req.params.candidateId as string;
      const validated = SimulateReplySchema.parse(req.body);

      const result = await ReplyService.simulateReply(candidateId, validated.content);
      res.status(200).json({
        message: `Inbound reply simulated. Classified as "${result.classification}".`,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async sendResponse(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const replyId = req.params.replyId as string;
      const result = await ReplyService.sendApprovedResponse(replyId);
      res.status(200).json({
        message: 'Approved response successfully sent to candidate.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getByCandidate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const candidateId = req.params.candidateId as string;
      const replies = await ReplyService.getByCandidateId(candidateId);
      res.status(200).json({ data: replies });
    } catch (err) {
      next(err);
    }
  }
}

