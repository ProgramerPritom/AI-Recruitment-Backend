import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import { defaultWorkerOptions } from '../queues/queue.config';
import { SourcingJobData } from '../queues/sourcing.queue';
import { Job } from '../modules/jobs/job.model';
import { Candidate } from '../modules/candidates/candidate.model';
import { CandidateService } from '../modules/candidates/candidate.service';
import { SearchProvider } from '../integrations/search/searchProvider';
import { TaskService } from '../modules/tasks/task.service';
import { ActivityService } from '../modules/activity/activity.service';
import { processScoringJob } from './scoring.worker';

export async function processSourcingJob(jobData: SourcingJobData): Promise<{ sourcedCount: number }> {
  const { taskId, jobId, limit = 8 } = jobData;
  const maxLimit = Math.min(Math.max(limit || 8, 1), 8); // Strictly capped at 8 candidates

  const targetJob = await Job.findById(jobId).exec();
  if (!targetJob) {
    throw new Error(`Job ${jobId} not found for sourcing`);
  }

  await TaskService.updateProgress(taskId, {
    phase: 'searching',
    progress: 10,
    processedCount: 0,
    totalCount: maxLimit,
  });

  // 1. Search candidates via Serper or mock provider (strictly capped at 8)
  const profiles = await SearchProvider.searchCandidates(targetJob.title, targetJob.mustHaveSkills, maxLimit);

  await TaskService.updateProgress(taskId, {
    phase: 'deduplicating',
    progress: 30,
    processedCount: Math.min(profiles.length, maxLimit),
    totalCount: maxLimit,
  });

  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  const createdCandidateIds: string[] = [];

  for (const p of profiles) {
    if (createdCandidateIds.length >= maxLimit) {
      break; // Stop immediately once strictly 8 candidates are reached
    }

    const normalizedEmail = CandidateService.normalizeEmail(p.email);
    const normalizedProfileUrl = CandidateService.normalizeProfileUrl(p.profileUrl);

    // Deduplication check
    const duplicateConditions: any[] = [];
    if (normalizedEmail) duplicateConditions.push({ jobId: jobObjectId, normalizedEmail });
    if (normalizedProfileUrl) duplicateConditions.push({ jobId: jobObjectId, normalizedProfileUrl });

    if (duplicateConditions.length > 0) {
      const exists = await Candidate.findOne({ $or: duplicateConditions }).exec();
      if (exists) {
        createdCandidateIds.push(exists._id.toString());
        continue;
      }
    }

    try {
      const candidate = new Candidate({
        jobId: jobObjectId,
        name: p.name,
        email: p.email,
        normalizedEmail: normalizedEmail || undefined,
        profileUrl: p.profileUrl,
        normalizedProfileUrl: normalizedProfileUrl || undefined,
        source: 'web',
        skills: p.skills,
        experienceSummary: p.experienceSummary,
        status: 'sourced',
      });
      const saved = await candidate.save();
      createdCandidateIds.push(saved._id.toString());
    } catch (err: any) {
      if (err.code === 11000) {
        // Skip duplicate
      } else {
        console.warn(`[SourcingWorker] Error persisting candidate ${p.name}: ${err.message}`);
      }
    }
  }

  await ActivityService.record({
    jobId,
    actor: 'agent',
    action: `Sourced ${createdCandidateIds.length} candidate profiles`,
    newValue: { sourcedCount: createdCandidateIds.length },
  });

  // 2. Automatically trigger scoring for newly sourced profiles
  await processScoringJob({
    taskId,
    jobId,
    candidateIds: createdCandidateIds,
  });

  return { sourcedCount: createdCandidateIds.length };
}

export function startSourcingWorker(): Worker<SourcingJobData> {
  const worker = new Worker<SourcingJobData>(
    'sourcing-queue',
    async (job: BullJob<SourcingJobData>) => {
      console.log(`[SourcingWorker] Processing sourcing job ${job.id} for task ${job.data.taskId}`);
      return await processSourcingJob(job.data);
    },
    defaultWorkerOptions
  );

  worker.on('failed', async (job, err) => {
    if (job?.data?.taskId) {
      console.error(`[SourcingWorker] Job ${job.id} failed:`, err);
      await TaskService.failTask(job.data.taskId, err.message);
    }
  });

  return worker;
}

