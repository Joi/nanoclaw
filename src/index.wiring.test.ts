import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Source inspection tests for GIDC wiring in index.ts
// These tests verify that src/index.ts contains the required GIDC connection block
// and imports. They FAIL before the wiring is added, PASS after.

const indexSource = readFileSync(resolve(__dirname, './index.ts'), 'utf-8');

describe('GIDC wiring in index.ts', () => {
  describe('SLACK_3 config imports', () => {
    it('imports SLACK_3_BOT_TOKEN from config', () => {
      expect(indexSource).toContain('SLACK_3_BOT_TOKEN');
    });

    it('imports SLACK_3_APP_TOKEN from config', () => {
      expect(indexSource).toContain('SLACK_3_APP_TOKEN');
    });

    it('imports SLACK_3_NAMESPACE from config', () => {
      expect(indexSource).toContain('SLACK_3_NAMESPACE');
    });

    it('imports SLACK_3_SIGNING_SECRET from config', () => {
      expect(indexSource).toContain('SLACK_3_SIGNING_SECRET');
    });
  });

  describe('GIDC connection block', () => {
    it('has Third Slack workspace GIDC comment', () => {
      expect(indexSource).toContain('Third Slack workspace');
      expect(indexSource).toContain('GIDC');
    });

    it('has No onNewContact comment', () => {
      expect(indexSource).toContain('No onNewContact');
    });

    it('has GIDC guard clause with all three required tokens', () => {
      expect(indexSource).toMatch(
        /if\s*\(\s*SLACK_3_BOT_TOKEN\s*&&\s*SLACK_3_APP_TOKEN\s*&&\s*SLACK_3_NAMESPACE\s*\)/,
      );
    });

    it('creates SlackChannel with SLACK_3_BOT_TOKEN', () => {
      expect(indexSource).toContain('slackBotToken: SLACK_3_BOT_TOKEN');
    });

    it('creates SlackChannel with SLACK_3_APP_TOKEN', () => {
      expect(indexSource).toContain('slackAppToken: SLACK_3_APP_TOKEN');
    });

    it('creates SlackChannel with SLACK_3_SIGNING_SECRET', () => {
      expect(indexSource).toContain('slackSigningSecret: SLACK_3_SIGNING_SECRET');
    });

    it('creates SlackChannel with SLACK_3_NAMESPACE', () => {
      expect(indexSource).toContain('namespace: SLACK_3_NAMESPACE');
    });

    it('uses channelOpts spread in GIDC block', () => {
      // Find the GIDC block and verify it uses ...channelOpts
      const gidcBlockMatch = indexSource.match(
        /Third Slack workspace[\s\S]*?(?=\/\/ Telegram channel)/,
      );
      expect(gidcBlockMatch).not.toBeNull();
      expect(gidcBlockMatch![0]).toContain('...channelOpts');
    });

    it('logs success with namespace: SLACK_3_NAMESPACE', () => {
      expect(indexSource).toMatch(/logger\.info\(\s*\{\s*namespace:\s*SLACK_3_NAMESPACE/);
    });

    it('logs failure with namespace: SLACK_3_NAMESPACE', () => {
      expect(indexSource).toMatch(/logger\.error\(\s*\{\s*err.*namespace:\s*SLACK_3_NAMESPACE/);
    });

    it('GIDC block appears between SLACK_2 block and Telegram block', () => {
      const slack2Pos = indexSource.indexOf('Second Slack workspace (if configured)');
      const telegramPos = indexSource.indexOf('// Telegram channel');
      const gidcPos = indexSource.indexOf('Third Slack workspace');

      expect(slack2Pos).toBeGreaterThan(-1);
      expect(telegramPos).toBeGreaterThan(-1);
      expect(gidcPos).toBeGreaterThan(-1);

      // GIDC block must appear after SLACK_2 block and before Telegram
      expect(gidcPos).toBeGreaterThan(slack2Pos);
      expect(gidcPos).toBeLessThan(telegramPos);
    });
  });
});
