/**
 * Model-backed brains. A brain turns the loop state into one action, using the
 * same model access as Forge (see model.ts). Each role gets a mandate-specific
 * prompt, so the PM reasons about requirements, QA about evidence, and so on.
 *
 * A brain always falls back to `finish` on unusable output, so a flaky model
 * ends the role safely instead of spinning.
 */
import type { AgentAction, AgentBrain, AgentBrainState } from '../kernel/loop.ts';
import type { ModelService, ChatMessage, TaskTier } from './model.ts';

/** Tools whose identical repeat cannot yield new information. */
const IDEMPOTENT_TOOLS = new Set(['read_file', 'think', 'list_files', 'search', 'find_files', 'run_check']);

export function guardRepeatedReadOnly(action: AgentAction, history: { action: AgentAction }[]): AgentAction {
  if (!IDEMPOTENT_TOOLS.has(action.tool)) return action;
  const key = JSON.stringify({ tool: action.tool, input: action.input });
  const repeated = history.some((h) => JSON.stringify({ tool: h.action.tool, input: h.action.input }) === key);
  if (!repeated) return action;
  return { tool: 'think', input: { thought: `Already ran ${key}; that result will not change. Choose a different tool or finish.` } };
}

export interface BrainSpec {
  role: string;
  mandate: string;
  /** What artifact kind this role must emit, and what fields it should carry. */
  artifactHint: string;
  /** An explicit tool sequence the role should follow. Rendered prominently. */
  sequence?: string[];
  /** Work tier: `easy` routes keyless (planning, review, decisions); `hard` may use keys. */
  tier?: TaskTier;
}

export function buildRolePrompt(spec: BrainSpec, state: AgentBrainState): string {
  const toolList = state.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const history = state.history.length
    ? state.history.map((h) => `step ${h.index}: ${h.action.tool} -> ${h.observation.ok ? 'ok' : 'FAILED'}: ${h.observation.output.slice(0, 4000)}`).join('\n')
    : '(no actions yet)';
  const upstream = state.memory?.trim() ? `What earlier roles produced (JSON, oldest first):\n${state.memory.trim().slice(0, 6000)}\n` : '';
  const sequence = spec.sequence?.length
    ? `Required sequence for your role (follow it in order, one action per reply):\n${spec.sequence.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`
    : '';
  return `You are the ${spec.role} in a software company. Your mandate: ${spec.mandate}
Overall goal: ${state.goal}
${upstream}Available tools:
${toolList}
${sequence}Your actions so far:
${history}
Choose exactly ONE next action. Return compact JSON only, no markdown:
{"tool":"<name>","input":{...}}
Rules:
- Do NOT repeat an action you already took; its result will not change.
- Read a file before editing it.
- To change an existing file, use edit_file with a small, unique old_string and copy it exactly from what you read. Do not rewrite a whole file from memory: you may only have seen part of it, and a whole-file write can silently delete everything you did not see.
- Use write_file only to create a new file.
- ${spec.artifactHint}
- When your sequence is complete (or if you cannot proceed), finish: {"tool":"finish","input":{"summary":"...","data":{...}}}.
- Use only tools from the list. Never invent a tool. Respond only with valid JSON.`;
}

/** A deterministic fallback brain: emits one finish carrying the given data. */
export function scriptedBrain(summary: string, data: Record<string, unknown>): AgentBrain {
  return async () => ({ tool: 'finish', input: { summary, data } });
}

export function modelBrain(model: ModelService, spec: BrainSpec): AgentBrain {
  return async (state: AgentBrainState): Promise<AgentAction> => {
    const prompt = buildRolePrompt(spec, state);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a careful senior software engineer. Return valid JSON only.' },
      { role: 'user', content: prompt },
    ];
    const { value } = await model.completeJson<{ tool?: string; input?: Record<string, unknown> }>(messages, prompt, spec.tier ?? 'hard');
    if (value && typeof value.tool === 'string') {
      return guardRepeatedReadOnly({ tool: value.tool, input: value.input }, state.history);
    }
    return { tool: 'finish', input: { summary: `${spec.role} could not choose an action; stopping safely.`, data: {} } };
  };
}
