import { config } from '../../config';
import nodemailer, { Transporter } from 'nodemailer';

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
let smtpTransporter: Transporter | undefined;

export class EmailProvider {
  /**
   * Send email using SMTP or virtual outbox fallback
   */
  public static async sendEmail(payload: SendEmailPayload): Promise<EmailDeliveryResult> {
    const fromAddress = payload.from || config.FROM_EMAIL;

    if (config.EMAIL_PROVIDER === 'smtp') {
      if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
        throw new Error('SMTP email is enabled, but SMTP_HOST, SMTP_USER, or SMTP_PASS is missing.');
      }

      smtpTransporter ??= nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: {
          user: config.SMTP_USER,
          pass: config.SMTP_PASS,
        },
      });

      const result = await smtpTransporter.sendMail({
        from: fromAddress,
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      });

      return {
        success: true,
        messageId: result.messageId,
        provider: 'smtp',
      };
    }

    // In-memory / virtual outbox for safe local testing.
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
