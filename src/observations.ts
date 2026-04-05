/**
 * Community Knowledge Observation System for NanoClaw
 *
 * Handles observation detection via IPC tasks and staging to
 * pending observation files for owner triage.
 */
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface ObservationData {
  person_name: string;
  entity_id?: string;
  observation_text: string;
  source: string;
  contributed_by: string;
  discrepancy_noted: boolean;
  created: string;
}

export interface ObservationIpcTask {
  type: 'observation';
  person_name: string;
  observation_text: string;
  source: string;
  contributed_by: string;
  entity_id?: string;
  discrepancy_noted?: boolean;
}

/**
 * Check if an IPC task is an observation type.
 */
export function isObservationIpcTask(data: Record<string, unknown>): boolean {
  return data.type === 'observation';
}

/**
 * Parse and validate an observation from IPC task data.
 * Returns null if required fields are missing.
 */
export function parseObservation(data: Record<string, unknown>): ObservationData | null {
  if (data.type !== 'observation') return null;

  const person_name = data.person_name as string | undefined;
  const observation_text = data.observation_text as string | undefined;
  const source = data.source as string | undefined;
  const contributed_by = data.contributed_by as string | undefined;

  if (!person_name || !observation_text || !source || !contributed_by) {
    logger.warn({ data }, 'observations: missing required fields');
    return null;
  }

  return {
    person_name,
    entity_id: (data.entity_id as string) || undefined,
    observation_text,
    source,
    contributed_by,
    discrepancy_noted: (data.discrepancy_noted as boolean) || false,
    created: new Date().toISOString(),
  };
}

/**
 * Write a pending observation YAML file to the observations/pending directory.
 * Returns the full path to the created file.
 */
export function writePendingObservation(
  observation: ObservationData,
  pendingDir: string,
): string {
  const dateStr = observation.created.slice(0, 10);
  const slugName = observation.person_name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const uniqueSuffix = Math.random().toString(36).slice(2, 8);
  const filename = `${dateStr}-${slugName}-${uniqueSuffix}.yaml`;
  const filePath = path.join(pendingDir, filename);

  const doc = {
    person_name: observation.person_name,
    entity_id: observation.entity_id || null,
    observation_text: observation.observation_text,
    source: observation.source,
    contributed_by: observation.contributed_by,
    discrepancy_noted: observation.discrepancy_noted,
    created: observation.created,
  };

  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(doc));

  logger.info(
    { filePath, person: observation.person_name },
    'observations: pending observation created',
  );
  return filePath;
}
