/**
 * Email Approval Gate for NanoClaw email channel.
 * Handles messages from senders that cannot be mapped to a tier.
 * Creates a pending approval record and notifies the owner via Signal.
 */

import {
  createEmailApproval,
  getEmailApproval,
  getPendingEmailApprovals,
  updateEmailApprovalStatus,
} from './db.js';
import { logger } from './logger.js';

export interface ApprovalGateOpts {
  ownerSignalJid: string;
  sendSignalMessage: (jid: string, text: string) => Promise<void>;
}

export interface ApprovalRequest {
  senderEmail: string;
  threadId: string;
  subject: string;
  inferredIntent: string;
  riskSummary: string;
}

export class EmailApprovalGate {
  private opts: ApprovalGateOpts;

  constructor(opts: ApprovalGateOpts) {
    this.opts = opts;
  }

  /**
   * Create a pending approval and notify the owner via Signal.
   * Returns the approval ID.
   */
  async requestApproval(request: ApprovalRequest): Promise<string> {
    const id = `email_approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    createEmailApproval({
      id,
      sender_email: request.senderEmail,
      thread_id: request.threadId,
      subject: request.subject,
      inferred_intent: request.inferredIntent,
      risk_summary: request.riskSummary,
      status: 'pending',
      created_at: now,
    });

    // Notify owner via Signal
    const message = [
      `📧 Email approval needed`,
      ``,
      `From: ${request.senderEmail}`,
      `Subject: ${request.subject}`,
      `Intent: ${request.inferredIntent}`,
      `Risk: ${request.riskSummary}`,
      ``,
      `Approval ID: ${id}`,
    ].join('\n');

    try {
      await this.opts.sendSignalMessage(this.opts.ownerSignalJid, message);
      logger.info({ id, sender: request.senderEmail }, 'email-approval: sent Signal notification');
    } catch (err) {
      logger.error({ id, err }, 'email-approval: failed to send Signal notification');
    }

    return id;
  }

  /**
   * Approve a pending request.
   */
  approve(id: string): void {
    updateEmailApprovalStatus(id, 'approved', new Date().toISOString());
    logger.info({ id }, 'email-approval: approved');
  }

  /**
   * Deny a pending request.
   */
  deny(id: string): void {
    updateEmailApprovalStatus(id, 'denied', new Date().toISOString());
    logger.info({ id }, 'email-approval: denied');
  }

  /**
   * Check if a sender has any pending approval.
   */
  hasPendingApproval(senderEmail: string): boolean {
    const pending = getPendingEmailApprovals();
    return pending.some((a) => a.sender_email === senderEmail.toLowerCase());
  }
}
