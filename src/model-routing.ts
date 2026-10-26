/**
 * One routing policy for every model call.
 *
 * Forge's two engines used to decide keyless-vs-keyed differently, which meant
 * the same environment could route two ways:
 *   - `src/services/model.ts` always passed `keyless: true` (keyed first, then
 *     the anonymous Kilo/OVHcloud endpoints as a last resort).
 *   - `src/company/model.ts` passed `keyless: 'auto'` for hard work, which freelm
 *     resolves to "use the keyed providers and nothing else" — so when a key was
 *     present the keyless endpoints were never a fallback at all.
 *
 * This module states the policy once, as a pure function of the environment and
 * the work tier, so both engines integrate the same way and the behaviour is
 * unit-testable without a network call.
 *
 * Policy:
 *   - FIRSTBORN_KEYLESS_ONLY=true  -> `true`: keyless only (provider keys are
 *     stripped, so there is nothing else to route to).
 *   - hard work with a key         -> `'auto'`: keyed providers only. freelm
 *     reads 'auto' as "add keyless only when no keys exist", so a present key
 *     keeps the anonymous Kilo/OVHcloud endpoints out of the pool entirely. A
 *     large sweep must not land on a 3-requests-per-minute keyless endpoint.
 *   - easy work, or no provider key -> `true`: keyed first, then the anonymous
 *     endpoints as a last resort (freelm gives them priority 100, tried last).
 */

/** Provider credentials freelm reads. Shared so both engines strip the same set. */
export const CREDENTIAL_ENV_NAMES = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];

/** The strict keyless lock, recognized case-insensitively (GitHub capitalizes). */
export function isKeylessOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FIRSTBORN_KEYLESS_ONLY ?? '').trim().toLowerCase() === 'true';
}

/** True when at least one provider credential is present. */
export function hasProviderKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return CREDENTIAL_ENV_NAMES.some((name) => (env[name] ?? '').trim() !== '');
}

export type KeylessMode = 'always' | 'auto';

/** Work tier. `easy` work needs no key; `hard` work should prefer configured keys. */
export type RoutingTier = 'easy' | 'hard';

/**
 * True when hard work may use configured keys first and keep the anonymous
 * keyless endpoints out of the pool. False for easy work, when no key is
 * configured, or under the strict keyless lock.
 */
function prefersKeyedOnly(env: NodeJS.ProcessEnv, tier: RoutingTier): boolean {
  return tier === 'hard' && hasProviderKeys(env) && !isKeylessOnly(env);
}

/**
 * The single routing decision, as a freelm `keyless` mode.
 *
 * `'auto'` for hard work when a key is present: freelm then builds a keyed-only
 * pool, which is what keeps a 29-chunk sweep off the anonymous Kilo endpoint and
 * its ~3-requests-per-minute cap. Every other case is `'always'`, so the keyless
 * endpoints remain available as a genuine last resort (priority 100, tried last).
 */
export function resolveKeylessMode(env: NodeJS.ProcessEnv = process.env, tier: RoutingTier = 'easy'): KeylessMode {
  return prefersKeyedOnly(env, tier) ? 'auto' : 'always';
}

/**
 * The freelm `keyless` option for the environment and tier.
 *
 * Defaults to the keyless-tolerant value when no tier is given, so Forge's
 * services engine (`keylessOption()`) keeps its long-standing `true` behaviour.
 */
export function keylessOption(env: NodeJS.ProcessEnv = process.env, tier: RoutingTier = 'easy'): boolean | 'auto' {
  return resolveKeylessMode(env, tier) === 'auto' ? 'auto' : true;
}

/** True when the keyless endpoints may be used at all (not a strict keyless lock). */
export function keylessAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isKeylessOnly(env);
}

/**
 * Apply the policy to an environment in place: under the strict lock, remove
 * every provider credential and ask freelm for keyless explicitly. Mutating the
 * passed env (not `process.env`) keeps this testable and side-effect-free for the
 * caller's real environment.
 */
export function applyRoutingPolicy(env: NodeJS.ProcessEnv): { keyless: boolean | 'auto' } {
  if (isKeylessOnly(env)) {
    for (const name of CREDENTIAL_ENV_NAMES) delete env[name];
    env.FREELM_KEYLESS = '1';
  }
  return { keyless: keylessOption(env) };
}
