import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { consolidate } from '../services/consolidate-service.js';
import { importMemories } from '../services/memory-import-service.js';
import { getBoundProjectId } from '../services/project-service.js';
import { doctor } from '../services/repair-service.js';
import { hybridSearchFromCwd } from '../services/search-service.js';
import { composeStartupContext } from '../services/startup-context-service.js';
import { getCurrentVersion } from '../services/update-service.js';

/**
 * memorize MCP server — the cross-harness pillar.
 *
 * Lifecycle hooks (Claude/Codex/…) give deterministic SessionStart injection +
 * automatic capture, but only harnesses with a hook system get them. MCP is the
 * universal fallback: ANY MCP-capable host (Cursor, Cline, Goose, opencode, …)
 * can call these tools to recall/record memory without a per-harness adapter.
 *
 * Boundary vs hooks (documented limit): MCP tools/resources are pulled
 * on-demand by the agent — they are NOT auto-injected before the first turn the
 * way a SessionStart hook is. `memorize_context` (and the `memorize://context`
 * resource / `session-context` prompt) expose the same startup context, but the
 * host must choose to fetch it. Deterministic pre-turn injection still needs the
 * hook pillar.
 *
 * The server is cwd-scoped: it serves whatever memorize project the cwd binds
 * to (the host launches `memorize mcp` from the project root). `actor: 'mcp'`
 * attributes writes to this channel.
 */

const MCP_ACTOR = 'mcp';

function notBoundResult(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [
      {
        type: 'text',
        text:
          'This directory is not bound to a memorize project. Run `memorize init` in the project root first.',
      },
    ],
    isError: true,
  };
}

async function composeBoundStartupContext(cwd: string): Promise<string | undefined> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) return undefined;
  const composed = await composeStartupContext({ agent: 'claude', cwd });
  return composed.startupContext;
}

export function createMcpServer(cwd: string): McpServer {
  const server = new McpServer({ name: 'memorize', version: getCurrentVersion() });

  // --- recall (search) -------------------------------------------------------
  server.registerTool(
    'memorize_recall',
    {
      title: 'Recall from project memory',
      description:
        'Search the shared project brain for past decisions, rationale, and cross-session progress. Use for "what did we decide / why X" and cross-session questions — grep cannot see decisions made only in conversation.',
      inputSchema: {
        query: z.string().describe('Natural-language query.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Max hits (default server-side).'),
      },
    },
    async ({ query, limit }) => {
      const hits = await hybridSearchFromCwd(cwd, query, limit);
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: 'No matches in project memory.' }] };
      }
      const text = hits
        .map((h, i) => `${i + 1}. [${h.kind}] ${h.snippet}`)
        .join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  // --- context (startup recall) ---------------------------------------------
  server.registerTool(
    'memorize_context',
    {
      title: 'Load project memory context',
      description:
        'Return the context to load at the start of a session: active tasks, recent decisions, and parallel-session activity. Call this once at session start.',
      inputSchema: {},
    },
    async () => {
      const startupContext = await composeBoundStartupContext(cwd);
      if (startupContext === undefined) return notBoundResult();
      return {
        content: [
          { type: 'text', text: startupContext || 'No project context yet.' },
        ],
      };
    },
  );

  // --- record (save memory) --------------------------------------------------
  server.registerTool(
    'memorize_record',
    {
      title: 'Record to project memory',
      description:
        'Persist distilled decisions/rationale/progress into the shared project brain so future sessions recall them. Idempotent (dedup by kind+text). Record the durable "what/why", not transient chatter.',
      inputSchema: {
        items: z
          .array(
            z.object({
              kind: z.enum(['decision', 'rationale', 'progress']),
              text: z.string().min(1),
              salience: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('1–10 importance; higher surfaces first.'),
            }),
          )
          .min(1),
      },
    },
    async ({ items }) => {
      const projectId = await getBoundProjectId(cwd);
      if (!projectId) return notBoundResult();
      const result = await importMemories({
        projectId,
        actor: MCP_ACTOR,
        source: MCP_ACTOR,
        itemsJson: JSON.stringify(items),
      });
      return {
        content: [
          {
            type: 'text',
            text: `Recorded ${result.imported}, skipped ${result.skippedDuplicates} duplicate(s).`,
          },
        ],
      };
    },
  );

  // --- consolidate -----------------------------------------------------------
  server.registerTool(
    'memorize_consolidate',
    {
      title: 'Consolidate the observation backlog',
      description:
        'Run a consolidation boundary: distill the un-consolidated observation window into long-term memories now. This is a real side effect — use to flush a backlog, not to "check" health (use memorize_diagnose for that).',
      inputSchema: {},
    },
    async () => {
      const projectId = await getBoundProjectId(cwd);
      if (!projectId) return notBoundResult();
      const result = await consolidate({
        projectId,
        actor: MCP_ACTOR,
        boundary: 'manual',
      });
      return {
        content: [
          {
            type: 'text',
            text: `Consolidation ${result.outcome}: ${result.consolidated} memory(ies) from ${result.observationsProcessed} observation(s) via ${result.extractor}.`,
          },
        ],
      };
    },
  );

  // --- diagnose (doctor) -----------------------------------------------------
  server.registerTool(
    'memorize_diagnose',
    {
      title: 'Diagnose memory health',
      description:
        'Run memorize doctor: report whether capture, consolidation, hooks, and storage are healthy, with a fix for each issue. Trust this over hand-querying the DB.',
      inputSchema: {},
    },
    async () => {
      const report = await doctor(cwd);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    },
  );

  // --- resource + prompt mirrors of the startup context ----------------------
  // Hosts that prefer resources/prompts over tools can surface the same context.
  server.registerResource(
    'project-context',
    'memorize://context',
    {
      title: 'memorize project context',
      description: 'Active tasks, recent decisions, and parallel-session activity.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const startupContext = await composeBoundStartupContext(cwd);
      return {
        contents: [
          {
            uri: uri.href,
            text: startupContext ?? notBoundResult().content[0]!.text,
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'session-context',
    {
      title: 'Load memorize session context',
      description: 'Inject the project memory context at the start of a session.',
    },
    async () => {
      const startupContext = await composeBoundStartupContext(cwd);
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: startupContext ?? notBoundResult().content[0]!.text,
            },
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Run the memorize MCP server over stdio until the host closes the connection.
 * Stdout is the JSON-RPC channel — diagnostics MUST go to stderr only.
 */
export async function runMcpServer(cwd: string): Promise<void> {
  const server = createMcpServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
