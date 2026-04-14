import { doctor } from '../../services/repair-service.js';
import type { CliContext } from '../context.js';

export async function runDoctorCommand(
  _args: string[],
  ctx: CliContext,
): Promise<void> {
  console.log(await doctor(ctx.cwd));
}
