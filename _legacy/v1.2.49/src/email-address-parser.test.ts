import { describe, expect, it } from 'vitest';

import {
  parseEmailAlias,
  extractSenderEmail,
  isJibotAddress,
} from './email-address-parser.js';

describe('parseEmailAlias', () => {
  it('parses +action alias', () => {
    expect(parseEmailAlias('jibot+action@ito.com')).toBe('action');
  });

  it('parses +intake alias', () => {
    expect(parseEmailAlias('jibot+intake@ito.com')).toBe('intake');
  });

  it('returns "plain" for bare jibot address', () => {
    expect(parseEmailAlias('jibot@ito.com')).toBe('plain');
  });

  it('handles case-insensitive', () => {
    expect(parseEmailAlias('Jibot+Action@ito.com')).toBe('action');
    expect(parseEmailAlias('JIBOT+INTAKE@ITO.COM')).toBe('intake');
  });

  it('returns "unknown" for unrecognized alias', () => {
    expect(parseEmailAlias('jibot+unknown@ito.com')).toBe('unknown');
  });

  it('returns null for non-jibot address', () => {
    expect(parseEmailAlias('alice@example.com')).toBeNull();
  });
});

describe('extractSenderEmail', () => {
  it('extracts email from "Name <email>" format', () => {
    expect(extractSenderEmail('Alice Smith <alice@example.com>')).toBe('alice@example.com');
  });

  it('extracts bare email address', () => {
    expect(extractSenderEmail('bob@example.com')).toBe('bob@example.com');
  });

  it('handles quoted name format', () => {
    expect(extractSenderEmail('"Carol Jones" <carol@example.com>')).toBe('carol@example.com');
  });

  it('lowercases the result', () => {
    expect(extractSenderEmail('Bob@Example.COM')).toBe('bob@example.com');
  });

  it('returns empty string for empty input', () => {
    expect(extractSenderEmail('')).toBe('');
  });
});

describe('isJibotAddress', () => {
  it('recognizes jibot addresses', () => {
    expect(isJibotAddress('jibot@ito.com')).toBe(true);
    expect(isJibotAddress('jibot+action@ito.com')).toBe(true);
    expect(isJibotAddress('jibot+intake@ito.com')).toBe(true);
  });

  it('rejects non-jibot addresses', () => {
    expect(isJibotAddress('alice@ito.com')).toBe(false);
    expect(isJibotAddress('jibot@other.com')).toBe(false);
  });
});
