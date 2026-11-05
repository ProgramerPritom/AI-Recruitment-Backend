import mongoose from 'mongoose';
import { Meeting, IMeeting } from './meeting.model';
import { Candidate } from '../candidates/candidate.model';
import { CandidateService } from '../candidates/candidate.service';
import { ActivityService } from '../activity/activity.service';
import { AppError } from '../../middleware/errorHandler';
import { EmailProvider } from '../../integrations/email/emailProvider';
import { config } from '../../config';

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

  public static async sendInvitation(
    meetingId: string
  ): Promise<{ meeting: IMeeting; provider: 'smtp' | 'virtual_outbox' }> {
    const meeting = await Meeting.findById(meetingId)
      .populate('candidateId', 'name email')
      .exec();
    if (!meeting) {
      throw new AppError(`Meeting with ID ${meetingId} not found`, 404, 'MEETING_NOT_FOUND');
    }

    const candidate = meeting.candidateId as unknown as {
      _id: mongoose.Types.ObjectId;
      name: string;
      email?: string;
    };
    if (!candidate.email) {
      throw new AppError('Candidate has no email address for the interview invite.', 400, 'NO_EMAIL');
    }
    if (meeting.invitationStatus === 'sent') {
      throw new AppError('The interview invite has already been sent.', 409, 'INVITE_ALREADY_SENT');
    }

    const claimedMeeting = await Meeting.findOneAndUpdate(
      {
        _id: meeting._id,
        $or: [
          { invitationStatus: { $in: ['not_sent', 'failed'] } },
          { invitationStatus: { $exists: false } },
        ],
      },
      { $set: { invitationStatus: 'sending', invitationError: undefined } },
      { new: true }
    ).exec();
    if (!claimedMeeting) {
      throw new AppError('The interview invite is already being sent.', 409, 'INVITE_IN_PROGRESS');
    }

    try {
      await EmailProvider.sendEmail({
        to: candidate.email,
        subject: 'Interview invitation',
        body: [
          `Hi ${candidate.name},`,
          '',
          'Your interview has been scheduled.',
          `Time: ${meeting.slotTime}`,
          '',
          meeting.notes ? `Details: ${meeting.notes}` : '',
          'Please reply to this email if you need to reschedule.',
          '',
          'Best regards,',
          'Talent Acquisition Team',
          'Aironauts',
        ].filter(Boolean).join('\n'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Meeting.updateOne(
        { _id: meeting._id, invitationStatus: 'sending' },
        { $set: { invitationStatus: 'failed', invitationError: message } }
      ).exec();
      throw error;
    }

    const sentMeeting = await Meeting.findByIdAndUpdate(
      meeting._id,
      {
        $set: {
          invitationStatus: 'sent',
          invitationSentAt: new Date(),
          invitationError: undefined,
        },
      },
      { new: true }
    ).exec();
    if (!sentMeeting) {
      throw new AppError('Invite was sent, but the meeting record could not be updated.', 500, 'INVITE_STATUS_UPDATE_FAILED');
    }

    await ActivityService.record({
      jobId: meeting.jobId.toString(),
      candidateId: candidate._id.toString(),
      actor: 'recruiter',
      action: `Sent interview invitation to ${candidate.email}`,
      newValue: { meetingId: meeting._id, slotTime: meeting.slotTime },
    });

    return {
      meeting: sentMeeting,
      provider: config.EMAIL_PROVIDER === 'smtp' ? 'smtp' : 'virtual_outbox',
    };
  }
}
