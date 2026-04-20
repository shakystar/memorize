import process from 'node:process';

import { runClaudeHook, runCodexHook } from '../../services/hook-service.js';
import type { CliContext } from '../context.js';

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function runHookCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const target = args[0];
  const eventName = args[1];
  if (!target || !eventName) {
    throw new Error('Usage: memorize hook <claude|codex> <EventName>');
  }
  const runner =
    target === 'claude'
      ? runClaudeHook
      : target === 'codex'
      ? runCodexHook
      : undefined;
  if (!runner) {
    throw new Error(`Unknown hook target: ${target}. Expected 'claude' or 'codex'.`);
  }
  const stdinPayload = await readStdin();
  process.stdout.write(
    await runner({
      eventName,
      cwd: ctx.cwd,
      ...(stdinPayload !== undefined ? { stdinPayload } : {}),
    }),
  );
}
