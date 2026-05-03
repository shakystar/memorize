import type { ISODateString } from '../domain/common.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Human-friendly freshness label for an active session's lastSeenAt.
 * Used by the renderer to label "Other active tasks" entries so an agent
 * can decide whether to defer to the other session or treat the slot as
 * abandoned. Buckets:
 *   - < 5m  → "active just now"
 *   - < 30m → "active Nm ago"
 *   - < 4h  → "stale ~Nm ago" / "stale ~Nh ago"
 *   - >= 4h → "stale (likely abandoned)"
 */
export function freshnessLabel(
  lastSeenAt: ISODateString,
  now: Date = new Date(),
): string {
  const ageMs = now.getTime() - new Date(lastSeenAt).getTime();
  if (ageMs < 0) return 'active just now';
  if (ageMs < 5 * MINUTE_MS) return 'active just now';
  if (ageMs < 30 * MINUTE_MS) {
    return `active ${Math.round(ageMs / MINUTE_MS)}m ago`;
  }
  if (ageMs < 4 * HOUR_MS) {
    if (ageMs < HOUR_MS) {
      return `stale ~${Math.round(ageMs / MINUTE_MS)}m ago`;
    }
    return `stale ~${Math.round(ageMs / HOUR_MS)}h ago`;
  }
  return 'stale (likely abandoned)';
}
