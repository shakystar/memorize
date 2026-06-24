// scripts/benchmarks/e2e/chat-client.ts
import spawn from 'cross-spawn';
import { killExtractorTree, type CliExtractorChild } from '../../../src/services/consolidate-service.js';

export interface Chat {
  chat(prompt: string): Promise<string>;
}

const HTTP_TIMEOUT_MS = 60_000;
const CLI_TIMEOUT_MS = 120_000;

export interface HttpChatConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  num_ctx?: number;
}

export class HttpChat implements Chat {
  constructor(private readonly config: HttpChatConfig) {}

  async chat(prompt: string): Promise<string> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const response = await fetchImpl(
      `${this.config.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
          ...(this.config.num_ctx !== undefined ? { options: { num_ctx: this.config.num_ctx } } : {}),
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? HTTP_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`chat HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error('chat response missing choices[0].message.content');
    }
    return content;
  }
}

export type CliCommand = 'claude' | 'codex';

const CLI_ARGS: Record<CliCommand, string[]> = {
  claude: ['-p', '--output-format', 'text'],
  codex: ['exec', '-', '--skip-git-repo-check', '--color', 'never'],
};

export class CliChat implements Chat {
  constructor(
    private readonly command: CliCommand,
    private readonly timeoutMs: number = CLI_TIMEOUT_MS,
    private readonly spawnImpl: typeof spawn = spawn,
    private readonly killImpl: (child: CliExtractorChild) => void = killExtractorTree,
  ) {}

  chat(prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnImpl(this.command, CLI_ARGS[this.command], {
        // Suppress memorize's own hooks so a benchmark `claude -p` call does not
        // re-trigger them (literal of consolidate-service's SUPPRESS_HOOKS_ENV_VAR).
        env: { ...process.env, MEMORIZE_SUPPRESS_HOOKS: '1' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.killImpl(child as unknown as CliExtractorChild);
      }, this.timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`${this.command} timed out after ${this.timeoutMs}ms`));
        } else if (code !== 0) {
          reject(
            new Error(`${this.command} exited ${code}: ${stderr.trim().slice(0, 200)}`),
          );
        } else {
          resolve(stdout.trim());
        }
      });
      child.stdin?.end(prompt);
    });
  }
}

export function resolveChat(
  role: 'reader' | 'judge',
  env: NodeJS.ProcessEnv = process.env,
): Chat {
  const prefix = role === 'reader' ? 'BENCH_READER' : 'BENCH_JUDGE';
  const backend = env[`${prefix}_BACKEND`] ?? (role === 'reader' ? 'http' : 'cli');

  if (backend === 'cli') {
    const command = (env[`${prefix}_CLI`] ?? 'claude') as CliCommand;
    if (command !== 'claude' && command !== 'codex') {
      throw new Error(`${prefix}_CLI must be 'claude' or 'codex'`);
    }
    return new CliChat(command);
  }
  if (backend === 'http') {
    const endpoint =
      env[`${prefix}_ENDPOINT`] ??
      (role === 'reader' ? 'http://localhost:11434/v1' : undefined);
    const model =
      env[`${prefix}_MODEL`] ?? (role === 'reader' ? 'qwen2.5:7b' : undefined);
    if (!endpoint || !model) {
      throw new Error(
        `${prefix}_ENDPOINT and ${prefix}_MODEL are required for the http backend`,
      );
    }
    const apiKey = env[`${prefix}_API_KEY`];
    const numCtxRaw = env[`${prefix}_NUM_CTX`];
    return new HttpChat({
      endpoint,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(numCtxRaw ? { num_ctx: Number(numCtxRaw) } : {}),
    });
  }
  throw new Error(`${prefix}_BACKEND must be 'http' or 'cli'`);
}
