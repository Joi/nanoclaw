import { describe, expect, it, vi } from 'vitest';

import { checkEmailPolicy } from './email-policy-adapter.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('checkEmailPolicy', () => {
  it('owner can execute any action subtype', () => {
    expect(checkEmailPolicy('owner', 'action', 'general').allowed).toBe(true);
    expect(checkEmailPolicy('owner', 'action', 'calendar').allowed).toBe(true);
    expect(checkEmailPolicy('owner', 'action', 'reminder').allowed).toBe(true);
  });

  it('owner can use intake', () => {
    expect(checkEmailPolicy('owner', 'intake').allowed).toBe(true);
  });

  it('admin can execute jibot-native actions', () => {
    expect(checkEmailPolicy('admin', 'action', 'general').allowed).toBe(true);
  });

  it('admin can use calendar and reminders', () => {
    expect(checkEmailPolicy('admin', 'action', 'calendar').allowed).toBe(true);
    expect(checkEmailPolicy('admin', 'action', 'reminder').allowed).toBe(true);
  });

  it('admin can use intake', () => {
    expect(checkEmailPolicy('admin', 'intake').allowed).toBe(true);
  });

  it('staff can execute jibot-native actions', () => {
    expect(checkEmailPolicy('staff', 'action', 'general').allowed).toBe(true);
  });

  it('staff can use calendar and reminders', () => {
    expect(checkEmailPolicy('staff', 'action', 'calendar').allowed).toBe(true);
    expect(checkEmailPolicy('staff', 'action', 'reminder').allowed).toBe(true);
  });

  it('staff can use intake', () => {
    expect(checkEmailPolicy('staff', 'intake').allowed).toBe(true);
  });

  it('unknown tier is blocked from action', () => {
    const result = checkEmailPolicy('unknown', 'action', 'general');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('unknown tier is blocked from intake', () => {
    const result = checkEmailPolicy('unknown', 'intake');
    expect(result.allowed).toBe(false);
  });

  it('guest tier is blocked from everything', () => {
    expect(checkEmailPolicy('guest', 'action', 'general').allowed).toBe(false);
    expect(checkEmailPolicy('guest', 'intake').allowed).toBe(false);
  });
});
