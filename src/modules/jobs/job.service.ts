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
  seniority: string;
  experience: string;
  minExperienceYears: number;
  responsibilities: string[];
  qualifications: string[];
  location: string;
  remotePolicy: string;
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
  };
}

export class JobService {
  /**
   * Extract structured requirements from raw text without saving to the database
   */
  public static async extractJobFromText(content: string, _isUrl = false): Promise<ExtractedJobDraft> {
    if (!content || content.trim().length < 10) {
      throw new AppError('Job content must be at least 10 characters long.', 400, 'INVALID_CONTENT');
    }

    // 1. Attempt Master AI Extraction via Gemini
    if (config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'MOCK_KEY') {
      try {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({
          model: config.GEMINI_MODEL,
          generationConfig: {
            responseMimeType: 'application/json',
          },
        });

        const prompt = `You are a Principal Technical Recruiter and Staff Talent Architect.
Analyze the following user input or Job Description brief with high precision.
Extract every explicit requirement and formulate comprehensive structured requirements matching this exact JSON schema:

{
  "title": "string (clear, standardized industry job title, e.g. 'Senior AI Engineer')",
  "seniority": "string ('Junior' | 'Mid' | 'Senior' | 'Lead' | 'Principal' | 'Staff')",
  "experience": "string (e.g. '5+ years' or '3-5 years' as mentioned or implied by seniority)",
  "minExperienceYears": number (minimum years of experience required as an integer, e.g. 5),
  "description": "string (a professional 2-3 sentence overview describing the role's mission, impact, and core technologies)",
  "mustHaveSkills": ["string (essential mandatory technical skills, libraries, frameworks, languages, or tools mentioned)"],
  "niceToHaveSkills": ["string (complementary or preferred technical skills, adjacent tools, or domain experience)"],
  "responsibilities": [
    "string (3-5 concrete technical responsibilities and deliverables expected from this role)"
  ],
  "qualifications": [
    "string (3-5 key qualifications, background, and practical criteria)"
  ],
  "location": "string (e.g. 'Remote', 'San Francisco, CA', or 'Global Remote')",
  "remotePolicy": "Remote" | "Hybrid" | "Onsite" | "Flexible",
  "salaryRange": {
    "min": number or null,
    "max": number or null,
    "currency": "USD"
  }
}

STRICT EXTRACTION RULES:
1. EXPERIENCE: Look carefully for any mention of years (e.g. '5+ years experience', 'minimum 3 years', etc.). Set both 'experience' (e.g. '5+ years') and 'minExperienceYears' (e.g. 5). If unspecified, infer from seniority (Junior: 1, Mid: 3, Senior: 5, Lead: 7).
2. SKILLS: Separate explicitly requested skills into 'mustHaveSkills'. Add 2-4 realistic complementary industry tools into 'niceToHaveSkills' if not specified.
3. RESPONSIBILITIES: Generate 3-4 concrete, actionable engineering responsibilities tailored directly to this title and tech stack.
4. QUALIFICATIONS: Generate 3-4 professional qualifications emphasizing the required experience, tech stack proficiency, and delivery mindset.
5. NEVER leave empty arrays for mustHaveSkills, responsibilities, or qualifications.

Input Job Brief:
${content}`;

        const result = await callGeminiWithBackoff(async () => {
          const response = await model.generateContent(prompt);
          return response.response.text();
        });

        const parsed = JSON.parse(result);
        const minYears =
          typeof parsed.minExperienceYears === 'number'
            ? parsed.minExperienceYears
            : parseInt(String(parsed.experience || '').match(/\d+/)?.[0] || '5', 10);

        return {
          title: parsed.title || 'Senior Software Engineer',
          seniority: parsed.seniority || (minYears >= 5 ? 'Senior' : 'Mid'),
          experience: parsed.experience || `${minYears}+ years`,
          minExperienceYears: minYears,
          description: parsed.description || content.substring(0, 500),
          mustHaveSkills:
            Array.isArray(parsed.mustHaveSkills) && parsed.mustHaveSkills.length > 0
              ? parsed.mustHaveSkills
              : ['Python', 'PyTorch', 'RAG'],
          niceToHaveSkills:
            Array.isArray(parsed.niceToHaveSkills) && parsed.niceToHaveSkills.length > 0
              ? parsed.niceToHaveSkills
              : ['Docker', 'FastAPI', 'LangChain'],
          responsibilities:
            Array.isArray(parsed.responsibilities) && parsed.responsibilities.length > 0
              ? parsed.responsibilities
              : [
                  `Design and develop production systems for ${parsed.title || 'the role'}.`,
                  'Collaborate with product and engineering teams on architecture and roadmap.',
                  'Maintain rigorous testing, monitoring, and performance optimization.',
                ],
          qualifications:
            Array.isArray(parsed.qualifications) && parsed.qualifications.length > 0
              ? parsed.qualifications
              : [
                  `${minYears}+ years of hands-on professional software engineering experience.`,
                  'Deep expertise with required languages and production architectures.',
                  'Strong problem-solving, communication, and system design abilities.',
                ],
          location: parsed.location || 'Remote',
          remotePolicy: parsed.remotePolicy || 'Remote',
          salaryRange: parsed.salaryRange || { min: 120000, max: 175000, currency: 'USD' },
        };
      } catch (err) {
        console.warn('[JobService] Gemini extraction failed or rate limited, falling back to heuristic parser:', err);
      }
    }

    // 2. Deterministic Heuristic Extraction Fallback (Ensures zero downtime/failure)
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] || 'Software Engineer';

    let titleMatch = firstLine.replace(/^(Job Title|Position|Role):\s*/i, '');
    const titleRegexMatch = firstLine.match(
      /(?:we need|need|hire|hiring|looking for|create)\s+(?:a|an)?\s*([A-Za-z0-9\s\-/]+?)(?:\s+to|\s+with|\s+for|\.|\n|$)/i
    );
    if (titleRegexMatch && titleRegexMatch[1] && titleRegexMatch[1].trim().length > 3) {
      titleMatch = titleRegexMatch[1].trim();
    }

    // Extract experience years
    let minExperienceYears = 3;
    let experience = '3+ years';
    const expMatch = content.match(/(\d+)\s*(?:\+|-|to|\s*-\s*(\d+))?\s*years?(?:\s+of)?(?:\s+experience)?/i);
    if (expMatch && expMatch[1]) {
      minExperienceYears = parseInt(expMatch[1], 10);
      experience = `${minExperienceYears}+ years`;
    } else if (/senior|sr\./i.test(content)) {
      minExperienceYears = 5;
      experience = '5+ years';
    } else if (/lead|staff|principal/i.test(content)) {
      minExperienceYears = 7;
      experience = '7+ years';
    } else if (/junior|intern|entry/i.test(content)) {
      minExperienceYears = 1;
      experience = '1+ years';
    }

    let seniority = 'Mid';
    if (minExperienceYears >= 7 || /lead|principal|staff|architect/i.test(content)) seniority = 'Lead';
    else if (minExperienceYears >= 5 || /senior|sr\./i.test(content)) seniority = 'Senior';
    else if (minExperienceYears <= 2 || /junior|intern|associate/i.test(content)) seniority = 'Junior';

    const detectedSkills: string[] = [];
    const techCatalog = [
      'React', 'TypeScript', 'JavaScript', 'Node.js', 'Express', 'Python', 'PyTorch', 'RAG', 'LLM',
      'LangChain', 'FastAPI', 'Go', 'Docker', 'Kubernetes', 'MongoDB', 'PostgreSQL', 'Redis',
      'AWS', 'GraphQL', 'Next.js', 'Tailwind', 'Vue', 'Angular', 'Java', 'C#'
    ];
    for (const tech of techCatalog) {
      const regex = new RegExp(`\\b${tech.replace('.', '\\.')}\\b`, 'i');
      if (regex.test(content)) {
        detectedSkills.push(tech);
      }
    }

    const mustHave = detectedSkills.slice(0, 4);
    const niceToHave = detectedSkills.slice(4);

    return {
      title: titleMatch.length > 5 ? titleMatch : 'Senior Software Engineer',
      seniority,
      experience,
      minExperienceYears,
      description: content.length > 1000 ? content.substring(0, 1000) + '...' : content,
      mustHaveSkills: mustHave.length > 0 ? mustHave : ['Python', 'TypeScript', 'Node.js'],
      niceToHaveSkills: niceToHave.length > 0 ? niceToHave : ['Docker', 'AWS', 'PostgreSQL'],
      responsibilities: [
        `Architect and build production features for ${titleMatch}.`,
        'Drive technical decisions, code reviews, and high-quality engineering standards.',
        'Collaborate across cross-functional teams to deliver end-to-end solutions.',
      ],
      qualifications: [
        `${experience} of hands-on professional software engineering experience.`,
        `Demonstrated competency in ${mustHave.join(', ') || 'modern software architecture'}.`,
        'Strong problem solving and collaborative communication skills.',
      ],
      location: /remote/i.test(content) ? 'Remote' : 'Hybrid / Flexible',
      remotePolicy: 'Remote',
      salaryRange: { min: 110000, max: 165000, currency: 'USD' },
    };
  }

  /**
   * Create and persist a confirmed Job
   */
  public static async createJob(input: unknown): Promise<IJob> {
    const validated = CreateJobSchema.parse(input);

    // Prevent rapid accidental double-submissions with identical title within 10 seconds
    const recentDuplicate = await Job.findOne({
      title: validated.title,
      createdAt: { $gte: new Date(Date.now() - 10000) },
    }).exec();
    if (recentDuplicate) {
      return recentDuplicate;
    }

    const job = new Job({
      title: validated.title,
      description: validated.description,
      mustHaveSkills: validated.mustHaveSkills,
      niceToHaveSkills: validated.niceToHaveSkills,
      seniority: validated.seniority,
      experience: validated.experience,
      minExperienceYears: validated.minExperienceYears,
      responsibilities: validated.responsibilities,
      qualifications: validated.qualifications,
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

  public static async updateJob(jobId: string, input: unknown): Promise<IJob> {
    const job = await Job.findById(jobId).exec();
    if (!job) {
      throw new AppError(`Job with ID ${jobId} not found`, 404, 'JOB_NOT_FOUND');
    }

    const validated = CreateJobSchema.partial().parse(input);
    Object.assign(job, validated);
    const updated = await job.save();

    await ActivityService.record({
      jobId: updated._id.toString(),
      actor: 'recruiter',
      action: 'Updated job requirements',
      newValue: { title: updated.title, seniority: updated.seniority },
    });

    return updated;
  }

  public static async deleteJob(jobId: string): Promise<void> {
    const job = await Job.findById(jobId).exec();
    if (!job) {
      throw new AppError(`Job with ID ${jobId} not found`, 404, 'JOB_NOT_FOUND');
    }

    await Job.findByIdAndDelete(jobId).exec();

    await ActivityService.record({
      jobId,
      actor: 'recruiter',
      action: `Deleted job requisition "${job.title}"`,
    });
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

