/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configurable hard ceilings for a mission. Every value is bounded so a mission
 * stops safely instead of looping or producing an unbounded patch. Defaults are
 * conservative; operators can raise them per environment without code changes.
 */
export interface ForgeLimits {
  maxFilesPerMission: number;
  maxEditsPerMission: number;
  maxPatchBytes: number;
  maxModelCalls: number;
  maxRepairAttempts: number;
  modelAttempts: number;
  maxRuntimeMs: number;
  /** M3: bounded mission-level attempts for exhaustion/durability testing. */
  maxMissionAttempts: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function loadForgeLimits(env: NodeJS.ProcessEnv = process.env): ForgeLimits {
  return {
    maxFilesPerMission: envInt(env, 'FORGE_MAX_FILES', 5, 1, 50),
    maxEditsPerMission: envInt(env, 'FORGE_MAX_EDITS', 8, 1, 200),
    maxPatchBytes: envInt(env, 'FORGE_MAX_PATCH_BYTES', 100 * 1024, 1024, 5 * 1024 * 1024),
    maxModelCalls: envInt(env, 'FORGE_MAX_MODEL_CALLS', 8, 1, 50),
    maxRepairAttempts: envInt(env, 'FORGE_MAX_REPAIRS', 2, 0, 10),
    modelAttempts: envInt(env, 'FORGE_MODEL_ATTEMPTS', 2, 1, 10),
    maxRuntimeMs: envInt(env, 'FORGE_MAX_RUNTIME_MS', 10 * 60 * 1000, 10_000, 60 * 60 * 1000),
    maxMissionAttempts: envInt(env, 'FORGE_MAX_MISSION_ATTEMPTS', 1, 1, 5),
  };
}
