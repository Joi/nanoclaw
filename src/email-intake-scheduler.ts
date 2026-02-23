/**
 * Email intake scheduler.
 * Runs pollEmailIntake() on a fixed interval alongside the main process.
 */

import {
  EMAIL_INTAKE_ENABLED,
  EMAIL_INTAKE_POLL_INTERVAL,
} from './config.js';
import { ensureEmailLabel, pollEmailIntake } from './email-intake.js';
import { logger } from './logger.js';

let running = false;

export function startEmailIntakeLoop(): void {
  if (!EMAIL_INTAKE_ENABLED) {
    logger.info('Email intake disabled via EMAIL_INTAKE_ENABLED');
    return;
  }
  if (running) {
    logger.debug('Email intake loop already running, skipping duplicate start');
    return;
  }
  running = true;
  logger.info('Email intake loop started');

  // Initial run: ensure label, then first poll
  (async () => {
    try {
      await ensureEmailLabel();
    } catch (err) {
      logger.error({ err }, 'Email intake: failed to ensure label');
    }
    try {
      await pollEmailIntake();
    } catch (err) {
      logger.error({ err }, 'Email intake: error in initial poll');
    }
  })();

  // Subsequent polls
  setInterval(async () => {
    try {
      await pollEmailIntake();
    } catch (err) {
      logger.error({ err }, 'Email intake: error in poll');
    }
  }, EMAIL_INTAKE_POLL_INTERVAL);
}
