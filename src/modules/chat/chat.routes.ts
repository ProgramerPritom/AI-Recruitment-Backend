import { Router } from 'express';
import { ChatController } from './chat.controller';

const router = Router();

router.post('/chat/message', ChatController.sendMessage);
router.get('/chat/history/:sessionId', ChatController.getHistory);
router.delete('/chat/history/:sessionId', ChatController.clearHistory);

export default router;

