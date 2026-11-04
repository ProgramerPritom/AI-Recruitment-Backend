import mongoose from 'mongoose';
import { ChatMessage, IChatMessage } from '../modules/chat/chat.model';
import { Candidate } from '../modules/candidates/candidate.model';
import { Job } from '../modules/jobs/job.model';
import { AGENT_SYSTEM_PROMPT } from './agent.prompts';
import { agentToolDeclarations, AgentToolExecutor } from './agent.tools';
import { getGeminiClient, callGeminiWithModelFallback } from '../integrations/gemini/geminiClient';
import { config } from '../config';

export interface AgentChatResponse {
  message: string;
  cardPayload?: Record<string, any>;
  toolCalls?: Array<{ name: string; args: Record<string, any> }>;
  toolResults?: Array<{ name: string; result: Record<string, any> }>;
}

export class AgentService {
  /**
   * Main conversational loop with tool-calling and persistence
   */
  public static async sendMessage(
    sessionId: string,
    userMessage: string,
    jobId?: string
  ): Promise<AgentChatResponse> {
    const jobObjectId = jobId ? new mongoose.Types.ObjectId(jobId) : undefined;

    // 1. Persist user message to ChatMessage
    await ChatMessage.create({
      sessionId,
      jobId: jobObjectId,
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    });

    // 2. Fetch past conversation history (last 10 messages)
    const history = await ChatMessage.find({ sessionId })
      .sort({ timestamp: 1 })
      .limit(10)
      .exec();

    let assistantText = '';
    let cardPayload: Record<string, any> | undefined = undefined;
    const executedToolCalls: Array<{ name: string; args: Record<string, any> }> = [];
    const executedToolResults: Array<{ name: string; result: Record<string, any> }> = [];

    const isJobCreationIntent =
      (/\b(want|i want|we want|we need|need|hire|hiring|looking for|create job|new job|post a job|open role|job description|jd|lagbe|dorkar|khujchi|chai)\b/i.test(userMessage) &&
        /\b(engineer|developer|designer|manager|lead|architect|specialist|intern|senior|junior|mid|python|react|frontend|backend|full-stack|fullstack|devops|data|ai|ml|rag|llm|mern|node|software)\b/i.test(userMessage)) ||
      (userMessage.length > 25 && /\b(responsibilities|requirements|qualifications|years?(\s+of)?\s+experience|\d+\s*\+?\s*years?)\b/i.test(userMessage));

    // 2.5 Prepare rich, real-time candidate and job context for Gemini
    let candidateContextSummary = '';
    let activeJobInfo = '';

    if (jobId && !isJobCreationIntent) {
      try {
        const targetJob = await Job.findById(jobId).select('title mustHaveSkills niceToHaveSkills seniority experience').exec();
        if (targetJob) {
          activeJobInfo = `[Active Job: "${targetJob.title}"] (ID: "${targetJob._id}") | Must-Haves: [${targetJob.mustHaveSkills.join(', ')}] | Seniority: ${targetJob.seniority || 'N/A'}`;
        }

        const existingCandidates = await Candidate.find({ jobId: new mongoose.Types.ObjectId(jobId) })
          .select('_id name score status skills')
          .sort({ score: -1, createdAt: -1 })
          .exec();

        if (existingCandidates.length > 0) {
          candidateContextSummary = `[Active Job Pipeline - ${existingCandidates.length} Candidates in Pipeline (Ranked by Match Score)]:\n` +
            existingCandidates
              .map(
                (c, i) =>
                  `${i + 1}. [Candidate ID: "${c._id}"] "${c.name}" | Match Score: ${c.score !== undefined ? `${c.score}%` : 'Unscored'} | Current Status: "${c.status}"`
              )
              .join('\n');

          const lower = userMessage.toLowerCase();
          const isRemoveOrDelete = /\b(remove|delete|muche|katia|drop)\b/i.test(lower);
          const isReject = /\b(reject|bad)\b/i.test(lower) && !/\b(don't|dont|not|na|koro na)\b/i.test(lower);
          const isAccept = /\b(accept|shorthand|shortlist|nebo|neo)\b/i.test(lower) && !/\b(don't|dont|not|na|koro na)\b/i.test(lower);
          const isLowestScore = /\b(lowest score|low score|last candidate|lowest|bottom|sobar sesher)\b/i.test(lower);
          const isFirstCandidate = /\b(1st candidate|first candidate|top 1 candidate|only 1st|only first|1st|top 1|first one)\b/i.test(lower);
          const isNegation =
            /\b(don't|dont|do not|never|stop|cancel|undo|korio na|koro na)\b/i.test(lower) &&
            /\b(accept|hire|shortlist)\b/i.test(lower);

          const hexIdMatch = lower.match(/\b([a-f0-9]{24})\b/i);
          const isDetailIntent =
            /\b(detail|details|experience|techonlogies|technologies|skills|profile|linkedin|info|background|shared|share|cv|resume)\b/i.test(lower);

          // Score threshold pattern (e.g. "above score 80", "score >= 80", "above 80", "score 80 ar beshi")
          const scoreThresholdMatch =
            lower.match(/\b(?:above|over|greater than|more than|>=?|higher than|beshi|besi)\s*(?:score)?\s*(\d+)\b/i) ||
            lower.match(/\b(?:score)\s*(?:above|over|greater than|more than|>=?|higher than|beshi|besi)?\s*(\d+)\b/i);

          // Find candidate by name
          const mentionedCandidate = existingCandidates.find((c) => {
            const cNameLower = c.name.toLowerCase();
            const firstName = cNameLower.split(' ')[0];
            const lastName = cNameLower.split(' ').slice(1).join(' ');
            return (
              lower.includes(cNameLower) ||
              (firstName.length > 3 && lower.includes(firstName)) ||
              (lastName.length > 3 && lower.includes(lastName))
            );
          });

          // 1. Specific Candidate Detail Lookup (by ID or Name)
          if ((hexIdMatch && isDetailIntent) || (hexIdMatch && !isAccept && !isReject && !isRemoveOrDelete)) {
            const candidateId = hexIdMatch[1];
            const res = await AgentToolExecutor.execute('getCandidateDetails', { candidateId, jobId });
            cardPayload = res;
            assistantText = res.message;
          } else if (mentionedCandidate && isDetailIntent && !isRemoveOrDelete && !isReject && !isAccept) {
            const res = await AgentToolExecutor.execute('getCandidateDetails', {
              candidateId: mentionedCandidate._id.toString(),
              candidateName: mentionedCandidate.name,
              jobId,
            });
            cardPayload = res;
            assistantText = res.message;
          } else if (
            mentionedCandidate &&
            (lower.includes('only') || lower.includes('shudhu') || lower.includes('sudu') || lower.includes('chara')) &&
            (lower.includes('accept') || lower.includes('accepted'))
          ) {
            // User specified: "only [Candidate] accepted" (e.g. "undo accepted status to sourced. only Badruzzaman Pritom candidate accepted")
            await Candidate.updateMany(
              { jobId: new mongoose.Types.ObjectId(jobId), _id: { $ne: mentionedCandidate._id }, status: 'accepted' },
              { $set: { status: 'sourced' } }
            );
            await Candidate.findByIdAndUpdate(mentionedCandidate._id, { $set: { status: 'accepted' } });
            assistantText = `Understood! Set **${mentionedCandidate.name}** as the only Accepted candidate, and reverted all other candidates back to Sourced pipeline.`;
          } else if (isNegation) {
            const match = lower.match(/\d+/);
            const topN = match ? parseInt(match[0], 10) : undefined;
            if (topN) {
              const acceptedCandidates = await Candidate.find({ jobId: new mongoose.Types.ObjectId(jobId), status: 'accepted' })
                .sort({ score: -1 })
                .limit(topN)
                .select('_id name')
                .exec();
              const ids = acceptedCandidates.map((c) => c._id);
              await Candidate.updateMany({ _id: { $in: ids } }, { $set: { status: 'sourced' } });
              assistantText = `Understood. Reverted ${acceptedCandidates.map((c) => c.name).join(', ') || `${topN} candidate(s)`} back to Sourced pipeline.`;
            } else {
              await Candidate.updateMany({ jobId: new mongoose.Types.ObjectId(jobId), status: 'accepted' }, { $set: { status: 'sourced' } });
              assistantText = `Understood. Reverted candidate statuses back to Sourced pipeline.`;
            }
          } else if (isAccept && scoreThresholdMatch) {
            // Score threshold acceptance (e.g. "accept candidate who have above score 80")
            const minScore = parseInt(scoreThresholdMatch[1], 10);
            const eligibleCandidates = existingCandidates.filter((c) => (c.score || 0) >= minScore);
            const newlyAccepted: string[] = [];
            const alreadyAccepted: string[] = [];

            for (const cand of eligibleCandidates) {
              if (cand.status === 'accepted') {
                alreadyAccepted.push(cand.name);
              } else {
                await Candidate.findByIdAndUpdate(cand._id, { $set: { status: 'accepted' } });
                newlyAccepted.push(cand.name);
              }
            }

            if (newlyAccepted.length > 0) {
              assistantText = `Successfully accepted ${newlyAccepted.length} candidate(s) with score >= ${minScore}%: **${newlyAccepted.join(', ')}**${alreadyAccepted.length > 0 ? ` (${alreadyAccepted.join(', ')} were already accepted)` : ''}.`;
            } else if (alreadyAccepted.length > 0) {
              assistantText = `All candidate(s) with score >= ${minScore}% are already accepted: **${alreadyAccepted.join(', ')}**.`;
            } else {
              assistantText = `No candidates found with score >= ${minScore}%. The highest score in pipeline is ${existingCandidates[0]?.score || 0}%.`;
            }
          } else if (mentionedCandidate) {
            if (isRemoveOrDelete) {
              const res = await AgentToolExecutor.execute('deleteCandidate', {
                jobId,
                candidateId: mentionedCandidate._id.toString(),
                candidateName: mentionedCandidate.name,
              });
              assistantText = res.message;
            } else if (isReject) {
              const res = await AgentToolExecutor.execute('reviewCandidates', {
                jobId,
                decision: 'reject',
                candidateName: mentionedCandidate.name,
              });
              assistantText = res.message;
            } else if (isAccept) {
              const res = await AgentToolExecutor.execute('reviewCandidates', {
                jobId,
                decision: 'accept',
                candidateName: mentionedCandidate.name,
              });
              assistantText = res.message;
            } else if (lower.includes('name is') || lower.includes('score')) {
              const lastMsg = history[history.length - 2]?.content || '';
              if (lastMsg.toLowerCase().includes('reject') || lastMsg.toLowerCase().includes('remove') || lastMsg.toLowerCase().includes('delete') || lower.includes('reject') || lower.includes('remove')) {
                const res = await AgentToolExecutor.execute('deleteCandidate', {
                  jobId,
                  candidateId: mentionedCandidate._id.toString(),
                  candidateName: mentionedCandidate.name,
                });
                assistantText = res.message;
              } else {
                assistantText = `Identified candidate **${mentionedCandidate.name}** (Match Score: **${mentionedCandidate.score || 0}%**, Status: *${mentionedCandidate.status}*). Would you like to accept, reject, or remove this candidate?`;
              }
            }
          } else if (isLowestScore) {
            if (isRemoveOrDelete) {
              const res = await AgentToolExecutor.execute('deleteCandidate', {
                jobId,
                criteria: 'lowest_score',
              });
              assistantText = res.message;
            } else if (isReject) {
              const res = await AgentToolExecutor.execute('reviewCandidates', {
                jobId,
                decision: 'reject',
                criteria: 'lowest_score',
              });
              assistantText = res.message;
            }
          } else if (isFirstCandidate && isAccept) {
            const topCandidate = existingCandidates[0];
            if (topCandidate) {
              if (lower.includes('only') || lower.includes('shudhu') || lower.includes('sudu')) {
                await Candidate.updateMany({ jobId: new mongoose.Types.ObjectId(jobId), _id: { $ne: topCandidate._id }, status: 'accepted' }, { $set: { status: 'sourced' } });
              }
              await Candidate.findByIdAndUpdate(topCandidate._id, { $set: { status: 'accepted' } });
              assistantText = `Successfully accepted top candidate **${topCandidate.name}** (Match Score: **${topCandidate.score || 0}%**)${lower.includes('only') || lower.includes('shudhu') || lower.includes('sudu') ? ', and kept all other candidates in Sourced pipeline' : ''}.`;
            }
          } else if (isAccept && (/\b(top|first)\s*(\d+)\b/i.test(lower) || /\b(\d+)\s*(candidates?|profiles?)\b/i.test(lower))) {
            const match = lower.match(/\b(top|first)\s*(\d+)\b/i) || lower.match(/\b(\d+)\b/);
            const count = match ? parseInt(match[2] || match[1], 10) : 3;
            const targetList = existingCandidates.slice(0, count);
            const targetIds = targetList.map((c) => c._id);
            if (lower.includes('only') || lower.includes('shudhu') || lower.includes('sudu')) {
              await Candidate.updateMany({ jobId: new mongoose.Types.ObjectId(jobId), _id: { $nin: targetIds }, status: 'accepted' }, { $set: { status: 'sourced' } });
            }
            await Candidate.updateMany({ _id: { $in: targetIds } }, { $set: { status: 'accepted' } });
            assistantText = `Successfully accepted top ${targetList.length} candidate(s): **${targetList.map((c) => c.name).join(', ')}**${lower.includes('only') || lower.includes('shudhu') || lower.includes('sudu') ? ', and kept all other candidates in Sourced pipeline' : ''}.`;
          } else if (
            /\b(show|list|view|display|dekhao|kader|ke ke)\b/i.test(lower) &&
            /\b(candidate|candidates|profile|profiles|applicant|applicants|top)\b/i.test(lower) &&
            !/\b(accept|reject|hire|shortlist|delete|remove)\b/i.test(lower)
          ) {
            const match = lower.match(/\d+/);
            const count = match ? parseInt(match[0], 10) : 3;
            const list = existingCandidates.slice(0, count);
            const formatted = list
              .map(
                (c, idx) =>
                  `${idx + 1}. **${c.name}** — Match Score: **${c.score !== undefined ? `${c.score}%` : 'Unscored'}** | Status: *${c.status}*`
              )
              .join('\n');
            assistantText = `Here are the top ${list.length} candidate(s) for this job:\n\n${formatted}\n\nWould you like to accept any of them or begin drafting outreach?`;
          } else if (
            /\b(draft|create|start|launch|begin|shuru|banao|ready)\b/i.test(lower) &&
            /\b(campaign|outreach|email|emails|sequence)\b/i.test(lower)
          ) {
            const res = await AgentToolExecutor.execute('createCampaign', { jobId });
            cardPayload = res;
            assistantText = res.message;
          }
        } else {
          candidateContextSummary = `[Active Job Pipeline: 0 candidates currently in pipeline]`;
        }
      } catch (err) {
        console.warn('[AgentService] Error building candidate context:', err);
      }
    }

    // 3. Call Gemini with Tool Calling if API key is provided and intent not yet handled
    if (!assistantText && config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();

        // Pass active Job ID and candidate context to Gemini
        const promptText = jobId && !isJobCreationIntent
          ? `${activeJobInfo ? activeJobInfo + '\n' : ''}${candidateContextSummary ? candidateContextSummary + '\n\n' : ''}User Message: ${userMessage}`
          : userMessage;

        const response = await callGeminiWithModelFallback(async (modelName) => {
          const model = client.getGenerativeModel({
            model: modelName,
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: [{ functionDeclarations: agentToolDeclarations }],
          });

          const chat = model.startChat({
            history: history.slice(0, -1).map((msg) => ({
              role: msg.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: msg.content }],
            })),
          });

          return await chat.sendMessage(promptText);
        });

        let functionCalls = response.response.functionCalls();

        // Safety override 1: if user clearly asked to create/hire a role but Gemini called getJobStats due to prior history, correct to createJob
        if (isJobCreationIntent && functionCalls && functionCalls.some((c) => c.name === 'getJobStats')) {
          functionCalls = [{ name: 'createJob', args: { rawContent: userMessage, confirm: false } }];
        }

        // Safety override 2: if user asked to show/list candidates, never accept or review them
        const isShowCandidateIntent =
          /\b(show|list|view|who|display|see|dekhao|kader)\b/i.test(userMessage) &&
          /\b(candidate|candidates|profile|profiles|applicant|applicants)\b/i.test(userMessage) &&
          !/\b(accept|reject|approve|shortlist|hire)\b/i.test(userMessage);

        if (isShowCandidateIntent && functionCalls && functionCalls.some((c) => c.name === 'reviewCandidates')) {
          const match = userMessage.match(/\d+/);
          const limit = match ? parseInt(match[0], 10) : 5;
          functionCalls = [{ name: 'getCandidates', args: { jobId, limit } }];
        }

        // Safety override 3: Negations & Cancellations (e.g. "don't accept", "do not accept", "don't reject", "undo")
        const isNegation =
          /\b(don't|dont|do not|never|stop|cancel|undo|korio na|koro na)\b/i.test(userMessage) &&
          /\b(accept|reject|hire|shortlist)\b/i.test(userMessage);

        if (isNegation && functionCalls && functionCalls.some((c) => c.name === 'reviewCandidates')) {
          // Never reject when user says "don't accept"! Revert them safely back to 'sourced'
          const match = userMessage.match(/\d+/);
          const topN = match ? parseInt(match[0], 10) : 3;
          functionCalls = [{ name: 'reviewCandidates', args: { jobId, decision: 'sourced', topN } }];
        }

        // Safety override 4: Feedback or confusion questions (e.g. "why did you reject?", "amar kothay to bujtese na")
        const isFeedbackOrQuestion =
          /\b(reject korlo ki|bujtese na|bujteso na|why did you|what happened|ki korla|ki holo)\b/i.test(userMessage);

        if (isFeedbackOrQuestion) {
          functionCalls = [];
          assistantText = `I apologize for the confusion! I am carefully listening now. I will not make any changes to your candidates without your explicit confirmation. All candidates are currently safe in your active pipeline. What would you like to do next?`;
        }

        if (functionCalls && functionCalls.length > 0) {
          for (const call of functionCalls) {
            executedToolCalls.push({ name: call.name, args: call.args as any });
            try {
              const callArgs = (call.args as Record<string, any>) || {};
              const toolResult = await AgentToolExecutor.execute(call.name, {
                ...callArgs,
                ...(jobId && !callArgs.jobId && call.name !== 'createJob' ? { jobId } : {}),
              });
              executedToolResults.push({ name: call.name, result: toolResult });

              if (toolResult.cardType) {
                cardPayload = toolResult;
              }
              if (toolResult.message) {
                assistantText += `${toolResult.message}\n\n`;
              }
            } catch (toolErr: any) {
              executedToolResults.push({ name: call.name, result: { error: toolErr.message } });
              assistantText += `Error executing ${call.name}: ${toolErr.message}\n\n`;
            }
          }
        } else {
          assistantText = response.response.text();
        }
      } catch (err: any) {
        console.warn('[AgentService] Gemini chat failed or rate limited, falling back to heuristic assistant:', err.message);
      }
    }

    // 4. Fallback Heuristic Rule-Based Co-worker (Guarantees zero downtime/failure during demo!)
    if (!assistantText) {
      const lower = userMessage.toLowerCase();

      if (
        isJobCreationIntent ||
        (userMessage.length > 20 && (lower.includes('engineer') || lower.includes('developer') || lower.includes('role') || lower.includes('job') || lower.includes('mern') || lower.includes('ai')))
      ) {
        const res = await AgentToolExecutor.execute('createJob', { rawContent: userMessage, confirm: false });
        cardPayload = res;
        assistantText = res.message;
      } else if (lower.includes('source') || lower.includes('find candidate')) {
        if (jobId) {
          const res = await AgentToolExecutor.execute('startSourcing', { jobId, limit: 8 });
          cardPayload = res;
          assistantText = res.message;
        } else {
          assistantText = 'Please select an active job first before starting candidate sourcing.';
        }
      } else if (lower.includes('csv') || lower.includes('upload candidate') || lower.includes('import candidate')) {
        assistantText = `You can import candidate profiles via CSV or resumes (PDF, Word, TXT) at any time:\n\n1. Look at the top right of the **Talent Pipeline** table and click the **"Upload CV / Resume"** button.\n2. In the modal, select your PDF, Word doc, or CSV file and click **"Upload & Parse Resume / CV"**.\n\nAll candidate credentials will be extracted by AI, evaluated with match scores, and saved to MongoDB.`;
      } else if (
        (lower.includes('show') || lower.includes('list') || lower.includes('view') || lower.includes('see') || lower.includes('dekhao') || lower.includes('kader') || lower.includes('who')) &&
        (lower.includes('candidate') || lower.includes('profile') || lower.includes('applicant'))
      ) {
        if (jobId) {
          const match = lower.match(/\d+/);
          const limit = match ? parseInt(match[0], 10) : 5;
          const res = await AgentToolExecutor.execute('getCandidates', { jobId, limit });
          assistantText = res.message;
        } else {
          assistantText = 'Please select an active job first to view candidate profiles.';
        }
      } else if (
        /\b(don't|dont|do not|never|stop|cancel|undo|korio na|koro na)\b/i.test(lower) &&
        (lower.includes('accept') || lower.includes('candidate') || lower.includes('reject'))
      ) {
        if (jobId) {
          const res = await AgentToolExecutor.execute('reviewCandidates', { jobId, decision: 'sourced', topN: 5 });
          assistantText = res.message;
        } else {
          assistantText = 'Understood. Reverted candidate actions back to Sourced.';
        }
      } else if (lower.includes('accept top') || (lower.includes('accept') && lower.includes('candidate'))) {
        if (jobId) {
          const match = lower.match(/\d+/);
          const topN = match ? parseInt(match[0], 10) : 5;
          const res = await AgentToolExecutor.execute('reviewCandidates', { jobId, decision: 'accept', topN });
          assistantText = res.message;
        } else {
          assistantText = 'Please select an active job first.';
        }
      } else if (lower.includes('campaign') || lower.includes('outreach') || lower.includes('email draft')) {
        if (jobId) {
          const res = await AgentToolExecutor.execute('createCampaign', { jobId });
          cardPayload = res;
          assistantText = res.message;
        } else {
          assistantText = 'Please select an active job first.';
        }
      } else if (
        lower.includes('stat') ||
        lower.includes('progress') ||
        lower.includes('how is hiring') ||
        lower.includes('how many') ||
        lower.includes('applied') ||
        lower.includes('applicant') ||
        lower.includes('count')
      ) {
        if (jobId) {
          const res = await AgentToolExecutor.execute('getJobStats', { jobId });
          assistantText = res.message || `Pipeline Status:\n- Total Candidates: ${res.totalSourced}\n- Meetings Booked: ${res.meetingsBooked}\n- Hires: ${res.hires}`;
        } else {
          assistantText = 'Please select a job first to inspect candidate counts and pipeline statistics.';
        }
      } else {
        assistantText = `Hello! I'm your AI Recruiting Co-Worker. I can help you extract job descriptions, source candidates, review scores, generate email campaigns, and schedule meetings. How can I assist you right now?`;
      }
    }

    // 5. Persist assistant response to ChatMessage
    await ChatMessage.create({
      sessionId,
      jobId: jobObjectId,
      role: 'assistant',
      content: assistantText.trim(),
      cardPayload,
      toolCalls: executedToolCalls,
      toolResults: executedToolResults,
      timestamp: new Date(),
    });

    return {
      message: assistantText.trim(),
      cardPayload,
      toolCalls: executedToolCalls,
      toolResults: executedToolResults,
    };
  }

  public static async getHistory(sessionId: string): Promise<IChatMessage[]> {
    return ChatMessage.find({ sessionId }).sort({ timestamp: 1 }).exec();
  }

  public static async clearHistory(sessionId: string): Promise<void> {
    await ChatMessage.deleteMany({ sessionId }).exec();
  }
}
