/**
 * Reminder Adapter for NanoClaw email channel.
 * Creates Apple Reminders via the existing EventKit bridge.
 */

import { callBridge, RemindersBridgeResult } from './reminders.js';
import { logger } from './logger.js';

export interface ReminderRequest {
  title: string;
  dueDate?: string; // YYYY-MM-DD
  notes?: string;
  listName?: string;
  priority?: number; // 1=high, 5=medium, 9=low
}

export interface ReminderResult {
  success: boolean;
  reminderId?: string;
  error?: string;
}

export class ReminderAdapter {
  /**
   * Create an Apple Reminder via the EventKit bridge.
   * Does NOT retry on failure (no silent duplicates).
   */
  createReminder(request: ReminderRequest): ReminderResult {
    const params: Record<string, unknown> = {
      title: request.title,
      list_name: request.listName ?? 'Inbox',
    };

    if (request.dueDate) params.due_date = request.dueDate;
    if (request.notes) params.notes = request.notes;
    if (request.priority !== undefined) params.priority = request.priority;

    const result: RemindersBridgeResult = callBridge('create_reminder', params);

    if (result.error) {
      logger.error({ error: result.error, title: request.title }, 'email-reminder: bridge error');
      return { success: false, error: result.error };
    }

    const reminderId = result.reminder_id as string | undefined;
    logger.info({ reminderId, title: request.title }, 'email-reminder: created');

    return {
      success: true,
      reminderId,
    };
  }
}
