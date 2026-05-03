import fs from 'node:fs/promises';
import path from 'node:path';

export function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

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
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readText(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await ensureParentDir(filePath);
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

/** Read every `.json` file in `dir` and return the parsed values. Returns [] when the dir does not exist. */
export async function readJsonDir<T>(dir: string): Promise<T[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir))
      .filter((entry) => entry.endsWith('.json'))
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const values = await Promise.all(
    entries.map((entry) => readJson<T>(path.join(dir, entry))),
  );
  return values.filter((value): value is Awaited<T> => Boolean(value)) as T[];
}

export interface NdjsonReadOptions {
  onCorrupt?: (line: string, error: unknown, lineNumber: number) => void;
}

export async function readNdjson<T>(
  filePath: string,
  options: NdjsonReadOptions = {},
): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const result: T[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as T);
    } catch (error) {
      if (options.onCorrupt) {
        options.onCorrupt(trimmed, error, i + 1);
      } else {
        throw error;
      }
    }
  }
  return result;
}
