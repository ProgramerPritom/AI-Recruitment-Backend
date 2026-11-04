import { Router } from 'express';
import multer from 'multer';
import { CandidateController } from './candidate.controller';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max CSV size
});

const router = Router();

router.post('/jobs/:jobId/candidates/import', upload.single('file'), CandidateController.importCsv);
router.post('/jobs/:jobId/candidates/parse-cv', CandidateController.parseAndAddCv);
router.get('/jobs/:jobId/candidates', CandidateController.getByJobId);
router.patch('/candidates/:candidateId/status', CandidateController.updateStatus);
router.post('/jobs/:jobId/candidates/bulk-review', CandidateController.bulkReview);

export default router;

