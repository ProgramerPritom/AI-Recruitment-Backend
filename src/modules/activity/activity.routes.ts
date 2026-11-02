import { Router } from 'express';
import { ActivityController } from './activity.controller';

const router = Router();

router.get('/jobs/:jobId/activity', ActivityController.getByJobId);

export default router;

