import process from 'node:process';

import { type HarnessId, harnessIds } from '../../harness/registry.js';
import { runHook } from '../../services/hook-service.js';
import type { CliContext } from '../context.js';

function isHarnessId(value: string): value is HarnessId {
  return (harnessIds as readonly string[]).includes(value);
}

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
    throw new Error(`Usage: memorize hook <${harnessIds.join('|')}> <EventName>`);
  }
  if (!isHarnessId(target)) {
    throw new Error(
      `Unknown hook target: ${target}. Expected one of: ${harnessIds.join(', ')}.`,
    );
  }
  const stdinPayload = await readStdin();
  process.stdout.write(
    await runHook(target, {
      eventName,
      cwd: ctx.cwd,
      ...(stdinPayload !== undefined ? { stdinPayload } : {}),
    }),
  );
}
