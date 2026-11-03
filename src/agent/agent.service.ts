import mongoose from 'mongoose';
import { ChatMessage, IChatMessage } from '../modules/chat/chat.model';
import { AGENT_SYSTEM_PROMPT } from './agent.prompts';
import { agentToolDeclarations, AgentToolExecutor } from './agent.tools';
import { getGeminiClient, callGeminiWithBackoff } from '../integrations/gemini/geminiClient';
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

    // 3. Call Gemini with Tool Calling if API key is provided
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({
          model: config.GEMINI_MODEL,
          systemInstruction: AGENT_SYSTEM_PROMPT,
          tools: [{ functionDeclarations: agentToolDeclarations }],
        });

        const chat = model.startChat({
          history: history.slice(0, -1).map((msg) => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
          })),
        });

        const promptText = jobId ? `[Active Job ID: ${jobId}]\n${userMessage}` : userMessage;

        const response = await callGeminiWithBackoff(async () => {
          return await chat.sendMessage(promptText);
        });

        const functionCalls = response.response.functionCalls();
        if (functionCalls && functionCalls.length > 0) {
          for (const call of functionCalls) {
            executedToolCalls.push({ name: call.name, args: call.args as any });
            try {
              const callArgs = (call.args as Record<string, any>) || {};
              const toolResult = await AgentToolExecutor.execute(call.name, {
                ...callArgs,
                ...(jobId && !callArgs.jobId ? { jobId } : {}),
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

      if (lower.includes('source') || lower.includes('find candidate')) {
        if (jobId) {
          const res = await AgentToolExecutor.execute('startSourcing', { jobId, limit: 8 });
          cardPayload = res;
          assistantText = res.message;
        } else {
          assistantText = 'Please select an active job first before starting candidate sourcing.';
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
      } else if (userMessage.length > 50 && (lower.includes('engineer') || lower.includes('developer') || lower.includes('role') || lower.includes('job'))) {
        const res = await AgentToolExecutor.execute('createJob', { rawContent: userMessage, confirm: false });
        cardPayload = res;
        assistantText = res.message;
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
