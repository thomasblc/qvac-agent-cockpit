// OpenClaw store adapter (read-only). Unlike Hermes (SQLite state.db + kanban.db + cron/jobs.json),
// OpenClaw keeps sessions as per-session JSONL trajectories + a sessions.json index, and skills as
// a plugin/bundled catalog. We read both through the OpenClaw CLI's `--json` output (version-robust:
// the same reason cron/kanban mutations go through the hermes CLI) rather than reverse-engineering
// the on-disk shapes. OpenClaw has no kanban board or cron scheduler, so those panes report an
// honest "not available for this harness" rather than an error.
import { execFile } from "node:child_process";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { underRoot } from "./safe-path.js";

const H = homedir();
const SESS_DIR = join(H, ".openclaw/agents/main/sessions");
const MAX_TRAJECTORY = 8 * 1024 * 1024; // cap the on-disk read; a runaway agent's .jsonl can be huge

// A session id must be a bare file-stem: no separators, no traversal. It reaches us straight off the
// WS client (history.view) AND from OpenClaw's own on-disk session keys (a compromised agent could
// plant a `../`-laden key), so both callers must sanitize before building a path. Defense in depth:
// reject the id, then confirm the resolved path is still under SESS_DIR via the shared jail.
function sessionFile(sessionId) {
  const id = String(sessionId || "");
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) return null;
  const abs = resolve(SESS_DIR, `${id}.jsonl`);
  if (!underRoot(abs, [SESS_DIR])) return null;
  return abs;
}
// Read a trajectory file, TRULY bounded: read at most MAX_TRAJECTORY bytes off the fd so a
// multi-hundred-MB (or >V8's ~512MB string-limit) .jsonl never gets pulled fully into memory. A
// truncated final line is harmless: both callers split on "\n" and JSON.parse each line under try.
function readTrajectory(abs) {
  let fd = null;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.allocUnsafe(MAX_TRAJECTORY);
    const n = readSync(fd, buf, 0, MAX_TRAJECTORY, 0);
    return buf.toString("utf8", 0, n);
  } catch { return null; }
  finally { if (fd !== null) try { closeSync(fd); } catch { /* */ } }
}

// Resolve the openclaw binary once (PATH lookup is done by execFile with shell off, so pass a name).
const OC = process.env.OPENCLAW_BIN || "openclaw";

function ocJson(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(OC, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // The CLI prints gateway-connect warnings to stderr and falls back to the local store; that is
      // not a failure, so we key off stdout being parseable JSON, not the exit code alone.
      const s = String(stdout || "").trim();
      const i = s.indexOf("{"); const j = s.lastIndexOf("}");
      if (i < 0 || j < 0) return reject(new Error((err && err.message) || "openclaw returned no JSON"));
      try { resolve(JSON.parse(s.slice(i, j + 1))); } catch (e) { reject(e); }
    });
  });
}

// Map an OpenClaw session index entry to the cockpit's shared session shape (same fields the
// Hermes history pane renders, so the UI is harness-agnostic).
function mapSession(s) {
  return {
    id: s.sessionId || s.key,
    source: s.modelProvider ? `${s.modelProvider}/${s.model}` : (s.model || null),
    title: s.sessionId || s.key,
    started_at: s.sessionStartedAt || (s.updatedAt ? s.updatedAt - (s.ageMs || 0) : null),
    ended_at: s.updatedAt || null,
    message_count: null, // not exposed by the index; trajectory length would need a per-session read
    tool_call_count: null,
    input_tokens: s.inputTokens ?? null,
    output_tokens: s.outputTokens ?? null,
    parent_session_id: null, // OpenClaw sessions are flat keys, no subagent parent link in the index
    profile: s.agentId || "main",
    kind: s.kind || null,
  };
}

export function listSessions({ limit = 60 } = {}) {
  // Synchronous callers expect a value; but the CLI is async. Return a promise; server.js awaits.
  return ocJson(["sessions", "list", "--limit", String(limit)]).then((d) => {
    const rows = (d.sessions || []).map(mapSession);
    rows.sort((a, b) => (Number(b.ended_at) || 0) - (Number(a.ended_at) || 0));
    return rows.slice(0, limit);
  }).catch(() => []);
}

// OpenClaw's CLI has no cross-session full-text search, so we do an honest bounded scan of the
// recent session trajectories on disk. Kept small (recent sessions only) to stay snappy.
export async function searchMessages(q, { limit = 30 } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  let sessions = [];
  try { sessions = await listSessions({ limit: 40 }); } catch { return []; }
  const hits = [];
  for (const s of sessions) {
    if (hits.length >= limit) break;
    const jl = sessionFile(s.id);
    if (!jl || !existsSync(jl)) continue;
    const text = readTrajectory(jl);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (hits.length >= limit) break;
      const low = line.toLowerCase();
      if (!low.includes(needle)) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const content = extractText(ev);
      if (!content) continue;
      const idx = content.toLowerCase().indexOf(needle);
      const snip = idx >= 0 ? content.slice(Math.max(0, idx - 40), idx + 80) : content.slice(0, 120);
      hits.push({ session_id: s.id, role: ev.role || ev.type || "", snip: "..." + snip + "...", timestamp: ev.timestamp || null, profile: s.profile });
    }
  }
  return hits.slice(0, limit);
}

export function sessionTree({ limit = 200 } = {}) {
  // OpenClaw's session index is flat (no parent_session_id), so the "tree" is a flat root list.
  return listSessions({ limit }).then((all) => all.map((s) => ({ ...s, children: [] })));
}

function extractText(ev) {
  if (!ev || typeof ev !== "object") return "";
  if (typeof ev.text === "string") return ev.text;
  if (typeof ev.content === "string") return ev.content;
  if (Array.isArray(ev.content)) return ev.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
  if (ev.message && typeof ev.message.content === "string") return ev.message.content;
  return "";
}

// Read a past session transcript from its on-disk JSONL trajectory (no ACP session/load, which would
// hijack the live session). Maps trajectory events to the {role, content, tool_name, timestamp} shape.
export function viewSession(sessionId /*, profile */) {
  const jl = sessionFile(sessionId);
  if (!jl || !existsSync(jl)) return { messages: [] };
  const text = readTrajectory(jl);
  if (!text) return { messages: [] };
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || messages.length >= 400) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const t = ev.type;
    if (t === "user_message" || t === "assistant_message" || t === "message") {
      const content = extractText(ev);
      if (content) messages.push({ role: ev.role || (t === "user_message" ? "user" : "assistant"), content: content.slice(0, 4000), tool_name: null, timestamp: ev.timestamp || null });
    } else if (t === "tool_execution" || t === "tool_call") {
      messages.push({ role: "tool", content: extractText(ev).slice(0, 1000), tool_name: ev.tool || ev.name || ev.toolName || null, timestamp: ev.timestamp || null });
    }
  }
  return { messages };
}

// Skills via `openclaw skills list --json`. OpenClaw has no per-skill usage counter (no .usage.json),
// so useCount/lastUsedAt are null; we surface readiness (eligible) + source instead.
export function listSkills() {
  return ocJson(["skills", "list"], 20000).then((d) => {
    const out = (d.skills || []).map((s) => ({
      name: s.name,
      category: s.source || (s.bundled ? "openclaw-bundled" : "skill"),
      description: String(s.description || "").slice(0, 140),
      version: s.version || null,
      useCount: 0,
      lastUsedAt: null,
      pinned: false,
      ready: s.eligible === true,
      emoji: s.emoji || null,
    }));
    // ready skills first, then alphabetical
    out.sort((a, b) => (b.ready - a.ready) || String(a.name).localeCompare(String(b.name)));
    return out;
  }).catch(() => []);
}
