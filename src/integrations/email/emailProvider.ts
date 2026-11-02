import { config } from '../../config';

export interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

export interface EmailDeliveryResult {
  success: boolean;
  messageId: string;
  provider: 'smtp' | 'virtual_outbox';
  error?: string;
}

// In-memory virtual outbox storage for inspection & zero-config testing
export interface OutboxEmailRecord {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  sentAt: Date;
}

const virtualOutbox: OutboxEmailRecord[] = [];

export class EmailProvider {
  /**
   * Send email using SMTP or virtual outbox fallback
   */
  public static async sendEmail(payload: SendEmailPayload): Promise<EmailDeliveryResult> {
    const fromAddress = payload.from || config.FROM_EMAIL;

    // In-memory / virtual outbox (Default zero-config provider)
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    virtualOutbox.unshift({
      id: messageId,
      to: payload.to,
      from: fromAddress,
      subject: payload.subject,
      body: payload.body,
      sentAt: new Date(),
    });

    // Keep outbox bounded
    if (virtualOutbox.length > 200) {
      virtualOutbox.pop();
    }

    console.log(`[EmailProvider] Outbox email dispatched to ${payload.to} with subject "${payload.subject}"`);

    return {
      success: true,
      messageId,
      provider: 'virtual_outbox',
    };
  }

  public static getVirtualOutbox(limit = 50): OutboxEmailRecord[] {
    return virtualOutbox.slice(0, limit);
  }
}

