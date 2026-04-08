import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildSenderContext,
  clearSenderCache,
  type PersonEntry,
} from './people-context.js';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a QMD query SSE response with search results */
function qmdQueryResponse(results: Array<{ file: string; title: string; score: number }>) {
  const json = JSON.stringify({
    result: {
      content: [{ type: 'text', text: `Found ${results.length} results` }],
      structuredContent: { results },
    },
    jsonrpc: '2.0',
    id: 1,
  });
  return new Response(`event: message\ndata: ${json}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Build a QMD get SSE response with document content */
function qmdGetResponse(content: string) {
  const json = JSON.stringify({
    result: {
      content: [{ type: 'resource', resource: { uri: 'qmd://test', mimeType: 'text/markdown', text: content } }],
    },
    jsonrpc: '2.0',
    id: 1,
  });
  return new Response(`event: message\ndata: ${json}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A sample people page with frontmatter and body */
const MADARS_PAGE = `---
type: person
name: Madars Virza
description: "Cryptographer; Chief Scientist at Radius; MIT PhD under Ron Rivest (zero-knowledge proofs)."
nanoclaw_tier: admin
organizations:
- Radius Technology Systems
- MIT Media Lab
tags:
- crypto
---

Madars Virza is a Latvian cryptographer and the Chief Scientist at Radius Technology Systems.
He completed his PhD at MIT under Ron Rivest, specializing in zero-knowledge proofs.
Active in the Wikipedia Editing Workshop group.`;

const UNKNOWN_PERSON_NO_RESULTS = {
  results: [] as Array<{ file: string; title: string; score: number }>,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearSenderCache();
  mockFetch.mockReset();
});

describe('buildSenderContext', () => {
  it('returns empty string for empty sender list', async () => {
    const result = await buildSenderContext([]);
    expect(result).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns XML people-context for a known sender', async () => {
    // First call: QMD query
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    // Second call: QMD get
    mockFetch.mockResolvedValueOnce(qmdGetResponse(MADARS_PAGE));

    const result = await buildSenderContext(['Madars Virza']);

    expect(result).toContain('<people-context>');
    expect(result).toContain('</people-context>');
    expect(result).toContain('name="Madars Virza"');
    expect(result).toContain('tier="admin"');
    expect(result).toContain('Cryptographer');
    expect(result).toContain('Radius');
  });

  it('returns empty string when QMD returns no matches', async () => {
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([]),
    );

    const result = await buildSenderContext(['Unknown Person']);
    expect(result).toBe('');
  });

  it('skips senders below score threshold (0.7)', async () => {
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/someone.md', title: 'Someone', score: 0.5 }]),
    );

    const result = await buildSenderContext(['Someone']);
    expect(result).toBe('');
  });

  it('handles multiple senders, mixing found and not-found', async () => {
    // Madars: found
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(MADARS_PAGE));
    // Unknown: not found
    mockFetch.mockResolvedValueOnce(qmdQueryResponse([]));

    const result = await buildSenderContext(['Madars Virza', 'Unknown Person']);

    expect(result).toContain('name="Madars Virza"');
    expect(result).not.toContain('Unknown Person');
    // Should still have the wrapper
    expect(result).toContain('<people-context>');
  });

  it('caches results and does not re-query within TTL', async () => {
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(MADARS_PAGE));

    // First call
    await buildSenderContext(['Madars Virza']);
    const callCount = mockFetch.mock.calls.length;

    // Second call - should use cache
    await buildSenderContext(['Madars Virza']);
    expect(mockFetch.mock.calls.length).toBe(callCount); // No new calls
  });

  it('re-queries after cache TTL expires', async () => {
    mockFetch.mockResolvedValue(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    // Also mock get responses
    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(MADARS_PAGE));

    await buildSenderContext(['Madars Virza']);

    // Simulate cache expiry by clearing
    clearSenderCache();

    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/madars-virza.md', title: 'Madars Virza', score: 0.93 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(MADARS_PAGE));

    await buildSenderContext(['Madars Virza']);
    // Should have made new calls after cache clear
    expect(mockFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it('returns empty string when QMD is unreachable (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await buildSenderContext(['Madars Virza']);
    expect(result).toBe('');
  });

  it('returns empty string on QMD HTTP error (graceful degradation)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await buildSenderContext(['Madars Virza']);
    expect(result).toBe('');
  });

  it('clips person content to stay within token budget', async () => {
    const longBody = 'A'.repeat(2000); // Way over the ~500 char limit
    const longPage = `---
type: person
name: Verbose Person
description: "Has a very long page"
nanoclaw_tier: guest
---

${longBody}`;

    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/verbose.md', title: 'Verbose Person', score: 0.9 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(longPage));

    const result = await buildSenderContext(['Verbose Person']);

    // The person block should exist but content should be clipped
    expect(result).toContain('name="Verbose Person"');
    // Should not contain 2000 A's
    expect(result.length).toBeLessThan(1000);
  });

  it('uses description from frontmatter as primary content', async () => {
    const pageWithDescription = `---
type: person
name: Brief Person
description: "CEO at Acme Corp; expert in AI safety governance."
nanoclaw_tier: guest
---

This is a much longer body that goes into detail about various topics.`;

    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/brief.md', title: 'Brief Person', score: 0.9 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(pageWithDescription));

    const result = await buildSenderContext(['Brief Person']);

    expect(result).toContain('CEO at Acme Corp');
    expect(result).toContain('AI safety governance');
  });

  it('escapes XML special characters in person content', async () => {
    const pageWithSpecialChars = `---
type: person
name: R&D Person
description: "Works at A&B <Corp>; focus on \"AI\" research."
nanoclaw_tier: guest
---`;

    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/rd.md', title: 'R&D Person', score: 0.9 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(pageWithSpecialChars));

    const result = await buildSenderContext(['R&D Person']);

    // Name should be XML-escaped
    expect(result).toContain('name="R&amp;D Person"');
    // Content should be escaped too
    expect(result).not.toContain('<Corp>');
    expect(result).toContain('&lt;Corp&gt;');
  });

  it('defaults tier to "unknown" when not in frontmatter', async () => {
    const pageNoTier = `---
type: person
name: No Tier Person
description: "Just a person without tier info."
---

Some body text.`;

    mockFetch.mockResolvedValueOnce(
      qmdQueryResponse([{ file: 'jibrain/atlas/people/notier.md', title: 'No Tier Person', score: 0.9 }]),
    );
    mockFetch.mockResolvedValueOnce(qmdGetResponse(pageNoTier));

    const result = await buildSenderContext(['No Tier Person']);

    expect(result).toContain('tier="unknown"');
  });

  it('handles QMD returning malformed SSE gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('not valid SSE at all', { status: 200 }),
    );

    const result = await buildSenderContext(['Madars Virza']);
    expect(result).toBe('');
  });
});
