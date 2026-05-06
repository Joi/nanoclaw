/**
 * NeMo Guardrails Integration for NanoClaw
 * ==========================================
 * HTTP client for the NeMo Guardrails sidecar (localhost:3300).
 * 
 * Two integration points in the message pipeline:
 *   1. checkInput()  — called BEFORE runContainerAgent with the user prompt
 *   2. checkOutput() — called BEFORE sendMessage with the agent response
 * 
 * Fail-open design: if the sidecar is down, messages pass through.
 */

import { logger } from './logger.js';

const GUARDRAILS_URL = process.env.GUARDRAILS_URL || 'http://127.0.0.1:3300';
const GUARDRAILS_ENABLED = process.env.GUARDRAILS_ENABLED !== 'false';
const GUARDRAILS_TIMEOUT_MS = parseInt(process.env.GUARDRAILS_TIMEOUT_MS || '5000', 10);

interface CheckResult {
  allowed: boolean;
  reason?: string;
  engine?: string;
  snippet?: string;
}

async function callGuardrails(path: string, body: Record<string, string>): Promise<CheckResult> {
  if (!GUARDRAILS_ENABLED) {
    return { allowed: true, engine: 'disabled' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GUARDRAILS_TIMEOUT_MS);

    const response = await fetch(`${GUARDRAILS_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn({ status: response.status, path }, 'Guardrails sidecar error, failing open');
      return { allowed: true, engine: 'error' };
    }

    return await response.json() as CheckResult;
  } catch (err: unknown) {
    // Fail open: if sidecar is down, allow the message through
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('abort')) {
      logger.debug('Guardrails sidecar not reachable, failing open');
    } else {
      logger.warn({ err: message }, 'Guardrails check failed, failing open');
    }
    return { allowed: true, engine: 'unavailable' };
  }
}

/**
 * Check an incoming user message before it reaches the container agent.
 * Returns { allowed: true } if safe, { allowed: false, reason } if blocked.
 */
export async function checkInput(
  message: string,
  sender?: string,
  channel?: string,
): Promise<CheckResult> {
  const result = await callGuardrails('/v1/check/input', {
    message,
    sender: sender || 'unknown',
    channel: channel || 'unknown',
  });

  if (!result.allowed) {
    logger.warn(
      { sender, channel, reason: result.reason, engine: result.engine },
      'Input BLOCKED by guardrails',
    );
  }

  return result;
}

/**
 * Check an agent response before it is sent to the user.
 * Returns { allowed: true } if safe, { allowed: false, reason } if blocked.
 */
export async function checkOutput(
  inputMessage: string,
  outputMessage: string,
): Promise<CheckResult> {
  const result = await callGuardrails('/v1/check/output', {
    input_message: inputMessage,
    output_message: outputMessage,
  });

  if (!result.allowed) {
    logger.warn(
      { reason: result.reason, engine: result.engine },
      'Output BLOCKED by guardrails',
    );
  }

  return result;
}

/**
 * Check if the guardrails sidecar is healthy.
 */
export async function isHealthy(): Promise<boolean> {
  if (!GUARDRAILS_ENABLED) return true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${GUARDRAILS_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const data = await response.json() as { status: string };
    return data.status === 'ok';
  } catch {
    return false;
  }
}
