/**
 * Safety predicate for amplifier-remote dispatch.
 *
 * The amplifier-remote runner forwards prompts to amplifierd over HTTP, giving
 * the message sender access to a full Amplifier session (joi bundle = email,
 * vault, GTD, beads, qmd, senzing MCP, etc.). The blast radius if accidentally
 * dispatched in the wrong context is significant.
 *
 * This module enforces a 4-layer fail-closed predicate that ALL must hold
 * before dispatch:
 *
 *   1. Channel YAML opt-in (`engine === 'amplifier-remote'`)
 *   2. Owner floor (`floor === 'owner'` — group channels are guest/staff floor)
 *   3. DM channel pattern (`channel_name` ends in `-dm` AND `chat_jid` matches
 *      a known DM JID prefix per platform)
 *   4. Sender allowlist (`allowed_senders` non-empty AND `sender ∈ allowed_senders`
 *      AND `is_from_me === false`)
 *
 * Failure → caller logs structured warn `{layer, reason, sender, jid}` and
 * falls through to the claude-agent-sdk path (existing local container behavior).
 *
 * Threat model documented in:
 *   ~/switchboard/ops/jibot/channels/_SCHEMA.md (## Engine Routing)
 *
 * Related beads: joi-1l51 (epic), joi-1l51.6 (1Password creds migration).
 *
 * @added 2026-05-05 for joi-1l51 (NanoClaw → remote Amplifier session pipe)
 */

import type { ChannelConfig } from '../../channel-config.js';
import type { NewMessage } from '../../types.js';

export interface SafetyDecision {
  /** True iff all 4 layers pass. */
  ok: boolean;
  /** Human-readable reason — logged for the audit trail. Required even when ok=true. */
  reason: string;
  /** Which layer rejected (1-4). Undefined when ok=true. */
  layer?: 1 | 2 | 3 | 4;
}

/**
 * Recognize DM JIDs across the platforms NanoClaw currently bridges.
 * Per-platform conventions confirmed against src/channels/{signal,slack,whatsapp,line,...}.ts:
 *   - Signal:    `sig:+E.164` for DM  (`sig:group:...` for group)
 *   - WhatsApp:  `whatsapp:` prefix + `+` somewhere in the JID for DM (`@g.us` = group)
 *   - iMessage:  `imsg:+E.164`
 *   - LINE:      `line:dm:U...` for DM (`line:C...` or `line:R...` for group)
 *   - Slack:     `slack:{ws}:dm:U...` for DM (`slack:{ws}:channel:C...` for channel)
 *
 * Discord (`dc:`) and Telegram (`tg:`) are NOT in the DM allowlist — Amplifier-remote
 * dispatch on those platforms would need a per-platform DM-detection extension first.
 */
export function isDmJid(jid: string): boolean {
  if (!jid) return false;
  return (
    /^sig:\+/.test(jid) ||
    (/^whatsapp:/.test(jid) && jid.includes('+')) ||
    /^imsg:\+/.test(jid) ||
    /^line:dm:/.test(jid) ||
    /^slack:[^:]+:dm:/.test(jid)
  );
}

/**
 * Run the 4-layer safety predicate. Returns a SafetyDecision the caller logs verbatim.
 *
 * IMPORTANT: This is FAIL-CLOSED. Any uncertainty → reject. The caller must
 * treat `ok: false` as "do NOT route to amplifier-remote" without exception.
 */
export function isAmplifierRemoteAllowed(
  cfg: ChannelConfig,
  msg: NewMessage,
): SafetyDecision {
  // ── Layer 1: channel opt-in ───────────────────────────────────────────────
  if (cfg.engine !== 'amplifier-remote') {
    return {
      ok: false,
      reason: `engine=${cfg.engine ?? 'unset'} (must be 'amplifier-remote')`,
      layer: 1,
    };
  }

  // ── Layer 2: owner-floor channel ──────────────────────────────────────────
  if (cfg.floor !== 'owner') {
    return {
      ok: false,
      reason: `floor=${cfg.floor} (must be 'owner')`,
      layer: 2,
    };
  }

  // ── Layer 3: DM channel pattern ───────────────────────────────────────────
  if (!cfg.channel_name.endsWith('-dm')) {
    return {
      ok: false,
      reason: `channel_name=${cfg.channel_name} (must end in '-dm')`,
      layer: 3,
    };
  }
  if (!isDmJid(msg.chat_jid)) {
    return {
      ok: false,
      reason: `chat_jid=${msg.chat_jid} (does not match known DM JID pattern)`,
      layer: 3,
    };
  }

  // ── Layer 4: sender allowlist + not-from-self ────────────────────────────
  if (msg.is_from_me) {
    return {
      ok: false,
      reason: 'is_from_me=true (message originated from jibot itself)',
      layer: 4,
    };
  }
  if (!cfg.allowed_senders || cfg.allowed_senders.length === 0) {
    return {
      ok: false,
      reason: 'allowed_senders is empty or missing (fail-closed default)',
      layer: 4,
    };
  }
  if (!cfg.allowed_senders.includes(msg.sender)) {
    return {
      ok: false,
      reason: `sender=${msg.sender} not in allowed_senders=[${cfg.allowed_senders.join(', ')}]`,
      layer: 4,
    };
  }

  // ── All 4 layers passed ──────────────────────────────────────────────────
  return {
    ok: true,
    reason: 'all 4 layers pass: engine=amplifier-remote, floor=owner, DM channel, sender allowlisted',
  };
}
