import { describe, it, expect } from 'vitest';

import { shouldRunIntake } from './intake-routing.js';

describe('shouldRunIntake', () => {
  it('returns true in listening mode regardless of explicit command', () => {
    expect(shouldRunIntake('listening', false)).toBe(true);
    expect(shouldRunIntake('listening', true)).toBe(true);
  });

  it('returns false in available mode when not explicitly commanded', () => {
    expect(shouldRunIntake('available', false)).toBe(false);
  });

  it('returns true in available mode when explicitly commanded', () => {
    expect(shouldRunIntake('available', true)).toBe(true);
  });

  it('defaults to listening when channelMode is undefined', () => {
    expect(shouldRunIntake(undefined, false)).toBe(true);
    expect(shouldRunIntake(undefined, true)).toBe(true);
  });
});
