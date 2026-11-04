import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import { defaultWorkerOptions } from '../queues/queue.config';
import { OutreachJobData } from '../queues/outreach.queue';
import { Campaign } from '../modules/campaigns/campaign.model';
import { CampaignDelivery } from '../modules/campaigns/campaignDelivery.model';
import { Candidate } from '../modules/candidates/candidate.model';
import { CandidateStateMachine } from '../shared/stateMachine';
import { EmailProvider } from '../integrations/email/emailProvider';
import { TaskService } from '../modules/tasks/task.service';
import { ActivityService } from '../modules/activity/activity.service';

export async function processOutreachJob(
  jobData: OutreachJobData
): Promise<{ sentCount: number; suppressedCount: number; failedCount: number }> {
  const { taskId, campaignId, stepNumber = 1 } = jobData;

  const campaign = await Campaign.findById(campaignId).exec();
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  const step = campaign.steps.find((s) => s.stepNumber === stepNumber) || campaign.steps[0];
  if (!step) {
    throw new Error(`Campaign step ${stepNumber} not found`);
  }

  // Retrieve candidates for this job
  const candidates = await Candidate.find({
    jobId: campaign.jobId,
    email: { $exists: true, $ne: '' },
    // Only candidates who were accepted (or already contacted if this is follow-up step > 1)
    status: stepNumber === 1 ? 'accepted' : { $in: ['accepted', 'contacted'] },
  }).exec();

  const total = candidates.length;
  await TaskService.updateProgress(taskId, {
    phase: 'sending',
    processedCount: 0,
    totalCount: total,
    progress: 0,
  });

  let sentCount = 0;
  let suppressedCount = 0;
  let failedCount = 0;

  for (const candidate of candidates) {
    // 1. Critical Pre-flight Check: Re-read fresh candidate from database
    const freshCandidate = await Candidate.findById(candidate._id).exec();
    if (!freshCandidate) continue;

    // Check suppression: if candidate replied or unsubscribed, skip delivery!
    if (CandidateStateMachine.shouldSuppressOutreach(freshCandidate.status)) {
      suppressedCount++;
      try {
        await CampaignDelivery.create({
          campaignId: campaign._id,
          candidateId: freshCandidate._id,
          stepNumber: step.stepNumber,
          recipientEmail: freshCandidate.email || '',
          subject: step.subject,
          body: step.body,
          status: 'suppressed',
          error: `Suppressed: candidate status is "${freshCandidate.status}"`,
        });
      } catch {}
      continue;
    }

    // 2. Duplicate Delivery Prevention: Check if candidate already received this step
    const existingDelivery = await CampaignDelivery.findOne({
      campaignId: campaign._id,
      candidateId: freshCandidate._id,
      stepNumber: step.stepNumber,
      status: 'sent',
    }).exec();

    if (existingDelivery) {
      console.log(`[OutreachWorker] Candidate ${freshCandidate.name} already received step ${step.stepNumber}. Skipping.`);
      continue;
    }

    // 3. Dispatch Email with personalization & dynamic variable substitution
    let personalizedBody = step.body.replace(/\{\{name\}\}/gi, freshCandidate.name);
    personalizedBody = personalizedBody
      .replace(/\[Your Name\]/gi, 'Talent Acquisition Team')
      .replace(/\[Your Title\]/gi, 'Executive Recruiter')
      .replace(/\[Your Company\]/gi, 'Aironauts')
      .replace(/\[mention a relevant area[^\]]*\]/gi, freshCandidate.skills?.slice(0, 3).join(', ') || 'AI & MERN Stack')
      .replace(/\[industry\/tech domain\]/gi, 'AI technology')
      .replace(/\[Your LinkedIn Profile[^\]]*\]/gi, '')
      .replace(/\[Your Phone Number[^\]]*\]/gi, '');

    try {
      await EmailProvider.sendEmail({
        to: freshCandidate.email!,
        subject: step.subject,
        body: personalizedBody,
      });

      // Record successful delivery
      await CampaignDelivery.findOneAndUpdate(
        {
          campaignId: campaign._id,
          candidateId: freshCandidate._id,
          stepNumber: step.stepNumber,
        },
        {
          recipientEmail: freshCandidate.email,
          subject: step.subject,
          body: personalizedBody,
          sentAt: new Date(),
          status: 'sent',
        },
        { upsert: true, new: true }
      );

      // Transition candidate status to 'contacted' if currently 'accepted'
      if (freshCandidate.status === 'accepted') {
        freshCandidate.status = 'contacted';
        await freshCandidate.save();
      }

      sentCount++;
    } catch (err: any) {
      failedCount++;
      console.error(`[OutreachWorker] Failed sending to ${freshCandidate.email}:`, err.message);
      try {
        await CampaignDelivery.create({
          campaignId: campaign._id,
          candidateId: freshCandidate._id,
          stepNumber: step.stepNumber,
          recipientEmail: freshCandidate.email || '',
          subject: step.subject,
          body: personalizedBody,
          status: 'failed',
          error: err.message,
        });
      } catch {}
    }

    await TaskService.updateProgress(taskId, {
      phase: 'sending',
      processedCount: sentCount + suppressedCount + failedCount,
      totalCount: total,
    });
  }

  campaign.status = 'running';
  await campaign.save();

  await TaskService.completeTask(taskId, {
    sentCount,
    suppressedCount,
    failedCount,
  });

  await ActivityService.record({
    jobId: campaign.jobId.toString(),
    actor: 'system',
    action: `Sent campaign step ${step.stepNumber}: ${sentCount} sent, ${suppressedCount} suppressed`,
    newValue: { sentCount, suppressedCount, failedCount },
  });

  return { sentCount, suppressedCount, failedCount };
}

export function startOutreachWorker(): Worker<OutreachJobData> {
  const worker = new Worker<OutreachJobData>(
    'outreach-queue',
    async (job: BullJob<OutreachJobData>) => {
      console.log(`[OutreachWorker] Processing outreach job ${job.id}`);
      return await processOutreachJob(job.data);
    },
    defaultWorkerOptions
  );

  worker.on('failed', async (job, err) => {
    if (job?.data?.taskId) {
      console.error(`[OutreachWorker] Job ${job.id} failed:`, err);
      await TaskService.failTask(job.data.taskId, err.message);
    }
  });

  return worker;
}

