import type { CliContext } from '../context.js';

/**
 * `memorize mcp` — run the memorize MCP server over stdio.
 *
 * The MCP SDK is a sizeable dependency, so it is dynamically imported here:
 * the rest of the CLI (and every hook subprocess) stays light and never loads
 * it. A host wires this as an `mcpServers` entry, e.g.
 *   { "memorize": { "command": "npx", "args": ["-y", "@shakystar/memorize", "mcp"] } }
 * The server serves whatever memorize project `ctx.cwd` binds to.
 */
export async function runMcpCommand(
  _args: string[],
  ctx: CliContext,
): Promise<void> {
  const { runMcpServer } = await import('../../mcp/server.js');
  await runMcpServer(ctx.cwd);
}
