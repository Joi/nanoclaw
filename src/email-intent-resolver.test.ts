import { describe, expect, it, vi } from 'vitest';

import { resolveEmailIntent, EmailIntent } from './email-intent-resolver.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('resolveEmailIntent', () => {
  // --- Explicit alias behavior ---

  it('+action always returns action regardless of content', () => {
    const result = resolveEmailIntent('action', 'owner', 'Please capture this note');
    expect(result.intent).toBe('action');
  });

  it('+intake with non-action content returns intake', () => {
    const result = resolveEmailIntent('intake', 'owner', 'FYI here is some info');
    expect(result.intent).toBe('intake');
  });

  it('+intake with action-like content returns clarify', () => {
    const result = resolveEmailIntent('intake', 'owner', 'Please schedule a meeting next Tuesday');
    expect(result.intent).toBe('clarify');
    expect(result.reason).toContain('action');
  });

  it('+intake with reminder-like content returns clarify', () => {
    const result = resolveEmailIntent('intake', 'owner', 'Remind me to follow up on Friday');
    expect(result.intent).toBe('clarify');
  });

  // --- Plain address, owner sender ---

  it('plain + owner + clear action request returns action', () => {
    const result = resolveEmailIntent('plain', 'owner', 'Schedule a meeting with the team for next Wednesday');
    expect(result.intent).toBe('action');
  });

  it('plain + owner + clear intake content returns intake', () => {
    const result = resolveEmailIntent('plain', 'owner', 'FYI: the quarterly report is attached for your reference');
    expect(result.intent).toBe('intake');
  });

  it('plain + owner + ambiguous content returns clarify', () => {
    const result = resolveEmailIntent('plain', 'owner', 'Hello, how are things?');
    expect(result.intent).toBe('clarify');
  });

  // --- Plain address, admin/staff sender ---

  it('plain + admin + ambiguous content returns intake (downgrade)', () => {
    const result = resolveEmailIntent('plain', 'admin', 'Some thoughts on the project');
    expect(result.intent).toBe('intake');
  });

  it('plain + staff + ambiguous content returns intake (downgrade)', () => {
    const result = resolveEmailIntent('plain', 'staff', 'Here are my notes from today');
    expect(result.intent).toBe('intake');
  });

  it('plain + admin + clear action returns action', () => {
    const result = resolveEmailIntent('plain', 'admin', 'Please schedule a team meeting for Monday at 2pm');
    expect(result.intent).toBe('action');
  });

  // --- Action subtype classification ---

  it('classifies scheduling subtype', () => {
    const result = resolveEmailIntent('action', 'owner', 'Schedule a meeting with Alice next Thursday at 3pm');
    expect(result.intent).toBe('action');
    expect(result.actionSubtype).toBe('calendar');
  });

  it('classifies reminder subtype', () => {
    const result = resolveEmailIntent('action', 'owner', 'Remind me to review the proposal on Friday');
    expect(result.intent).toBe('action');
    expect(result.actionSubtype).toBe('reminder');
  });

  it('classifies general action subtype', () => {
    const result = resolveEmailIntent('action', 'owner', 'Send a summary of yesterday\'s discussion to the team');
    expect(result.intent).toBe('action');
    expect(result.actionSubtype).toBe('general');
  });
});
