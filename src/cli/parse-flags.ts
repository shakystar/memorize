export interface ParsedFlags {
  positional: string[];
  single: Record<string, string>;
  multi: Record<string, string[]>;
  boolean: Record<string, boolean>;
}

export function parseFlags(
  args: string[],
  options: { multi?: string[]; single?: string[]; boolean?: string[] } = {},
): ParsedFlags {
  const multiKeys = new Set(options.multi ?? []);
  const singleKeys = new Set(options.single ?? []);
  const booleanKeys = new Set(options.boolean ?? []);
  const knownKeys = new Set<string>([
    ...multiKeys,
    ...singleKeys,
    ...booleanKeys,
  ]);
  const positional: string[] = [];
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const boolean: Record<string, boolean> = {};

  const assign = (key: string, value: string): void => {
    if (multiKeys.has(key)) {
      (multi[key] ??= []).push(value);
    } else if (singleKeys.has(key)) {
      single[key] = value;
    } else {
      throw new Error(`Unknown flag --${key}.`);
    }
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equalsIndex = body.indexOf('=');
    if (equalsIndex !== -1) {
      const key = body.slice(0, equalsIndex);
      const value = body.slice(equalsIndex + 1);
      if (booleanKeys.has(key)) {
        throw new Error(`Flag --${key} does not take a value.`);
      }
      assign(key, value);
      continue;
    }
    const key = body;
    if (booleanKeys.has(key)) {
      boolean[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) {
      throw new Error(`Flag --${key} requires a value.`);
    }
    if (next.startsWith('--')) {
      const nextKey = next.slice(2).split('=')[0] ?? '';
      if (knownKeys.has(nextKey)) {
        throw new Error(`Flag --${key} requires a value.`);
      }
    }
    i += 1;
    assign(key, next);
  }

  return { positional, single, multi, boolean };
}
