import { describe, expect, it, vi } from 'vitest';

import { sanitizeReplyRecipients } from './email-reply-sanitizer.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('sanitizeReplyRecipients', () => {
  const knownEmails = new Set(['joi@ito.com', 'alice@ito.com', 'bob@ito.com', 'jibot@ito.com']);

  it('keeps recognized internal recipients and requester', () => {
    const result = sanitizeReplyRecipients(
      'Alice <alice@ito.com>',
      ['joi@ito.com', 'alice@ito.com', 'bob@ito.com', 'stranger@external.com'],
      knownEmails,
    );
    expect(result).toContain('alice@ito.com');
    expect(result).toContain('joi@ito.com');
    expect(result).toContain('bob@ito.com');
    expect(result).not.toContain('stranger@external.com');
  });

  it('excludes jibot from reply recipients', () => {
    const result = sanitizeReplyRecipients(
      'joi@ito.com',
      ['joi@ito.com', 'jibot@ito.com', 'jibot+action@ito.com'],
      knownEmails,
    );
    expect(result).toContain('joi@ito.com');
    expect(result).not.toContain('jibot@ito.com');
    expect(result).not.toContain('jibot+action@ito.com');
  });

  it('always includes the requester even if not in known set', () => {
    const result = sanitizeReplyRecipients(
      'newperson@unknown.com',
      ['newperson@unknown.com', 'joi@ito.com'],
      knownEmails,
    );
    expect(result).toContain('newperson@unknown.com');
    expect(result).toContain('joi@ito.com');
  });

  it('deduplicates recipients', () => {
    const result = sanitizeReplyRecipients(
      'Alice <alice@ito.com>',
      ['alice@ito.com', 'Alice <alice@ito.com>', 'joi@ito.com'],
      knownEmails,
    );
    const aliceCount = result.filter((r) => r === 'alice@ito.com').length;
    expect(aliceCount).toBe(1);
  });

  it('handles empty thread recipients', () => {
    const result = sanitizeReplyRecipients(
      'joi@ito.com',
      [],
      knownEmails,
    );
    expect(result).toEqual(['joi@ito.com']);
  });
});
