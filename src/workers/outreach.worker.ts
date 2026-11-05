import { Worker, Job as BullJob } from 'bullmq';
import { defaultWorkerOptions } from '../queues/queue.config';
import { OutreachJobData } from '../queues/outreach.queue';
import { Campaign } from '../modules/campaigns/campaign.model';
import { CampaignDelivery } from '../modules/campaigns/campaignDelivery.model';
import { Candidate } from '../modules/candidates/candidate.model';
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

  const step = campaign.steps.find((s) => s.stepNumber === stepNumber);
  if (!step) {
    throw new Error(`Campaign step ${stepNumber} not found`);
  }

  const previousStep = campaign.steps
    .filter((campaignStep) => campaignStep.stepNumber < step.stepNumber)
    .sort((a, b) => b.stepNumber - a.stepNumber)[0];

  const candidates = await Candidate.find({
    jobId: campaign.jobId,
    email: { $exists: true, $ne: '' },
    status: step.stepNumber === 1 ? 'accepted' : 'contacted',
  }).exec();

  const previouslyContactedIds =
    previousStep && step.stepNumber > 1
      ? new Set(
          (
            await CampaignDelivery.find({
              campaignId: campaign._id,
              stepNumber: previousStep.stepNumber,
              status: 'sent',
            })
              .select('candidateId')
              .exec()
          ).map((delivery) => delivery.candidateId.toString())
        )
      : null;
  const eligibleCandidates = previouslyContactedIds
    ? candidates.filter((candidate) => previouslyContactedIds.has(candidate._id.toString()))
    : candidates;

  const total = eligibleCandidates.length;
  await TaskService.updateProgress(taskId, {
    phase: 'sending',
    processedCount: 0,
    totalCount: total,
    progress: 0,
  });

  let sentCount = 0;
  let suppressedCount = 0;
  let failedCount = 0;
  let processedCount = 0;
  const recordProgress = async () => {
    processedCount++;
    await TaskService.updateProgress(taskId, {
      phase: 'sending',
      processedCount,
      totalCount: total,
    });
  };

  for (const candidate of eligibleCandidates) {
    const freshCandidate = await Candidate.findOne({
      _id: candidate._id,
      status: step.stepNumber === 1 ? 'accepted' : 'contacted',
    }).exec();
    if (!freshCandidate) {
      suppressedCount++;
      await recordProgress();
      continue;
    }

    const deliveryKey = {
      campaignId: campaign._id,
      candidateId: candidate._id,
      stepNumber: step.stepNumber,
    };

    const existingDelivery = await CampaignDelivery.findOne(deliveryKey).exec();
    if (existingDelivery?.status === 'sent' || existingDelivery?.status === 'sending') {
      await recordProgress();
      continue;
    }

    const personalizedBody = step.body
      .replace(/\{\{name\}\}/gi, freshCandidate.name)
      .replace(/\[Your Name\]/gi, 'Talent Acquisition Team')
      .replace(/\[Your Title\]/gi, 'Executive Recruiter')
      .replace(/\[Your Company\]/gi, 'Aironauts')
      .replace(/\[mention a relevant area[^\]]*\]/gi, freshCandidate.skills?.slice(0, 3).join(', ') || 'AI & MERN Stack')
      .replace(/\[industry\/tech domain\]/gi, 'AI technology')
      .replace(/\[Your LinkedIn Profile[^\]]*\]/gi, '')
      .replace(/\[Your Phone Number[^\]]*\]/gi, '');

    const deliveryData = {
      ...deliveryKey,
      delayDays: step.delayDays,
      recipientEmail: candidate.email || '',
      subject: step.subject,
      body: personalizedBody,
      status: 'sending' as const,
      error: undefined,
    };

    if (existingDelivery) {
      const claimedDelivery = await CampaignDelivery.findOneAndUpdate(
        {
          ...deliveryKey,
          status: { $in: ['failed', 'suppressed'] },
        },
        { $set: deliveryData },
        { new: true }
      ).exec();
      if (!claimedDelivery) {
        await recordProgress();
        continue;
      }
    } else {
      try {
        await CampaignDelivery.create(deliveryData);
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
          await recordProgress();
          continue;
        }
        throw err;
      }
    }

    try {
      await EmailProvider.sendEmail({
        to: freshCandidate.email!,
        subject: step.subject,
        body: personalizedBody,
      });
    } catch (err: unknown) {
      failedCount++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[OutreachWorker] Failed sending to ${freshCandidate.email}:`, errorMessage);
      await CampaignDelivery.findOneAndUpdate(
        deliveryKey,
        {
          $set: {
            status: 'failed',
            error: errorMessage,
          },
        },
        { new: true }
      ).exec();
      await recordProgress();
      continue;
    }

    await CampaignDelivery.findOneAndUpdate(
      deliveryKey,
      {
        $set: {
          sentAt: new Date(),
          status: 'sent',
        },
      },
      { new: true }
    ).exec();
    if (step.stepNumber === 1) {
      await Candidate.updateOne(
        { _id: freshCandidate._id, status: 'accepted' },
        { $set: { status: 'contacted' } }
      ).exec();
    }
    sentCount++;
    await recordProgress();
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
