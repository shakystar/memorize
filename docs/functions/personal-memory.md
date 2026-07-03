# Personal memory

## What

Personal memory is the account-scoped memory for user preferences and working-style facts. It follows the same user across projects.

## Who

The account owner reads and writes personal memory. It is not shared with a workspace as project state.

## When

- Automatic classification can route personal facts during consolidation.
- Explicit import can add pre-existing personal notes.
- Startup rendering can include top personal memories in a separate channel.
- Same-account sync can move personal memory between the user's devices.

## Where

Local personal memory lives here:

```text
<MEMORIZE_ROOT>/accounts/<accountId>/personal/memorize.db
```

When synced through the Hub, the remote store id is server-minted and starts with `psm_`.

## Why

Project memory should not contain private user preferences. Personal memory keeps those facts useful across projects without leaking them into a project workspace.

## How

1. The extractor classifies a memory as project or personal.
2. Personal memories are stored outside any project.
3. Startup rendering labels personal memories as `memorize.personal`.
4. `personal sync` routes through the account's `psm_` store and stays inside the same account boundary.

## Commands

```sh
memorize personal import --source <label>
memorize personal list
memorize personal show <memoryId>
memorize personal sync --remote-url <hub-url>
```

## Rule

User preferences and working-style facts belong here. Project state does not. Personal sync is same-account only.
