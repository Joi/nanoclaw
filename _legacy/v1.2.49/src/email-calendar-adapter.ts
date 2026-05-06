/**
 * Calendar Adapter for NanoClaw email channel.
 * Creates Google Calendar events via the gog CLI.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const GOG_TIMEOUT = 30_000;

export interface CalendarAdapterOpts {
  gogBin: string;
  account: string;
  calendarId: string;
  keyringPassword: string;
}

export interface CalendarRequest {
  summary: string;
  startTime: string; // RFC3339
  endTime: string;   // RFC3339
  description?: string;
  attendees?: string[];
  location?: string;
}

export interface CalendarResult {
  success: boolean;
  eventId?: string;
  htmlLink?: string;
  error?: string;
}

export class CalendarAdapter {
  private opts: CalendarAdapterOpts;

  constructor(opts: CalendarAdapterOpts) {
    this.opts = opts;
  }

  /**
   * Create a Google Calendar event.
   * Returns success/failure with event details or error message.
   * Does NOT retry on failure (no silent duplicates).
   */
  async createEvent(request: CalendarRequest): Promise<CalendarResult> {
    const args = [
      'calendar', 'create', this.opts.calendarId,
      '--account', this.opts.account,
      '--summary', request.summary,
      '--from', request.startTime,
      '--to', request.endTime,
      '-j', '-y',
    ];

    if (request.description) {
      args.push('--description', request.description);
    }
    if (request.attendees && request.attendees.length > 0) {
      args.push('--attendees', request.attendees.join(','));
      args.push('--send-updates', 'all');
    }
    if (request.location) {
      args.push('--location', request.location);
    }

    try {
      const { stdout } = await execFileAsync(this.opts.gogBin, args, {
        env: { ...process.env, GOG_KEYRING_PASSWORD: this.opts.keyringPassword },
        encoding: 'utf-8',
        timeout: GOG_TIMEOUT,
      });

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // If gog doesn't return JSON, still consider success if no error thrown
      }

      logger.info(
        { eventId: parsed.id, summary: request.summary },
        'email-calendar: event created',
      );

      return {
        success: true,
        eventId: parsed.id as string | undefined,
        htmlLink: parsed.htmlLink as string | undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, summary: request.summary }, 'email-calendar: failed to create event');
      return {
        success: false,
        error: msg,
      };
    }
  }
}
