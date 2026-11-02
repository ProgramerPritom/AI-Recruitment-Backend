import { Job, IJob } from './job.model';
import { CreateJobSchema } from '../../shared/schemas';
import { AppError } from '../../middleware/errorHandler';
import { ActivityService } from '../activity/activity.service';
import { getGeminiClient, callGeminiWithBackoff } from '../../integrations/gemini/geminiClient';
import { config } from '../../config';

export interface ExtractedJobDraft {
  title: string;
  description: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  seniority?: string;
  location?: string;
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
  };
  remotePolicy?: string;
}

export class JobService {
  /**
   * Extract structured requirements from raw text without saving to the database
   */
  public static async extractJobFromText(content: string, _isUrl = false): Promise<ExtractedJobDraft> {
    if (!content || content.trim().length < 10) {
      throw new AppError('Job content must be at least 10 characters long.', 400, 'INVALID_CONTENT');
    }

    // Attempt extraction via Gemini if API key is present
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({
          model: config.GEMINI_MODEL,
          generationConfig: {
            responseMimeType: 'application/json',
          },
        });

        const prompt = `You are an expert technical recruiter. Analyze the following Job Description and extract structured requirements in JSON format matching this exact schema:
{
  "title": "string (job title)",
  "description": "string (cleaned overview/summary of role)",
  "mustHaveSkills": ["string (essential skills/technologies)"],
  "niceToHaveSkills": ["string (optional/preferred skills)"],
  "seniority": "string (e.g. Junior, Mid, Senior, Lead, Staff)",
  "location": "string (e.g. Remote, San Francisco, CA, London, etc.)",
  "salaryRange": {
    "min": number or null,
    "max": number or null,
    "currency": "USD"
  },
  "remotePolicy": "Remote" | "Hybrid" | "Onsite" | "Flexible"
}

Never invent or hallucinate skills not mentioned. If salary or location is unspecified, leave them empty or null.

Job Description Content:
${content}`;

        const result = await callGeminiWithBackoff(async () => {
          const response = await model.generateContent(prompt);
          return response.response.text();
        });

        const parsed = JSON.parse(result);
        return {
          title: parsed.title || 'Software Engineer',
          description: parsed.description || content.substring(0, 500),
          mustHaveSkills: Array.isArray(parsed.mustHaveSkills) && parsed.mustHaveSkills.length > 0 ? parsed.mustHaveSkills : ['TypeScript', 'JavaScript'],
          niceToHaveSkills: Array.isArray(parsed.niceToHaveSkills) ? parsed.niceToHaveSkills : [],
          seniority: parsed.seniority || 'Mid-Senior',
          location: parsed.location || 'Remote',
          salaryRange: parsed.salaryRange || { min: 80000, max: 130000, currency: 'USD' },
          remotePolicy: parsed.remotePolicy || 'Remote',
        };
      } catch (err) {
        console.warn('[JobService] Gemini extraction failed or rate limited, falling back to heuristic parser:', err);
      }
    }

    // Deterministic Heuristic Extraction Fallback (Ensures zero downtime/failure)
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] || 'Software Engineer';
    const titleMatch = firstLine.replace(/^(Job Title|Position|Role):\s*/i, '');

    const detectedSkills: string[] = [];
    const techCatalog = ['React', 'TypeScript', 'JavaScript', 'Node.js', 'Express', 'Python', 'Go', 'Docker', 'Kubernetes', 'MongoDB', 'PostgreSQL', 'Redis', 'AWS', 'GraphQL', 'Next.js', 'Tailwind', 'Vue', 'Angular', 'Java', 'C#'];
    for (const tech of techCatalog) {
      const regex = new RegExp(`\\b${tech.replace('.', '\\.')}\\b`, 'i');
      if (regex.test(content)) {
        detectedSkills.push(tech);
      }
    }

    const mustHave = detectedSkills.slice(0, 4);
    const niceToHave = detectedSkills.slice(4);

    let seniority = 'Mid-Senior';
    if (/junior|intern|associate/i.test(content)) seniority = 'Junior';
    else if (/lead|principal|staff|architect/i.test(content)) seniority = 'Lead';
    else if (/senior|sr\./i.test(content)) seniority = 'Senior';

    return {
      title: titleMatch.length > 5 ? titleMatch : 'Full-Stack Software Engineer',
      description: content.length > 1000 ? content.substring(0, 1000) + '...' : content,
      mustHaveSkills: mustHave.length > 0 ? mustHave : ['TypeScript', 'Node.js', 'React'],
      niceToHaveSkills: niceToHave,
      seniority,
      location: /remote/i.test(content) ? 'Remote' : 'Hybrid / Flexible',
      salaryRange: { min: 90000, max: 140000, currency: 'USD' },
      remotePolicy: 'Remote',
    };
  }

  /**
   * Create and persist a confirmed Job
   */
  public static async createJob(input: unknown): Promise<IJob> {
    const validated = CreateJobSchema.parse(input);

    const job = new Job({
      title: validated.title,
      description: validated.description,
      mustHaveSkills: validated.mustHaveSkills,
      niceToHaveSkills: validated.niceToHaveSkills,
      seniority: validated.seniority,
      location: validated.location,
      salaryRange: validated.salaryRange,
      remotePolicy: validated.remotePolicy,
      status: 'active',
    });

    const savedJob = await job.save();

    await ActivityService.record({
      jobId: savedJob._id.toString(),
      actor: 'recruiter',
      action: 'Created job',
      newValue: { title: savedJob.title, status: savedJob.status },
    });

    return savedJob;
  }

  public static async getJobs(): Promise<IJob[]> {
    return Job.find().sort({ createdAt: -1 }).exec();
  }

  public static async getJobById(jobId: string): Promise<IJob> {
    const job = await Job.findById(jobId).exec();
    if (!job) {
      throw new AppError(`Job with ID ${jobId} not found`, 404, 'JOB_NOT_FOUND');
    }
    return job;
  }
}

