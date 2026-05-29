import { exportFromCwd } from '../../services/export-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

export async function runExportCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['out'] });
  const outFile = flags.single.out;
  const result = await exportFromCwd(ctx.cwd, outFile);

  if (result.outFile) {
    console.log(
      `Exported ${result.eventCount} event(s) to ${result.outFile}.`,
    );
  } else {
    // Stream NDJSON to stdout for piping / inspection.
    process.stdout.write(result.ndjson ? `${result.ndjson}\n` : '');
  }
}
