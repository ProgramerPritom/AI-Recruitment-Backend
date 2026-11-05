import { Request, Response, NextFunction } from 'express';
import { MeetingService } from './meeting.service';
import { BookMeetingSchema } from '../../shared/schemas';

export class MeetingController {
  public static async book(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const candidateId = req.params.candidateId as string;
      const validated = BookMeetingSchema.parse(req.body);
      const result = await MeetingService.bookMeeting(candidateId, validated.slotTime, req.body.notes);
      res.status(200).json({
        message: 'Meeting slot confirmed and candidate moved to meeting_booked.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getByJobId(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const meetings = await MeetingService.getByJobId(jobId);
      res.status(200).json({ data: meetings });
    } catch (err) {
      next(err);
    }
  }

  public static async sendInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const meetingId = req.params.meetingId as string;
      const result = await MeetingService.sendInvitation(meetingId);
      res.status(200).json({
        message: 'Interview invitation sent successfully.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
}
