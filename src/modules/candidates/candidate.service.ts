import { Readable } from 'stream';
import csv from 'csv-parser';
import mongoosePackage from 'mongoose';
import { Candidate, ICandidate } from './candidate.model';
import { Job, IJob } from '../jobs/job.model';
import { ScoringEngine } from './scoringEngine';
import { CandidateStatus, CandidateStateMachine } from '../../shared/stateMachine';
import { AppError } from '../../middleware/errorHandler';
import { ActivityService } from '../activity/activity.service';

export interface CsvImportSummary {
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  failedRows: Array<{ row: number; error: string }>;
  candidates: ICandidate[];
}

export class CandidateService {
  /**
   * Normalize email for reliable deduplication
   */
  public static normalizeEmail(email?: string): string {
    if (!email) return '';
    return email.trim().toLowerCase();
  }

  /**
   * Normalize LinkedIn or profile URL to canonical form
   */
  public static normalizeProfileUrl(url?: string): string {
    if (!url) return '';
    try {
      let cleaned = url.trim().toLowerCase();
      // Remove protocol and www
      cleaned = cleaned.replace(/^https?:\/\/(www\.)?/, '');
      // Remove query parameters and hash
      cleaned = cleaned.split('?')[0].split('#')[0];
      // Remove trailing slash
      if (cleaned.endsWith('/')) {
        cleaned = cleaned.slice(0, -1);
      }
      return cleaned;
    } catch {
      return url.trim().toLowerCase();
    }
  }

  /**
   * Intelligently parses raw CV / Resume text using AI extraction rules
   */
  public static extractCandidateFromText(rawText: string): {
    name: string;
    email?: string;
    profileUrl?: string;
    skills: string[];
    experienceSummary: string;
  } {
    const text = rawText.trim();

    // 1. Extract Email
    const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0].toLowerCase() : undefined;

    // 2. Extract LinkedIn URL
    const urlMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9-_]+/i);
    let profileUrl = urlMatch ? urlMatch[0] : undefined;

    // 3. Extract Name
    let name = '';
    const nameLineMatch = text.match(/^(?:Name|Full Name|Candidate Name|Candidate):\s*([^\n\r,]+)/im);
    if (nameLineMatch && nameLineMatch[1] && nameLineMatch[1].trim().length > 2) {
      name = nameLineMatch[1].trim();
    } else {
      // Look at first non-empty line
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines.slice(0, 3)) {
        if (
          line.length >= 3 &&
          line.length <= 40 &&
          !line.includes('@') &&
          !line.includes('http') &&
          !/^(resume|cv|curriculum|profile|experience|skills|contact|about)/i.test(line)
        ) {
          name = line.replace(/^(?:cv\s+of|resume\s+of)\s+/i, '').trim();
          break;
        }
      }

      if (!name && email) {
        const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
        name = namePart.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
      }
    }

    if (!name) name = 'Applicant Candidate';

    if (!profileUrl) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
      profileUrl = `https://linkedin.com/in/${slug || 'candidate'}`;
    }

    // 4. Extract Skills
    const techCatalog = [
      'React', 'Node.js', 'TypeScript', 'JavaScript', 'MongoDB', 'Express', 'Python', 'PyTorch',
      'FastAPI', 'Go', 'Docker', 'Kubernetes', 'AWS', 'PostgreSQL', 'Redis', 'GraphQL', 'Next.js',
      'Tailwind', 'MERN Stack', 'MERN', 'Vue', 'Angular', 'Java', 'C#', 'SQL', 'LangChain', 'RAG',
      'LLM', 'LLMs', 'CI/CD', 'Git', 'Linux', 'Microservices', 'REST', 'RESTful'
    ];

    const detectedSkills: string[] = [];
    for (const tech of techCatalog) {
      const regex = new RegExp(`\\b${tech.replace('.', '\\.')}\\b`, 'i');
      if (regex.test(text)) {
        const canonical = tech === 'MERN' ? 'MERN Stack' : tech;
        if (!detectedSkills.includes(canonical)) {
          detectedSkills.push(canonical);
        }
      }
    }

    // Also check for explicit "Skills: ..." line
    const skillsLineMatch = text.match(/(?:skills|technologies|tech stack):\s*([^\n\r]+)/i);
    if (skillsLineMatch && skillsLineMatch[1]) {
      const explicitSkills = skillsLineMatch[1].split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
      for (const es of explicitSkills) {
        if (!detectedSkills.some((ds) => ds.toLowerCase() === es.toLowerCase()) && es.length < 25) {
          detectedSkills.push(es);
        }
      }
    }

    // 5. Extract Experience
    let expYears = 3;
    const expMatch = text.match(/(\d+)\s*(?:\+|-|to|\s*-\s*(\d+))?\s*years?(?:\s+of)?(?:\s+experience)?/i);
    if (expMatch && expMatch[1]) {
      expYears = parseInt(expMatch[1], 10);
    }

    let experienceSummary = text.substring(0, 350).replace(/\s+/g, ' ').trim();
    const summaryMatch = text.match(/(?:summary|about|experience|overview|bio):\s*([^\n\r]+(?:\n[^\n\r]+){0,2})/i);
    if (summaryMatch && summaryMatch[1]) {
      experienceSummary = summaryMatch[1].replace(/\s+/g, ' ').trim();
    }

    return {
      name,
      email,
      profileUrl,
      skills: detectedSkills.length > 0 ? detectedSkills : ['Software Engineering', 'Full Stack Development'],
      experienceSummary: experienceSummary || `${expYears}+ years of hands-on technical development experience.`,
    };
  }

  /**
   * Parse an applicant's raw CV/Resume text using AI, extract structured fields,
   * score against the job, and persist into MongoDB.
   */
  public static async parseAndAddCv(jobId: string, rawCvText: string): Promise<any> {
    if (!rawCvText || rawCvText.trim().length < 15) {
      throw new AppError('Candidate CV text must be at least 15 characters long.', 400, 'INVALID_CV_TEXT');
    }

    const targetJob = await Job.findById(jobId).exec();
    if (!targetJob) {
      throw new AppError('Target job not found for candidate import', 404, 'JOB_NOT_FOUND');
    }

    // 1. Extract candidate attributes from CV text
    const extracted = this.extractCandidateFromText(rawCvText);

    const jobObjectId = new mongoosePackage.Types.ObjectId(jobId);
    const normalizedEmail = this.normalizeEmail(extracted.email);
    const normalizedProfileUrl = this.normalizeProfileUrl(extracted.profileUrl);

    // 2. Check for duplicate
    const duplicateConditions: any[] = [];
    if (normalizedEmail) duplicateConditions.push({ jobId: jobObjectId, normalizedEmail });
    if (normalizedProfileUrl) duplicateConditions.push({ jobId: jobObjectId, normalizedProfileUrl });

    let candidate: ICandidate | null = null;
    let isExisting = false;

    if (duplicateConditions.length > 0) {
      const exists = await Candidate.findOne({ $or: duplicateConditions }).exec();
      if (exists) {
        candidate = exists;
        isExisting = true;
      }
    }

    if (!candidate) {
      candidate = new Candidate({
        jobId: jobObjectId,
        name: extracted.name,
        email: extracted.email,
        normalizedEmail,
        profileUrl: extracted.profileUrl,
        normalizedProfileUrl,
        source: 'csv',
        skills: extracted.skills,
        experienceSummary: extracted.experienceSummary,
        status: 'sourced',
      });
      await candidate.save();
    }

    // 3. Score against target job using AI ScoringEngine
    const { score, reason } = await ScoringEngine.scoreCandidate(targetJob, candidate);
    candidate.score = score;
    candidate.scoreReason = reason;
    await candidate.save();

    // 4. Record audit activity
    await ActivityService.record({
      jobId,
      actor: 'recruiter',
      action: `Parsed and AI-evaluated CV for ${candidate.name} (Match Score: ${score}%)`,
      newValue: { candidateId: candidate._id, score, isExisting },
    });

    return {
      candidate,
      isDuplicate: isExisting,
      score,
      scoreReason: reason,
    };
  }

  /**
   * Universal CV & Candidate document importer:
   * Supports PDF (.pdf), Word (.docx, .doc), Plain Text (.txt), and bulk applicant sheets (.csv).
   */
  public static async importCandidateFile(
    jobId: string,
    fileBuffer: Buffer,
    filename: string = '',
    mimetype: string = ''
  ): Promise<CsvImportSummary> {
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    // 1. PDF Document (.pdf)
    if (ext === 'pdf' || mimetype === 'application/pdf') {
      try {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: fileBuffer });
        const textResult = await parser.getText();
        let extractedText = '';
        if (typeof textResult === 'string') {
          extractedText = textResult;
        } else if (textResult && typeof textResult.text === 'string') {
          extractedText = textResult.text;
        } else if (textResult && textResult.pages) {
          extractedText = textResult.pages.map((p: any) => p.text || '').join('\n');
        }

        if (extractedText && extractedText.trim().length > 15) {
          const cvResult = await this.parseAndAddCv(jobId, extractedText);
          return {
            importedCount: cvResult.isDuplicate ? 0 : 1,
            duplicateCount: cvResult.isDuplicate ? 1 : 0,
            failedCount: 0,
            failedRows: [],
            candidates: cvResult.isDuplicate ? [] : [cvResult.candidate],
          };
        }
      } catch (pdfErr: any) {
        console.warn(`[CandidateService] PDF extraction failed: ${pdfErr.message}`);
      }
    }

    // 2. Word Document (.docx, .doc)
    if (ext === 'docx' || ext === 'doc' || mimetype.includes('word') || mimetype.includes('officedocument')) {
      try {
        const mammoth = require('mammoth');
        const res = await mammoth.extractRawText({ buffer: fileBuffer });
        const docxText = res.value || '';
        if (docxText && docxText.trim().length > 15) {
          const cvResult = await this.parseAndAddCv(jobId, docxText);
          return {
            importedCount: cvResult.isDuplicate ? 0 : 1,
            duplicateCount: cvResult.isDuplicate ? 1 : 0,
            failedCount: 0,
            failedRows: [],
            candidates: cvResult.isDuplicate ? [] : [cvResult.candidate],
          };
        }
      } catch (wordErr: any) {
        console.warn(`[CandidateService] Word extraction failed: ${wordErr.message}`);
      }
    }

    // 3. Fallback: CSV or TXT
    return this.importFromCsv(jobId, fileBuffer);
  }

  /**
   * Parse CSV stream, validate rows, deduplicate, persist, and automatically run AI scoring
   */
  public static async importFromCsv(jobId: string, fileBuffer: Buffer): Promise<CsvImportSummary> {
    const targetJob = await Job.findById(jobId).exec();
    const jobObjectId = new mongoosePackage.Types.ObjectId(jobId);

    const rawBufferStr = fileBuffer.toString('utf-8').trim();
    const firstLine = rawBufferStr.split(/\r?\n/)[0] || '';
    const hasCsvComma = firstLine.includes(',');

    // If file looks like a single applicant CV/resume document (not a CSV table)
    if (!hasCsvComma && rawBufferStr.length > 20 && (
      /(?:email|skills|experience|summary|curriculum|education|projects|objective)/i.test(rawBufferStr)
    )) {
      try {
        const cvResult = await this.parseAndAddCv(jobId, rawBufferStr);
        return {
          importedCount: cvResult.isDuplicate ? 0 : 1,
          duplicateCount: cvResult.isDuplicate ? 1 : 0,
          failedCount: 0,
          failedRows: [],
          candidates: cvResult.isDuplicate ? [] : [cvResult.candidate],
        };
      } catch (err: any) {
        // If single CV parsing fails, fall back to CSV parser below
      }
    }

    const stream = Readable.from(fileBuffer);

    const rows: any[] = [];
    await new Promise<void>((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });

    // If CSV parsed 0 rows but buffer has content, try single CV parse
    if (rows.length === 0 && rawBufferStr.length > 20) {
      try {
        const cvResult = await this.parseAndAddCv(jobId, rawBufferStr);
        return {
          importedCount: cvResult.isDuplicate ? 0 : 1,
          duplicateCount: cvResult.isDuplicate ? 1 : 0,
          failedCount: 0,
          failedRows: [],
          candidates: cvResult.isDuplicate ? [] : [cvResult.candidate],
        };
      } catch (err: any) {
        return {
          importedCount: 0,
          duplicateCount: 0,
          failedCount: 1,
          failedRows: [{ row: 1, error: err.message || 'Failed to parse candidate details.' }],
          candidates: [],
        };
      }
    }

    let importedCount = 0;
    let duplicateCount = 0;
    const failedRows: Array<{ row: number; error: string }> = [];
    const createdCandidates: ICandidate[] = [];

    let rowIndex = 1;
    for (const rawRow of rows) {
      rowIndex++;
      // Flexible column key matching
      let name = rawRow.name || rawRow.Name || rawRow['Full Name'] || rawRow['Candidate Name'];
      let email = rawRow.email || rawRow.Email || rawRow['Email Address'];
      let profileUrl = rawRow.profileUrl || rawRow.profile_url || rawRow.linkedin || rawRow.LinkedIn || rawRow['Profile URL'];
      let skillsStr = rawRow.skills || rawRow.Skills || '';
      let experienceSummary = rawRow.experience || rawRow.Experience || rawRow.summary || rawRow.Summary || '';

      // If key columns are missing, extract with AI extraction rules from the raw row values
      if (!name || name.trim().length === 0) {
        const fullRowText = Object.values(rawRow).join('\n');
        const aiExtracted = this.extractCandidateFromText(fullRowText);
        name = aiExtracted.name;
        if (!email) email = aiExtracted.email;
        if (!profileUrl) profileUrl = aiExtracted.profileUrl;
        if (!skillsStr && aiExtracted.skills.length > 0) skillsStr = aiExtracted.skills.join(', ');
        if (!experienceSummary) experienceSummary = aiExtracted.experienceSummary;
      }

      if (!name || name.trim().length === 0) {
        failedRows.push({ row: rowIndex, error: 'Candidate name could not be parsed.' });
        continue;
      }

      const normalizedEmail = this.normalizeEmail(email);
      const normalizedProfileUrl = this.normalizeProfileUrl(profileUrl);

      // Check if duplicate already exists for this job
      const duplicateConditions: any[] = [];
      if (normalizedEmail) {
        duplicateConditions.push({ jobId: jobObjectId, normalizedEmail });
      }
      if (normalizedProfileUrl) {
        duplicateConditions.push({ jobId: jobObjectId, normalizedProfileUrl });
      }

      if (duplicateConditions.length > 0) {
        const existing = await Candidate.findOne({ $or: duplicateConditions }).exec();
        if (existing) {
          duplicateCount++;
          continue;
        }
      }

      // Parse skills
      const skills = typeof skillsStr === 'string'
        ? skillsStr.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
        : [];

      try {
        const candidate = new Candidate({
          jobId: jobObjectId,
          name: name.trim(),
          email: email ? email.trim() : undefined,
          normalizedEmail: normalizedEmail || undefined,
          profileUrl: profileUrl ? profileUrl.trim() : undefined,
          normalizedProfileUrl: normalizedProfileUrl || undefined,
          source: 'csv',
          skills,
          experienceSummary: experienceSummary ? experienceSummary.trim() : undefined,
          status: 'sourced',
        });

        const saved = await candidate.save();

        // Immediately execute AI scoring against the target job
        if (targetJob) {
          try {
            const { score, reason } = await ScoringEngine.scoreCandidate(targetJob, saved);
            saved.score = score;
            saved.scoreReason = reason;
            await saved.save();
          } catch (scErr: any) {
            console.warn(`[CandidateService] Scoring failed for candidate ${saved._id}: ${scErr.message}`);
          }
        }

        createdCandidates.push(saved);
        importedCount++;
      } catch (err: any) {
        if (err.code === 11000) {
          duplicateCount++;
        } else {
          failedRows.push({ row: rowIndex, error: err.message || 'Validation error' });
        }
      }
    }

    if (importedCount > 0) {
      await ActivityService.record({
        jobId,
        actor: 'recruiter',
        action: `Imported and AI-scored ${importedCount} candidates from CSV`,
        newValue: { importedCount, duplicateCount, failedCount: failedRows.length },
      });
    }

    return {
      importedCount,
      duplicateCount,
      failedCount: failedRows.length,
      failedRows,
      candidates: createdCandidates,
    };
  }

  /**
   * Retrieve candidates for a job with optional status filtering
   */
  public static async getCandidates(
    jobId: string,
    filters?: { status?: string; minScore?: number }
  ): Promise<ICandidate[]> {
    const query: any = { jobId: new mongoosePackage.Types.ObjectId(jobId) };

    if (filters?.status && filters.status !== 'all') {
      query.status = filters.status;
    }
    if (filters?.minScore !== undefined) {
      query.score = { $gte: filters.minScore };
    }

    return Candidate.find(query)
      .sort({ score: -1, createdAt: -1 })
      .exec();
  }

  /**
   * Update candidate status with state-machine validation and audit recording
   */
  public static async updateStatus(
    candidateId: string,
    targetStatus: CandidateStatus,
    actor: 'recruiter' | 'agent' | 'system' = 'recruiter',
    metadata?: Record<string, any>
  ): Promise<ICandidate> {
    const candidate = await Candidate.findById(candidateId).exec();
    if (!candidate) {
      throw new AppError(`Candidate with ID ${candidateId} not found`, 404, 'CANDIDATE_NOT_FOUND');
    }

    const previousStatus = candidate.status;
    CandidateStateMachine.validateTransition(previousStatus, targetStatus);

    candidate.status = targetStatus;
    const updated = await candidate.save();

    await ActivityService.record({
      jobId: candidate.jobId.toString(),
      candidateId: candidate._id.toString(),
      actor,
      action: `Updated candidate status to ${targetStatus}`,
      previousValue: previousStatus,
      newValue: targetStatus,
      metadata,
    });

    return updated;
  }

  /**
   * Bulk review candidates (Accept or Reject)
   */
  public static async bulkReview(
    jobId: string,
    candidateIds: string[],
    decision: 'accept' | 'reject',
    actor: 'recruiter' | 'agent' = 'recruiter'
  ): Promise<{ updatedCount: number; updatedCandidates: ICandidate[] }> {
    const targetStatus: CandidateStatus = decision === 'accept' ? 'accepted' : 'rejected';
    const updatedCandidates: ICandidate[] = [];

    for (const cid of candidateIds) {
      try {
        const updated = await this.updateStatus(cid, targetStatus, actor);
        updatedCandidates.push(updated);
      } catch (err: any) {
        console.warn(`[BulkReview] Skipping candidate ${cid}: ${err.message}`);
      }
    }

    await ActivityService.record({
      jobId,
      actor,
      action: `Bulk ${decision}ed ${updatedCandidates.length} candidates`,
      newValue: { targetStatus, count: updatedCandidates.length },
    });

    return {
      updatedCount: updatedCandidates.length,
      updatedCandidates,
    };
  }

  /**
   * Permanently delete candidate from MongoDB and record audit trail
   */
  public static async deleteCandidate(
    candidateId: string,
    actor: 'recruiter' | 'agent' | 'system' = 'recruiter'
  ): Promise<{ success: boolean; deletedCandidateId: string; candidateName: string }> {
    const candidate = await Candidate.findById(candidateId).exec();
    if (!candidate) {
      throw new AppError(`Candidate with ID ${candidateId} not found`, 404, 'CANDIDATE_NOT_FOUND');
    }

    const candidateName = candidate.name;
    const jobId = candidate.jobId.toString();

    await Candidate.findByIdAndDelete(candidateId).exec();

    await ActivityService.record({
      jobId,
      actor,
      action: `Permanently removed candidate "${candidateName}" from recruitment workspace`,
      previousValue: { candidateId, name: candidateName, status: candidate.status },
    });

    return {
      success: true,
      deletedCandidateId: candidateId,
      candidateName,
    };
  }

  /**
   * Bulk delete candidates from MongoDB
   */
  public static async bulkDelete(
    jobId: string,
    candidateIds: string[],
    actor: 'recruiter' | 'agent' = 'recruiter'
  ): Promise<{ deletedCount: number }> {
    const jobObjectId = new mongoosePackage.Types.ObjectId(jobId);
    const validObjectIds = candidateIds.map((id) => new mongoosePackage.Types.ObjectId(id));

    const result = await Candidate.deleteMany({
      _id: { $in: validObjectIds },
      jobId: jobObjectId,
    }).exec();

    await ActivityService.record({
      jobId,
      actor,
      action: `Bulk deleted ${result.deletedCount} candidates from recruitment workspace`,
      newValue: { deletedCount: result.deletedCount },
    });

    return {
      deletedCount: result.deletedCount,
    };
  }
}

