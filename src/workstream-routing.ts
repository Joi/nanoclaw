/**
 * Workstream Routing — parse #ws:{slug} tags from email subjects
 * and resolve the correct intake directory.
 *
 * If the subject contains #ws:sankosh, the receipt goes to
 * confidential/sankosh/intake/ instead of email-receipts/.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const WS_TAG_RE = /#ws:([a-z0-9_-]+)/i;

/**
 * Extract the workstream slug from a subject line.
 * Returns null if no #ws: tag is found.
 */
export function extractWorkstreamSlug(subject: string): string | null {
  const match = WS_TAG_RE.exec(subject);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolve the receipt directory for an email based on its subject.
 *
 * If the subject contains a valid #ws:{slug} tag AND the directory
 * `confidentialRoot/{slug}/intake/` exists (or its parent `{slug}/` exists),
 * returns that intake path. Otherwise falls back to `email-receipts/`.
 */
export function resolveReceiptDir(
  confidentialRoot: string,
  subject: string,
): string {
  const slug = extractWorkstreamSlug(subject);

  if (slug) {
    const intakeDir = path.join(confidentialRoot, slug, 'intake');
    const wsDir = path.join(confidentialRoot, slug);

    if (fs.existsSync(intakeDir)) {
      logger.info({ slug, dir: intakeDir }, 'workstream-routing: routed to intake');
      return intakeDir;
    }

    if (fs.existsSync(wsDir)) {
      // Workstream dir exists but no intake/ subfolder — create it
      fs.mkdirSync(intakeDir, { recursive: true });
      logger.info({ slug, dir: intakeDir }, 'workstream-routing: created intake dir');
      return intakeDir;
    }

    logger.warn({ slug }, 'workstream-routing: unknown slug, falling back to email-receipts');
  }

  return path.join(confidentialRoot, 'email-receipts');
}
