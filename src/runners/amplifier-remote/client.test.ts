import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';

// Mock fs for credential file loading
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), existsSync: vi.fn(() => true) },
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import fs from 'fs';
import {
  loadAmplifierdCreds,
  createSession,
  executePrompt,
  resetCredsCache,
} from './client.js';

const VALID_ENV = `
AMPLIFIERD_API_KEY=08e34852000000000000000000000000000000000000000000000000abcd5ec4
AMPLIFIERD_BASE_URL=http://172.27.158.235:8410
`;

interface MockResponse {
  statusCode: number;
  body: string;
}

let capturedRequest: { opts: http.RequestOptions; body: string } | null = null;
let mockResponse: MockResponse | null = null;
let mockError: Error | null = null;

function setMockResponse(statusCode: number, body: string): void {
  mockResponse = { statusCode, body };
  mockError = null;
}

function setMockError(err: Error): void {
  mockError = err;
  mockResponse = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCredsCache();
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(VALID_ENV);
  capturedRequest = null;
  mockResponse = null;
  mockError = null;

  // Mock http.request — the only outbound HTTP we make
  vi.spyOn(http, 'request').mockImplementation(((opts: http.RequestOptions, cb?: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.write = (chunk: string) => {
      capturedRequest = { opts, body: (capturedRequest?.body || '') + chunk };
    };
    req.end = () => {
      // Schedule async callback
      setImmediate(() => {
        if (mockError) {
          req.emit('error', mockError);
          return;
        }
        if (mockResponse && cb) {
          const res = new EventEmitter() as any;
          res.statusCode = mockResponse.statusCode;
          cb(res);
          setImmediate(() => {
            res.emit('data', Buffer.from(mockResponse!.body));
            res.emit('end');
          });
        }
      });
    };
    req.destroy = () => {};
    capturedRequest = { opts, body: '' };
    return req;
  }) as any);
});

describe('loadAmplifierdCreds', () => {
  it('parses keys from credentials.env', () => {
    const c = loadAmplifierdCreds();
    expect(c.apiKey).toBe('08e34852000000000000000000000000000000000000000000000000abcd5ec4');
    expect(c.baseUrl).toBe('http://172.27.158.235:8410');
  });
  it('reads from ~/.config/amplifierd/credentials.env', () => {
    loadAmplifierdCreds();
    const callArg = (fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(callArg)).toMatch(/\.config\/amplifierd\/credentials\.env$/);
  });
  it('caches creds — second call does not re-read', () => {
    loadAmplifierdCreds();
    loadAmplifierdCreds();
    expect((fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
  it('strips quotes and whitespace', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY="quoted-key"
AMPLIFIERD_BASE_URL=  http://172.27.158.235:8410
`);
    const c = loadAmplifierdCreds();
    expect(c.apiKey).toBe('quoted-key');
    expect(c.baseUrl).toBe('http://172.27.158.235:8410');
  });
  it('throws when AMPLIFIERD_API_KEY is missing', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_BASE_URL=http://x:8410\n');
    expect(() => loadAmplifierdCreds()).toThrow(/AMPLIFIERD_API_KEY/);
  });
  it('throws when AMPLIFIERD_BASE_URL is missing', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_API_KEY=abc\n');
    expect(() => loadAmplifierdCreds()).toThrow(/AMPLIFIERD_BASE_URL/);
  });
  it('throws when credentials file unreadable', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('ENOENT: no such file'); });
    expect(() => loadAmplifierdCreds()).toThrow(/ENOENT|credentials/);
  });
});

describe('createSession', () => {
  it('POSTs to /sessions with bundle_name + Bearer auth', async () => {
    setMockResponse(201, JSON.stringify({ session_id: 'abc-123', status: 'idle', bundle_name: 'joi' }));
    const sid = await createSession('joi');
    expect(sid).toBe('abc-123');
    expect(capturedRequest!.opts.method).toBe('POST');
    expect(capturedRequest!.opts.path).toBe('/sessions');
    expect((capturedRequest!.opts.headers as any).Authorization).toMatch(/^Bearer 08e34852/);
    expect(JSON.parse(capturedRequest!.body).bundle_name).toBe('joi');
  });
  it('includes optional metadata when provided', async () => {
    setMockResponse(201, JSON.stringify({ session_id: 'abc-123' }));
    await createSession('joi', { purpose: 'test', folder: 'joi-dm' });
    expect(JSON.parse(capturedRequest!.body).metadata).toEqual({ purpose: 'test', folder: 'joi-dm' });
  });
  it('throws on 401 (auth failure)', async () => {
    setMockResponse(401, JSON.stringify({ detail: 'Unauthorized' }));
    await expect(createSession('joi')).rejects.toThrow(/401|Unauthorized/i);
  });
  it('throws on 5xx', async () => {
    setMockResponse(500, 'Internal Server Error');
    await expect(createSession('joi')).rejects.toThrow(/500/);
  });
  it('throws on network error with code surfaced (ECONNREFUSED)', async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8410') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    setMockError(err);
    await expect(createSession('joi')).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('executePrompt', () => {
  it('POSTs to /sessions/{id}/execute with prompt + Bearer auth', async () => {
    setMockResponse(200, JSON.stringify({ response: 'hello back' }));
    const result = await executePrompt('abc-123', 'hello?');
    expect(result.response).toBe('hello back');
    expect(capturedRequest!.opts.path).toBe('/sessions/abc-123/execute');
    expect(capturedRequest!.opts.method).toBe('POST');
    expect(JSON.parse(capturedRequest!.body).prompt).toBe('hello?');
  });
  it('respects per-call timeout option', async () => {
    setMockResponse(200, JSON.stringify({ response: 'ok' }));
    await executePrompt('abc', 'p', { timeoutMs: 1000 });
    expect((capturedRequest!.opts as any).timeout).toBe(1000);
  });
  it('throws on 4xx with detail extracted (RFC 7807 amplifierd shape)', async () => {
    setMockResponse(404, JSON.stringify({ detail: { type: 'session-not-found', title: 'Session Not Found', detail: "Session 'x' not found" } }));
    await expect(executePrompt('missing-id', 'p')).rejects.toThrow(/Session.*not found|404/i);
  });
  it('throws when response has no response field (shape mismatch)', async () => {
    setMockResponse(200, JSON.stringify({ unexpected: 'shape' }));
    await expect(executePrompt('abc', 'p')).rejects.toThrow(/response|shape/i);
  });
});


describe('executePrompt — prompt size cap (security)', () => {
  it('throws when prompt exceeds 256KB without making any HTTP request', async () => {
    const huge = 'x'.repeat(257 * 1024); // 257KB > 256KB limit
    await expect(executePrompt('abc', huge)).rejects.toThrow(/prompt size.*exceeds limit/);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('accepts prompts at the limit boundary (256KB)', async () => {
    setMockResponse(200, JSON.stringify({ response: 'ok' }));
    const atLimit = 'x'.repeat(256 * 1024);
    const result = await executePrompt('abc', atLimit);
    expect(result.response).toBe('ok');
  });

  it('respects AMPLIFIERD_MAX_PROMPT_BYTES env override', async () => {
    const original = process.env.AMPLIFIERD_MAX_PROMPT_BYTES;
    process.env.AMPLIFIERD_MAX_PROMPT_BYTES = '1024';
    try {
      const just_over = 'x'.repeat(1100);
      await expect(executePrompt('abc', just_over)).rejects.toThrow(/exceeds limit 1024/);
    } finally {
      if (original === undefined) {
        delete process.env.AMPLIFIERD_MAX_PROMPT_BYTES;
      } else {
        process.env.AMPLIFIERD_MAX_PROMPT_BYTES = original;
      }
    }
  });
});


describe('AMPLIFIERD_WORKING_DIR support', () => {
  it('loads workingDir from credentials.env when present', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY=k
AMPLIFIERD_BASE_URL=http://x:8410
AMPLIFIERD_WORKING_DIR=/Users/joi/workspaces/jibot
`);
    const c = loadAmplifierdCreds();
    expect(c.workingDir).toBe('/Users/joi/workspaces/jibot');
  });

  it('omits workingDir when not set (backward-compat)', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY=k
AMPLIFIERD_BASE_URL=http://x:8410
`);
    const c = loadAmplifierdCreds();
    expect(c.workingDir).toBeUndefined();
  });

  it('createSession includes working_dir in POST body when set in creds', async () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY=k
AMPLIFIERD_BASE_URL=http://x:8410
AMPLIFIERD_WORKING_DIR=/Users/joi/workspaces/jibot
`);
    setMockResponse(201, JSON.stringify({ session_id: 'abc' }));
    await createSession('joi');
    const body = JSON.parse(capturedRequest!.body);
    expect(body.working_dir).toBe('/Users/joi/workspaces/jibot');
  });

  it('createSession omits working_dir when creds has none (backward-compat)', async () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(`
AMPLIFIERD_API_KEY=k
AMPLIFIERD_BASE_URL=http://x:8410
`);
    setMockResponse(201, JSON.stringify({ session_id: 'abc' }));
    await createSession('joi');
    const body = JSON.parse(capturedRequest!.body);
    expect(body.working_dir).toBeUndefined();
  });
});
