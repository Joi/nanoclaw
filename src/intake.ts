import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const CONFIDENTIAL_ROOT = '/data/confidential';

export interface IntakeAttachment {
  filename: string;
  path: string;
}

export interface IntakeMessage {
  author: string;
  source: string;
  workstream: string;
  text?: string;
  date: string;
  attachments?: IntakeAttachment[];
}

/**
 * Write an intake markdown file for an inbound Slack message.
 * Creates the intake directory if needed, writes YAML frontmatter + body,
 * and returns the written file path.
 */
export function writeIntakeFile(msg: IntakeMessage): string {
  // (1) Build intakeDir and create it
  const intakeDir = path.join(CONFIDENTIAL_ROOT, msg.workstream, 'intake');
  fs.mkdirSync(intakeDir, { recursive: true });

  // (2) Build safe filename: replace ':' with '-' in date, lowercase author
  //     replacing non-alphanumeric chars with '-'
  const safeTimestamp = msg.date.replace(/:/g, '-');
  const safeAuthor = msg.author.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const filename = `${safeTimestamp}-${safeAuthor}.md`;
  const filePath = path.join(intakeDir, filename);

  // (3) Generate briefTopic from first ~60 chars of text or 'attachment upload'
  const briefTopic = msg.text ? msg.text.substring(0, 60) : 'attachment upload';

  // (4) Build YAML frontmatter
  const frontmatter = [
    '---',
    'type: slack-intake',
    `source: "${msg.source}"`,
    `author: "${msg.author}"`,
    `date: "${msg.date}"`,
    'classification: confidential',
    `workstream: "${msg.workstream}"`,
    `description: ${briefTopic}`,
    '---',
  ].join('\n');

  // (5) Build body: text + optional '## Attachments' section
  let body = msg.text ?? '';

  if (msg.attachments && msg.attachments.length > 0) {
    body += '\n\n## Attachments\n';
    for (const attachment of msg.attachments) {
      body += `\n- [${attachment.filename}](${attachment.path})`;
    }
  }

  const content = `${frontmatter}\n\n${body}`;

  // (6) Write file with utf-8
  fs.writeFileSync(filePath, content, 'utf-8');

  // (7) Log with logger.info
  logger.info(
    { filePath, author: msg.author, workstream: msg.workstream },
    'Wrote intake file',
  );

  // (8) Return filePath
  return filePath;
}
