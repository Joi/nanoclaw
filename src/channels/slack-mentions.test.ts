import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), statSync: vi.fn() },
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import fs from 'fs';
import { compactSlackMentions, resetSlackMentionsCache } from './slack-mentions.js';

const INDEX = JSON.stringify({
  // gidc workspace
  'slack:gidc:U001': {
    name: 'seanbonner',
    handle: 'sean',
    first_name: 'Sean',
    last_name: 'Bonner',
  },
  'slack:gidc:U002': {
    name: 'jpphillips',
    handle: 'rejon',
    first_name: 'Jon',
    last_name: 'Phillips',
  },
  // Two Marks across namespaces — first-name "mark" should NOT be aliased
  'slack:gidc:U003': {
    name: 'markk',
    first_name: 'Mark',
    last_name: 'Knopfler',
  },
  'slack:other:U004': {
    name: 'markz',
    first_name: 'Mark',
    last_name: 'Zuckerberg',
  },
  // Channel entries should be ignored
  'slack:gidc:channel:C001': { name: 'general' },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSlackMentionsCache();
  (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 1 });
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(INDEX);
});

describe('compactSlackMentions', () => {
  it('replaces @name (concatenated form) with Slack mention', () => {
    expect(compactSlackMentions('hi @seanbonner')).toBe('hi <@U001>');
  });

  it('replaces @handle', () => {
    expect(compactSlackMentions('cc @sean')).toBe('cc <@U001>');
  });

  it('replaces "@First Last" form', () => {
    expect(compactSlackMentions('thanks @Sean Bonner')).toBe('thanks <@U001>');
  });

  it('replaces unique first-name @Sean (no collisions in this test)', () => {
    expect(compactSlackMentions('hello @Sean')).toBe('hello <@U001>');
  });

  it('does NOT replace @Mark when it collides across users (two Marks)', () => {
    // Both U003 and U004 have first_name=Mark — the regression guard
    expect(compactSlackMentions('ping @Mark')).toBe('ping @Mark');
  });

  it('still replaces @markk (concatenated full name) when first-name collides', () => {
    expect(compactSlackMentions('ping @markk')).toBe('ping <@U003>');
  });

  it('handles longest-first matching: "Sean Bonner" beats "Sean"', () => {
    // If "Sean" matched first the result would be "<@U001> Bonner".
    expect(compactSlackMentions('hi @Sean Bonner!')).toBe('hi <@U001>!');
  });

  it('case-insensitive', () => {
    expect(compactSlackMentions('hey @SEANBONNER')).toBe('hey <@U001>');
    expect(compactSlackMentions('hey @sean')).toBe('hey <@U001>');
  });

  it("doesn't munge @SeanBonner123 (longer arbitrary token)", () => {
    // The trailing "123" makes this not match @seanbonner because of the
    // word-boundary lookahead.
    expect(compactSlackMentions('user @SeanBonner123 typed')).toBe('user @SeanBonner123 typed');
  });

  it('replaces multiple distinct mentions in one message', () => {
    expect(compactSlackMentions('cc @sean and @rejon')).toBe('cc <@U001> and <@U002>');
  });

  it('passes through text with no mentions', () => {
    expect(compactSlackMentions('plain message')).toBe('plain message');
    expect(compactSlackMentions('email me at foo@bar.com')).toBe('email me at foo@bar.com');
  });

  it('handles empty/short inputs', () => {
    expect(compactSlackMentions('')).toBe('');
    expect(compactSlackMentions('@')).toBe('@');
  });

  it('returns input unchanged when index is missing', () => {
    (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const err = new Error('ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    });
    expect(compactSlackMentions('hi @sean')).toBe('hi @sean');
  });

  it('returns input unchanged when index is unparseable', () => {
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not json');
    expect(compactSlackMentions('hi @sean')).toBe('hi @sean');
  });

  it('caches across calls when mtime is unchanged', () => {
    compactSlackMentions('@sean');
    compactSlackMentions('@sean again');
    // statSync called twice (once per invocation), readFileSync only once
    expect((fs.statSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('reloads when mtime changes', () => {
    compactSlackMentions('@sean');
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 2 });
    compactSlackMentions('@sean');
    expect((fs.readFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
