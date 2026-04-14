import process from 'node:process';

import { runClaudeHook } from '../../services/hook-service.js';
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
  if (target !== 'claude') {
    throw new Error('Only `claude` hooks are implemented currently.');
  }
  if (!eventName) {
    throw new Error('Hook event name is required for Claude hooks.');
  }
  const stdinPayload = await readStdin();
  process.stdout.write(
    await runClaudeHook({
      eventName,
      cwd: ctx.cwd,
      ...(stdinPayload !== undefined ? { stdinPayload } : {}),
    }),
  );
}
