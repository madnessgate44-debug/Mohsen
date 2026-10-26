/** Shared routing helpers for Forge's coding model path. */
import { keylessOption } from '../model-routing.ts';

/** Coding and repository-audit tasks are hard work: use configured provider credentials first. */
export function codingKeylessOption(env: NodeJS.ProcessEnv = process.env): boolean | 'auto' {
  return keylessOption(env, 'hard');
}
