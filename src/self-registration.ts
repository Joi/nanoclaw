/**
 * Self-Registration System for NanoClaw
 *
 * Detects registration intent, parses claimed names, looks up
 * the identity index, and creates claim YAML files.
 */
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface IdentityEntry {
  name: string;
  tier: string;
  domains: string[];
}

export interface RegistrationContext {
  senderJid: string;
  displayName: string;
  claimedName: string | null;
  platformEmail: string | null;
  matchedIdentity: IdentityEntry | null;
  channel: string;
  workspace: string;
}

export interface ClaimData {
  platform: string;
  workspace: string;
  user_id: string;
  display_name: string;
  claimed_identity: string | null;
  matched_people_file: string | null;
  platform_email: string | null;
  conversation_log: string;
  channel: string;
}

// Anchor "I'm" / "I am" patterns to an utterance start (string start or
// after a sentence boundary like .!?;,\n) so dependent clauses such as
// "the person I'm referring to" do NOT trigger self-registration.
//
// Bug history: the unanchored pattern matched the LINE message
//   "Here is the person I'm referring to: https://www.jst.go.jp/..."
// and parseClaimedName captured "referring to:" as the user's name
// (claim file 2026-04-30-line-Cd91...-U8c8...yaml).
const SENTENCE_BOUNDARY = String.raw`(?:^|[.!?;,\n]\s*)`;

// Patterns that indicate registration intent. The "I'm/I am" forms are
// anchored to utterance start; "add me"/"register me" remain word-boundary
// matches because they're already specific enough.
const REGISTRATION_PATTERNS = [
  /\badd\s+me\b/i,
  /\bregister\s+me\b/i,
  new RegExp(SENTENCE_BOUNDARY + String.raw`i['\u2019]m\s+\S`, 'i'),
  new RegExp(SENTENCE_BOUNDARY + String.raw`i\s+am\s+\S`, 'i'),
];

// Words that look like a name claim but obviously aren't. If the captured
// "I'm <X>" candidate's first word is in this set, the claim is rejected.
const NON_NAME_LEAD_WORDS: ReadonlySet<string> = new Set([
  // Continuative verbs that commonly follow "I'm"
  'going', 'getting', 'looking', 'thinking', 'doing', 'trying',
  'making', 'reading', 'writing', 'working', 'asking', 'saying',
  'telling', 'referring', 'pointing', 'talking',
  // Adverbs / hedges
  'about', 'still', 'just', 'really', 'always', 'never', 'maybe',
  // Negation / feeling words
  'not', 'sure', 'sorry', 'happy', 'tired', 'busy', 'fine', 'okay', 'ok', 'good',
  // Prepositions / articles
  'in', 'on', 'at', 'to', 'from', 'with', 'the', 'a', 'an', 'of', 'for',
  // Adverbs of place
  'here', 'there',
]);

/**
 * Heuristic: does this captured string look like a person's name?
 * Rejects empty, overly long, punctuated, or stopword-led candidates.
 */
function isNameLike(candidate: string): boolean {
  const trimmed = candidate.replace(/[.!?,;:]+$/, '').trim();
  if (!trimmed) return false;
  if (trimmed.length > 60) return false;
  if (/[:;()[\]/\\@<>{}|]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 5) return false;
  if (NON_NAME_LEAD_WORDS.has(words[0].toLowerCase())) return false;
  return true;
}

/**
 * Check if a message expresses registration intent.
 */
export function isRegistrationIntent(text: string): boolean {
  const cleaned = text.replace(/@\w+\s*/g, '').trim();
  return REGISTRATION_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/**
 * Extract a claimed name from "I'm [Name]" or "I am [Name]" patterns.
 * Returns null if no name claim is found OR if the captured value does
 * not look like a name (e.g., "referring to:", "going home", "not sure").
 *
 * The match is anchored to an utterance start so a self-introduction in
 * a dependent clause ("the person I'm referring to") is NOT treated as
 * a name claim. The capture stops at sentence-ending punctuation, colons,
 * commas, semicolons, or newlines so URLs and follow-on text are excluded.
 */
export function parseClaimedName(text: string): string | null {
  const cleaned = text.replace(/@\w+\s*/g, '').trim();
  const namePatterns = [
    new RegExp(SENTENCE_BOUNDARY + String.raw`i['\u2019]m\s+([^.!?;:,\n]+)`, 'i'),
    new RegExp(SENTENCE_BOUNDARY + String.raw`i\s+am\s+([^.!?;:,\n]+)`, 'i'),
  ];
  for (const pattern of namePatterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    const candidate = match[1].replace(/\s+/g, ' ').trim();
    if (!isNameLike(candidate)) continue;
    return candidate.replace(/[.!?,;:]+$/, '').trim() || null;
  }
  return null;
}

/**
 * Look up a JID or email key in the identity index.
 * Returns the matched identity entry, or null if not found.
 */
export function lookupIdentity(
  key: string,
  indexPath: string,
): IdentityEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    logger.warn({ indexPath }, 'self-registration: cannot read identity index');
    return null;
  }

  let index: Record<string, IdentityEntry>;
  try {
    index = JSON.parse(raw);
  } catch {
    logger.warn({ indexPath }, 'self-registration: invalid JSON in identity index');
    return null;
  }

  return index[key] ?? null;
}

/**
 * Write a claim YAML file to the claims directory.
 * Returns the full path to the created file.
 */
export function writeClaimFile(claim: ClaimData, claimsDir: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `${dateStr}-${claim.platform}-${claim.workspace}-${claim.user_id}.yaml`;
  const filePath = path.join(claimsDir, filename);

  const doc = {
    platform: claim.platform,
    workspace: claim.workspace,
    user_id: claim.user_id,
    display_name: claim.display_name,
    claimed_identity: claim.claimed_identity,
    matched_people_file: claim.matched_people_file,
    platform_email: claim.platform_email,
    conversation_log: claim.conversation_log,
    status: 'pending_review',
    created: now.toISOString(),
    channel: claim.channel,
  };

  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(doc));

  logger.info({ filePath, userId: claim.user_id }, 'self-registration: claim file created');
  return filePath;
}
