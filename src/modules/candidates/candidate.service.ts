import mongoose from 'express';
import { Readable } from 'stream';
import csv from 'csv-parser';
import mongoosePackage from 'mongoose';
import { Candidate, ICandidate } from './candidate.model';
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
   * Parse CSV stream, validate rows, deduplicate, and persist candidates
   */
  public static async importFromCsv(jobId: string, fileBuffer: Buffer): Promise<CsvImportSummary> {
    const jobObjectId = new mongoosePackage.Types.ObjectId(jobId);
    const stream = Readable.from(fileBuffer);

    const rows: any[] = [];
    await new Promise<void>((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });

    let importedCount = 0;
    let duplicateCount = 0;
    const failedRows: Array<{ row: number; error: string }> = [];
    const createdCandidates: ICandidate[] = [];

    let rowIndex = 1;
    for (const rawRow of rows) {
      rowIndex++;
      // Flexible column key matching
      const name = rawRow.name || rawRow.Name || rawRow['Full Name'] || rawRow['Candidate Name'];
      const email = rawRow.email || rawRow.Email || rawRow['Email Address'];
      const profileUrl = rawRow.profileUrl || rawRow.profile_url || rawRow.linkedin || rawRow.LinkedIn || rawRow['Profile URL'];
      const skillsStr = rawRow.skills || rawRow.Skills || '';
      const experienceSummary = rawRow.experience || rawRow.Experience || rawRow.summary || rawRow.Summary || '';

      if (!name || name.trim().length === 0) {
        failedRows.push({ row: rowIndex, error: 'Candidate name is required.' });
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
        action: `Imported ${importedCount} candidates from CSV`,
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
}

