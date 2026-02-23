/**
 * Bookmark relay client for NanoClaw.
 * Calls the bookmark-relay HTTP service at localhost:9999 which bridges
 * to the bookmark-extractor sprite for content extraction.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const RELAY_URL = 'http://localhost:9999';
const BOOKMARK_TIMEOUT = 90_000; // 90s — extraction can take 30-60s

export interface BookmarkResult {
  status?: string;
  file_path?: string;
  title?: string;
  classification?: string;
  synced_to_jibrain?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface HealthResult {
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export interface RecentResult {
  recent?: unknown[];
  error?: string;
  [key: string]: unknown;
}

/**
 * Bookmark a URL via the relay service.
 */
export async function bookmarkUrl(
  url: string,
  hint?: string,
): Promise<BookmarkResult> {
  const body: Record<string, string> = { url };
  if (hint) body.hint = hint;

  try {
    const resp = await fetch(`${RELAY_URL}/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BOOKMARK_TIMEOUT),
    });
    return (await resp.json()) as BookmarkResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Bookmark relay error: ${msg}` };
  }
}

/**
 * Check bookmark service health.
 */
export async function getBookmarkHealth(): Promise<HealthResult> {
  try {
    const resp = await fetch(`${RELAY_URL}/relay-health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return (await resp.json()) as HealthResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Bookmark health check failed: ${msg}` };
  }
}

/**
 * Get recent bookmarks from the relay.
 */
export async function getRecentBookmarks(): Promise<RecentResult> {
  try {
    const resp = await fetch(`${RELAY_URL}/recent`, {
      signal: AbortSignal.timeout(10_000),
    });
    return (await resp.json()) as RecentResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to get recent bookmarks: ${msg}` };
  }
}

/**
 * Process a bookmark IPC request file from a container.
 * Reads the request, calls the appropriate relay endpoint,
 * and writes a response file for the container to read.
 */
export async function processBookmarkIpc(
  ipcFilePath: string,
): Promise<void> {
  const raw = fs.readFileSync(ipcFilePath, 'utf-8');
  let request: { operation: string; params?: Record<string, unknown>; responseFile?: string };
  try {
    request = JSON.parse(raw);
  } catch {
    logger.error({ file: ipcFilePath }, 'Invalid JSON in bookmark IPC file');
    return;
  }

  let result: Record<string, unknown>;

  switch (request.operation) {
    case 'bookmark_url': {
      const params = request.params || {};
      result = await bookmarkUrl(
        params.url as string,
        params.hint as string | undefined,
      );
      break;
    }
    case 'bookmark_health':
      result = await getBookmarkHealth();
      break;
    case 'bookmark_recent':
      result = await getRecentBookmarks();
      break;
    default:
      result = { error: `Unknown bookmark operation: ${request.operation}` };
  }

  // Write response file for the container to pick up
  if (request.responseFile) {
    const respDir = path.dirname(ipcFilePath);
    const respPath = path.join(respDir, request.responseFile);
    const tempPath = `${respPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
    fs.renameSync(tempPath, respPath);
  }
}
