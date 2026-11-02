import { Router } from 'express';
import { CampaignController } from './campaign.controller';

const router = Router();

router.post('/jobs/:jobId/campaigns', CampaignController.createDraft);
router.get('/jobs/:jobId/campaigns', CampaignController.getByJobId);
router.get('/campaigns/:campaignId', CampaignController.getById);
router.patch('/campaigns/:campaignId', CampaignController.updateDraft);
router.post('/campaigns/:campaignId/approve', CampaignController.approve);
router.post('/campaigns/:campaignId/send', CampaignController.send);
router.get('/campaigns/:campaignId/deliveries', CampaignController.getDeliveries);
router.get('/email/outbox', CampaignController.getOutbox);

export default router;

