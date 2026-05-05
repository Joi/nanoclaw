import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs for credential file loading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

// Mock logger
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import fs from 'fs';
import {
  loadAmplifierdCreds,
  createSession,
  executePrompt,
  resetCredsCache,
  type AmplifierdCreds,
} from './client.js';

const VALID_ENV = `
# amplifierd HTTP API credentials for the macazbd remote brain.
AMPLIFIERD_API_KEY=08e34852000000000000000000000000000000000000000000000000abcd5ec4
AMPLIFIERD_BASE_URL=http://172.27.158.235:8410
`;

beforeEach(() => {
  vi.clearAllMocks();
  resetCredsCache();
  // Default: creds file is readable and valid
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(VALID_ENV);
  // Default: stub global fetch
  vi.stubGlobal('fetch', vi.fn());
});

// ────────────────────────────────────────────────────────────────────────────
// loadAmplifierdCreds: reads ~/.config/amplifierd/credentials.env
// ────────────────────────────────────────────────────────────────────────────

describe('loadAmplifierdCreds', () => {
  it('parses AMPLIFIERD_API_KEY and AMPLIFIERD_BASE_URL from the file', () => {
    const creds = loadAmplifierdCreds();
    expect(creds.apiKey).toBe('08e34852000000000000000000000000000000000000000000000000abcd5ec4');
    expect(creds.baseUrl).toBe('http://172.27.158.235:8410');
  });

  it('reads from ~/.config/amplifierd/credentials.env (user-scope, not in repo)', () => {
    loadAmplifierdCreds();
    const callArg = (fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(callArg)).toMatch(/\.config\/amplifierd\/credentials\.env$/);
  });

  it('caches creds — second call does not re-read the file', () => {
    loadAmplifierdCreds();
    loadAmplifierdCreds();
    loadAmplifierdCreds();
    expect((fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('strips surrounding whitespace and quotes from values', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY="quoted-key-value"
AMPLIFIERD_BASE_URL=  http://172.27.158.235:8410  
`);
    const creds = loadAmplifierdCreds();
    expect(creds.apiKey).toBe('quoted-key-value');
    expect(creds.baseUrl).toBe('http://172.27.158.235:8410');
  });

  it('throws when AMPLIFIERD_API_KEY is missing', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_BASE_URL=http://x:8410\n');
    expect(() => loadAmplifierdCreds()).toThrow(/AMPLIFIERD_API_KEY/);
  });

  it('throws when AMPLIFIERD_BASE_URL is missing', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_API_KEY=abc\n');
    expect(() => loadAmplifierdCreds()).toThrow(/AMPLIFIERD_BASE_URL/);
  });

  it('throws when credentials file is unreadable (ENOENT)', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    expect(() => loadAmplifierdCreds()).toThrow(/ENOENT|credentials/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// createSession: POST /sessions
// ────────────────────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('POSTs to /sessions with bundle_name + Bearer auth', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ session_id: 'abc-123' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const sid = await createSession('joi');

    expect(sid).toBe('abc-123');
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('http://172.27.158.235:8410/sessions');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers['Authorization']).toMatch(/^Bearer 08e34852/);
    expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(fetchCall[1].body);
    expect(body.bundle_name).toBe('joi');
  });

  it('includes optional metadata when provided', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ session_id: 'abc-123' }), { status: 201 }),
    );
    await createSession('joi', { purpose: 'test', folder: 'joi-dm' });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.metadata).toEqual({ purpose: 'test', folder: 'joi-dm' });
  });

  it('throws on 401 (auth failure)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
    );
    await expect(createSession('joi')).rejects.toThrow(/401|unauthorized/i);
  });

  it('throws on 5xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    await expect(createSession('joi')).rejects.toThrow(/500|server/i);
  });

  it('throws on network error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(createSession('joi')).rejects.toThrow(/ECONNREFUSED|network|fetch/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executePrompt: POST /sessions/{id}/execute
// ────────────────────────────────────────────────────────────────────────────

describe('executePrompt', () => {
  it('POSTs to /sessions/{id}/execute with prompt + Bearer auth', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ response: 'hello back' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await executePrompt('abc-123', 'hello?');

    expect(result.response).toBe('hello back');
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('http://172.27.158.235:8410/sessions/abc-123/execute');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers['Authorization']).toMatch(/^Bearer 08e34852/);
    const body = JSON.parse(fetchCall[1].body);
    expect(body.prompt).toBe('hello?');
  });

  it('respects per-call timeout', async () => {
    let abortSignal: AbortSignal | undefined;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((_url, opts: RequestInit) => {
      abortSignal = opts.signal as AbortSignal | undefined;
      return Promise.resolve(new Response(JSON.stringify({ response: 'ok' }), { status: 200 }));
    });
    await executePrompt('abc', 'p', { timeoutMs: 1000 });
    expect(abortSignal).toBeDefined();
  });

  it('throws on 4xx with detail message extracted', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Session not found' }), { status: 404 }),
    );
    await expect(executePrompt('missing-id', 'p')).rejects.toThrow(/404|not found/i);
  });

  it('throws when response has no response field (shape mismatch)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }),
    );
    await expect(executePrompt('abc', 'p')).rejects.toThrow(/response|shape/i);
  });
});
