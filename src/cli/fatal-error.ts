type StderrLike = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
};

type TimerLike = {
  unref?: () => void;
};

type FatalErrorDeps = {
  stderr?: StderrLike;
  exit?: (code: number) => never;
  setTimeout?: (callback: () => void, ms: number) => TimerLike;
};

export function formatFatalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writeFatalErrorAndExit(
  error: unknown,
  deps: FatalErrorDeps = {},
): never | void {
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? process.exit;
  const schedule = deps.setTimeout ?? setTimeout;
  let exited = false;

  const exitOnce = (): never | void => {
    if (exited) return;
    exited = true;
    return exit(1);
  };

  stderr.write(`${formatFatalError(error)}\n`, exitOnce);

  schedule(exitOnce, 250);
}
