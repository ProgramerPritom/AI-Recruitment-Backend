import mongoose from 'mongoose';
import { Meeting, IMeeting } from './meeting.model';
import { Candidate } from '../candidates/candidate.model';
import { CandidateService } from '../candidates/candidate.service';
import { ActivityService } from '../activity/activity.service';
import { AppError } from '../../middleware/errorHandler';

export class MeetingService {
  /**
   * Book and confirm an interview meeting slot
   */
  public static async bookMeeting(
    candidateId: string,
    slotTime: string,
    notes?: string
  ): Promise<{ meeting: IMeeting; candidate: any }> {
    const candidate = await Candidate.findById(candidateId).exec();
    if (!candidate) {
      throw new AppError(`Candidate with ID ${candidateId} not found`, 404, 'CANDIDATE_NOT_FOUND');
    }

    if (!slotTime || slotTime.trim().length === 0) {
      throw new AppError('A valid meeting slot time is required.', 400, 'SLOT_REQUIRED');
    }

    // 1. Create meeting record
    const meeting = new Meeting({
      candidateId: candidate._id,
      jobId: candidate.jobId,
      slotTime: slotTime.trim(),
      status: 'confirmed',
      confirmedAt: new Date(),
      notes,
    });
    const savedMeeting = await meeting.save();

    // 2. Transition candidate status to 'meeting_booked'
    const updatedCandidate = await CandidateService.updateStatus(
      candidateId,
      'meeting_booked',
      'system',
      { meetingId: savedMeeting._id, slotTime }
    );

    // 3. Record in audit trail
    await ActivityService.record({
      jobId: candidate.jobId.toString(),
      candidateId: candidate._id.toString(),
      actor: 'recruiter',
      action: `Confirmed interview meeting booked for ${slotTime}`,
      newValue: { meetingId: savedMeeting._id, slotTime },
    });

    return {
      meeting: savedMeeting,
      candidate: updatedCandidate,
    };
  }

  public static async getByJobId(jobId: string): Promise<IMeeting[]> {
    return Meeting.find({ jobId: new mongoose.Types.ObjectId(jobId) })
      .populate('candidateId', 'name email status')
      .sort({ confirmedAt: -1 })
      .exec();
  }
}

