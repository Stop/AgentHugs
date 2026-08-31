import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

interface AgentEntry {
  name: string
  pid: number
  session: string
  lastSeen: number
  status: string
}

interface LockEntry {
  agent: string
  session: string
  reason: string
  since: number
  ttl: number
}

interface MessageEntry {
  id: string
  ts: number
  session: string
  agent: string
  kind: "status" | "edit" | "lock" | "unlock" | "join" | "leave"
  text: string
  file?: string
}

interface Board {
  agents: Record<string, AgentEntry>
  locks: Record<string, LockEntry>
  messages: MessageEntry[]
}

const HEARTBEAT_MS = 5000
const STALE_MS = 15_000
const MAX_MESSAGES = 2000

function now(): number {
  return Date.now()
}

function isStale(ts: number): boolean {
  return now() - ts > STALE_MS
}

type Instance = {
  hugsDir: string
  stateFile: string
  logFile: string
  sessionId: string
  agentName: string
  board: Board
}

function writeTextAtomic(file: string, content: string, tmpSuffix: string) {
  const tmp = file + "." + tmpSuffix + ".tmp"
  fs.writeFileSync(tmp, content, "utf8")
  fs.renameSync(tmp, file)
}

function readBoard(inst: Instance): Board {
  try {
    if (!fs.existsSync(inst.stateFile)) {
      inst.board = { agents: {}, locks: {}, messages: [] }
      return inst.board
    }
    const parsed = JSON.parse(fs.readFileSync(inst.stateFile, "utf8")) as Board
    inst.board = {
      agents: parsed.agents ?? {},
      locks: parsed.locks ?? {},
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    }
    return inst.board
  } catch {
    inst.board = { agents: {}, locks: {}, messages: [] }
    return inst.board
  }
}

function pushMessage(inst: Instance, b: Board, m: Omit<MessageEntry, "id" | "ts" | "agent" | "session"> & { agent?: string; session?: string }) {
  b.messages.push({
    id: randomUUID(),
    ts: now(),
    agent: m.agent ?? inst.agentName,
    session: m.session ?? inst.sessionId,
    ...m,
  } as MessageEntry)
  if (b.messages.length > MAX_MESSAGES) {
    b.messages = b.messages.slice(b.messages.length - MAX_MESSAGES)
  }
}

function pruneStaleLocks(inst: Instance) {
  const snap = readBoard(inst)
  const liveSessions = new Set<string>()
  for (const [id, agent] of Object.entries(snap.agents)) {
    if (!isStale(agent.lastSeen)) liveSessions.add(id)
  }
  for (const [file, lock] of Object.entries(snap.locks)) {
    const holder = snap.agents[lock.session]
    const expired = !liveSessions.has(lock.session) || now() - lock.since > lock.ttl
    if (expired) {
      delete snap.locks[file]
      pushMessage(inst, snap, {
        kind: "unlock",
        text: `Lock on "${file}" expired (holder gone or ttl passed)`,
        file,
      })
    }
  }
}

function persist(inst: Instance, b: Board) {
  inst.board = b
  fs.mkdirSync(inst.hugsDir, { recursive: true })
  try {
    writeTextAtomic(inst.stateFile, JSON.stringify(b, null, 2), inst.sessionId)
  } catch {
    /* state write is best-effort under races */
  }
  try {
    writeTextAtomic(inst.logFile, renderHtml(inst, b), inst.sessionId)
  } catch {
    /* html render is best-effort */
  }
}

function withBoard<T>(inst: Instance, fn: (b: Board) => T): T {
  const b = readBoard(inst)
  pruneStaleLocks(inst)
  const res = fn(b)
  persist(inst, b)
  return res
}

function renderHtml(inst: Instance, board: Board): string {
  const fmt = (ts: number) => {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const esc = (s: string) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  const agentRows = Object.entries(board.agents)
    .map(([id, a]) => {
      const alive = !isStale(a.lastSeen)
      return `<tr class="${alive ? "alive" : "gone"}">
        <td>${esc(a.name)}</td>
        <td>${esc(id.slice(0, 8))}</td>
        <td>${fmt(a.lastSeen)}</td>
        <td>${alive ? "active" : "stale"}</td>
        <td>${esc(a.status || "—")}</td>
      </tr>`
    })
    .join("")

  const lockRows = Object.entries(board.locks)
    .map(([file, l]) => {
      const holder = board.agents[l.session]
      return `<tr><td class="mono">${esc(file)}</td><td>${esc(holder?.name || l.session)}</td><td>${esc(l.reason || "—")}</td><td>${fmt(l.since)}</td><td>${Math.round((l.ttl - (now() - l.since)) / 1000)}s</td></tr>`
    })
    .join("")

  const kindClass: Record<string, string> = {
    join: "k-join",
    leave: "k-leave",
    edit: "k-edit",
    lock: "k-lock",
    unlock: "k-unlock",
    status: "k-status",
  }
  const kindLabel: Record<string, string> = {
    join: "joined",
    leave: "left",
    edit: "edited",
    lock: "locked",
    unlock: "unlocked",
    status: "status",
  }

  const msgRows = [...board.messages]
    .reverse()
    .map((m) => {
      const fileTag = m.file ? `<span class="mono file">${esc(m.file)}</span>` : ""
      return `<div class="msg ${kindClass[m.kind] || ""}">
        <span class="time">${fmt(m.ts)}</span>
        <span class="agent">${esc(m.agent)}</span>
        <span class="kind">${kindLabel[m.kind] || m.kind}</span>
        <span class="text">${esc(m.text)}</span>${fileTag}
      </div>`
    })
    .join("")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Hugs — activity log</title>
<style>
  :root {
    --bg: #10131a; --panel: #1a1f2b; --panel2: #222838;
    --text: #e6e9f0; --muted: #8b93a7; --accent: #ff7ab8;
    --border: #2c3344; --mono: #9cdcfe;
    --green: #7ee0a3; --red: #ff7b7b; --amber: #ffd479; --blue: #7bc7ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 20px 28px; background: linear-gradient(135deg, #241b2f, #10131a);
    border-bottom: 1px solid var(--border); }
  header h1 { margin: 0; font-size: 22px; letter-spacing: .5px; }
  header h1 .hug { color: var(--accent); }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px 28px; }
  .grid.cols1 { grid-template-columns: 1fr; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .panel h2 { margin: 0; padding: 12px 16px; font-size: 14px; text-transform: uppercase;
    letter-spacing: 1px; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--panel2); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  tr.alive td:nth-child(4) { color: var(--green); }
  tr.gone td:nth-child(4) { color: var(--red); }
  .mono { font-family: "Cascadia Code", Consolas, monospace; color: var(--mono); }
  .board { max-height: 340px; overflow: auto; }
  .msg { display: flex; align-items: baseline; gap: 10px; padding: 7px 12px;
    border-bottom: 1px solid var(--border); font-size: 13px; flex-wrap: wrap; }
  .msg .time { color: var(--muted); font-family: Consolas, monospace; font-size: 12px; white-space: nowrap; }
  .msg .agent { font-weight: 600; white-space: nowrap; }
  .msg .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
    padding: 1px 7px; border-radius: 10px; background: var(--panel2); color: var(--muted); white-space: nowrap; }
  .msg .text { flex: 1; }
  .msg .file { font-size: 12px; }
  .k-join .agent { color: var(--green); } .k-join .kind { color: var(--green); }
  .k-leave .agent { color: var(--red); } .k-leave .kind { color: var(--red); }
  .k-lock .kind { color: var(--amber); } .k-unlock .kind { color: var(--blue); }
  .k-edit .kind { color: var(--blue); }
  .empty { padding: 18px; color: var(--muted); font-size: 13px; }
  footer { padding: 16px 28px; color: var(--muted); font-size: 12px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>
    <span class="hug">Agent Hugs</span> · activity log
  </h1>
  <p>Generated ${fmt(now())} · open this file in a browser to view. No server needed.</p>
</header>

<div class="grid cols1">
  <div class="panel">
    <h2>Active agents (${Object.keys(board.agents).length})</h2>
    ${agentRows ? `<table>
      <tr><th>name</th><th>id</th><th>last seen</th><th>state</th><th>status</th></tr>
      ${agentRows}
    </table>` : '<div class="empty">No agents yet.</div>'}
  </div>
</div>

<div class="grid">
  <div class="panel">
    <h2>File locks (${Object.keys(board.locks).length})</h2>
    ${lockRows ? `<table>
      <tr><th>file</th><th>held by</th><th>reason</th><th>since</th><th>ttl</th></tr>
      ${lockRows}
    </table>` : '<div class="empty">No active locks.</div>'}
  </div>
  <div class="panel">
    <h2>Activity feed (${board.messages.length})</h2>
    <div class="board">
      ${msgRows || '<div class="empty">Nothing yet — send a hug to start the log.</div>'}
    </div>
  </div>
</div>

<footer>Agent Hugs · every message, heartbeat, lock and edit is recorded here automatically.</footer>
</body>
</html>`
}

export const AgentHugs: Plugin = async ({ project, directory }) => {
  const inst: Instance = {
    hugsDir: "",
    stateFile: "",
    logFile: "",
    sessionId: randomUUID(),
    agentName: "",
    board: { agents: {}, locks: {}, messages: [] },
  }

  inst.hugsDir = path.join(directory, ".agenthugs")
  inst.stateFile = path.join(inst.hugsDir, "state.json")
  inst.logFile = path.join(inst.hugsDir, "log.html")

  const base = path.basename(project?.worktree || directory) || "agent"
  inst.agentName = `${base}@${String(process.pid).slice(-4)}`

  fs.mkdirSync(inst.hugsDir, { recursive: true })
  withBoard(inst, (b) => {
    b.agents[inst.sessionId] = {
      name: inst.agentName,
      pid: process.pid,
      session: inst.sessionId,
      lastSeen: now(),
      status: "online",
    }
    pushMessage(inst, b, { kind: "join", text: `${inst.agentName} connected to the project.` })
  })

  const beat = setInterval(() => {
    withBoard(inst, (b) => {
      if (b.agents[inst.sessionId]) {
        b.agents[inst.sessionId].lastSeen = now()
      }
    })
  }, HEARTBEAT_MS)

  const htmlPath = inst.logFile

  const say = (text: string) => {
    withBoard(inst, (b) => pushMessage(inst, b, { kind: "status", text }))
    return `"${text}" shared with all agents. Open/refresh ${htmlPath} to view the log.`
  }

  return {
    dispose: async () => {
      clearInterval(beat)
      try {
        withBoard(inst, (b) => {
          if (b.agents[inst.sessionId]) b.agents[inst.sessionId].lastSeen = 0
          for (const [f, l] of Object.entries(b.locks)) {
            if (l.session === inst.sessionId) delete b.locks[f]
          }
          pushMessage(inst, b, { kind: "leave", text: `${inst.agentName} disconnected.` })
        })
      } catch {
        /* board may already be gone */
      }
    },

    "tool.execute.after": async (input) => {
      const toolName = input.tool
      const args = (input as { args?: Record<string, unknown> }).args ?? {}
      if (toolName === "edit" || toolName === "write") {
        const filePath = (args as { filePath?: string }).filePath
        if (filePath) {
          withBoard(inst, (b) => pushMessage(inst, b, { kind: "edit", text: "edited file", file: filePath.replace(/\\/g, "/") }))
        }
      }
    },

    "tool.execute.before": async (input) => {
      const toolName = input.tool
      const args = (input as { args?: Record<string, unknown> }).args ?? {}
      if (toolName === "edit" || toolName === "write") {
        const filePath = (args as { filePath?: string }).filePath
        if (filePath) {
          const rel = filePath.replace(/\\/g, "/")
          const b = readBoard(inst)
          const lock = b.locks[rel]
          if (lock && lock.session !== inst.sessionId) {
            const holder = b.agents[lock.session]
            throw new Error(`Cannot edit "${rel}": it is locked by ${holder ? holder.name : lock.session}.${lock.reason ? " Reason: " + lock.reason : ""} Use hug_status, coordinate with hug_send, or wait for them to unlock.`)
          }
        }
      }
    },

    tool: {
      hug_send: tool({
        description:
          "Send a short status update to the other agent(s) working on this project. Use this to say what you're doing, blockers, or completion notes so nobody steps on each other. Also resolves to a message everyone can read.",
        args: {
          text: tool.schema.string().describe("The short update to share with other agents."),
        },
        async execute(args) {
          return say(args.text)
        },
      }),

      hug_status: tool({
        description:
          "Read the current Agent Hugs board: who else is connected, what each agent is doing, which files are currently locked (and by whom), and the recent activity feed. Check this before and while editing shared files.",
        args: {},
        async execute() {
          const b = readBoard(inst)
          pruneStaleLocks(inst)
          const alive = Object.values(b.agents).filter((a) => !isStale(a.lastSeen))
          const locks = Object.entries(b.locks).map(([f, l]) => {
            const holder = b.agents[l.session]
            return { file: f, heldBy: holder ? holder.name : l.session, reason: l.reason, ttlLeft: Math.max(0, Math.round((l.ttl - (now() - l.since)) / 1000)) }
          })
          const feed = [...b.messages]
            .slice(-40)
            .reverse()
            .map((m) => `${m.agent} [${m.kind}] ${m.text}${m.file ? " -> " + m.file : ""}`)
          return JSON.stringify(
            {
              connected: alive.map((a) => ({ name: a.name, status: a.status, lastSeen: new Date(a.lastSeen).toISOString() })),
              locks,
              recent: feed,
              log: `${htmlPath}`,
            },
            null,
            2,
          )
        },
      }),

      hug_lock: tool({
        description:
          "Acquire an exclusive lock on a file (relative path within this project) so no other agent edits it while you work. Returns success or a clear conflict error listing who holds it. Call hug_unlock when done.",
        args: {
          file: tool.schema.string().describe("Project-relative path of the file to lock, e.g. src/Foo.ts"),
          reason: tool.schema.string().optional().describe("Short note about why you need the lock."),
          ttl_seconds: tool.schema.number().optional().describe("Lock lifetime in seconds. Defaults to 600. Extends automatically each heartbeat."),
        },
        async execute(args) {
          const rel = args.file.replace(/\\/g, "/")
          const ttl = args.ttl_seconds && args.ttl_seconds > 0 ? args.ttl_seconds * 1000 : 600_000
          return withBoard(inst, (b) => {
            pruneStaleLocks(inst)
            const existing = b.locks[rel]
            if (existing && existing.session !== inst.sessionId) {
              const holder = b.agents[existing.session]
              pushMessage(inst, b, { kind: "lock", text: `${inst.agentName} tried to lock "${rel}" but it's held by ${holder ? holder.name : existing.session}.` })
              return `CONFLICT: "${rel}" is already locked by ${holder ? holder.name : existing.session}. ${existing.reason ? "Reason: " + existing.reason + ". " : ""}Wait for them to unlock, or coordinate via hug_send.`
            }
            b.locks[rel] = { agent: inst.agentName, session: inst.sessionId, reason: args.reason ?? "", since: now(), ttl }
            pushMessage(inst, b, { kind: "lock", text: `${inst.agentName} locked "${rel}".${args.reason ? " Reason: " + args.reason : ""}`, file: rel })
            return `LOCKED "${rel}" for ${ttl / 1000}s. Remember to hug_unlock when done. Other agents will now steer clear.`
          })
        },
      }),

      hug_unlock: tool({
        description:
          "Release a file lock you previously acquired with hug_lock, so other agents can edit it. Safe to call even if the lock is gone.",
        args: {
          file: tool.schema.string().describe("Project-relative path of the file you locked. (Optional — omit to release every lock you hold.)").optional(),
        },
        async execute(args) {
          return withBoard(inst, (b) => {
            pruneStaleLocks(inst)
            const mine = Object.entries(b.locks).filter(([, l]) => l.session === inst.sessionId)
            if (args.file) {
              const rel = args.file.replace(/\\/g, "/")
              const l = b.locks[rel]
              if (!l) return `No lock exists on "${rel}".`
              if (l.session !== inst.sessionId) return `You don't hold the lock on "${rel}" — ${b.agents[l.session]?.name ?? l.session} does.`
              delete b.locks[rel]
              pushMessage(inst, b, { kind: "unlock", text: `${inst.agentName} released "${rel}".`, file: rel })
              return `Unlocked "${rel}".`
            } else {
              const released = mine.map(([f]) => {
                delete b.locks[f]
                pushMessage(inst, b, { kind: "unlock", text: `${inst.agentName} released "${f}".`, file: f })
                return f
              })
              return released.length ? `Unlocked: ${released.join(", ")}` : "You hold no locks."
            }
          })
        },
      }),
    },
  }
}
