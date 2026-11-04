import { Request, Response, NextFunction } from 'express';
import { CandidateService } from './candidate.service';
import { UpdateCandidateStatusSchema, BulkReviewCandidatesSchema } from '../../shared/schemas';
import { AppError } from '../../middleware/errorHandler';

export class CandidateController {
  public static async importFile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      if (!req.file || !req.file.buffer) {
        throw new AppError('Please provide a valid CV file (PDF, Word, TXT, or CSV).', 400, 'FILE_REQUIRED');
      }

      const summary = await CandidateService.importCandidateFile(
        jobId,
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      res.status(200).json({
        message: summary.importedCount > 0
          ? `Successfully processed and AI-evaluated ${summary.importedCount} candidate(s).`
          : summary.duplicateCount > 0
          ? 'Candidate already exists in this recruitment workspace.'
          : 'Processed candidate file.',
        data: summary,
      });
    } catch (err) {
      next(err);
    }
  }

  // Alias for backward compatibility
  public static importCsv = CandidateController.importFile;

  public static async parseAndAddCv(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const { rawCvText } = req.body;
      const result = await CandidateService.parseAndAddCv(jobId, rawCvText);
      res.status(200).json({
        message: `Successfully parsed CV for "${result.candidate.name}", extracted skills, and scored match (${result.score}%)`,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getByJobId(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const { status, minScore } = req.query;

      const candidates = await CandidateService.getCandidates(jobId, {
        status: status as string,
        minScore: minScore ? parseInt(minScore as string, 10) : undefined,
      });

      res.status(200).json({ data: candidates });
    } catch (err) {
      next(err);
    }
  }

  public static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const candidateId = req.params.candidateId as string;
      const validated = UpdateCandidateStatusSchema.parse(req.body);

      const updated = await CandidateService.updateStatus(
        candidateId,
        validated.status as any,
        validated.actor,
        validated.metadata
      );

      res.status(200).json({
        message: `Candidate status updated to ${validated.status}`,
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async bulkReview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const jobId = req.params.jobId as string;
      const validated = BulkReviewCandidatesSchema.parse(req.body);

      const result = await CandidateService.bulkReview(
        jobId,
        validated.candidateIds,
        validated.decision,
        validated.actor
      );

      res.status(200).json({
        message: `Successfully updated ${result.updatedCount} candidates`,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
}
