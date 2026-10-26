// Prove the genuinely keyless path: deliberately remove all provider credentials
// from this process so a configured Gemini/Groq/etc. key cannot make the test pass.
const credentialNames = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ZAI_API_KEY', 'COHERE_API_KEY',
  'CO_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'NVIDIA_API_KEY', 'NIM_API_KEY',
  'KILO_API_KEY', 'FREELM_GOOGLE_KEYS', 'FREELM_GROQ_KEYS', 'FREELM_OPENROUTER_KEYS',
  'FREELM_CLOUDFLARE_KEYS', 'FREELM_ZAI_KEYS', 'FREELM_COHERE_KEYS',
  'FREELM_CEREBRAS_KEYS', 'FREELM_MISTRAL_KEYS', 'FREELM_NIM_KEYS', 'FREELM_KILO_KEYS',
];
for (const name of credentialNames) delete process.env[name];
process.env.FREELM_KEYLESS = '1';

const { FreeLLM } = await import('freelm');
const failures = [];
const events = [];
try {
  const llm = FreeLLM.fromEnv({
    keyless: true,
    maxAttempts: 12,
    timeout: 30,
    hedge: true,
    onEvent: (event) => {
      events.push(event);
      if (event.kind === 'error') {
        failures.push(`${event.provider || 'unknown provider'} / ${event.model || 'unknown model'}: ${event.error || `HTTP ${event.status ?? 'unknown'}`}`);
      }
    },
  });
  let passed = null;
  for (const alias of ['chat', 'chat:fast', 'chat:small']) {
    try {
      const response = await llm.chat([
        { role: 'system', content: 'Reply with exactly the requested token and no other text.' },
        { role: 'user', content: 'Reply with exactly: FIRSTBORN_KEYLESS_ROUTE_OK' },
      ], {
        model: alias,
        temperature: 0,
        max_tokens: 256,
        signal: AbortSignal.timeout(30000),
      });
      const text = response.text.trim();
      const provider = response.provider || 'not-reported';
      if (text.includes('FIRSTBORN_KEYLESS_ROUTE_OK') && /kilo|ovh|keyless|anonymous/i.test(provider)) {
        passed = { response, text, provider, alias };
        break;
      }
      const firstChoice = response.raw?.choices?.[0];
      const message = firstChoice?.message;
      failures.push(`${alias} via ${provider}: unusable text; finish_reason=${firstChoice?.finish_reason ?? 'unknown'}, message_keys=${message && typeof message === 'object' ? Object.keys(message).join(',') : 'none'}, content_type=${Array.isArray(message?.content) ? 'array' : typeof message?.content}, reasoning_chars=${typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0}`);
    } catch (error) {
      failures.push(`${alias}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!passed) throw new Error('No keyless route returned the required usable text across chat, chat:fast, and chat:small.');
  console.log(JSON.stringify({
    status: 'PASS',
    mode: 'keyless-only (all provider credentials removed)',
    requestedAlias: passed.alias,
    provider: passed.provider,
    actualModel: passed.response.model || 'not-reported',
    responseReceived: true,
    responseValidated: true,
    priorRouteFailures: failures,
    attemptCount: events.filter((event) => event.kind === 'attempt').length,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    mode: 'keyless-only (all provider credentials removed)',
    error: error instanceof Error ? error.message : String(error),
    routeFailures: failures,
    events: events.map(({ kind, provider, model, status, error: message }) => ({ kind, provider, model, status, error: message })),
  }, null, 2));
  process.exit(1);
}
