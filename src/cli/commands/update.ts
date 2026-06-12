import process from 'node:process';

import {
  formatRefreshSummary,
  recordUpdateCheck,
  runRefresh,
  runSelfUpdate,
} from '../../services/update-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

export async function runUpdateCommand(
  args: string[],
  _ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { boolean: ['post-only', 'check'] });

  // Internal: detached registry probe spawned by SessionStart (notify-only).
  if (flags.boolean.check) {
    await recordUpdateCheck();
    return;
  }

  // Internal: re-exec entry point — the parent already ran npm install,
  // we are the NEW binary and own the machine-wide refresh.
  if (flags.boolean['post-only']) {
    const result = await runRefresh();
    for (const line of formatRefreshSummary(result)) console.log(line);
    if (result.failures.length > 0) process.exitCode = 1;
    return;
  }

  const exitCode = await runSelfUpdate();
  if (exitCode !== 0) process.exitCode = exitCode;
}
