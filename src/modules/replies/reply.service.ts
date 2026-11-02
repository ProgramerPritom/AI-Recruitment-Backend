import mongoose from 'mongoose';
import { Reply, IReply, ReplyClassification } from './reply.model';
import { Candidate } from '../candidates/candidate.model';
import { Job } from '../jobs/job.model';
import { CandidateService } from '../candidates/candidate.service';
import { ActivityService } from '../activity/activity.service';
import { EmailProvider } from '../../integrations/email/emailProvider';
import { getGeminiClient, callGeminiWithBackoff } from '../../integrations/gemini/geminiClient';
import { config } from '../../config';
import { AppError } from '../../middleware/errorHandler';

export interface SimulatedReplyResult {
  reply: IReply;
  classification: ReplyClassification;
  responseDraft: string;
  candidateNewStatus: string;
}

export class ReplyService {
  /**
   * Classify candidate reply intent using Gemini or deterministic heuristic fallback
   */
  public static async classifyIntent(content: string): Promise<{
    classification: ReplyClassification;
    responseDraft: string;
  }> {
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({
          model: config.GEMINI_MODEL,
          generationConfig: { responseMimeType: 'application/json' },
        });

        const prompt = `You are an AI recruitment co-worker. Classify the following candidate reply into exactly one of these 5 categories:
- "Interested"
- "Not interested"
- "Question"
- "Wants a meeting"
- "Unsubscribe"

Also generate a professional, concise response draft for the recruiter to review.
JSON format:
{
  "classification": "Interested" | "Not interested" | "Question" | "Wants a meeting" | "Unsubscribe",
  "responseDraft": "string"
}

Candidate Reply Content:
"${content}"`;

        const raw = await callGeminiWithBackoff(async () => {
          const res = await model.generateContent(prompt);
          return res.response.text();
        });
        const parsed = JSON.parse(raw);
        return {
          classification: parsed.classification || 'Question',
          responseDraft: parsed.responseDraft || 'Thank you for your reply. We will get back to you shortly.',
        };
      } catch (err) {
        console.warn('[ReplyService] Gemini intent classification failed, using heuristic fallback:', err);
      }
    }

    // Deterministic Heuristic Classifier (Zero failure guarantee)
    const lower = content.toLowerCase();

    if (/unsubscribe|remove me|stop emailing|do not contact/i.test(lower)) {
      return {
        classification: 'Unsubscribe',
        responseDraft: 'You have been unsubscribed and will not receive any further communications from us.',
      };
    }

    if (/schedule|book|call|meet|calendar|slot|chat|time/i.test(lower) && /when|let's|can we|available/i.test(lower)) {
      return {
        classification: 'Wants a meeting',
        responseDraft: 'Fantastic! Here are our available interview slots: Tomorrow at 2:00 PM, or Thursday at 10:00 AM. Which works best for you?',
      };
    }

    if (/not interested|no thanks|pass|already found|happy where i am|decline/i.test(lower)) {
      return {
        classification: 'Not interested',
        responseDraft: 'Thank you for letting us know! Best of luck with your current endeavors, and feel free to stay in touch.',
      };
    }

    if (/\?|how much|salary|compensation|remote|tech stack|what is|tell me more/i.test(lower)) {
      return {
        classification: 'Question',
        responseDraft: 'Thanks for reaching out! In response to your question, we offer competitive market compensation and fully flexible remote options.',
      };
    }

    if (/interested|sounds good|tell me more|excited|open to/i.test(lower)) {
      return {
        classification: 'Interested',
        responseDraft: 'Great to hear that you are interested! Would you be open to booking a brief 15-minute conversation with our team?',
      };
    }

    return {
      classification: 'Interested',
      responseDraft: 'Thank you for your message! We would love to discuss this opportunity further with you.',
    };
  }

  /**
   * Process an inbound or simulated candidate reply
   */
  public static async simulateReply(
    candidateId: string,
    content: string
  ): Promise<SimulatedReplyResult> {
    const candidate = await Candidate.findById(candidateId).exec();
    if (!candidate) {
      throw new AppError(`Candidate with ID ${candidateId} not found`, 404, 'CANDIDATE_NOT_FOUND');
    }

    // 1. Classify intent and generate draft
    const { classification, responseDraft } = await this.classifyIntent(content);

    // 2. Map classification to pipeline state transition
    let targetStatus = candidate.status;
    if (classification === 'Unsubscribe') {
      targetStatus = 'unsubscribed';
    } else if (classification === 'Not interested') {
      targetStatus = 'not_interested';
    } else if (classification === 'Interested' || classification === 'Wants a meeting') {
      // NOTE: Assignment rule: "Wants a meeting" does NOT mark meeting_booked yet!
      targetStatus = 'interested';
    } else {
      // Question
      targetStatus = 'replied';
    }

    // Apply status update via CandidateService (which validates state transition & logs activity)
    const updatedCandidate = await CandidateService.updateStatus(
      candidateId,
      targetStatus,
      'system',
      { simulatedReply: true, classification }
    );

    // 3. Save reply record
    const reply = new Reply({
      candidateId: candidate._id,
      jobId: candidate.jobId,
      content,
      classification,
      responseDraft,
      isApproved: false,
      receivedAt: new Date(),
    });
    const savedReply = await reply.save();

    await ActivityService.record({
      jobId: candidate.jobId.toString(),
      candidateId: candidate._id.toString(),
      actor: 'system',
      action: `Candidate replied: classified as "${classification}"`,
      newValue: { classification, candidateStatus: updatedCandidate.status },
    });

    return {
      reply: savedReply,
      classification,
      responseDraft,
      candidateNewStatus: updatedCandidate.status,
    };
  }

  /**
   * Send approved response to candidate
   */
  public static async sendApprovedResponse(replyId: string): Promise<IReply> {
    const reply = await Reply.findById(replyId).exec();
    if (!reply) {
      throw new AppError(`Reply ${replyId} not found`, 404, 'REPLY_NOT_FOUND');
    }

    const candidate = await Candidate.findById(reply.candidateId).exec();
    if (!candidate || !candidate.email) {
      throw new AppError('Candidate has no valid email address', 400, 'NO_EMAIL');
    }

    if (candidate.status === 'unsubscribed') {
      throw new AppError('Cannot send response: Candidate is unsubscribed.', 400, 'CANDIDATE_UNSUBSCRIBED');
    }

    await EmailProvider.sendEmail({
      to: candidate.email,
      subject: 'Re: Your application and reply',
      body: reply.responseDraft || 'Thank you for connecting with us.',
    });

    reply.isApproved = true;
    const saved = await reply.save();

    await ActivityService.record({
      jobId: reply.jobId.toString(),
      candidateId: candidate._id.toString(),
      actor: 'recruiter',
      action: 'Sent approved response to candidate',
    });

    return saved;
  }

  public static async getByCandidateId(candidateId: string): Promise<IReply[]> {
    return Reply.find({ candidateId: new mongoose.Types.ObjectId(candidateId) })
      .sort({ receivedAt: -1 })
      .exec();
  }
}

