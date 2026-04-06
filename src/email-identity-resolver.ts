/**
 * Email Identity Resolver for NanoClaw email channel.
 * Maps sender email → NanoClaw identity and tier.
 *
 * Resolution order:
 * 1. Look up "email:<address>" in identity-index.json (primary source of truth)
 * 2. If not found, check the email alias map for alternate addresses
 * 3. If still unresolved, return { resolved: false }
 */

import fs from 'fs';

import { loadEmailAliasMap, resolveEmailAlias, AliasEntry } from './email-alias-map.js';
import { logger } from './logger.js';

export interface IdentityResult {
  resolved: boolean;
  identity?: string;
  tier?: string;
  name?: string;
}

interface IdentityEntry {
  tier: string;
  name?: string;
  domains?: string[];
}

export class EmailIdentityResolver {
  private identityIndexPath: string;
  private aliasMapPath: string;
  private identityIndex: Record<string, IdentityEntry> = {};
  private aliasMap: Map<string, AliasEntry> = new Map();

  constructor(identityIndexPath: string, aliasMapPath: string) {
    this.identityIndexPath = identityIndexPath;
    this.aliasMapPath = aliasMapPath;
    this.reload();
  }

  /**
   * Reload both the identity index and alias map from disk.
   */
  reload(): void {
    // Load identity-index.json
    try {
      const raw = fs.readFileSync(this.identityIndexPath, 'utf-8');
      this.identityIndex = JSON.parse(raw) as Record<string, IdentityEntry>;
    } catch {
      this.identityIndex = {};
      logger.debug({ path: this.identityIndexPath }, 'email-identity: could not load identity-index');
    }

    // Load alias map
    this.aliasMap = loadEmailAliasMap(this.aliasMapPath);
  }

  /**
   * Resolve a sender email address to a NanoClaw identity.
   * Returns { resolved: true, tier, name, identity } or { resolved: false }.
   */
  resolve(senderEmail: string): IdentityResult {
    const email = senderEmail.toLowerCase().trim();

    // Step 1: Check identity-index.json with "email:" prefix
    const jid = `email:${email}`;
    const indexEntry = this.identityIndex[jid];
    if (indexEntry) {
      logger.debug({ email, tier: indexEntry.tier }, 'email-identity: resolved via identity-index');
      return {
        resolved: true,
        identity: jid,
        tier: indexEntry.tier,
        name: indexEntry.name,
      };
    }

    // Step 2: Check alias map
    const aliasEntry = resolveEmailAlias(email, this.aliasMap);
    if (aliasEntry) {
      logger.debug({ email, identity: aliasEntry.identity }, 'email-identity: resolved via alias map');
      return {
        resolved: true,
        identity: aliasEntry.identity,
        tier: aliasEntry.tier,
        name: aliasEntry.name,
      };
    }

    // Step 3: Unresolved
    logger.debug({ email }, 'email-identity: unresolved sender');
    return { resolved: false };
  }
}
