import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
}

const LOCK_STALE_MS = 30_000;
const LOCK_SETTLE_MS = 10;

export async function withFileLock<T>(
  lockTarget: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = `${lockTarget}.lock`;
  const ownerFile = path.join(lockDir, 'owner');
  const ownerId = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const maxRetries = 50;
  const retryBaseMs = 5;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let created = false;
    try {
      await fs.mkdir(lockDir);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (created) {
      await fs.writeFile(ownerFile, ownerId);
      await new Promise((r) => setTimeout(r, LOCK_SETTLE_MS));
      try {
        const currentOwner = await fs.readFile(ownerFile, 'utf8');
        if (currentOwner === ownerId) break;
      } catch {
        // Owner file gone — another process rm'd our lock
      }
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    // Lock exists — check if stale
    try {
      const stat = await fs.stat(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw statErr;
    }

    if (attempt === maxRetries - 1) {
      throw new Error(
        `Failed to acquire file lock after ${maxRetries} retries: ${lockTarget}`,
      );
    }
    const jitter = Math.random() * retryBaseMs * Math.min(attempt + 1, 10);
    await new Promise((r) =>
      setTimeout(r, retryBaseMs * Math.min(attempt + 1, 10) + jitter),
    );
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
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
