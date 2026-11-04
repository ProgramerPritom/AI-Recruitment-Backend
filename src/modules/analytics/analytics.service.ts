import mongoose from 'mongoose';
import { Candidate } from '../candidates/candidate.model';
import { Job } from '../jobs/job.model';
import { Meeting } from '../meetings/meeting.model';
import { CampaignDelivery } from '../campaigns/campaignDelivery.model';
import { getGeminiClient, callGeminiWithModelFallback } from '../../integrations/gemini/geminiClient';
import { config } from '../../config';
import { AppError } from '../../middleware/errorHandler';

export interface FunnelStats {
  jobId: string;
  jobTitle: string;
  totalCandidates: number;
  stageCounts: {
    sourced: number;
    accepted: number;
    rejected: number;
    contacted: number;
    replied: number;
    interested: number;
    not_interested: number;
    meeting_booked: number;
    interviewed: number;
    shortlisted: number;
    hired: number;
    unsubscribed: number;
  };
  metrics: {
    replyRate: number; // replied / contacted * 100
    interestedRate: number; // interested / replied * 100
    meetingRate: number; // meeting_booked / interested * 100
    hireRate: number; // hired / sourced * 100
  };
  emailDeliveries: {
    sent: number;
    suppressed: number;
    failed: number;
  };
}

export class AnalyticsService {
  /**
   * Calculate recruitment funnel counts and rates
   */
  public static async getFunnelStats(jobId: string): Promise<FunnelStats> {
    const job = await Job.findById(jobId).exec();
    if (!job) {
      throw new AppError(`Job ${jobId} not found`, 404, 'JOB_NOT_FOUND');
    }

    const jobObjectId = new mongoose.Types.ObjectId(jobId);
    const candidates = await Candidate.find({ jobId: jobObjectId }).exec();

    const counts = {
      sourced: 0,
      accepted: 0,
      rejected: 0,
      contacted: 0,
      replied: 0,
      interested: 0,
      not_interested: 0,
      meeting_booked: 0,
      interviewed: 0,
      shortlisted: 0,
      hired: 0,
      unsubscribed: 0,
    };

    for (const c of candidates) {
      if (counts[c.status] !== undefined) {
        counts[c.status]++;
      }
    }

    // Deliveries summary
    const deliveries = await CampaignDelivery.find({
      campaignId: { $in: await mongoose.model('Campaign').find({ jobId: jobObjectId }).distinct('_id') },
    }).exec();

    const emailDeliveries = {
      sent: deliveries.filter((d) => d.status === 'sent').length,
      suppressed: deliveries.filter((d) => d.status === 'suppressed').length,
      failed: deliveries.filter((d) => d.status === 'failed').length,
    };

    // Calculate rates with documented denominators (safe against division by zero)
    const totalContacted = counts.contacted + counts.replied + counts.interested + counts.not_interested + counts.meeting_booked + counts.interviewed + counts.shortlisted + counts.hired;
    const totalReplied = counts.replied + counts.interested + counts.not_interested + counts.meeting_booked + counts.interviewed + counts.shortlisted + counts.hired;
    const totalInterested = counts.interested + counts.meeting_booked + counts.interviewed + counts.shortlisted + counts.hired;

    const replyRate = totalContacted > 0 ? Math.round((totalReplied / totalContacted) * 100) : 0;
    const interestedRate = totalReplied > 0 ? Math.round((totalInterested / totalReplied) * 100) : 0;
    const meetingRate = totalInterested > 0 ? Math.round((counts.meeting_booked / totalInterested) * 100) : 0;
    const hireRate = candidates.length > 0 ? Math.round((counts.hired / candidates.length) * 100) : 0;

    return {
      jobId,
      jobTitle: job.title,
      totalCandidates: candidates.length,
      stageCounts: counts,
      metrics: {
        replyRate,
        interestedRate,
        meetingRate,
        hireRate,
      },
      emailDeliveries,
    };
  }

  /**
   * Generate an AI-powered executive summary of recruitment progress
   */
  public static async generateSummary(jobId: string): Promise<{ summary: string; stats: FunnelStats }> {
    const stats = await this.getFunnelStats(jobId);

    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();

        const prompt = `You are a Senior Talent Partner. Write a concise, 3-bullet executive summary of the recruitment progress for this role.
Use the exact numbers provided below. Do not fabricate any numbers.

Role: ${stats.jobTitle}
Total Candidates Sourced: ${stats.totalCandidates}
Accepted: ${stats.stageCounts.accepted}
Contacted: ${stats.stageCounts.contacted}
Replied: ${stats.stageCounts.replied}
Interested: ${stats.stageCounts.interested}
Meetings Booked: ${stats.stageCounts.meeting_booked}
Hired: ${stats.stageCounts.hired}
Reply Rate: ${stats.metrics.replyRate}%
Interested Rate: ${stats.metrics.interestedRate}%

Format: 3 clear, actionable bullet points analyzing funnel velocity, conversion health, and immediate next recommendation.`;

        const summaryText = await callGeminiWithModelFallback(async (modelName) => {
          const model = client.getGenerativeModel({ model: modelName });
          const res = await model.generateContent(prompt);
          return res.response.text();
        });

        return {
          summary: summaryText.trim(),
          stats,
        };
      } catch (err) {
        console.warn('[AnalyticsService] Gemini summary generation failed, using structured fallback:', err);
      }
    }

    // Grounded Deterministic Summary Fallback
    const summary = `Executive Summary for ${stats.jobTitle}:
• Pipeline Health: Sourced ${stats.totalCandidates} candidates with ${stats.stageCounts.accepted} accepted for outreach.
• Outreach Velocity: ${stats.emailDeliveries.sent} messages sent, generating a ${stats.metrics.replyRate}% reply rate and ${stats.metrics.interestedRate}% interest rate.
• Next Steps: ${stats.stageCounts.meeting_booked} interview(s) booked and ${stats.stageCounts.hired} offer(s) accepted. Recommend accelerating reviews for pending candidates.`;

    return {
      summary,
      stats,
    };
  }
}

