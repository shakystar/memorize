import process from 'node:process';

import { doctor, formatDoctorReport } from '../../services/repair-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

export async function runDoctorCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { boolean: ['json'] });
  const report = await doctor(ctx.cwd);

  if (flags.boolean.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }

  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}
