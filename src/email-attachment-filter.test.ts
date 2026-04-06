import { describe, expect, it } from 'vitest';

import { filterAttachments, isSafeAttachment } from './email-attachment-filter.js';

describe('isSafeAttachment', () => {
  it('accepts PDF', () => {
    expect(isSafeAttachment('report.pdf', 'application/pdf')).toBe(true);
  });

  it('accepts images', () => {
    expect(isSafeAttachment('photo.png', 'image/png')).toBe(true);
    expect(isSafeAttachment('photo.jpg', 'image/jpeg')).toBe(true);
    expect(isSafeAttachment('photo.jpeg', 'image/jpeg')).toBe(true);
    expect(isSafeAttachment('photo.gif', 'image/gif')).toBe(true);
    expect(isSafeAttachment('photo.heic', 'image/heic')).toBe(true);
  });

  it('accepts documents', () => {
    expect(isSafeAttachment('doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(isSafeAttachment('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(isSafeAttachment('readme.txt', 'text/plain')).toBe(true);
    expect(isSafeAttachment('notes.md', 'text/markdown')).toBe(true);
    expect(isSafeAttachment('data.csv', 'text/csv')).toBe(true);
  });

  it('rejects executables', () => {
    expect(isSafeAttachment('virus.exe', 'application/x-msdownload')).toBe(false);
    expect(isSafeAttachment('script.sh', 'application/x-sh')).toBe(false);
    expect(isSafeAttachment('script.bat', 'application/x-bat')).toBe(false);
  });

  it('rejects archives', () => {
    expect(isSafeAttachment('archive.zip', 'application/zip')).toBe(false);
    expect(isSafeAttachment('archive.tar.gz', 'application/gzip')).toBe(false);
  });

  it('rejects unknown types by default', () => {
    expect(isSafeAttachment('unknown.xyz', 'application/octet-stream')).toBe(false);
  });

  it('uses extension as fallback when mime is generic', () => {
    expect(isSafeAttachment('document.pdf', 'application/octet-stream')).toBe(true);
    expect(isSafeAttachment('photo.jpg', 'application/octet-stream')).toBe(true);
  });
});

describe('filterAttachments', () => {
  it('splits attachments into safe and rejected', () => {
    const attachments = [
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 1000 },
      { filename: 'virus.exe', mimeType: 'application/x-msdownload', size: 2000 },
      { filename: 'photo.png', mimeType: 'image/png', size: 500 },
    ];
    const { safe, rejected } = filterAttachments(attachments);
    expect(safe).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(safe[0].filename).toBe('report.pdf');
    expect(rejected[0].filename).toBe('virus.exe');
  });
});
