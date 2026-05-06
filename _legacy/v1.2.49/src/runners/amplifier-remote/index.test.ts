import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the client (createSession + executePrompt)
vi.mock('./client.js', () => ({
  createSession: vi.fn(),
  executePrompt: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createSession, executePrompt } from './client.js';
import { runAmplifierRemoteAgent } from './index.js';
import type { RegisteredGroup, NewMessage } from '../../types.js';
import type { ContainerInput, ContainerOutput } from '../../container-runner.js';

const TEST_GROUP: RegisteredGroup = {
  name: 'joi-dm',
  folder: 'joi-dm',
  trigger: 'jibot',
  added_at: '2026-05-05T00:00:00Z',
  isMain: false,
};

function makeInput(prompt: string = 'hello'): ContainerInput {
  return {
    prompt,
    groupFolder: 'joi-dm',
    chatJid: 'sig:+819048411965',
    isMain: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// Happy path: createSession + executePrompt → ContainerOutput
// ────────────────────────────────────────────────────────────────────────────

describe('runAmplifierRemoteAgent — happy path', () => {
  it('creates a session, executes the prompt, returns ContainerOutput', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('session-abc-123');
    (executePrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ response: 'reply text' });

    const result = await runAmplifierRemoteAgent(TEST_GROUP, makeInput('what time is it?'));

    expect(result.status).toBe('success');
    expect(result.result).toBe('reply text');
    expect(result.newSessionId).toBe('session-abc-123');

    expect(createSession).toHaveBeenCalledWith('joi', expect.objectContaining({
      folder: 'joi-dm',
      chatJid: 'sig:+819048411965',
    }));
    expect(executePrompt).toHaveBeenCalledWith('session-abc-123', 'what time is it?');
  });

  it('reuses an existing sessionId when provided in input.sessionId', async () => {
    (executePrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ response: 'follow-up reply' });

    const input: ContainerInput = { ...makeInput('follow-up'), sessionId: 'existing-session' };
    const result = await runAmplifierRemoteAgent(TEST_GROUP, input);

    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('existing-session');
    expect(createSession).not.toHaveBeenCalled();
    expect(executePrompt).toHaveBeenCalledWith('existing-session', 'follow-up');
  });

  it('fires onOutput callback with the ContainerOutput', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('session-xyz');
    (executePrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ response: 'streamed reply' });

    const onOutput = vi.fn().mockResolvedValue(undefined);
    await runAmplifierRemoteAgent(TEST_GROUP, makeInput(), onOutput);

    expect(onOutput).toHaveBeenCalledTimes(1);
    const [callArg] = (onOutput as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArg.status).toBe('success');
    expect(callArg.result).toBe('streamed reply');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error paths: failures during createSession or executePrompt
// ────────────────────────────────────────────────────────────────────────────

describe('runAmplifierRemoteAgent — error handling', () => {
  it('returns ContainerOutput error when createSession fails', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('amplifierd 401 on createSession'));

    const result = await runAmplifierRemoteAgent(TEST_GROUP, makeInput());

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toMatch(/401|createSession/);
  });

  it('returns ContainerOutput error when executePrompt fails', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('session-id');
    (executePrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('amplifierd 500 on executePrompt'));

    const result = await runAmplifierRemoteAgent(TEST_GROUP, makeInput());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/500|executePrompt/);
  });

  it('error result is still passed to onOutput callback', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const onOutput = vi.fn().mockResolvedValue(undefined);
    await runAmplifierRemoteAgent(TEST_GROUP, makeInput(), onOutput);

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect((onOutput as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe('error');
  });
});


// ────────────────────────────────────────────────────────────────────────────
// Stale-session auto-recovery (added 2026-05-05 after live-test discovery)
// ────────────────────────────────────────────────────────────────────────────
//
// NanoClaw stores session_id per group_folder in SQLite messages.db. That
// session ID can outlive its amplifierd peer (amplifierd restart, hot-replace,
// daily session cleanup), causing executePrompt to throw "amplifierd 404
// session not found". The runner should detect this, drop the stale ID, create
// a fresh session, and retry once.

describe('runAmplifierRemoteAgent — stale session auto-recovery', () => {
  it('on 404 with reused session, creates a fresh session and retries', async () => {
    (executePrompt as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("amplifierd 404 on executePrompt: Session 'abc-stale' not found"))
      .mockResolvedValueOnce({ response: 'recovered reply' });
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('fresh-session-id');

    const input: ContainerInput = { ...makeInput(), sessionId: 'abc-stale' };
    const result = await runAmplifierRemoteAgent(TEST_GROUP, input);

    expect(result.status).toBe('success');
    expect(result.result).toBe('recovered reply');
    expect(result.newSessionId).toBe('fresh-session-id');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(executePrompt).toHaveBeenCalledTimes(2);
    expect((executePrompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('abc-stale');
    expect((executePrompt as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('fresh-session-id');
  });

  it('on "Session Not Found" pattern, also rotates and retries', async () => {
    (executePrompt as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('amplifierd 404 on executePrompt: {"detail":{"title":"Session Not Found"}}'))
      .mockResolvedValueOnce({ response: 'ok' });
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('fresh-id');

    const result = await runAmplifierRemoteAgent(
      TEST_GROUP,
      { ...makeInput(), sessionId: 'stale' },
    );
    expect(result.status).toBe('success');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on non-stale errors (e.g. 401, 500, network)', async () => {
    (executePrompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('amplifierd 401 on executePrompt: invalid x-api-key'),
    );

    const result = await runAmplifierRemoteAgent(
      TEST_GROUP,
      { ...makeInput(), sessionId: 'some-id' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/401/);
    expect(createSession).not.toHaveBeenCalled();
    expect(executePrompt).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when there was no cached sessionId (just-created session must be valid)', async () => {
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('new-id');
    (executePrompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("amplifierd 404 on executePrompt: Session 'new-id' not found"),
    );

    const input: ContainerInput = { ...makeInput() }; // no sessionId
    const result = await runAmplifierRemoteAgent(TEST_GROUP, input);

    expect(result.status).toBe('error');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(executePrompt).toHaveBeenCalledTimes(1);
  });

  it('on retry-also-fails, returns error from the retry attempt', async () => {
    (executePrompt as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("amplifierd 404 on executePrompt: Session 'stale' not found"))
      .mockRejectedValueOnce(new Error('amplifierd 500 on executePrompt: server crashed'));
    (createSession as ReturnType<typeof vi.fn>).mockResolvedValue('fresh-id');

    const result = await runAmplifierRemoteAgent(
      TEST_GROUP,
      { ...makeInput(), sessionId: 'stale' },
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/500|server crashed/);
  });
});
