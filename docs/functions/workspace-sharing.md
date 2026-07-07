# Workspace sharing

## What

Workspace sharing lets multiple accounts exchange project memory through a Hub workspace. The Hub mints a workspace store id that starts with `wsp_`.

A public hosted Hub is live at https://memorize-hub-shakystar.fly.dev (open beta, free to join); the `<hub-url>` in the commands below can point at it or at your own Hub.

## Who

Workspace members can read shared workspace memory. Owners can invite members, change roles, remove members, and retract another writer's memory when the owner-only rule applies.

## When

- Create a workspace when a local project needs shared remote coordination.
- Invite a member when another account needs access.
- Join a workspace when a member receives an invite token or URL.
- Sync when the local project should exchange events with the workspace store.

## Where

Workspace identity and membership live in the Hub control plane. Project events still live in local project stores and sync through the Hub data plane.

The local project keeps its own `proj_` identity. The workspace uses a remote `wsp_` id. Foreign member events keep their origin in `sourceProjectId`.

## Why

The local project must keep working offline. The shared workspace must also have one remote coordination identity and one membership model. Separating `proj_` from `wsp_` gives both.

## How

1. `workspace create` asks the Hub for a `wsp_` store.
2. The client stores the Hub URL, `wsp_` id, and cached role in sync state.
3. Project sync pushes and pulls event logs through the `wsp_` data route.
4. Startup rendering shows other members' memories in `memorize.shared`.

## Commands

```sh
memorize auth login --remote-url <hub-url>
memorize workspace create --remote-url <hub-url>
memorize workspace invite
memorize workspace join --remote-url <hub-url> --token <invite-token>
memorize workspace status
memorize workspace members
memorize workspace promote <accountId-or-email>
memorize workspace demote <accountId-or-email>
memorize workspace remove <accountId-or-email>
memorize project sync --push --pull
```

## Rule

Workspace identity, membership, and role are Hub control-plane facts.
