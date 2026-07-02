/**
 * Rendering for manual `project sync` results. Split out of the command
 * handler because the empty-push case needs wording that does not read as a
 * failure: boundary auto-sync (P3-b) usually pushes new events before a manual
 * `--push` runs, so "Pushed 0 events. lastAcceptedEventId=none" was the normal
 * outcome of a HEALTHY store - and looked broken (W3 live dogfood, 2026-07-03).
 */

export interface PushResultView {
  accepted: unknown[];
  lastAcceptedEventId?: string;
}

/**
 * Render a manual-push outcome. `watermark` is the persisted
 * `lastPushedEventId` AFTER the push, so an empty push can still show where
 * the log stands instead of `none`.
 */
export function renderPushResult(
  response: PushResultView,
  watermark: string | undefined,
): string {
  if (response.accepted.length === 0) {
    return (
      'Already up to date - nothing new to push (boundary auto-sync keeps ' +
      `this current). watermark=${watermark ?? 'none'}`
    );
  }
  return (
    `Pushed ${response.accepted.length} events. ` +
    `lastAcceptedEventId=${response.lastAcceptedEventId ?? 'none'}`
  );
}
