import { Router } from 'express';
import { MeetingController } from './meeting.controller';

const router = Router();

router.post('/candidates/:candidateId/book-meeting', MeetingController.book);
router.get('/jobs/:jobId/meetings', MeetingController.getByJobId);
router.post('/meetings/:meetingId/send-invitation', MeetingController.sendInvitation);

export default router;
