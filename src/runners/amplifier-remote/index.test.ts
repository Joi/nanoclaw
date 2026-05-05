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
