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

describe('writeIntakeFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates intake directory if it does not exist', () => {
    const msg: IntakeMessage = {
      text: 'Hello world',
      author: 'Karma',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
    };

    writeIntakeFile(msg);

    expect(fs.mkdirSync).toHaveBeenCalledWith(INTAKE_DIR, { recursive: true });
  });

  it('writes markdown file with correct frontmatter', () => {
    const msg: IntakeMessage = {
      text: 'Hello from Karma',
      author: 'Karma',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
    };

    writeIntakeFile(msg);

    const [filePath, content] = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];

    expect(filePath).toBe(`${INTAKE_DIR}/2026-03-22T10-30-00Z-karma.md`);
    expect(content).toContain('type: slack-intake');
    expect(content).toContain('source: "slack:gidc:channel:C12345"');
    expect(content).toContain('author: "Karma"');
    expect(content).toContain('date: "2026-03-22T10:30:00Z"');
    expect(content).toContain('classification: confidential');
    expect(content).toContain('workstream: "sankosh"');
    expect(content).toContain('description:');
    expect(content).toContain('Hello from Karma');
  });

  it('sanitizes author name for filename (lowercase, no spaces)', () => {
    const msg: IntakeMessage = {
      text: 'Hello',
      author: 'Test User',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
    };

    writeIntakeFile(msg);

    const [filePath] = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];

    expect(filePath).toMatch(/test-user\.md$/);
  });

  it('includes attachment references in markdown body', () => {
    const attachments: IntakeAttachment[] = [
      { filename: 'report.pdf', path: '/tmp/report.pdf' },
      { filename: 'photo.jpg', path: '/tmp/photo.jpg' },
    ];

    const msg: IntakeMessage = {
      text: 'See attached files',
      author: 'Karma',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
      attachments,
    };

    writeIntakeFile(msg);

    const [, content] = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];

    expect(content).toContain('## Attachments');
    expect(content).toContain('report.pdf');
    expect(content).toContain('photo.jpg');
  });

  it('handles message with no text (attachment-only)', () => {
    const attachments: IntakeAttachment[] = [
      { filename: 'document.pdf', path: '/tmp/document.pdf' },
    ];

    const msg: IntakeMessage = {
      author: 'Karma',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
      attachments,
    };

    writeIntakeFile(msg);

    const [, content] = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];

    expect(content).toContain('type: slack-intake');
    expect(content).toContain('document.pdf');
  });

  it('returns the written file path', () => {
    const msg: IntakeMessage = {
      text: 'Hello world',
      author: 'Karma',
      date: '2026-03-22T10:30:00Z',
      source: 'slack:gidc:channel:C12345',
      workstream: 'sankosh',
    };

    const result = writeIntakeFile(msg);

    expect(result).toMatch(/^\/data\/confidential\/sankosh\/intake\/.*\.md$/);
  });
});
