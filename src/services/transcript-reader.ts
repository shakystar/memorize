import fs from 'node:fs/promises';

/**
 * Conversation-complete transcript reading for the #99 capture fix.
 *
 * The old capture path handed the extractor only the last 16KB of raw
 * transcript bytes (mostly tool I/O). The #99 measurement showed ~97% of missed
 * decisions lay OUTSIDE that 16KB window (cat-2): they were stated in
 * conversational turns the extractor never saw. This reads forward from a
 * per-transcript byte watermark and strips to the conversational turns a
 * decision could be stated in (user + assistant visible text), dropping tool
 * I/O and thinking — the same ~20x reduction the measurement relied on, so the
 * extractor sees the WHOLE conversation cheaply instead of a raw tail.
 *
 * Like readTranscriptTail this never treats the transcript as a stable
 * interface: per-line JSON.parse failures are skipped, any I/O failure returns
 * undefined, and the caller keeps the raw-tail fallback for the case where the
 * format defeats stripping entirely.
 */

// One boundary reads at most this many raw bytes (~50KB stripped). A large
// backlog (e.g. the first read of a long pre-existing transcript) drains across
// successive boundaries instead of skipping content or sending one huge prompt.
export const MAX_RAW_BYTES_PER_READ = 1024 * 1024;

export interface ConversationSlice {
  /** Stripped conversational turns in [offset, newOffset). */
  text: string;
  /** Advance the per-transcript byte watermark to here on success. */
  newOffset: number;
  /** Raw bytes actually read (for the caller's degrade-to-tail heuristic). */
  rawLen: number;
  /** True when a backlog remains beyond newOffset (drains next boundary). */
  capped: boolean;
}

/** Target max chars per raw-transcript segment (turn-boundary greedy packing). */
export const SEGMENT_MAX_CHARS = 1500;

/**
 * Split a stripped conversation (turns joined by "\n\n", as produced by
 * readConversationSince) into retrievable segments, greedily packing whole turns
 * up to `maxChars`. A single turn larger than the budget becomes its own segment
 * (never split mid-turn). Empty/blank input -> []. Mirrors the benchmark's
 * chunkTurns precedent; used to build the v10 `segments` buffer.
 */
export function chunkConversation(text: string, maxChars = SEGMENT_MAX_CHARS): string[] {
  const turns = text.split('\n\n').map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const turn of turns) {
    if (buf && buf.length + 2 + turn.length > maxChars) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n\n${turn}` : turn;
  }
  if (buf) out.push(buf);
  return out;
}

function stripJsonlToConversation(raw: string): string {
  const turns: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = obj as { type?: string; message?: { content?: unknown } };
    const content = rec.message?.content;
    if (rec.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) turns.push(`USER: ${content.trim()}`);
      } else if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; text?: string }>) {
          if (b.type === 'text' && b.text?.trim()) turns.push(`USER: ${b.text.trim()}`);
        }
      }
    } else if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) {
        if (b.type === 'text' && b.text?.trim()) turns.push(`AGENT: ${b.text.trim()}`);
      }
    }
  }
  return turns.join('\n\n');
}

/**
 * Read and strip the transcript from `offset` (a byte position, always a line
 * boundary) to EOF, capped at MAX_RAW_BYTES_PER_READ. Returns undefined on I/O
 * failure or when nothing new is available.
 */
export async function readConversationSince(
  transcriptPath: string | undefined,
  offset: number,
): Promise<ConversationSlice | undefined> {
  if (!transcriptPath) return undefined;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      // Clamp: a truncated/rotated transcript (size < stored offset) restarts
      // from 0 rather than reading a negative range.
      const start = offset > size ? 0 : Math.max(0, offset);
      if (size - start <= 0) return undefined;
      const capped = size - start > MAX_RAW_BYTES_PER_READ;
      const length = capped ? MAX_RAW_BYTES_PER_READ : size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let raw = buffer.toString('utf8');
      let consumed = length;
      if (capped) {
        // Cut at the last complete JSONL line so the next read resumes cleanly
        // (this also drops any partial multibyte char at the buffer edge).
        const lastNl = raw.lastIndexOf('\n');
        if (lastNl > 0) {
          raw = raw.slice(0, lastNl);
          consumed = Buffer.byteLength(raw, 'utf8') + 1; // + the '\n'
        }
      }
      return {
        text: stripJsonlToConversation(raw),
        newOffset: start + consumed,
        rawLen: consumed,
        capped,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
