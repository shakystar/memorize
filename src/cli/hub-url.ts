/**
 * Pretty-URL contract with the Hub (decision_mr3pzyap_udw7gdma): an onboarding
 * URL's ORIGIN is the sync remote-url and its LAST path segment is the shared
 * store id (`wsp_…` workspace or `proj_…` legacy project). Intermediate
 * segments (`/clone`, `/sync`, `/p`, …) are display sugar the Hub is free to
 * change at any time, so parsing deliberately ignores them — the client must
 * never couple to a specific Hub route shape, and the Hub owes no redirect
 * endpoint.
 */

const HUB_STORE_ID = /^(wsp|proj)_[a-z0-9][a-z0-9_]*$/i;

export interface ParsedHubUrl {
  /** The Hub origin — what `--remote-url` would carry. */
  remoteUrl: string;
  /** The shared store id (`wsp_…` / `proj_…`) — the URL's last path segment. */
  remoteProjectId: string;
}

/** Cheap gate to tell a URL positional apart from a bare store id. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function parseHubUrl(raw: string): ParsedHubUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Hub URLs must be http(s): ${raw}`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || !HUB_STORE_ID.test(last)) {
    throw new Error(
      `Hub URL must end in a workspace/project id (wsp_… or proj_…): ${raw}`,
    );
  }
  return { remoteUrl: url.origin, remoteProjectId: last };
}
