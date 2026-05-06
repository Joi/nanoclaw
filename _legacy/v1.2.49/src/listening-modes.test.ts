import { describe, expect, it } from 'vitest';

import {
  isValidListeningMode,
  parseListeningModeCommand,
  shouldIngest,
  shouldRespond,
} from './listening-modes.js';

describe('isValidListeningMode', () => {
  it('returns true for all valid modes', () => {
    expect(isValidListeningMode('active')).toBe(true);
    expect(isValidListeningMode('attentive')).toBe(true);
    expect(isValidListeningMode('silent')).toBe(true);
  });

  it('returns false for deprecated and invalid modes', () => {
    expect(isValidListeningMode('on-call')).toBe(false);
    expect(isValidListeningMode('loud')).toBe(false);
    expect(isValidListeningMode('')).toBe(false);
    expect(isValidListeningMode('ACTIVE')).toBe(false);
  });
});

describe('parseListeningModeCommand', () => {
  it('parses valid mode commands', () => {
    expect(parseListeningModeCommand('set listening mode to active')).toBe('active');
    expect(parseListeningModeCommand('set listening mode to attentive')).toBe('attentive');
    expect(parseListeningModeCommand('set listening mode to silent')).toBe('silent');
  });

  it('accepts deprecated on-call as attentive', () => {
    expect(parseListeningModeCommand('set listening mode to on-call')).toBe('attentive');
  });

  it('is case-insensitive for the command prefix', () => {
    expect(parseListeningModeCommand('Set Listening Mode To active')).toBe('active');
  });

  it('returns null for invalid modes', () => {
    expect(parseListeningModeCommand('set listening mode to loud')).toBeNull();
  });

  it('returns null for non-matching text', () => {
    expect(parseListeningModeCommand('hello world')).toBeNull();
    expect(parseListeningModeCommand('set mode to active')).toBeNull();
  });
});

describe('shouldRespond', () => {
  it('active mode: always responds', () => {
    expect(shouldRespond('active', true)).toBe(true);
    expect(shouldRespond('active', false)).toBe(true);
  });

  it('attentive mode: responds only when mentioned', () => {
    expect(shouldRespond('attentive', true)).toBe(true);
    expect(shouldRespond('attentive', false)).toBe(false);
  });

  it('silent mode: never responds', () => {
    expect(shouldRespond('silent', true)).toBe(false);
    expect(shouldRespond('silent', false)).toBe(false);
  });
});

describe('shouldIngest', () => {
  it('active mode: always ingests', () => {
    expect(shouldIngest('active', true)).toBe(true);
    expect(shouldIngest('active', false)).toBe(true);
  });

  it('attentive mode: always ingests', () => {
    expect(shouldIngest('attentive', true)).toBe(true);
    expect(shouldIngest('attentive', false)).toBe(true);
  });

  it('silent mode: never ingests', () => {
    expect(shouldIngest('silent', true)).toBe(false);
    expect(shouldIngest('silent', false)).toBe(false);
  });
});
