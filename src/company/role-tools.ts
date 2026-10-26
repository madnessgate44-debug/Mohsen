/**
 * Role tools: the real workspace tools each employee is handed.
 *
 * Reads are always available. Only `branch-write` roles get `write_file` and
 * `run_check`, and a mutation is refused unless its path is inside the role's
 * allowed roots. Every write is recorded so the team's change map reflects disk.
 */
import { buildWorkspaceTools, type AgentTool } from '../kernel/loop.ts';
import { runCommand } from './runner.ts';

export interface RoleToolsOptions {
  /** The real directory this role works in. */
  workspaceDir: string;
  /** True for `branch-write` roles. */
  canMutate: boolean;
  /** Relative path prefixes a write is confined to. Defaults to the whole workspace. */
  allowedRoots?: string[];
  /** Authorized verification commands: label -> command. */
  authorizedCommands?: Record<string, string>;
}

const DEFAULT_COMMANDS: Record<string, string> = {
  test: 'npm test',
  lint: 'npm run lint',
};

export function buildRoleTools(options: RoleToolsOptions): AgentTool[] {
  const roots = options.allowedRoots?.length ? options.allowedRoots : [''];
  const authorized = options.authorizedCommands ?? DEFAULT_COMMANDS;

  const base = buildWorkspaceTools({
    workspace: options.workspaceDir,
    allowMutation: options.canMutate,
    authorizedCommands: authorized,
    runner: (command, cwd) => runCommand(command, cwd),
  });

  return base.map((tool) => {
    if (tool.name !== 'write_file' && tool.name !== 'edit_file') return tool;
    const original = tool.run;
    return {
      ...tool,
      run: async (input, ctx) => {
        const rel = typeof input.path === 'string' ? input.path : '';
        if (!roots.some((root) => root === '' || rel === root || rel.startsWith(root.endsWith('/') ? root : root + '/'))) {
          return { ok: false, output: `Refusing to write outside the allowed roots (${roots.join(', ')}): ${rel}` };
        }
        return original(input, ctx);
      },
    };
  });
}
