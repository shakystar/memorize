import { requireBoundProjectId } from '../../services/project-service.js';
import {
  bindWorkspace,
  changeWorkspaceMemberRole,
  getWorkspaceBinding,
  inviteToWorkspace,
  joinAndBindWorkspace,
  listWorkspaceMembers,
  removeMemberFromWorkspace,
} from '../../services/workspace-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const CREATE_USAGE =
  'Usage: memorize workspace create --remote-url <hub-url> [--name <name>]';
const STATUS_USAGE = 'Usage: memorize workspace status [--json]';
const INVITE_USAGE =
  'Usage: memorize workspace invite [--remote-url <hub-url>] [--max-uses <N>] [--expires <ISO-8601>]';
const JOIN_USAGE =
  'Usage: memorize workspace join --remote-url <hub-url> --token <invite-token>';
const MEMBERS_USAGE = 'Usage: memorize workspace members [--json]';
const PROMOTE_USAGE =
  'Usage: memorize workspace promote <accountId-or-email>';
const DEMOTE_USAGE = 'Usage: memorize workspace demote <accountId-or-email>';
const REMOVE_USAGE = 'Usage: memorize workspace remove <accountId-or-email>';
const USAGE = [
  CREATE_USAGE,
  STATUS_USAGE,
  INVITE_USAGE,
  JOIN_USAGE,
  MEMBERS_USAGE,
  PROMOTE_USAGE,
  DEMOTE_USAGE,
  REMOVE_USAGE,
].join('\n');

/**
 * `memorize workspace …` — the workspace control-plane surface (SoT-022, Hub
 * H030/H040): identity bind (W-a), invite/join (W-d), and roster/role
 * management (W-c). Everything here is typed gateway calls — a workspace never
 * writes domain events, and the local `proj_` identity is never rekeyed
 * (SoT-021). The shared-memory data-plane is ordinary sync over the `wsp_`
 * events route (W-b).
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
  if (subcommand === 'invite') {
    await runWorkspaceInvite(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'join') {
    await runWorkspaceJoin(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'members') {
    await runWorkspaceMembers(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'promote' || subcommand === 'demote') {
    await runWorkspaceRoleChange(subcommand, args.slice(1), ctx);
    return;
  }
  if (subcommand === 'remove') {
    await runWorkspaceRemove(args.slice(1), ctx);
    return;
  }
  throw new Error(USAGE);
}

/**
 * `memorize workspace members [--json]` — the control-plane roster (W-c). Read
 * by any member; the verified email is the display handle that maps a lane's
 * provenance back to a person.
 */
async function runWorkspaceMembers(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { boolean: ['json'] });
  const projectId = await requireBoundProjectId(ctx.cwd);
  const roster = await listWorkspaceMembers(projectId);
  if (flags.boolean.json) {
    console.log(JSON.stringify(roster));
    return;
  }
  console.log(
    `workspace: ${roster.workspaceId}${roster.name ? ` (${roster.name})` : ''}\n` +
      `shared:    ${roster.inviteReachable ? 'yes (invite-reachable)' : 'no (private project)'}\n` +
      `members:   ${roster.members.length}`,
  );
  for (const member of roster.members) {
    console.log(
      `  ${member.role.padEnd(6)} ${member.email} (${member.accountId}) joined ${member.joinedAt}`,
    );
  }
}

/**
 * `memorize workspace promote|demote <accountId-or-email>` — owner-only role
 * change over the Hub PATCH endpoint (W-c). Promote is also the ownership
 * transfer path; demoting the sole remaining owner is refused Hub-side (409).
 */
async function runWorkspaceRoleChange(
  verb: 'promote' | 'demote',
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, {});
  const memberRef = flags.positional[0];
  if (!memberRef) {
    throw new Error(verb === 'promote' ? PROMOTE_USAGE : DEMOTE_USAGE);
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await changeWorkspaceMemberRole(
    projectId,
    memberRef,
    verb === 'promote' ? 'owner' : 'member',
  );
  console.log(JSON.stringify(result));
}

/**
 * `memorize workspace remove <accountId-or-email>` — owner removes a member
 * (or a member removes themselves; the Hub allows self-leave). Revokes future
 * access only: already-pulled bytes are not recallable (SoT-040/050).
 */
async function runWorkspaceRemove(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, {});
  const memberRef = flags.positional[0];
  if (!memberRef) {
    throw new Error(REMOVE_USAGE);
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await removeMemberFromWorkspace(projectId, memberRef);
  console.log(JSON.stringify(result));
}

async function runWorkspaceInvite(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, {
    single: ['remote-url', 'max-uses', 'expires'],
  });
  let maxUses: number | undefined;
  if (flags.single['max-uses'] !== undefined) {
    maxUses = Number(flags.single['max-uses']);
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      throw new Error('--max-uses must be a positive integer.');
    }
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  const invite = await inviteToWorkspace(projectId, {
    ...(flags.single['remote-url'] ? { remoteUrl: flags.single['remote-url'] } : {}),
    ...(maxUses !== undefined ? { maxUses } : {}),
    ...(flags.single.expires ? { expiresAt: flags.single.expires } : {}),
  });
  // The token/joinUrl are shown ONCE — the Hub never re-serves them.
  console.log(JSON.stringify(invite));
}

async function runWorkspaceJoin(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['remote-url', 'token'] });
  const remoteUrl = flags.single['remote-url'];
  const inviteToken = flags.single.token;
  if (!remoteUrl || !inviteToken) {
    throw new Error(JOIN_USAGE);
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  const binding = await joinAndBindWorkspace(projectId, {
    remoteUrl,
    inviteToken,
  });
  console.log(JSON.stringify(binding));
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
