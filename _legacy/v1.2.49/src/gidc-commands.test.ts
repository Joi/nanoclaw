import { describe, it, expect } from 'vitest';

import { parseGidcCommand } from './gidc-commands.js';

describe('mode command', () => {
  it('parses "mode listening" to mode command', () => {
    expect(parseGidcCommand('mode listening')).toEqual({ type: 'mode', value: 'listening' });
  });

  it('parses "mode available" to mode command', () => {
    expect(parseGidcCommand('mode available')).toEqual({ type: 'mode', value: 'available' });
  });

  it('is case-insensitive', () => {
    expect(parseGidcCommand('Mode Listening')).toEqual({ type: 'mode', value: 'listening' });
    expect(parseGidcCommand('MODE AVAILABLE')).toEqual({ type: 'mode', value: 'available' });
  });

  it('rejects invalid mode values', () => {
    expect(parseGidcCommand('mode invalid')).toBeNull();
    expect(parseGidcCommand('mode')).toBeNull();
  });
});

describe('scan command', () => {
  it('parses "scan" to scan command', () => {
    expect(parseGidcCommand('scan')).toEqual({ type: 'scan' });
  });

  it('parses "scan  " with trailing whitespace', () => {
    expect(parseGidcCommand('scan  ')).toEqual({ type: 'scan' });
  });
});

describe('unknown commands', () => {
  it('returns null for general messages', () => {
    expect(parseGidcCommand('hello')).toBeNull();
    expect(parseGidcCommand('what is the sankosh timeline?')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGidcCommand('')).toBeNull();
  });

  it('returns null for partial command-like strings', () => {
    expect(parseGidcCommand('scanning documents')).toBeNull();
    expect(parseGidcCommand('modeless')).toBeNull();
  });
});
