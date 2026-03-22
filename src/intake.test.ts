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

const INTAKE_DIR = '/data/confidential/sankosh/intake';

const BASE_MSG: IntakeMessage = {
  text: 'Hello world',
  author: 'Karma',
  date: '2026-03-22T10:30:00Z',
  source: 'slack:gidc:channel:C12345',
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
    writeIntakeFile(BASE_MSG);

    expect(fs.mkdirSync).toHaveBeenCalledWith(INTAKE_DIR, { recursive: true });
  });

  it('writes markdown file with correct frontmatter', () => {
    const msg: IntakeMessage = { ...BASE_MSG, text: 'Hello from Karma' };

    writeIntakeFile(msg);

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

    writeIntakeFile(msg);

    const [filePath] = getWriteCall();

    expect(filePath).toMatch(/test-user\.md$/);
  });

  it('includes attachment references in markdown body', () => {
    const attachments: IntakeAttachment[] = [
      { filename: 'report.pdf', path: '/tmp/report.pdf' },
      { filename: 'photo.jpg', path: '/tmp/photo.jpg' },
    ];

    const msg: IntakeMessage = { ...BASE_MSG, text: 'See attached files', attachments };

    writeIntakeFile(msg);

    const [, content] = getWriteCall();

    expect(content).toContain('## Attachments');
    expect(content).toContain('report.pdf');
    expect(content).toContain('photo.jpg');
  });

  it('handles message with no text (attachment-only)', () => {
    const attachments: IntakeAttachment[] = [
      { filename: 'document.pdf', path: '/tmp/document.pdf' },
    ];

    const { text: _omit, ...baseNoText } = BASE_MSG;
    const msg: IntakeMessage = { ...baseNoText, attachments };

    writeIntakeFile(msg);

    const [, content] = getWriteCall();

    expect(content).toContain('type: slack-intake');
    expect(content).toContain('document.pdf');
  });

  it('returns the written file path', () => {
    const result = writeIntakeFile(BASE_MSG);

    expect(result).toMatch(/^\/data\/confidential\/sankosh\/intake\/.*\.md$/);
  });
});
