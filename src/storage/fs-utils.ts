import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
}

const LOCK_STALE_MS = 10_000;

export async function withFileLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = `${lockTarget}.lock`;
  const maxRetries = 50;
  const retryBaseMs = 5;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (attempt === maxRetries - 1) {
        throw new Error(
          `Failed to acquire file lock after ${maxRetries} retries: ${lockTarget}`,
        );
      }
      const jitter = Math.random() * retryBaseMs;
      await new Promise((r) =>
        setTimeout(r, retryBaseMs * Math.min(attempt + 1, 10) + jitter),
      );
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await ensureParentDir(filePath);
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}
