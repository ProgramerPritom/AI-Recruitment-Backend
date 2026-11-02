import { Request, Response, NextFunction } from 'express';
import { AgentService } from '../../agent/agent.service';
import { ChatMessageInputSchema } from '../../shared/schemas';

export class ChatController {
  public static async sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = ChatMessageInputSchema.parse(req.body);
      const result = await AgentService.sendMessage(
        validated.sessionId,
        validated.message,
        validated.jobId
      );
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  public static async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sessionId = req.params.sessionId as string;
      const history = await AgentService.getHistory(sessionId);
      res.status(200).json({ data: history });
    } catch (err) {
      next(err);
    }
  }

  public static async clearHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sessionId = req.params.sessionId as string;
      await AgentService.clearHistory(sessionId);
      res.status(200).json({ message: 'Chat history cleared successfully.' });
    } catch (err) {
      next(err);
    }
  }
}

