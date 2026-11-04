import crypto from 'crypto';
import mongoose from 'mongoose';
import { Campaign, ICampaign, ICampaignStep } from './campaign.model';
import { CampaignDelivery, ICampaignDelivery } from './campaignDelivery.model';
import { Candidate } from '../candidates/candidate.model';
import { Job } from '../jobs/job.model';
import { AppError } from '../../middleware/errorHandler';
import { ActivityService } from '../activity/activity.service';
import { getGeminiClient, callGeminiWithModelFallback } from '../../integrations/gemini/geminiClient';
import { config } from '../../config';

export class CampaignService {
  /**
   * Compute stable hash of campaign steps to ensure content integrity between approval and send
   */
  public static computePayloadHash(steps: ICampaignStep[]): string {
    const serialized = JSON.stringify(
      steps.map((s) => ({
        stepNumber: s.stepNumber,
        delayDays: s.delayDays,
        subject: s.subject.trim(),
        body: s.body.trim(),
      }))
    );
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Create a personalized campaign draft sequence
   */
  public static async createDraft(
    jobId: string,
    name?: string
  ): Promise<{ campaign: ICampaign; eligibleCandidateCount: number }> {
    const job = await Job.findById(jobId).exec();
    if (!job) {
      throw new AppError(`Job with ID ${jobId} not found`, 404, 'JOB_NOT_FOUND');
    }

    // Filter ONLY accepted candidates with valid emails
    const eligibleCandidates = await Candidate.find({
      jobId: new mongoose.Types.ObjectId(jobId),
      status: 'accepted',
      email: { $exists: true, $ne: '' },
    }).exec();

    let steps: ICampaignStep[] = [];

    // Attempt Gemini draft generation
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();

        const prompt = `You are an elite executive recruiter crafting an email outreach campaign for the role of "${job.title}".
Generate a 3-step sequence in JSON format matching this schema:
{
  "steps": [
    {
      "stepNumber": 1,
      "delayDays": 0,
      "subject": "string",
      "body": "string with personalized placeholders like {{name}}"
    },
    {
      "stepNumber": 2,
      "delayDays": 3,
      "subject": "string",
      "body": "string"
    },
    {
      "stepNumber": 3,
      "delayDays": 7,
      "subject": "string",
      "body": "string"
    }
  ]
}

Role: ${job.title}
Key Skills: ${job.mustHaveSkills.join(', ')}
Location: ${job.location || 'Remote'}`;

        const raw = await callGeminiWithModelFallback(async (modelName) => {
          const model = client.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json' },
          });
          const res = await model.generateContent(prompt);
          return res.response.text();
        });
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          steps = parsed.steps;
        }
      } catch (err) {
        console.warn('[CampaignService] Gemini campaign draft failed, using standard sequence:', err);
      }
    }

    // Fallback deterministic sequence
    if (steps.length === 0) {
      steps = [
        {
          stepNumber: 1,
          delayDays: 0,
          subject: `Exciting opportunity: ${job.title} role`,
          body: `Hi {{name}},\n\nI came across your profile and was impressed by your background in ${job.mustHaveSkills.slice(0, 2).join(' and ')}. We are actively looking for a ${job.title} and think your experience would be a fantastic match.\n\nWould you be open to a quick 15-minute chat this week?\n\nBest regards,\nRecruitment Team`,
        },
        {
          stepNumber: 2,
          delayDays: 3,
          subject: `Following up regarding ${job.title} role`,
          body: `Hi {{name}},\n\nJust floating this to the top of your inbox in case it got buried. We are moving quickly on the ${job.title} position and would love to connect if you're exploring new opportunities.\n\nLet me know your thoughts!\n\nBest regards,\nRecruitment Team`,
        },
        {
          stepNumber: 3,
          delayDays: 7,
          subject: `Final touchpoint: ${job.title}`,
          body: `Hi {{name}},\n\nI understand you might be busy or happy in your current role. I won't follow up again, but please feel free to reach out anytime if things change.\n\nWishing you all the best!\n\nBest regards,\nRecruitment Team`,
        },
      ];
    }

    const campaign = new Campaign({
      jobId: new mongoose.Types.ObjectId(jobId),
      name: name || `${job.title} Outreach Campaign`,
      steps,
      status: 'draft',
    });

    const saved = await campaign.save();

    await ActivityService.record({
      jobId,
      actor: 'agent',
      action: `Created campaign draft "${saved.name}" with ${steps.length} steps`,
      newValue: { campaignId: saved._id, status: 'draft', eligibleCount: eligibleCandidates.length },
    });

    return {
      campaign: saved,
      eligibleCandidateCount: eligibleCandidates.length,
    };
  }

  /**
   * Edit draft campaign steps
   */
  public static async updateDraft(
    campaignId: string,
    updates: { name?: string; steps?: ICampaignStep[] }
  ): Promise<ICampaign> {
    const campaign = await Campaign.findById(campaignId).exec();
    if (!campaign) {
      throw new AppError(`Campaign ${campaignId} not found`, 404, 'CAMPAIGN_NOT_FOUND');
    }

    if (campaign.status === 'running' || campaign.status === 'completed') {
      throw new AppError('Cannot edit an active or completed campaign.', 400, 'CAMPAIGN_IMMUTABLE');
    }

    if (updates.name) campaign.name = updates.name;
    if (updates.steps) {
      campaign.steps = updates.steps;
      // Invalidate any prior approval if content changed!
      campaign.status = 'draft';
      campaign.approvedAt = undefined;
      campaign.approvedBy = undefined;
      campaign.payloadHash = undefined;
    }

    return await campaign.save();
  }

  /**
   * Explicit approval gating
   */
  public static async approveCampaign(
    campaignId: string,
    approvedBy = 'recruiter'
  ): Promise<ICampaign> {
    const campaign = await Campaign.findById(campaignId).exec();
    if (!campaign) {
      throw new AppError(`Campaign ${campaignId} not found`, 404, 'CAMPAIGN_NOT_FOUND');
    }

    const payloadHash = this.computePayloadHash(campaign.steps);
    campaign.status = 'approved';
    campaign.approvedBy = approvedBy;
    campaign.approvedAt = new Date();
    campaign.payloadHash = payloadHash;

    const saved = await campaign.save();

    await ActivityService.record({
      jobId: campaign.jobId.toString(),
      actor: 'recruiter',
      action: `Approved outreach campaign "${campaign.name}"`,
      newValue: { campaignId: saved._id, status: 'approved', payloadHash },
    });

    return saved;
  }

  /**
   * Verify approval and prepare for sending
   */
  public static async verifyApprovalForSend(campaignId: string): Promise<ICampaign> {
    const campaign = await Campaign.findById(campaignId).exec();
    if (!campaign) {
      throw new AppError(`Campaign ${campaignId} not found`, 404, 'CAMPAIGN_NOT_FOUND');
    }

    if (campaign.status !== 'approved') {
      throw new AppError(
        'Campaign must be explicitly approved before sending.',
        403,
        'APPROVAL_REQUIRED'
      );
    }

    const currentHash = this.computePayloadHash(campaign.steps);
    if (currentHash !== campaign.payloadHash) {
      campaign.status = 'draft';
      await campaign.save();
      throw new AppError(
        'Campaign content has been modified since approval. Re-approval required.',
        400,
        'APPROVAL_INVALIDATED'
      );
    }

    return campaign;
  }

  public static async getByJobId(jobId: string): Promise<ICampaign[]> {
    return Campaign.find({ jobId: new mongoose.Types.ObjectId(jobId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  public static async getById(campaignId: string): Promise<ICampaign> {
    const campaign = await Campaign.findById(campaignId).exec();
    if (!campaign) {
      throw new AppError(`Campaign ${campaignId} not found`, 404, 'CAMPAIGN_NOT_FOUND');
    }
    return campaign;
  }

  public static async getDeliveries(campaignId: string): Promise<ICampaignDelivery[]> {
    return CampaignDelivery.find({ campaignId: new mongoose.Types.ObjectId(campaignId) })
      .sort({ createdAt: -1 })
      .exec();
  }
}

