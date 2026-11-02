import { Router } from 'express';
import { MeetingController } from './meeting.controller';

const router = Router();

router.post('/candidates/:candidateId/book-meeting', MeetingController.book);
router.get('/jobs/:jobId/meetings', MeetingController.getByJobId);

export default router;

