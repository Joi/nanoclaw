import { describe, it, expect } from 'vitest';

import { shouldRunIntake, shouldRouteToAgent } from './intake-routing.js';

describe('shouldRunIntake', () => {
  it('returns true in listening mode when not mentioned', () => {
    expect(shouldRunIntake('listening', false)).toBe(true);
  });

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

describe('shouldRouteToAgent', () => {
  it('routes to agent when bot is mentioned (any mode)', () => {
    expect(shouldRouteToAgent('listening', true, false)).toBe(true);
    expect(shouldRouteToAgent('available', true, false)).toBe(true);
  });

  it('routes to agent for DMs (any mode)', () => {
    expect(shouldRouteToAgent('listening', false, true)).toBe(true);
    expect(shouldRouteToAgent('available', false, true)).toBe(true);
  });

  it('does NOT route to agent for non-mention channel messages', () => {
    expect(shouldRouteToAgent('listening', false, false)).toBe(false);
    expect(shouldRouteToAgent('available', false, false)).toBe(false);
  });

  it('defaults to listening when channelMode is undefined', () => {
    expect(shouldRouteToAgent(undefined, true, false)).toBe(true);
    expect(shouldRouteToAgent(undefined, false, false)).toBe(false);
  });
});
