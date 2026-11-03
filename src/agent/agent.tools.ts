import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { JobService } from '../modules/jobs/job.service';
import { CandidateService } from '../modules/candidates/candidate.service';
import { CampaignService } from '../modules/campaigns/campaign.service';
import { ReplyService } from '../modules/replies/reply.service';
import { TaskService } from '../modules/tasks/task.service';
import { Candidate } from '../modules/candidates/candidate.model';
import { Job } from '../modules/jobs/job.model';
import { processSourcingJob } from '../workers/sourcing.worker';
import { processOutreachJob } from '../workers/outreach.worker';

export const agentToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'createJob',
    description: 'Extract or create a new hiring job. MUST be called whenever the user mentions needing or hiring for a role (e.g. "We need a Senior AI Engineer", "Hire a React developer"), pastes a JD, or provides job requirements. If confirm=false, returns an editable job confirmation card. If confirm=true, persists the job.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        rawContent: { type: SchemaType.STRING, description: 'Raw job description text or requirements' },
        title: { type: SchemaType.STRING, description: 'Job title' },
        mustHaveSkills: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Required skills list',
        },
        niceToHaveSkills: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional skills list',
        },
        location: { type: SchemaType.STRING, description: 'Job location or Remote' },
        seniority: { type: SchemaType.STRING, description: 'Seniority level' },
        confirm: { type: SchemaType.BOOLEAN, description: 'Whether the user explicitly confirmed saving this job' },
      },
      required: ['rawContent'],
    },
  },
  {
    name: 'startSourcing',
    description: 'Start candidate sourcing for a specific job.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The MongoDB ID of the active job' },
        limit: { type: SchemaType.NUMBER, description: 'Number of candidates to source (default 8)' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'reviewCandidates',
    description: 'Accept or reject candidates individually or in bulk (e.g. "accept top 5 candidates").',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The Job ID' },
        decision: { type: SchemaType.STRING, description: '"accept" or "reject"' },
        topN: { type: SchemaType.NUMBER, description: 'Select top N scored candidates (e.g. 5)' },
        candidateIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Explicit list of candidate IDs to update',
        },
      },
      required: ['jobId', 'decision'],
    },
  },
  {
    name: 'createCampaign',
    description: 'Draft an email outreach sequence for accepted candidates.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The Job ID' },
        name: { type: SchemaType.STRING, description: 'Campaign name' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'approveCampaign',
    description: 'Explicitly approve an outreach campaign for sending.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        campaignId: { type: SchemaType.STRING, description: 'Campaign ID' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'sendCampaign',
    description: 'Dispatch approved campaign emails to eligible candidates.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        campaignId: { type: SchemaType.STRING, description: 'Campaign ID' },
        stepNumber: { type: SchemaType.NUMBER, description: 'Campaign step to send (default 1)' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'simulateReply',
    description: 'Simulate candidate reply to test classification and automated response drafting.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        candidateId: { type: SchemaType.STRING, description: 'Candidate ID' },
        content: { type: SchemaType.STRING, description: 'Simulated reply text' },
      },
      required: ['candidateId', 'content'],
    },
  },
  {
    name: 'updateCandidateStatus',
    description: 'Update the pipeline status of a specific candidate (e.g., mark as hired, interviewed, shortlisted).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        candidateId: { type: SchemaType.STRING, description: 'Candidate ID' },
        candidateName: { type: SchemaType.STRING, description: 'Candidate name (if ID not known)' },
        jobId: { type: SchemaType.STRING, description: 'Job ID' },
        status: { type: SchemaType.STRING, description: 'Target status' },
      },
      required: ['status'],
    },
  },
  {
    name: 'getJobStats',
    description: 'Get recruitment funnel statistics and rates for a job.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'Job ID' },
      },
      required: ['jobId'],
    },
  },
];

export class AgentToolExecutor {
  public static async execute(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'createJob': {
        if (!args.confirm) {
          const draft = await JobService.extractJobFromText(args.rawContent);
          return {
            requiresConfirmation: true,
            cardType: 'job_draft',
            draft,
            message: `I have extracted the requirements for "${draft.title}". Please review the details below and confirm to create this job.`,
          };
        }
        const created = await JobService.createJob({
          title: args.title || 'Software Engineer',
          description: args.rawContent,
          mustHaveSkills: args.mustHaveSkills || ['TypeScript', 'React'],
          niceToHaveSkills: args.niceToHaveSkills || [],
          location: args.location || 'Remote',
          seniority: args.seniority || 'Senior',
        });
        return {
          success: true,
          job: created,
          message: `Job "${created.title}" successfully created and activated!`,
        };
      }

      case 'startSourcing': {
        const limit = args.limit || 8;
        const task = await TaskService.createTask(args.jobId, 'sourcing', limit);
        setImmediate(() => {
          processSourcingJob({ taskId: task.taskId, jobId: args.jobId, limit }).catch((e) =>
            TaskService.failTask(task.taskId, e.message)
          );
        });
        return {
          success: true,
          taskId: task.taskId,
          cardType: 'live_progress',
          message: `Candidate sourcing started for job. Task ID: ${task.taskId}. Watching live progress...`,
        };
      }

      case 'reviewCandidates': {
        const { jobId, decision, topN } = args;
        let candidateIds: string[] = args.candidateIds || [];

        if (topN && (!candidateIds || candidateIds.length === 0)) {
          const topCandidates = await Candidate.find({ jobId, status: 'sourced' })
            .sort({ score: -1 })
            .limit(topN)
            .select('_id')
            .exec();
          candidateIds = topCandidates.map((c) => c._id.toString());
        }

        const result = await CandidateService.bulkReview(
          jobId,
          candidateIds,
          decision as 'accept' | 'reject',
          'agent'
        );
        return {
          success: true,
          decision,
          updatedCount: result.updatedCount,
          message: `Successfully ${decision}ed ${result.updatedCount} candidates.`,
        };
      }

      case 'createCampaign': {
        const result = await CampaignService.createDraft(args.jobId, args.name);
        return {
          success: true,
          campaign: result.campaign,
          cardType: 'campaign_preview',
          eligibleCandidateCount: result.eligibleCandidateCount,
          message: `Created draft campaign with ${result.campaign.steps.length} steps. ${result.eligibleCandidateCount} accepted candidates are eligible. Please approve before sending.`,
        };
      }

      case 'approveCampaign': {
        const approved = await CampaignService.approveCampaign(args.campaignId, 'agent');
        return {
          success: true,
          campaign: approved,
          message: `Campaign "${approved.name}" is now approved for safe sending.`,
        };
      }

      case 'sendCampaign': {
        const campaign = await CampaignService.verifyApprovalForSend(args.campaignId);
        const task = await TaskService.createTask(campaign.jobId.toString(), 'outreach');
        const stepNumber = args.stepNumber || 1;
        setImmediate(() => {
          processOutreachJob({ taskId: task.taskId, campaignId: args.campaignId, stepNumber }).catch((e) =>
            TaskService.failTask(task.taskId, e.message)
          );
        });
        return {
          success: true,
          taskId: task.taskId,
          cardType: 'live_progress',
          message: `Outreach campaign dispatch started for Step ${stepNumber}. Task ID: ${task.taskId}.`,
        };
      }

      case 'simulateReply': {
        const result = await ReplyService.simulateReply(args.candidateId, args.content);
        return {
          success: true,
          result,
          cardType: 'reply_review',
          message: `Inbound reply simulated. Classified as "${result.classification}". Suggested response generated.`,
        };
      }

      case 'updateCandidateStatus': {
        let cid = args.candidateId;
        if (!cid && args.candidateName && args.jobId) {
          const found = await Candidate.findOne({
            jobId: args.jobId,
            name: new RegExp(args.candidateName.trim(), 'i'),
          }).exec();
          if (found) cid = found._id.toString();
        }

        if (!cid) {
          throw new Error('Candidate not found. Please provide candidateId or exact name.');
        }

        const updated = await CandidateService.updateStatus(cid, args.status as any, 'agent');
        return {
          success: true,
          candidate: updated,
          message: `Candidate ${updated.name} status updated to "${updated.status}".`,
        };
      }

      case 'getJobStats': {
        const candidates = await Candidate.find({ jobId: args.jobId }).exec();
        const counts: Record<string, number> = {};
        for (const c of candidates) {
          counts[c.status] = (counts[c.status] || 0) + 1;
        }

        const totalSourced = candidates.length;
        const totalContacted = counts['contacted'] || 0;
        const totalReplied = (counts['replied'] || 0) + (counts['interested'] || 0) + (counts['not_interested'] || 0);
        const totalInterested = counts['interested'] || 0;
        const totalHired = counts['hired'] || 0;
        const totalMeetings = counts['meeting_booked'] || 0;

        const replyRate = totalContacted > 0 ? Math.round((totalReplied / totalContacted) * 100) : 0;
        const interestedRate = totalReplied > 0 ? Math.round((totalInterested / totalReplied) * 100) : 0;

        return {
          totalSourced,
          counts,
          rates: {
            replyRate: `${replyRate}%`,
            interestedRate: `${interestedRate}%`,
          },
          meetingsBooked: totalMeetings,
          hires: totalHired,
          message: `Currently, there are ${totalSourced} total candidates in the pipeline for this job:\n- Sourced: ${counts['sourced'] || 0}\n- Accepted: ${counts['accepted'] || 0}\n- Contacted: ${totalContacted}\n- Replied: ${totalReplied}\n- Meetings Booked: ${totalMeetings}\n- Hired: ${totalHired}\n\nReply Rate: ${replyRate}% | Interest Rate: ${interestedRate}%`,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

