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

describe('GIDC intake pipeline wiring in index.ts', () => {
  describe('intake imports', () => {
    it("imports writeIntakeFile from intake.js", () => {
      expect(indexSource).toContain("from './intake.js'");
      expect(indexSource).toContain('writeIntakeFile');
    });

    it("imports shouldRunIntake from intake-routing.js", () => {
      expect(indexSource).toContain("from './intake-routing.js'");
      expect(indexSource).toContain('shouldRunIntake');
    });
  });

  describe('GIDC intake block in onMessage', () => {
    it("checks chatJid starts with slack:gidc:", () => {
      expect(indexSource).toContain("chatJid.startsWith('slack:gidc:')");
    });

    it("checks group.intakeAccess", () => {
      expect(indexSource).toContain('group.intakeAccess');
    });

    it("calls shouldRunIntake with channelMode and false", () => {
      expect(indexSource).toContain('shouldRunIntake(group.channelMode, false)');
    });

    it("calls writeIntakeFile with confidentialRoot", () => {
      expect(indexSource).toContain('writeIntakeFile(confidentialRoot,');
    });

    it("derives workstream from group.folder split on dash", () => {
      expect(indexSource).toContain("group.folder.split('-')[0]");
    });

    it("derives confidentialRoot using process.env.HOME and switchboard/confidential", () => {
      expect(indexSource).toContain("process.env.HOME || '/Users/jibot'");
      expect(indexSource).toContain('switchboard/confidential');
    });

    it("uses try/catch with logger.warn on error in GIDC intake block", () => {
      const intakeBlock = indexSource.match(
        /\/\/ GIDC intake[\s\S]*?(?=\/\/ jibrain intake)/,
      );
      expect(intakeBlock).not.toBeNull();
      expect(intakeBlock![0]).toContain('try {');
      expect(intakeBlock![0]).toContain('catch');
      expect(intakeBlock![0]).toContain('logger.warn');
    });

    it("GIDC intake block appears BEFORE jibrain intake block in onMessage", () => {
      const gidcIntakePos = indexSource.indexOf('// GIDC intake');
      const jibrainIntakePos = indexSource.indexOf('// jibrain intake');

      expect(gidcIntakePos).toBeGreaterThan(-1);
      expect(jibrainIntakePos).toBeGreaterThan(-1);
      expect(gidcIntakePos).toBeLessThan(jibrainIntakePos);
    });

    it("passes author from msg.sender_name in writeIntakeFile call", () => {
      const intakeBlock = indexSource.match(
        /writeIntakeFile\(confidentialRoot,[\s\S]*?\}\s*\)/,
      );
      expect(intakeBlock).not.toBeNull();
      expect(intakeBlock![0]).toContain('msg.sender_name');
    });

    it("passes text from msg.content in writeIntakeFile call", () => {
      const intakeBlock = indexSource.match(
        /writeIntakeFile\(confidentialRoot,[\s\S]*?\}\s*\)/,
      );
      expect(intakeBlock).not.toBeNull();
      expect(intakeBlock![0]).toContain('msg.content');
    });

    it("passes timestamp from msg.timestamp in writeIntakeFile call", () => {
      const intakeBlock = indexSource.match(
        /writeIntakeFile\(confidentialRoot,[\s\S]*?\}\s*\)/,
      );
      expect(intakeBlock).not.toBeNull();
      expect(intakeBlock![0]).toContain('msg.timestamp');
    });
  });
});

describe('@gibot mode/scan command handling in processGroupMessages', () => {
  describe('import', () => {
    it('imports parseGidcCommand from gidc-commands.js', () => {
      expect(indexSource).toContain("from './gidc-commands.js'");
      expect(indexSource).toContain('parseGidcCommand');
    });
  });

  describe('command detection block', () => {
    it('checks chatJid starts with slack:gidc: and missedMessages.length === 1', () => {
      expect(indexSource).toContain("chatJid.startsWith('slack:gidc:')");
      expect(indexSource).toContain('missedMessages.length === 1');
    });

    it('calls parseGidcCommand on the last message content', () => {
      expect(indexSource).toContain('parseGidcCommand(');
    });
  });

  describe('mode command handler', () => {
    it('updates group.channelMode with cmd.value', () => {
      expect(indexSource).toContain('group.channelMode = cmd.value');
    });

    it('persists the group via setRegisteredGroup', () => {
      expect(indexSource).toContain('setRegisteredGroup(chatJid, group)');
    });

    it('sends listening mode confirmation message', () => {
      expect(indexSource).toContain('All messages will be captured as intake.');
    });

    it('sends available mode confirmation message', () => {
      expect(indexSource).toContain('Intake only runs on explicit command.');
    });
  });

  describe('scan command handler', () => {
    it('sends Starting QMD re-index scan... message', () => {
      expect(indexSource).toContain('Starting QMD re-index scan...');
    });

    it('calls execFile with qmd and index --all', () => {
      expect(indexSource).toContain("'qmd'");
      expect(indexSource).toContain("'index'");
      expect(indexSource).toContain("'--all'");
    });
  });

  describe('command handler placement', () => {
    it('GIDC command block appears BEFORE formatMessages call in processGroupMessages', () => {
      const processFnMatch = indexSource.match(
        /async function processGroupMessages[\s\S]*?(?=async function runAgent)/,
      );
      expect(processFnMatch).not.toBeNull();
      const fn = processFnMatch![0];
      const cmdBlockPos = fn.indexOf('parseGidcCommand(');
      const formatMessagesPos = fn.indexOf('formatMessages(');
      expect(cmdBlockPos).toBeGreaterThan(-1);
      expect(formatMessagesPos).toBeGreaterThan(-1);
      expect(cmdBlockPos).toBeLessThan(formatMessagesPos);
    });
  });
});
