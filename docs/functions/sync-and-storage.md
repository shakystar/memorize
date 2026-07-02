# Sync and storage

## What

Sync exchanges append-only event logs. Storage keeps local project and personal stores under the active account.

## Who

Local agents read the local store. The Hub coordinates remote stores, credentials, workspace membership, and same-account personal sync.

## When

- Startup reads local data.
- Manual sync runs when the user or agent calls `project sync` or `personal sync`.
- Automatic sync can run at session boundaries when a remote binding exists.

## Where

```text
<MEMORIZE_ROOT>/
  profile/
    bindings.json
  credentials
  accounts/
    <accountId>/
      projects/
        <projectId>/
          memorize.db
          sync/remote.json
      personal/
        memorize.db
        sync/remote.json
```

## Why

Local stores keep startup fast and offline. Hub stores give remote routing and access control without moving projection logic into the server.

## How

1. Events append locally.
2. Sync pushes local events and pulls remote events.
3. The client merges by event identity and rebuilds projections.
4. Startup uses local projections.

## Commands

```sh
memorize auth login --remote-url <hub-url>
memorize project sync --push --pull
memorize remote <hub-url>
memorize clone <hub-url>
memorize personal sync --remote-url <hub-url>
memorize projection rebuild
memorize memory-index rebuild
memorize events validate
```

## Rule

Canonical remote sync uses the Hub and server-minted `wsp_` or `psm_` ids. File transport remains for existing users but is deprecated and frozen.
