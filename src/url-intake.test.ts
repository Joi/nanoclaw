import { describe, it, expect, beforeEach, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), existsSync: vi.fn(() => true) },
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import fs from 'fs';
import {
  detectBareUrl,
  loadIntakeCreds,
  intakeUrl,
  resetIntakeCredsCache,
  formatIntakeReply,
} from './url-intake.js';

const VALID_ENV = `
AMPLIFIERD_API_KEY=k
AMPLIFIERD_BASE_URL=http://x:8410
INTAKE_API_KEY=intake-key-abc-123
`;

let capturedRequest: { opts: https.RequestOptions; body: string } | null = null;
let mockResponse: { statusCode: number; body: string } | null = null;
let mockError: Error | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  resetIntakeCredsCache();
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(VALID_ENV);
  capturedRequest = null;
  mockResponse = null;
  mockError = null;

  vi.spyOn(https, 'request').mockImplementation(((opts: https.RequestOptions, cb?: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.write = (chunk: string) => {
      capturedRequest = { opts, body: (capturedRequest?.body || '') + chunk };
    };
    req.end = () => {
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

// ─── Bare URL detection ────────────────────────────────────────────────────

describe('detectBareUrl', () => {
  it('matches a bare https URL', () => {
    expect(detectBareUrl('https://x.com/foo/status/123')).toBe('https://x.com/foo/status/123');
  });
  it('matches a bare http URL', () => {
    expect(detectBareUrl('http://example.com')).toBe('http://example.com');
  });
  it('strips surrounding whitespace', () => {
    expect(detectBareUrl('  \n https://example.com \t ')).toBe('https://example.com');
  });
  it('rejects URL with prefix text', () => {
    expect(detectBareUrl('check this https://x.com')).toBeNull();
  });
  it('rejects URL with suffix text', () => {
    expect(detectBareUrl('https://x.com extra')).toBeNull();
  });
  it('rejects empty / blank string', () => {
    expect(detectBareUrl('')).toBeNull();
    expect(detectBareUrl('   ')).toBeNull();
  });
  it('rejects non-URL text', () => {
    expect(detectBareUrl('hello world')).toBeNull();
  });
  it('rejects bare text after URL even when URL would match', () => {
    expect(detectBareUrl('https://x.com/a https://x.com/b')).toBeNull();
  });
  it('rejects "URL" without scheme', () => {
    expect(detectBareUrl('x.com/foo')).toBeNull();
  });
  it('handles trailing newline', () => {
    expect(detectBareUrl('https://x.com\n')).toBe('https://x.com');
  });
});

// ─── Creds loading ─────────────────────────────────────────────────────────

describe('loadIntakeCreds', () => {
  it('parses INTAKE_API_KEY from credentials.env', () => {
    const c = loadIntakeCreds();
    expect(c.apiKey).toBe('intake-key-abc-123');
  });
  it('caches creds across calls', () => {
    loadIntakeCreds();
    loadIntakeCreds();
    expect((fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
  it('throws when INTAKE_API_KEY is missing', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_API_KEY=k\n');
    expect(() => loadIntakeCreds()).toThrow(/INTAKE_API_KEY/);
  });
  it('throws when file unreadable', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => loadIntakeCreds()).toThrow(/credentials/);
  });
});

// ─── intakeUrl HTTP behavior ───────────────────────────────────────────────

describe('intakeUrl', () => {
  it('POSTs to /intake on knowledge-intake sprite with X-API-Key + url body', async () => {
    mockResponse = { statusCode: 200, body: JSON.stringify({ status: 'created', title: 'Test', file_path: 'agents/curator/extractions/test.md' }) };
    const r = await intakeUrl('https://example.com/test');
    expect(r.status).toBe('created');
    expect(r.title).toBe('Test');
    expect(capturedRequest!.opts.method).toBe('POST');
    expect(capturedRequest!.opts.hostname).toBe('knowledge-intake-bmal2.sprites.app');
    expect(capturedRequest!.opts.path).toBe('/intake');
    expect((capturedRequest!.opts.headers as any)['X-API-Key']).toBe('intake-key-abc-123');
    expect(JSON.parse(capturedRequest!.body)).toEqual({ url: 'https://example.com/test' });
  });
  it('includes hint when provided', async () => {
    mockResponse = { statusCode: 200, body: '{"status":"created"}' };
    await intakeUrl('https://example.com', { hint: 'reference' });
    expect(JSON.parse(capturedRequest!.body)).toEqual({ url: 'https://example.com', hint: 'reference' });
  });
  it('returns error object on missing INTAKE_API_KEY (not thrown)', async () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('AMPLIFIERD_API_KEY=k\n');
    const r = await intakeUrl('https://example.com');
    expect(r.error).toMatch(/INTAKE_API_KEY/);
  });
  it('returns error object on HTTP 4xx', async () => {
    mockResponse = { statusCode: 401, body: '{"detail":"invalid x-api-key"}' };
    const r = await intakeUrl('https://example.com');
    expect(r.error).toMatch(/401/);
  });
  it('returns error object on network error (with code)', async () => {
    const e = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
    e.code = 'ECONNREFUSED';
    mockError = e;
    const r = await intakeUrl('https://example.com');
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

// ─── formatIntakeReply ─────────────────────────────────────────────────────

describe('formatIntakeReply', () => {
  it('formats success reply with classification + path', () => {
    const r = formatIntakeReply(
      { status: 'created', title: 'Audrey Tang', classification: 'person', file_path: 'agents/curator/extractions/audrey-tang.md' },
      'https://en.wikipedia.org/wiki/Audrey_Tang',
    );
    expect(r).toContain('Audrey Tang');
    expect(r).toContain('[person]');
    expect(r).toContain('agents/curator/extractions/audrey-tang.md');
  });
  it('formats fallback when title missing', () => {
    const r = formatIntakeReply({ status: 'created' }, 'https://example.com');
    expect(r).toContain('untitled');
  });
  it('formats error reply', () => {
    const r = formatIntakeReply({ error: 'sprite is down' }, 'https://example.com');
    expect(r).toMatch(/Couldn't auto-file/);
    expect(r).toContain('sprite is down');
  });
});
