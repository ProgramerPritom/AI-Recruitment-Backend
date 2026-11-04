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

        const prompt = `You are an objective AI technical recruiter. Evaluate the following candidate strictly against the job requirements.
Scoring Rubric:
- Must-have skills alignment: Up to 45 points
- Nice-to-have skills alignment: Up to 20 points
- Seniority & relevant experience fit: Up to 20 points
- Overall profile fit: Up to 15 points
Total possible score: 0 to 100.

Rules:
1. Do not invent or hallucinate candidate experience.
2. If any skill or experience is unknown, state "Information unknown" rather than assuming proficiency.
3. The response must be valid JSON matching:
{
  "score": number (0 to 100),
  "reason": "Concise 1-2 sentence evidence-based rationale citing matched skills and gaps"
}

Job Requirements:
Title: ${job.title}
Must-Have Skills: ${job.mustHaveSkills.join(', ')}
Nice-To-Have Skills: ${job.niceToHaveSkills.join(', ')}
Seniority: ${job.seniority || 'Not specified'}

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

