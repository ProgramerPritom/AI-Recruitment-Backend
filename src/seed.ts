import fs from 'fs';
import path from 'path';
import { connectDatabase, disconnectDatabase } from './config/database';
import { JobService } from './modules/jobs/job.service';
import { CandidateService } from './modules/candidates/candidate.service';
import { ScoringEngine } from './modules/candidates/scoringEngine';
import { CampaignService } from './modules/campaigns/campaign.service';
import { Job } from './modules/jobs/job.model';
import { Candidate } from './modules/candidates/candidate.model';

async function seed() {
  console.log('--- Starting Aironauts Database Seeding ---');
  await connectDatabase();

  // 1. Create or retrieve sample Job
  const existingJob = await Job.findOne({ title: 'Senior Full-Stack Engineer (React & Node.js)' }).exec();
  let job: any = existingJob;

  if (!job) {
    console.log('[Seed] Creating sample Job...');
    const jdPath = path.join(__dirname, '../seed/sample-job-description.txt');
    const jdText = fs.existsSync(jdPath) ? fs.readFileSync(jdPath, 'utf8') : 'Senior React & Node Developer';

    const draft = await JobService.extractJobFromText(jdText);
    job = await JobService.createJob({
      title: 'Senior Full-Stack Engineer (React & Node.js)',
      description: draft.description,
      mustHaveSkills: ['React', 'TypeScript', 'Node.js', 'MongoDB', 'BullMQ'],
      niceToHaveSkills: ['Docker', 'GraphQL', 'Tailwind CSS'],
      seniority: 'Senior',
      location: 'Remote',
      salaryRange: { min: 130000, max: 170000, currency: 'USD' },
      remotePolicy: 'Remote',
    });
    console.log(`[Seed] Created Job: ${job.title} (ID: ${job._id})`);
  } else {
    console.log(`[Seed] Using existing Job: ${job.title} (ID: ${job._id})`);
  }

  // 2. Import sample Candidates from CSV
  const csvPath = path.join(__dirname, '../seed/sample-candidates.csv');
  if (fs.existsSync(csvPath)) {
    console.log('[Seed] Importing candidates from sample-candidates.csv...');
    const fileBuffer = fs.readFileSync(csvPath);
    const summary = await CandidateService.importFromCsv(job._id.toString(), fileBuffer);
    console.log(`[Seed] Import result: ${summary.importedCount} imported, ${summary.duplicateCount} duplicates, ${summary.failedCount} invalid rows.`);
  }

  // 3. Score all candidates for this job
  const candidates = await Candidate.find({ jobId: job._id }).exec();
  console.log(`[Seed] Scoring ${candidates.length} candidates against job rubric...`);
  for (const c of candidates) {
    if (c.score === undefined || c.score === null) {
      const { score, reason } = ScoringEngine.calculateDeterministicScore(job, c);
      c.score = score;
      c.scoreReason = reason;
      await c.save();
    }
  }

  // 4. Accept top 3 candidates for outreach
  const topCandidates = await Candidate.find({ jobId: job._id, status: 'sourced' })
    .sort({ score: -1 })
    .limit(3)
    .exec();

  if (topCandidates.length > 0) {
    console.log(`[Seed] Accepting top ${topCandidates.length} scored candidates...`);
    await CandidateService.bulkReview(
      job._id.toString(),
      topCandidates.map((c) => c._id.toString()),
      'accept',
      'recruiter'
    );
  }

  // 5. Create Draft Outreach Campaign
  const existingCampaign = await CampaignService.getByJobId(job._id.toString());
  if (existingCampaign.length === 0) {
    console.log('[Seed] Creating initial draft outreach campaign...');
    const { campaign, eligibleCandidateCount } = await CampaignService.createDraft(job._id.toString());
    console.log(`[Seed] Created campaign "${campaign.name}" (${eligibleCandidateCount} eligible candidates).`);
  }

  console.log('--- Database Seeding Completed Successfully! ---');
  console.log(`Job ID: ${job._id}`);
  console.log('You can now run `npm run dev` to start the backend server.');

  await disconnectDatabase();
  process.exit(0);
}

seed().catch((err) => {
  console.error('[Seed] Seeding failed:', err);
  process.exit(1);
});
