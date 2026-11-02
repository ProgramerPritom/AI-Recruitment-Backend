import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import { defaultWorkerOptions } from '../queues/queue.config';
import { ScoringJobData } from '../queues/scoring.queue';
import { Job } from '../modules/jobs/job.model';
import { Candidate } from '../modules/candidates/candidate.model';
import { ScoringEngine } from '../modules/candidates/scoringEngine';
import { TaskService } from '../modules/tasks/task.service';
import { ActivityService } from '../modules/activity/activity.service';

export async function processScoringJob(jobData: ScoringJobData): Promise<{ scoredCount: number }> {
  const { taskId, jobId, candidateIds } = jobData;
  const targetJob = await Job.findById(jobId).exec();
  if (!targetJob) {
    throw new Error(`Job ${jobId} not found for scoring`);
  }

  const total = candidateIds.length;
  await TaskService.updateProgress(taskId, {
    phase: 'scoring',
    processedCount: 0,
    totalCount: total,
    progress: 0,
  });

  let processed = 0;
  for (const cid of candidateIds) {
    try {
      const candidate = await Candidate.findById(cid).exec();
      if (candidate) {
        const { score, reason } = await ScoringEngine.scoreCandidate(targetJob, candidate);
        candidate.score = score;
        candidate.scoreReason = reason;
        await candidate.save();
      }
    } catch (err: any) {
      console.warn(`[ScoringWorker] Failed to score candidate ${cid}: ${err.message}`);
    }

    processed++;
    await TaskService.updateProgress(taskId, {
      phase: 'scoring',
      processedCount: processed,
      totalCount: total,
    });
  }

  await TaskService.completeTask(taskId, { scoredCount: processed });
  await ActivityService.record({
    jobId,
    actor: 'system',
    action: `Scored ${processed} candidates`,
    newValue: { scoredCount: processed },
  });

  return { scoredCount: processed };
}

export function startScoringWorker(): Worker<ScoringJobData> {
  const worker = new Worker<ScoringJobData>(
    'scoring-queue',
    async (job: BullJob<ScoringJobData>) => {
      console.log(`[ScoringWorker] Processing scoring job ${job.id} for task ${job.data.taskId}`);
      return await processScoringJob(job.data);
    },
    defaultWorkerOptions
  );

  worker.on('failed', async (job, err) => {
    if (job?.data?.taskId) {
      console.error(`[ScoringWorker] Job ${job.id} failed:`, err);
      await TaskService.failTask(job.data.taskId, err.message);
    }
  });

  return worker;
}

