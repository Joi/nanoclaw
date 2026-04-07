import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs (mkdirSync, writeFileSync, existsSync, copyFileSync)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => { throw new Error("ENOENT: mock"); }),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import fs from 'fs';
import { writeIntakeFile, type IntakeMessage, type IntakeAttachment } from './intake.js';

const CONFIDENTIAL_ROOT = '/data/confidential';
const INTAKE_DIR = '/data/confidential/sankosh/intake';

const BASE_MSG: IntakeMessage = {
  text: 'Hello world',
  author: 'Karma',
  timestamp: '2026-03-22T10:30:00Z',
  channelId: 'C12345',
  channelName: 'general',
  workstream: 'sankosh',
};

function getWriteCall() {
  return (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
}

describe('writeIntakeFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates intake directory if it does not exist', () => {
    writeIntakeFile(CONFIDENTIAL_ROOT, BASE_MSG);

    expect(fs.mkdirSync).toHaveBeenCalledWith(INTAKE_DIR, { recursive: true });
  });

  it('writes markdown file with correct frontmatter', () => {
    const msg: IntakeMessage = { ...BASE_MSG, text: 'Hello from Karma' };

    writeIntakeFile(CONFIDENTIAL_ROOT, msg);

    const [filePath, content] = getWriteCall();

    expect(filePath).toBe(`${INTAKE_DIR}/2026-03-22T10-30-00Z-karma.md`);
    expect(content).toContain('type: slack-intake');
    expect(content).toContain('source: \"slack:gidc:channel:C12345\"');
    expect(content).toContain('author: \"Karma\"');
    expect(content).toContain('date: \"2026-03-22T10:30:00Z\"');
    expect(content).toContain('classification: confidential');
    expect(content).toContain('workstream: \"sankosh\"');
    expect(content).toContain('description:');
    expect(content).toContain('Hello from Karma');
  });

  it('sanitizes author name for filename (lowercase, no spaces)', () => {
    const msg: IntakeMessage = { ...BASE_MSG, text: 'Hello', author: 'Test User' };

    writeIntakeFile(CONFIDENTIAL_ROOT, msg);

    const [filePath] = getWriteCall();

    expect(filePath).toMatch(/test-user\.md$/);
  });

  it('includes attachment references in markdown body', () => {
    const attachments: IntakeAttachment[] = [
      { originalFilename: 'report.pdf', savedPath: '/tmp/report.pdf' },
      { originalFilename: 'photo.jpg', savedPath: '/tmp/photo.jpg' },
    ];

    const msg: IntakeMessage = { ...BASE_MSG, text: 'See attached files', attachments };

    writeIntakeFile(CONFIDENTIAL_ROOT, msg);

    const [, content] = getWriteCall();

    expect(content).toContain('## Attachments');
    expect(content).toContain('report.pdf');
    expect(content).toContain('photo.jpg');
  });

  it('handles message with no text (attachment-only)', () => {
    const attachments: IntakeAttachment[] = [
      { originalFilename: 'document.pdf', savedPath: '/tmp/document.pdf' },
    ];

    const msg: IntakeMessage = { ...BASE_MSG, text: '', attachments };

    writeIntakeFile(CONFIDENTIAL_ROOT, msg);

    const [, content] = getWriteCall();

    expect(content).toContain('type: slack-intake');
    expect(content).toContain('document.pdf');
    expect(content).toContain('description:');
    expect(content).toContain('attachment upload');
  });

  it('returns the written file path', () => {
    const result = writeIntakeFile(CONFIDENTIAL_ROOT, BASE_MSG);

    expect(result).toMatch(/^\/data\/confidential\/sankosh\/intake\/.*\.md$/);
  });

  it('wraps description in quotes to handle colons in message text', () => {
    const msg: IntakeMessage = { ...BASE_MSG, text: 'Check out: https://example.com' };

    writeIntakeFile(CONFIDENTIAL_ROOT, msg);

    const [, content] = getWriteCall();

    // description must be quoted to prevent YAML corruption on colons
    expect(content).toContain('description: "Check out: https://example.com"');
  });
});
