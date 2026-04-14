export interface CliContext {
  cwd: string;
}

export type CommandHandler = (
  args: string[],
  ctx: CliContext,
) => Promise<void>;
