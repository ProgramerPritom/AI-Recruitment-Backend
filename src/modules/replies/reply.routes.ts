import { Router } from 'express';
import { ReplyController } from './reply.controller';

const router = Router();

router.post('/candidates/:candidateId/simulate-reply', ReplyController.simulateReply);
router.post('/replies/:replyId/send', ReplyController.sendResponse);
router.get('/candidates/:candidateId/replies', ReplyController.getByCandidate);

export default router;

