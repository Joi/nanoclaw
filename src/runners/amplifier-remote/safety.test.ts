import { describe, it, expect } from 'vitest';
import {
  isAmplifierRemoteAllowed,
  isDmJid,
  type SafetyDecision,
} from './safety.js';
import type { ChannelConfig } from '../../channel-config.js';
import type { NewMessage } from '../../types.js';

// ────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────────────────

/** A fully-allowed signal-joi-dm config — passes all 4 layers when paired with okMsg() */
function joiDmConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    platform: 'signal',
    workspace: '',
    channel_id: 'sig:+819048411965',
    channel_name: 'joi-dm',
    floor: 'owner',
    domains: [],
    listening_mode: 'active',
    sender_policy: 'allow',
    access: { reminders: true, bookmarks: true, email: true, calendar: false, file_serving: false, intake: true },
    members: { joi: { tier: 'owner' } },
    engine: 'amplifier-remote',
    allowed_senders: ['+819048411965'],
    ...overrides,
  };
}

/** A message from Joi's verified Signal — passes layer 4 with joiDmConfig() */
function okMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'sig:+819048411965',
    sender: '+819048411965',
    sender_name: 'Joi',
    content: 'hello',
    timestamp: '2026-05-05T18:30:00Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// isDmJid: regex matches per-platform DM patterns
// ────────────────────────────────────────────────────────────────────────────

describe('isDmJid', () => {
  it('accepts Signal DM (sig:+E.164)', () => {
    expect(isDmJid('sig:+819048411965')).toBe(true);
  });
  it('rejects Signal group (sig:group:...)', () => {
    expect(isDmJid('sig:group:abc123')).toBe(false);
  });
  it('accepts WhatsApp DM (+E.164 in JID)', () => {
    expect(isDmJid('whatsapp:+15551234@s.whatsapp.net')).toBe(true);
  });
  it('rejects WhatsApp group (no + in JID)', () => {
    expect(isDmJid('whatsapp:120363399876069532@g.us')).toBe(false);
  });
  it('accepts iMessage DM (imsg:+E.164)', () => {
    expect(isDmJid('imsg:+15551234')).toBe(true);
  });
  it('accepts LINE DM (line:dm:U...)', () => {
    expect(isDmJid('line:dm:U1f27abc')).toBe(true);
  });
  it('rejects LINE group (line:C...)', () => {
    expect(isDmJid('line:C988cec')).toBe(false);
  });
  it('accepts Slack DM (slack:ws:dm:U...)', () => {
    expect(isDmJid('slack:joiito:dm:U123ABC')).toBe(true);
  });
  it('rejects Slack channel (slack:ws:channel:C...)', () => {
    expect(isDmJid('slack:joiito:channel:C030BV6SM')).toBe(false);
  });
  it('rejects Discord (no DM pattern in fleet)', () => {
    expect(isDmJid('dc:1493530518766096434:1493530518766096434')).toBe(false);
  });
  it('rejects Telegram (no DM pattern in fleet)', () => {
    expect(isDmJid('tg:-1001234567890')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isDmJid('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isAmplifierRemoteAllowed: 4-layer safety predicate
// ────────────────────────────────────────────────────────────────────────────

describe('isAmplifierRemoteAllowed — happy path', () => {
  it('passes when all 4 layers hold (signal-joi-dm + Joi sender)', () => {
    const decision = isAmplifierRemoteAllowed(joiDmConfig(), okMsg());
    expect(decision.ok).toBe(true);
    expect(decision.layer).toBeUndefined();
  });
});

describe('isAmplifierRemoteAllowed — Layer 1 (engine opt-in)', () => {
  it('refuses when engine is undefined', () => {
    const cfg = joiDmConfig({ engine: undefined });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(1);
    expect(decision.reason).toMatch(/engine/);
  });

  it('refuses when engine is claude-agent-sdk (default)', () => {
    const cfg = joiDmConfig({ engine: 'claude-agent-sdk' });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(1);
  });
});

describe('isAmplifierRemoteAllowed — Layer 2 (owner floor)', () => {
  it('refuses when floor is guest', () => {
    const cfg = joiDmConfig({ floor: 'guest' });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(2);
    expect(decision.reason).toMatch(/floor/);
  });

  it('refuses when floor is staff', () => {
    const cfg = joiDmConfig({ floor: 'staff' });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(2);
  });

  it('refuses when floor is admin (owner only)', () => {
    const cfg = joiDmConfig({ floor: 'admin' });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(2);
  });
});

describe('isAmplifierRemoteAllowed — Layer 3 (DM channel pattern)', () => {
  it('refuses when channel_name does not end in -dm', () => {
    const cfg = joiDmConfig({ channel_name: 'jibot' });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(3);
    expect(decision.reason).toMatch(/-dm|dm/i);
  });

  it('refuses when chat_jid is a Slack channel (group), not DM', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig(),
      okMsg({ chat_jid: 'slack:joiito:channel:C030BV6SM' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(3);
  });

  it('refuses when chat_jid is a WhatsApp group (no + in JID)', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig(),
      okMsg({ chat_jid: 'whatsapp:120363399876069532@g.us' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(3);
  });

  it('refuses when chat_jid is a Signal group', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig(),
      okMsg({ chat_jid: 'sig:group:abc123' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(3);
  });
});

describe('isAmplifierRemoteAllowed — Layer 4 (sender allowlist + not-from-self)', () => {
  it('refuses when message is from jibot itself', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig(),
      okMsg({ is_from_me: true }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(4);
    expect(decision.reason).toMatch(/from_me|self/i);
  });

  it('refuses when allowed_senders is missing', () => {
    const cfg = joiDmConfig({ allowed_senders: undefined });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(4);
    expect(decision.reason).toMatch(/allowed[_ ]senders/i);
  });

  it('refuses when allowed_senders is empty array', () => {
    const cfg = joiDmConfig({ allowed_senders: [] });
    const decision = isAmplifierRemoteAllowed(cfg, okMsg());
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(4);
  });

  it('refuses when sender is not in allowed_senders', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig(),
      okMsg({ sender: '+15551234' }),
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(4);
    expect(decision.reason).toMatch(/sender|allowed/i);
  });
});

describe('isAmplifierRemoteAllowed — combined attacker scenarios', () => {
  it('blocks @jibot mention in a Slack guest-floor channel even if engine flag injected', () => {
    // Worst case: someone YAML-injects engine: amplifier-remote on a group channel.
    // Layers 2+3+4 must still defend.
    const cfg: ChannelConfig = {
      platform: 'slack',
      workspace: 'joiito',
      channel_id: 'slack:joiito:channel:C030BV6SM',
      channel_name: 'jibot',  // not -dm
      floor: 'guest',         // not owner
      domains: [],
      listening_mode: 'attentive',
      sender_policy: 'trigger',
      access: { reminders: false, bookmarks: false, email: false, calendar: false, file_serving: false, intake: false },
      members: {},
      engine: 'amplifier-remote',           // attacker injected
      allowed_senders: ['some-attacker'],   // attacker injected
    };
    const decision = isAmplifierRemoteAllowed(cfg, okMsg({
      sender: 'some-attacker',
      chat_jid: 'slack:joiito:channel:C030BV6SM',
    }));
    expect(decision.ok).toBe(false);
    // Layer 2 catches first (floor)
    expect(decision.layer).toBe(2);
  });

  it('blocks spoofed sender even on otherwise-correct DM channel', () => {
    const decision = isAmplifierRemoteAllowed(
      joiDmConfig({ allowed_senders: ['+819048411965'] }),
      okMsg({ sender: '+15551234567' }),  // not Joi
    );
    expect(decision.ok).toBe(false);
    expect(decision.layer).toBe(4);
  });
});
