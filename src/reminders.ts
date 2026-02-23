/**
 * Apple Reminders bridge for NanoClaw.
 * Calls the Python EventKit bridge script and manages snapshot caching.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

import { DATA_DIR } from "./config.js";

// Resolve paths relative to the project root (one level up from src/)
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, "scripts", "reminders-bridge.py");
const PYTHON_BIN = path.join(PROJECT_ROOT, ".venv", "bin", "python3");

export interface RemindersBridgeResult {
  error?: string;
  [key: string]: unknown;
}

/**
 * Call the Python reminders bridge with an operation and params.
 */
export function callBridge(
  operation: string,
  params: Record<string, unknown> = {},
): RemindersBridgeResult {
  const input = JSON.stringify({ operation, params });
  try {
    const result = execFileSync(PYTHON_BIN, [BRIDGE_SCRIPT], {
      input,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return JSON.parse(result.trim());
  } catch (err: unknown) {
    const execErr = err as { message: string; stderr?: Buffer | string };
    const stderr = execErr.stderr
      ? typeof execErr.stderr === 'string' ? execErr.stderr : execErr.stderr.toString()
      : '';
    const detail = stderr.trim() || execErr.message;
    return { error: `Bridge call failed: ${detail}` };
  }
}

/**
 * Write a reminders snapshot JSON file for a group's IPC directory.
 * The container MCP tool reads this for list_reminders.
 */
export function writeRemindersSnapshot(groupFolder: string): void {
  const ipcDir = path.join(DATA_DIR, "ipc", groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });

  const snapshot = callBridge("snapshot");
  if (snapshot.error) {
    console.error(
      `[reminders] Failed to write snapshot for ${groupFolder}: ${snapshot.error}`,
    );
    return;
  }

  const snapshotPath = path.join(ipcDir, "reminders_snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Process a reminders IPC request file from a container.
 * Returns the bridge result.
 */
export function processRemindersIpc(
  ipcFilePath: string,
  groupFolder: string,
): RemindersBridgeResult {
  const raw = fs.readFileSync(ipcFilePath, "utf-8");
  let request: { operation: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON in IPC file" };
  }

  const result = callBridge(request.operation, request.params || {});

  // After mutations, refresh the snapshot for the group
  if (
    ["create_reminder", "complete_reminder", "update_reminder"].includes(
      request.operation,
    )
  ) {
    writeRemindersSnapshot(groupFolder);
  }

  return result;
}
