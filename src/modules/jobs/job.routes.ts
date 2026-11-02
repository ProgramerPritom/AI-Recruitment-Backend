import { Router } from 'express';
import { JobController } from './job.controller';

const router = Router();

router.post('/jobs/extract', JobController.extract);
router.post('/jobs', JobController.create);
router.get('/jobs', JobController.getAll);
router.get('/jobs/:jobId', JobController.getById);

export default router;

