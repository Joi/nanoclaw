/**
 * Email Receipt Generator for NanoClaw email channel.
 * Creates durable markdown receipt artifacts for every email
 * action and intake operation — visible to downstream knowledge workflows.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface EmailReceiptData {
  type: 'intake' | 'action';
  senderEmail: string;
  senderName: string;
  subject: string;
  threadId: string;
  timestamp: string;
  body: string;
  actionSubtype?: string;
  actionResult?: string;
  attachments?: Array<{ filename: string; mimeType: string }>;
}

/**
 * Create a durable receipt artifact as a markdown file.
 * Returns the full path to the created file.
 */
export function createEmailReceipt(
  receiptDir: string,
  data: EmailReceiptData,
): string {
  fs.mkdirSync(receiptDir, { recursive: true });

  const safeTimestamp = data.timestamp.replace(/:/g, '-');
  const safeSender = data.senderEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const filename = `${safeTimestamp}-${safeSender}-${data.type}.md`;
  const filePath = path.join(receiptDir, filename);

  const artifactType = data.type === 'action' ? 'email-action' : 'email-intake';

  const frontmatter = [
    '---',
    `type: ${artifactType}`,
    `source: "email:${data.senderEmail}"`,
    `sender_name: "${data.senderName}"`,
    `subject: "${data.subject.replace(/"/g, "'")}"`,
    `thread_id: "${data.threadId}"`,
    `date: "${data.timestamp}"`,
  ];

  if (data.actionSubtype) {
    frontmatter.push(`action_subtype: "${data.actionSubtype}"`);
  }

  frontmatter.push('---');

  const sections: string[] = [frontmatter.join('\n'), ''];

  if (data.actionResult) {
    sections.push('## Result');
    sections.push('');
    sections.push(data.actionResult);
    sections.push('');
  }

  sections.push('## Original Message');
  sections.push('');
  sections.push(data.body);

  if (data.attachments && data.attachments.length > 0) {
    sections.push('');
    sections.push('## Attachments');
    sections.push('');
    for (const att of data.attachments) {
      sections.push(`- ${att.filename} (${att.mimeType})`);
    }
  }

  const content = sections.join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');

  logger.info(
    { filePath, type: data.type, sender: data.senderEmail },
    'email-receipt: created',
  );

  return filePath;
}
