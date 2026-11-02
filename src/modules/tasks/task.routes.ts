import { Router } from 'express';
import { TaskController } from './task.controller';

const router = Router();

router.post('/jobs/:jobId/sourcing', TaskController.startSourcing);
router.post('/jobs/:jobId/scoring', TaskController.startScoring);
router.get('/jobs/:jobId/tasks/active', TaskController.getLatestActive);
router.get('/tasks/:taskId', TaskController.getById);
router.get('/tasks/:taskId/events', TaskController.subscribeEvents);

export default router;

