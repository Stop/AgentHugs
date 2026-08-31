# Agent Hugs

A plugin for [opencode](https://opencode.ai) that lets multiple agent sessions work on the **same project simultaneously without colliding**. Agents share little updates, lock the files they're editing, and can't clobber each other — plus you get a pretty, self-contained activity log to watch it all live.

## Why

Running two opencode tabs/agents on one project is risky: both can edit the same files and silently overwrite each other. Agent Hugs gives them a shared "hug board" so they coordinate instead of colliding.

## How it works

Each opencode process loads the plugin and talks to a shared state file, `.agenthugs/state.json`, in the project root. Every agent:

- **registers itself** with a heartbeat (stale agents and their locks auto-expire after ~15s)
- **announces** edits and locks to a shared feed
- **respects locks**: an agent physically cannot edit a file another agent holds locked

A self-contained **`.agenthugs/log.html`** is regenerated on every change — open it directly in a browser (no web server needed) to watch the board.

## Installation

Put `agenthugs.ts` in your opencode plugin directory.

**Global (every project):**

```
~/.config/opencode/plugins/agenthugs.ts
```

**Project-local (one project):** place it at `.opencode/plugins/agenthugs.ts` and enable it in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/agenthugs.ts"]
}
```

Global plugins load automatically; no config entry required. Local plugins that import `@opencode-ai/plugin` need a `.opencode/package.json` declaring that dependency (opencode runs its own install at startup).

Restart opencode after installing — config and plugins load once at startup.

## Choosing which projects use it

The plugin can be installed **globally** (loaded in every project) but only **activated** in the projects you choose. This is the recommended setup:

- **Plugin → global.** Install once at `~/.config/opencode/plugins/agenthugs.ts`. It loads everywhere but sits **idle** in any project where no agent is told to use it — nothing changes for those projects.
- **Coordination rules → per-project `AGENTS.md`.** Agents only coordinate in projects that contain an `AGENTS.md` with the Agent Hugs rules (opencode auto-loads it for that project).

So to enable Agent Hugs on a project, just add this `AGENTS.md` to its root:

```markdown
# Agent Hugs — multi-agent coordination

You may be working in parallel with another agent session on this same project.
Coordinate with them using Agent Hugs so you don't collide.

- Before editing, call `hug_status` to see who's active and which files are locked.
- Call `hug_lock` on every file you're going to modify (with a short `reason`), before you edit.
- Call `hug_unlock` when you're done with a file.
- Do NOT edit files locked by another agent. Check `hug_status`, ask via `hug_send`, or work on something else.
- Use `hug_send` to flag what you're working on, blockers, or hand-offs.
- The plugin auto-blocks edits to files locked by another agent. If an edit fails with a
  lock conflict, respect it — don't try to work around it.
```

Projects **without** that `AGENTS.md` simply don't coordinate — the loaded plugin is harmless there.

## Tools

Agents use these tools to coordinate:

| Tool | Purpose |
| --- | --- |
| `hug_status` | See who's connected, what they're doing, which files are locked (and by whom), and the recent activity feed. |
| `hug_lock(file, reason?, ttl_seconds?)` | Take an exclusive lock on a file so no other agent edits it. Default TTL 600s, auto-extends via heartbeat. |
| `hug_unlock(file?)` | Release a lock. Omit `file` to release every lock you hold. |
| `hug_send(text)` | Post a status update / heads-up to the other agent(s). |

### Automatic guardrails (no agent cooperation required)

- **Lock enforcement** — if an agent tries to `edit`/`write` a file locked by another, the tool call is **blocked** with a clear message telling it who holds the lock and why.
- **Edit announcements** — every file edit/write is logged to the feed automatically.
- **Expiry** — if an agent dies or disconnects, its heartbeat stops and its locks are auto-released so you're never stuck waiting on a ghost lock.

## Recommended agent instruction

Yes — a standing instruction telling agents to lock and check status is exactly right. The two things to get agents doing:

- call **`hug_lock`** on every file before they edit it, and **`hug_unlock`** when done;
- check **`hug_status`** when they need situational awareness (not on *every* interaction — that gets noisy).

The full, ready-to-paste template lives in [Choosing which projects use it](#choosing-which-projects-use-it) above; drop it into the project's `AGENTS.md`, a custom agent's prompt, or your session prompt.

You don't need to repeat it constantly — the lock **blocking** is enforced by the plugin even if an agent forgets to check. The instruction just gets agents to use the tools proactively (and to unlock when they finish), so the safety net never depends on them remembering.

## Viewing the log

Open `.agenthugs/log.html` in any browser. It's fully self-contained (embedded CSS, dark theme) with three sections:

- **Active agents** — who's connected and their last status
- **File locks** — what's locked, by whom, and TTL remaining
- **Activity feed** — joins, leaves, edits, and every hug, newest first

The file regenerates automatically on every change — just refresh the tab.

## Files & data

| Path | Purpose |
| --- | --- |
| `.agenthugs/state.json` | Live shared state (agents, locks, messages). Safe to delete; regenerates. |
| `.agenthugs/log.html` | Human-readable activity log. |
| `opencode.json` | (Optional) registers the plugin for project-local installs. |

Add `.agenthugs/` to your `.gitignore` so runtime state isn't committed.

## Development

Type-check the plugin:

```bash
cd .opencode
npm install
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --types node plugins/agenthugs.ts
```
