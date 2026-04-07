import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractWorkstreamSlug, resolveReceiptDir } from './workstream-routing.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('extractWorkstreamSlug', () => {
  it('extracts slug from #ws:tag in subject', () => {
    expect(extractWorkstreamSlug('Fwd: Budget report #ws:sankosh')).toBe('sankosh');
  });

  it('extracts slug case-insensitively and normalises to lowercase', () => {
    expect(extractWorkstreamSlug('FW: Notes #ws:GIDC')).toBe('gidc');
    expect(extractWorkstreamSlug('#WS:Bhutan update')).toBe('bhutan');
  });

  it('supports hyphens and underscores in slug', () => {
    expect(extractWorkstreamSlug('#ws:gidc-funds info')).toBe('gidc-funds');
    expect(extractWorkstreamSlug('#ws:some_project')).toBe('some_project');
  });

  it('returns null when no tag present', () => {
    expect(extractWorkstreamSlug('Just a normal email subject')).toBeNull();
    expect(extractWorkstreamSlug('')).toBeNull();
  });

  it('extracts only the first tag if multiple present', () => {
    expect(extractWorkstreamSlug('#ws:sankosh #ws:gidc')).toBe('sankosh');
  });
});

describe('resolveReceiptDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-routing-test-'));
    // Create simulated workstream dirs
    fs.mkdirSync(path.join(tmpDir, 'sankosh', 'intake'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'bhutan'), { recursive: true }); // no intake/ yet
    fs.mkdirSync(path.join(tmpDir, 'email-receipts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes to workstream intake when slug and intake/ exist', () => {
    const dir = resolveReceiptDir(tmpDir, 'Report #ws:sankosh');
    expect(dir).toBe(path.join(tmpDir, 'sankosh', 'intake'));
  });

  it('creates intake/ and routes when workstream dir exists without intake/', () => {
    const dir = resolveReceiptDir(tmpDir, 'Update #ws:bhutan');
    expect(dir).toBe(path.join(tmpDir, 'bhutan', 'intake'));
    expect(fs.existsSync(path.join(tmpDir, 'bhutan', 'intake'))).toBe(true);
  });

  it('falls back to email-receipts for unknown slug', () => {
    const dir = resolveReceiptDir(tmpDir, 'Report #ws:nonexistent');
    expect(dir).toBe(path.join(tmpDir, 'email-receipts'));
  });

  it('falls back to email-receipts when no tag present', () => {
    const dir = resolveReceiptDir(tmpDir, 'Normal email subject');
    expect(dir).toBe(path.join(tmpDir, 'email-receipts'));
  });
});
