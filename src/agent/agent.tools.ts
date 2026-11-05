import mongoose from 'mongoose';
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
    name: 'getCandidates',
    description: 'List or show candidate profiles for the active job (e.g. "show top 3 candidates", "list candidates", "who are the top candidates?"). Returns candidate names, match scores, skills, and current status. DO NOT call reviewCandidates when user asks to see or show candidate list.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The MongoDB Job ID' },
        limit: { type: SchemaType.NUMBER, description: 'Number of candidates to list (default 5)' },
        status: { type: SchemaType.STRING, description: 'Filter by status: "all", "sourced", "accepted", "rejected"' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'reviewCandidates',
    description: 'Accept, reject, or restore candidates. Can specify candidate by name (e.g. "Olly Rennard", "Howard Li"), rank/topN (e.g. 1 for "1st candidate", 3 for "top 3"), minScore (e.g. 80 for score above 80), or criteria ("lowest_score", "last_candidate").',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The MongoDB Job ID' },
        decision: { type: SchemaType.STRING, description: '"accept", "reject", "delete", or "sourced"' },
        candidateName: { type: SchemaType.STRING, description: 'Candidate name to review (e.g. "Olly Rennard", "Howard Li")' },
        topN: { type: SchemaType.NUMBER, description: 'Select top N scored candidates (e.g. 1 for "1st candidate", 3 for "top 3")' },
        minScore: { type: SchemaType.NUMBER, description: 'Accept or filter candidates with match score >= minScore (e.g. 80)' },
        criteria: { type: SchemaType.STRING, description: '"lowest_score", "last", or "top"' },
        candidateIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Candidate IDs or names to update',
        },
      },
      required: ['jobId', 'decision'],
    },
  },
  {
    name: 'getCandidateDetails',
    description: 'Get full profile, experience, skills/technologies, match analysis, and LinkedIn link for a specific candidate by ID (e.g. "6aeae301e2ab5cbb1803d1cf") or candidate name. MUST be called when recruiter asks for details, experience, technologies, or profile of a specific candidate.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        candidateId: { type: SchemaType.STRING, description: 'Candidate MongoDB ObjectId' },
        candidateName: { type: SchemaType.STRING, description: 'Candidate name' },
        jobId: { type: SchemaType.STRING, description: 'Active Job ID' },
      },
    },
  },
  {
    name: 'deleteCandidate',
    description: 'Permanently remove or delete a candidate from the job. Can find candidate by name (e.g. "Olly Rennard"), criteria (e.g. "lowest_score", "last candidate"), or ID. Use when recruiter says "delete", "remove", or "reject and remove".',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The MongoDB Job ID' },
        candidateName: { type: SchemaType.STRING, description: 'Candidate name to delete (e.g. "Olly Rennard")' },
        criteria: { type: SchemaType.STRING, description: '"lowest_score", "last", or "bottom"' },
        candidateId: { type: SchemaType.STRING, description: 'Candidate ID if known' },
      },
      required: ['jobId'],
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
          description: args.description || args.rawContent,
          mustHaveSkills: args.mustHaveSkills || ['TypeScript', 'React'],
          niceToHaveSkills: args.niceToHaveSkills || [],
          location: args.location || 'Remote',
          seniority: args.seniority || 'Senior',
          experience: args.experience,
          minExperienceYears: args.minExperienceYears,
          responsibilities: args.responsibilities || [],
          qualifications: args.qualifications || [],
          salaryRange: args.salaryRange,
          remotePolicy: args.remotePolicy || 'Remote',
        });
        return {
          success: true,
          job: created,
          message: `Job "${created.title}" successfully created and activated!`,
        };
      }

      case 'startSourcing': {
        const limit = Math.min(args.limit || 8, 8);
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

      case 'getCandidates': {
        const { jobId, limit = 5, status } = args;
        const query: any = { jobId };
        if (status && status !== 'all') {
          query.status = status;
        }
        const candidates = await Candidate.find(query)
          .sort({ score: -1, createdAt: -1 })
          .limit(limit)
          .exec();

        if (candidates.length === 0) {
          return {
            success: true,
            candidates: [],
            message: 'No candidates found in the pipeline for this job yet. You can source candidates from the web or upload CVs.',
          };
        }

        const formattedList = candidates
          .map(
            (c, idx) =>
              `${idx + 1}. **${c.name}** — Match Score: **${c.score !== undefined ? `${c.score}%` : 'Unscored'}** | Status: *${c.status}*\n   - Skills: ${c.skills.slice(0, 5).join(', ')}\n   - Email: ${c.email || 'N/A'}${c.profileUrl ? ` | [LinkedIn](${c.profileUrl})` : ''}`
          )
          .join('\n\n');

        return {
          success: true,
          candidates,
          message: `Here are the top ${candidates.length} candidate(s) for this job:\n\n${formattedList}`,
        };
      }

      case 'getCandidateDetails': {
        const { candidateId, candidateName, jobId } = args;
        let targetCandidate: any = null;

        if (candidateId && mongoose.Types.ObjectId.isValid(candidateId)) {
          targetCandidate = await Candidate.findById(candidateId);
        }
        if (!targetCandidate && candidateName) {
          const filter: any = { name: { $regex: new RegExp(candidateName.trim(), 'i') } };
          if (jobId && mongoose.Types.ObjectId.isValid(jobId)) {
            filter.jobId = new mongoose.Types.ObjectId(jobId);
          }
          targetCandidate = await Candidate.findOne(filter);
        }

        if (!targetCandidate) {
          return {
            success: false,
            message: `Could not find candidate details for "${candidateName || candidateId || 'specified candidate'}".`,
          };
        }

        const expText = targetCandidate.experienceYears
          ? `${targetCandidate.experienceYears}+ years${targetCandidate.currentRole ? ` as ${targetCandidate.currentRole}` : ''}${targetCandidate.currentCompany ? ` at ${targetCandidate.currentCompany}` : ''}`
          : targetCandidate.currentRole
          ? `${targetCandidate.currentRole}${targetCandidate.currentCompany ? ` at ${targetCandidate.currentCompany}` : ''}`
          : 'Experience extracted from resume / LinkedIn profile';

        const skillsList = targetCandidate.skills && targetCandidate.skills.length > 0
          ? targetCandidate.skills.join(', ')
          : 'None specified';

        const matchScoreText = targetCandidate.score !== undefined ? `${targetCandidate.score}%` : 'Unscored';
        const rationaleText = targetCandidate.matchRationale || targetCandidate.matchBreakdown?.summary || 'Candidate profile aligns with core job requirements.';

        const message = `### Candidate Profile: **${targetCandidate.name}**\n\n` +
          `- **Match Score:** **${matchScoreText}** (Status: *${targetCandidate.status}*)\n` +
          `- **Experience:** ${expText}\n` +
          `- **Technologies & Skills:** ${skillsList}\n` +
          `- **Email:** ${targetCandidate.email || 'N/A'}\n` +
          `- **LinkedIn Profile:** ${targetCandidate.profileUrl ? `[View LinkedIn Profile](${targetCandidate.profileUrl})` : 'N/A'}\n` +
          `- **AI Match Evaluation:** ${rationaleText}\n` +
          (targetCandidate.matchBreakdown?.missingSkills?.length > 0 ? `- **Missing Skills:** ${targetCandidate.matchBreakdown.missingSkills.join(', ')}\n` : '');

        return {
          success: true,
          candidate: targetCandidate,
          cardType: 'candidate_detail',
          message,
        };
      }

      case 'deleteCandidate': {
        const { jobId, candidateName, criteria, candidateId } = args;
        let targetCandidate: any = null;
        const jobObjectId = new mongoose.Types.ObjectId(jobId);

        if (candidateId && mongoose.Types.ObjectId.isValid(candidateId)) {
          targetCandidate = await Candidate.findOne({ _id: candidateId, jobId: jobObjectId });
        }
        if (!targetCandidate && candidateName) {
          targetCandidate = await Candidate.findOne({
            jobId: jobObjectId,
            name: { $regex: new RegExp(candidateName.trim(), 'i') },
          });
        }
        if (!targetCandidate && (criteria === 'lowest_score' || criteria === 'last' || criteria === 'bottom' || !candidateName)) {
          targetCandidate = await Candidate.findOne({ jobId: jobObjectId })
            .sort({ score: 1, createdAt: -1 });
        }

        if (!targetCandidate) {
          return {
            success: false,
            message: `Could not find any candidate matching "${candidateName || criteria || 'criteria'}" in this job.`,
          };
        }

        const delResult = await CandidateService.deleteCandidate(targetCandidate._id.toString(), 'agent');
        return {
          success: true,
          deletedCandidateId: delResult.deletedCandidateId,
          message: `Successfully removed and deleted candidate "${targetCandidate.name}" (Score: ${targetCandidate.score !== undefined ? `${targetCandidate.score}%` : 'Unscored'}) from the job and database.`,
        };
      }

      case 'reviewCandidates': {
        const { jobId, decision, topN, candidateName, criteria } = args;
        let candidateIds: string[] = [];
        const jobObjectId = new mongoose.Types.ObjectId(jobId);

        // 1. If candidateName was provided, find by regex
        if (candidateName) {
          const found = await Candidate.findOne({
            jobId: jobObjectId,
            name: { $regex: new RegExp(candidateName.trim(), 'i') },
          });
          if (found) {
            candidateIds.push(found._id.toString());
          }
        }

        // 2. If criteria is lowest_score or last
        if (criteria === 'lowest_score' || criteria === 'last' || criteria === 'bottom') {
          const lowest = await Candidate.findOne({ jobId: jobObjectId }).sort({ score: 1 });
          if (lowest && !candidateIds.includes(lowest._id.toString())) {
            candidateIds.push(lowest._id.toString());
          }
        }

        // 3. If explicit candidateIds or names were provided
        if (Array.isArray(args.candidateIds) && args.candidateIds.length > 0) {
          for (const item of args.candidateIds) {
            if (typeof item === 'string') {
              if (mongoose.Types.ObjectId.isValid(item) && item.length === 24) {
                // Ensure it's a real candidate in this job, not a jobId hallucination!
                const realCandidate = await Candidate.findOne({ _id: item, jobId: jobObjectId });
                if (realCandidate) {
                  if (!candidateIds.includes(item)) candidateIds.push(item);
                  continue;
                }
              }
              // It's a candidate name! Find by name
              const foundByName = await Candidate.findOne({
                jobId: jobObjectId,
                name: { $regex: new RegExp(item.trim(), 'i') },
              });
              if (foundByName && !candidateIds.includes(foundByName._id.toString())) {
                candidateIds.push(foundByName._id.toString());
              }
            }
          }
        }

        // 4. If topN was provided (e.g. 1 for "1st candidate", 3 for "top 3")
        if (candidateIds.length === 0 && topN && topN > 0) {
          const statusFilter =
            decision === 'sourced'
              ? { $in: ['accepted', 'rejected'] }
              : decision === 'accept'
              ? { $in: ['sourced', 'rejected'] }
              : { $in: ['sourced', 'accepted'] };

          const candidatesToUpdate = await Candidate.find({ jobId: jobObjectId, status: statusFilter })
            .sort({ score: -1 })
            .limit(topN)
            .select('_id')
            .exec();
          candidateIds = candidatesToUpdate.map((c) => c._id.toString());
        }

        // 5. If minScore was provided (e.g. minScore: 80 for "above score 80")
        if (candidateIds.length === 0 && args.minScore !== undefined && args.minScore > 0) {
          const statusFilter =
            decision === 'sourced'
              ? { $in: ['accepted', 'rejected'] }
              : decision === 'accept'
              ? { $in: ['sourced', 'rejected'] }
              : { $in: ['sourced', 'accepted'] };

          const candidatesToUpdate = await Candidate.find({
            jobId: jobObjectId,
            score: { $gte: args.minScore },
            status: statusFilter,
          })
            .sort({ score: -1 })
            .select('_id')
            .exec();
          candidateIds = candidatesToUpdate.map((c) => c._id.toString());
        }

        // If user requested to delete or remove
        if (decision === 'delete' || decision === 'remove') {
          if (candidateIds.length === 0) {
            return {
              success: false,
              message: 'Could not find the specified candidate to remove.',
            };
          }
          const delRes = await CandidateService.bulkDelete(jobId, candidateIds, 'agent');
          return {
            success: true,
            deletedCount: delRes.deletedCount,
            message: `Successfully removed and deleted ${delRes.deletedCount} candidate(s) from database.`,
          };
        }

        if (candidateIds.length === 0) {
          return {
            success: false,
            message: `Could not find any candidates matching your instruction in this job.`,
          };
        }

        const targetDecision = decision === 'sourced' ? 'sourced' : (decision as 'accept' | 'reject');
        const result = await CandidateService.bulkReview(
          jobId,
          candidateIds,
          targetDecision,
          'agent'
        );

        const candidateNames = result.updatedCandidates.map((c) => c.name).join(', ');
        return {
          success: true,
          decision,
          updatedCount: result.updatedCount,
          message: decision === 'sourced'
            ? `Understood. Reverted ${candidateNames || `${result.updatedCount} candidate(s)`} back to Sourced.`
            : `Successfully ${decision}ed ${candidateNames || `${result.updatedCount} candidate(s)`}.`,
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
        const stepNumber = args.stepNumber || 1;
        const campaign = await CampaignService.verifyApprovalForSend(args.campaignId, stepNumber);
        const task = await TaskService.createTask(campaign.jobId.toString(), 'outreach');
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
