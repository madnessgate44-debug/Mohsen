/**
 * Prompt-robustness battery for the keyless model route.
 * Runs many prompt shapes through the real ModelService and fails if any prompt
 * comes back without usable text. Network-dependent, so it is a manual/CI-only
 * check (`npm run model:battery`), not part of `npm test`.
 */
import { ModelService } from '../src/services/model.ts';

const long = Array.from({ length: 400 }, (_, i) => `Line ${i}: the repository must keep its invariants and never invent anchors.`).join('\n');
const demoContext = [{ path: 'README.md', content: '# Demo\nA small demo repo.\n' }];

const cases: { name: string; prompt: string; context?: { path: string; content: string }[] }[] = [
  { name: 'tiny-greeting', prompt: 'Say hello in one word.' },
  { name: 'json-only', prompt: 'Return only JSON: {"ok": true}' },
  { name: 'prose-explain', prompt: 'Explain what a Gradle wrapper is in two sentences.' },
  { name: 'code-write', prompt: 'Write a TypeScript function that reverses a string.' },
  { name: 'question', prompt: 'Why would an LLM return an empty string with finish_reason=length?' },
  { name: 'arabic', prompt: 'اشرح بإيجاز كيف يعمل نظام إدارة المزرعة الذكية ومكوّناته الرئيسية.' },
  { name: 'unicode-mix', prompt: 'Translate "good morning" to Arabic, Japanese, and emoji. 🚜🌾' },
  { name: 'long-mission', prompt: long, context: [{ path: 'README.md', content: long }] },
  { name: 'whitespace', prompt: '   ' },
  { name: 'empty', prompt: '' },
];

const service = new ModelService();
let ok = 0;
for (const testCase of cases) {
  const started = Date.now();
  try {
    const result = await service.generatePlanAndPatch(testCase.prompt, testCase.context ?? demoContext);
    const length = (result.text || '').length;
    const good = result.success && length > 0;
    if (good) ok += 1;
    console.log(`${good ? 'OK ' : 'BAD'} ${testCase.name.padEnd(14)} success=${result.success} len=${length} provider=${result.provider} model=${result.model} ms=${Date.now() - started}`);
    if (!good) console.log(`     error=${String(result.error).slice(0, 200)}`);
  } catch (error) {
    console.log(`ERR ${testCase.name.padEnd(14)} threw: ${String((error as Error).message).slice(0, 200)}`);
  }
}
console.log(`\nRESULT ${ok}/${cases.length} returned a real non-empty response`);
process.exit(ok === cases.length ? 0 : 1);
