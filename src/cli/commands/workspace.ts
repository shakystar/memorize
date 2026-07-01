import { requireBoundProjectId } from '../../services/project-service.js';
import {
  bindWorkspace,
  getWorkspaceBinding,
} from '../../services/workspace-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const CREATE_USAGE =
  'Usage: memorize workspace create --remote-url <hub-url> [--name <name>]';
const STATUS_USAGE = 'Usage: memorize workspace status [--json]';
const USAGE = `${CREATE_USAGE}\n${STATUS_USAGE}`;

/**
 * `memorize workspace …` — W-a identity slice. Binds the bound project (`proj_`)
 * to a server-minted workspace store (`wsp_`), a control-plane fact fetched from
 * the Hub gateway (SoT-022, no domain event). This slice only establishes
 * identity; the whole-DB union sync, invite/join, and roles are later slices
 * (W-b/W-c/W-d). The local `proj_` identity is never rekeyed (SoT-021).
 */
export async function runWorkspaceCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'create') {
    await runWorkspaceCreate(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'status') {
    await runWorkspaceStatus(args.slice(1), ctx);
    return;
  }
  throw new Error(USAGE);
}

async function runWorkspaceCreate(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['remote-url', 'name'] });
  const remoteUrl = flags.single['remote-url'];
  if (!remoteUrl) {
    throw new Error(CREATE_USAGE);
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await bindWorkspace(projectId, {
    remoteUrl,
    ...(flags.single.name ? { name: flags.single.name } : {}),
  });
  console.log(JSON.stringify(result));
}

async function runWorkspaceStatus(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { boolean: ['json'] });
  const projectId = await requireBoundProjectId(ctx.cwd);
  const binding = await getWorkspaceBinding(projectId);

  if (flags.boolean.json) {
    console.log(JSON.stringify(binding ?? null));
    return;
  }
  if (!binding) {
    console.log('Not workspace-bound. Run `memorize workspace create --remote-url <hub-url>`.');
    return;
  }
  console.log(
    `workspace: ${binding.workspaceId}\n` +
      `role:      ${binding.role}\n` +
      `shared:    ${binding.inviteReachable ? 'yes (invite-reachable)' : 'no (private project)'}`,
  );
}
