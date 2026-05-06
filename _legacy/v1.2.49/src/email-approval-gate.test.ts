import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getEmailApproval } from './db.js';
import { EmailApprovalGate } from './email-approval-gate.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let signalMessages: Array<{ jid: string; text: string }>;

beforeEach(() => {
  _initTestDatabase();
  signalMessages = [];
});

function mockSendSignal(jid: string, text: string): Promise<void> {
  signalMessages.push({ jid, text });
  return Promise.resolve();
}

describe('EmailApprovalGate', () => {
  it('creates a pending approval and sends Signal notification', async () => {
    const gate = new EmailApprovalGate({
      ownerSignalJid: 'sig:+819048411965',
      sendSignalMessage: mockSendSignal,
    });

    const approvalId = await gate.requestApproval({
      senderEmail: 'stranger@external.com',
      threadId: 'thread_xyz',
      subject: 'Can you help?',
      inferredIntent: 'action',
      riskSummary: 'Unknown sender requesting action execution',
    });

    expect(approvalId).toBeDefined();

    // Signal message was sent to owner
    expect(signalMessages).toHaveLength(1);
    expect(signalMessages[0].jid).toBe('sig:+819048411965');
    expect(signalMessages[0].text).toContain('stranger@external.com');
    expect(signalMessages[0].text).toContain('Can you help?');

    // Approval record exists in DB
    const approval = getEmailApproval(approvalId);
    expect(approval).toBeDefined();
    expect(approval!.status).toBe('pending');
  });

  it('resolves approval as approved', async () => {
    const gate = new EmailApprovalGate({
      ownerSignalJid: 'sig:+819048411965',
      sendSignalMessage: mockSendSignal,
    });

    const id = await gate.requestApproval({
      senderEmail: 'someone@outside.com',
      threadId: 'thread_1',
      subject: 'Question',
      inferredIntent: 'intake',
      riskSummary: 'Unknown sender',
    });

    gate.approve(id);

    const approval = getEmailApproval(id);
    expect(approval!.status).toBe('approved');
    expect(approval!.resolved_at).toBeDefined();
  });

  it('resolves approval as denied', async () => {
    const gate = new EmailApprovalGate({
      ownerSignalJid: 'sig:+819048411965',
      sendSignalMessage: mockSendSignal,
    });

    const id = await gate.requestApproval({
      senderEmail: 'spammer@bad.com',
      threadId: 'thread_2',
      subject: 'Buy now!',
      inferredIntent: 'action',
      riskSummary: 'Suspicious sender',
    });

    gate.deny(id);

    const approval = getEmailApproval(id);
    expect(approval!.status).toBe('denied');
  });

  it('checks if a sender has a pending approval', async () => {
    const gate = new EmailApprovalGate({
      ownerSignalJid: 'sig:+819048411965',
      sendSignalMessage: mockSendSignal,
    });

    await gate.requestApproval({
      senderEmail: 'pending@external.com',
      threadId: 'thread_3',
      subject: 'Test',
      inferredIntent: 'action',
      riskSummary: 'Unknown',
    });

    expect(gate.hasPendingApproval('pending@external.com')).toBe(true);
    expect(gate.hasPendingApproval('other@external.com')).toBe(false);
  });
});
