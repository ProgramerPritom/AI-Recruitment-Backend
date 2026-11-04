import { IJob } from '../jobs/job.model';
import { ICandidate } from './candidate.model';
import { getGeminiClient, callGeminiWithModelFallback } from '../../integrations/gemini/geminiClient';
import { config } from '../../config';

export interface ScoreResult {
  score: number;
  reason: string;
}

export class ScoringEngine {
  /**
   * Score a candidate against job requirements with strict 0-100 bounds and anti-hallucination
   */
  public static async scoreCandidate(job: IJob, candidate: ICandidate): Promise<ScoreResult> {
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();

        const prompt = `You are an expert Principal AI Technical Talent Partner & Staff Engineering Evaluator.
Evaluate the candidate's alignment for the position fairly, holistically, and rigorously based on real-world engineering standards.

Evaluation Principles:
1. Holistic Domain Alignment (Job Title & Core Stack):
   - Notice the exact domain in the Job Title (e.g. "MERN Stack", "Full-Stack AI").
   - If a candidate demonstrates complete mastery across the primary ecosystem (e.g. React, Node.js, TypeScript, MongoDB, Express) and cutting-edge applied AI capabilities (e.g. LangChain, RAG, LLM integrations, Vector DBs/Redis, Microservices), recognize this as very high core competency (85%+ technical coverage).
2. Transferable Skills & Language Agility:
   - Do NOT apply punitive all-or-nothing disqualifications for a single missing language (e.g. Python) when the candidate is exceptionally strong in adjacent modern languages (TypeScript, Node.js) and possesses actual production AI/LLM experience (LangChain, RAG).
   - In modern software engineering, language transferability between TypeScript and Python is rapid. Missing Python should be a moderate, reasonable deduction (-8 to -12 points max), not a disqualification.
3. Relevant Modern AI & DevOps Tooling (High-Value Bonus):
   - Heavily credit advanced, high-leverage modern tools (LangChain, RAG, LLM, Docker, PostgreSQL, Redis, CI/CD, Next.js, Microservices) that directly prove ability to build and deploy production AI products.
4. Experience & Seniority Assessment:
   - Balance calendar years with demonstrated tech stack density and delivery maturity.
   - An engineer with 3+ years of hands-on production experience building full-stack applications with RAG pipelines, LLM orchestration, microservices, and containerization demonstrates strong Senior-level delivery capability. Deduct moderately for the 7+ year target (-8 to -10 points max), rather than discounting their capability.
5. Balanced Scoring Rubric (0-100):
   - Core & Must-Have Skills Fit (Up to 45 pts): Reward matched primary technologies (TypeScript, Node.js, etc.); deduct moderately for specific missing items like Python.
   - Domain & Applied AI Capabilities (Up to 30 pts): Reward complete MERN architecture, LangChain, RAG, LLMs, vector search, microservices, and practical system building.
   - Supporting Stack & DevOps Tooling (Up to 15 pts): Reward Docker, PostgreSQL, Redis, CI/CD, Git, Next.js.
   - Practical Delivery & Overall Fit (Up to 10 pts): Evaluate proven ability to ship modern AI solutions.

6. Output Schema:
Return ONLY valid JSON matching:
{
  "score": number (0 to 100),
  "reason": "Concise 2-sentence evidence-based rationale highlighting proven strengths (e.g., full MERN mastery, LangChain/RAG AI workflows, Docker/PostgreSQL) and objective development areas (e.g., Python, years of experience)."
}

Job Requirements:
Title: ${job.title}
Must-Have Skills: ${job.mustHaveSkills.join(', ')}
Nice-To-Have Skills: ${job.niceToHaveSkills.join(', ')}
Seniority: ${job.seniority || 'Not specified'}
Experience: ${job.experience || 'Not specified'}

Candidate Profile:
Name: ${candidate.name}
Skills: ${candidate.skills.join(', ')}
Summary: ${candidate.experienceSummary || 'No summary provided.'}`;

        const raw = await callGeminiWithModelFallback(async (modelName) => {
          const model = client.getGenerativeModel({
            model: modelName,
            generationConfig: {
              responseMimeType: 'application/json',
            },
          });
          const res = await model.generateContent(prompt);
          return res.response.text();
        });

        const parsed = JSON.parse(raw);
        const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
        return {
          score,
          reason: parsed.reason || `Evaluated score based on skills alignment with ${job.title}.`,
        };
      } catch (err) {
        console.warn(`[ScoringEngine] Gemini scoring failed for candidate ${candidate._id}, using deterministic rubric:`, err);
      }
    }

    // Deterministic Grounded Rubric Fallback
    return this.calculateDeterministicScore(job, candidate);
  }

  /**
   * Deterministic Rubric Evaluator
   */
  public static calculateDeterministicScore(job: IJob, candidate: ICandidate): ScoreResult {
    const candidateSkillsLower = (candidate.skills || []).map((s) => s.toLowerCase());
    const matchedMustHaves: string[] = [];
    const missingMustHaves: string[] = [];

    for (const must of job.mustHaveSkills) {
      if (candidateSkillsLower.some((cs) => cs.includes(must.toLowerCase()) || must.toLowerCase().includes(cs))) {
        matchedMustHaves.push(must);
      } else {
        missingMustHaves.push(must);
      }
    }

    const matchedNiceToHaves: string[] = [];
    for (const nice of job.niceToHaveSkills) {
      if (candidateSkillsLower.some((cs) => cs.includes(nice.toLowerCase()) || nice.toLowerCase().includes(cs))) {
        matchedNiceToHaves.push(nice);
      }
    }

    // Must-have points (45 max)
    const mustRatio = job.mustHaveSkills.length > 0 ? matchedMustHaves.length / job.mustHaveSkills.length : 1;
    const mustPoints = Math.round(mustRatio * 45);

    // Nice-to-have points (20 max)
    const niceRatio = job.niceToHaveSkills.length > 0 ? matchedNiceToHaves.length / job.niceToHaveSkills.length : 0.5;
    const nicePoints = Math.round(niceRatio * 20);

    // Experience / Summary points (25 max)
    let expPoints = 15;
    if (candidate.experienceSummary && candidate.experienceSummary.length > 30) {
      expPoints = 22;
    }

    // Base profile completeness (10 max)
    const profilePoints = (candidate.email ? 5 : 0) + (candidate.profileUrl ? 5 : 0);

    const totalScore = Math.max(0, Math.min(100, mustPoints + nicePoints + expPoints + profilePoints));

    const matchedStr = matchedMustHaves.length > 0 ? `Strong match on ${matchedMustHaves.join(', ')}` : 'Missing key required skills';
    const missingStr = missingMustHaves.length > 0 ? `lacks verified ${missingMustHaves.join(', ')}` : 'covers all must-haves';

    const reason = `${matchedStr}; ${missingStr}. ${candidate.experienceSummary ? 'Verified relevant experience.' : 'Limited experience details provided.'}`;

    return {
      score: totalScore,
      reason,
    };
  }
}

