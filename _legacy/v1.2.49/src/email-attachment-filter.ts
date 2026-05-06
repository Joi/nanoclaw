/**
 * Email Attachment Type Filter for NanoClaw email channel.
 * Filters attachments to safe types only.
 */

// Safe MIME types (v1)
const SAFE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/plain',
  'text/markdown',
  'text/csv',
]);

// Safe file extensions (used as fallback when MIME is generic)
const SAFE_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.heic',
  '.docx', '.xlsx', '.txt', '.md', '.csv',
]);

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Check if an attachment is a safe type.
 * Uses MIME type first, falls back to extension for generic MIME types.
 */
export function isSafeAttachment(filename: string, mimeType: string): boolean {
  if (SAFE_MIME_TYPES.has(mimeType)) return true;

  // Fallback: if MIME is generic (octet-stream), check extension
  if (mimeType === 'application/octet-stream') {
    return SAFE_EXTENSIONS.has(getExtension(filename));
  }

  return false;
}

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Partition attachments into safe and rejected lists.
 */
export function filterAttachments(attachments: AttachmentInput[]): {
  safe: AttachmentInput[];
  rejected: AttachmentInput[];
} {
  const safe: AttachmentInput[] = [];
  const rejected: AttachmentInput[] = [];

  for (const att of attachments) {
    if (isSafeAttachment(att.filename, att.mimeType)) {
      safe.push(att);
    } else {
      rejected.push(att);
    }
  }

  return { safe, rejected };
}
