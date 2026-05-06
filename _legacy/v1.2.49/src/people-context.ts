/**
 * People Context Enrichment for NanoClaw
 * =======================================
 * Looks up sender people pages via QMD before container dispatch,
 * injecting a <people-context> block into the agent prompt.
 *
 * Design:
 *   - Host-side enrichment (before container spawn, not inside)
 *   - Description-first (frontmatter description + tier, not full page)
 *   - Cache with 1-hour TTL per sender name
 *   - Graceful degradation (QMD down → skip silently)
 */

import { escapeXml } from './router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonEntry {
  name: string;
  tier: string;
  content: string;
}

interface CacheEntry {
  entry: PersonEntry | null; // null = not found / error
  timestamp: number;
}

interface QmdSearchResult {
  file: string;
  title: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const QMD_URL = process.env.QMD_PUBLIC_URL || 'http://localhost:7333/mcp';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SCORE_THRESHOLD = 0.7;
const MAX_CONTENT_CHARS = 500;
const QMD_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const senderCache = new Map<string, CacheEntry>();

export function clearSenderCache(): void {
  senderCache.clear();
}

// ---------------------------------------------------------------------------
// QMD MCP HTTP Client
// ---------------------------------------------------------------------------

/**
 * Parse SSE response text to extract the JSON-RPC result.
 * Format: "event: message\ndata: {JSON}\n\n"
 */
function parseSseResponse(text: string): unknown | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.slice(6));
        return parsed?.result ?? null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Call a QMD MCP tool via HTTP.
 */
async function callQmdTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QMD_TIMEOUT_MS);

  try {
    const response = await fetch(QMD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    return parseSseResponse(text);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Search QMD for a person by name. Returns the top result if score >= threshold.
 */
async function queryPerson(
  name: string,
): Promise<QmdSearchResult | null> {
  const result = await callQmdTool('query', {
    searches: [{ type: 'lex', query: `"${name}"` }],
    limit: 1,
    collections: ['jibrain'],
  });

  if (!result) return null;

  const structured = (result as Record<string, unknown>)
    .structuredContent as { results?: QmdSearchResult[] } | undefined;

  const results = structured?.results;
  if (!results || results.length === 0) return null;

  const top = results[0];
  if (top.score < SCORE_THRESHOLD) return null;

  return top;
}

/**
 * Fetch a document from QMD by file path.
 */
async function getPersonPage(filePath: string): Promise<string | null> {
  const result = await callQmdTool('get', {
    file: filePath,
    maxLines: 30,
  });

  if (!result) return null;

  const content = (result as Record<string, unknown>)
    .content as Array<{ type: string; resource?: { text?: string } }> | undefined;

  if (!content || content.length === 0) return null;

  const resource = content[0]?.resource;
  return resource?.text ?? null;
}

// ---------------------------------------------------------------------------
// Frontmatter Parsing
// ---------------------------------------------------------------------------

/**
 * Extract key fields from a people page's YAML frontmatter.
 */
function parsePeoplePage(
  rawContent: string,
  senderName: string,
): PersonEntry | null {
  // Split frontmatter from body
  const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Extract description (YAML string, may be quoted)
  const descMatch = frontmatter.match(
    /^description:\s*"?(.*?)"?\s*$/m,
  );
  const description = descMatch?.[1] ?? '';

  // Extract nanoclaw_tier
  const tierMatch = frontmatter.match(/^nanoclaw_tier:\s*(\S+)/m);
  const tier = tierMatch?.[1] ?? 'unknown';

  // Build content: prefer description, fall back to first paragraph of body
  let content = description;
  if (!content && body) {
    // Take first paragraph (up to first blank line)
    const firstPara = body.split(/\n\n/)[0] ?? '';
    content = firstPara;
  }

  // Clip to budget
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS).replace(/\s+\S*$/, '…');
  }

  if (!content) return null;

  return { name: senderName, tier, content };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up people pages for the given sender names and return a
 * <people-context> XML block to prepend to the agent prompt.
 *
 * Returns empty string if no senders are found or QMD is unreachable.
 */
export async function buildSenderContext(
  senderNames: string[],
): Promise<string> {
  if (senderNames.length === 0) return '';

  const now = Date.now();
  const entries: PersonEntry[] = [];

  // Deduplicate
  const unique = [...new Set(senderNames)];

  for (const name of unique) {
    // Check cache
    const cached = senderCache.get(name);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      if (cached.entry) entries.push(cached.entry);
      continue;
    }

    // Query QMD
    const searchResult = await queryPerson(name);
    if (!searchResult) {
      senderCache.set(name, { entry: null, timestamp: now });
      continue;
    }

    // Fetch page content
    const pageContent = await getPersonPage(searchResult.file);
    if (!pageContent) {
      senderCache.set(name, { entry: null, timestamp: now });
      continue;
    }

    // Parse people page
    const entry = parsePeoplePage(pageContent, name);
    senderCache.set(name, { entry, timestamp: now });
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) return '';

  // Format XML
  const personBlocks = entries
    .map(
      (e) =>
        `<person name="${escapeXml(e.name)}" tier="${escapeXml(e.tier)}">\n${escapeXml(e.content)}\n</person>`,
    )
    .join('\n');

  return `<people-context>\n${personBlocks}\n</people-context>`;
}
