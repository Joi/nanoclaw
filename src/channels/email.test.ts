import { describe, expect, it, vi } from 'vitest';

import { extractSenderEmail, isJibotAddress, parseEmailAlias } from '../email-address-parser.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Test the helpers that EmailChannel depends on (integration smoke tests)
// Full EmailChannel integration requires gog mocking which is complex;
// the component tests (identity, intent, policy, reply, etc.) cover the logic.

describe('EmailChannel helpers', () => {
  describe('jibot alias detection from recipients', () => {
    it('detects +action alias', () => {
      expect(parseEmailAlias('jibot+action@ito.com')).toBe('action');
    });

    it('detects +intake alias', () => {
      expect(parseEmailAlias('jibot+intake@ito.com')).toBe('intake');
    });

    it('detects plain jibot address', () => {
      expect(parseEmailAlias('jibot@ito.com')).toBe('plain');
    });

    it('returns null for non-jibot address', () => {
      expect(parseEmailAlias('alice@ito.com')).toBeNull();
    });
  });

  describe('sender extraction', () => {
    it('extracts from Name <email> format', () => {
      expect(extractSenderEmail('Joi Ito <joi@ito.com>')).toBe('joi@ito.com');
    });
  });

  describe('jibot address check', () => {
    it('recognizes all jibot variants', () => {
      expect(isJibotAddress('jibot@ito.com')).toBe(true);
      expect(isJibotAddress('jibot+action@ito.com')).toBe(true);
      expect(isJibotAddress('jibot+intake@ito.com')).toBe(true);
    });
  });
});
