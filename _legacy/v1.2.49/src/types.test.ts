import { describe, it, expect } from 'vitest';
import type { RegisteredGroup } from './types.js';

describe('RegisteredGroup tier capability fields', () => {
  it('supports calendarAccess field', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
      calendarAccess: true,
    };
    expect(group.calendarAccess).toBe(true);
  });

  it('supports fileServingAccess field', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
      fileServingAccess: true,
    };
    expect(group.fileServingAccess).toBe(true);
  });

  it('supports intakeAccess field', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
      intakeAccess: true,
    };
    expect(group.intakeAccess).toBe(true);
  });

  it('supports channelMode listening value', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
      channelMode: 'listening',
    };
    expect(group.channelMode).toBe('listening');
  });

  it('supports channelMode available value', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
      channelMode: 'available',
    };
    expect(group.channelMode).toBe('available');
  });

  it('allows undefined optional fields (backwards compatible)', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Bot',
      added_at: '2024-01-01',
    };
    expect(group.calendarAccess).toBeUndefined();
    expect(group.fileServingAccess).toBeUndefined();
    expect(group.intakeAccess).toBeUndefined();
    expect(group.channelMode).toBeUndefined();
  });
});
