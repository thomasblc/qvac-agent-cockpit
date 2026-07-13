// Session history across the main + per-profile Hermes stores (read-only).
// state.db opens fine with mode=ro while the gateway runs (P0 spike; FTS across 9 DBs = 17ms).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function dbPaths() {
  const H = homedir();
  const out = [{ profile: "main", path: join(H, ".hermes/state.db") }];
  const prof = join(H, ".hermes/profiles");
  if (existsSync(prof)) for (const p of readdirSync(prof)) {
    const f = join(prof, p, "state.db");
    if (existsSync(f)) out.push({ profile: p, path: f });
  }
  return out.filter((d) => existsSync(d.path));
}
function openRo(p) { return new DatabaseSync("file:" + p + "?mode=ro", { readOnly: true }); }

export function listSessions({ limit = 60 } = {}) {
  const rows = [];
  for (const d of dbPaths()) {
    try {
      const db = openRo(d.path);
      try {
        for (const r of db.prepare(`SELECT id, source, title, started_at, ended_at, message_count, tool_call_count,
            input_tokens, output_tokens, parent_session_id FROM sessions ORDER BY started_at DESC LIMIT ?`).all(limit)) {
          rows.push({ ...r, profile: d.profile });
        }
      } finally { db.close(); }
    } catch { /* locked or older schema: skip */ }
  }
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return rows.slice(0, limit);
}

export function searchMessages(q, { limit = 30 } = {}) {
  const hits = [];
  const safe = String(q || "").replace(/["']/g, " ").trim();
  if (!safe) return hits;
  for (const d of dbPaths()) {
    try {
      const db = openRo(d.path);
      try {
        for (const r of db.prepare(`SELECT m.session_id, m.role, snippet(messages_fts, 0, '[', ']', ' ... ', 12) AS snip, m.timestamp
            FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ? LIMIT ?`).all(safe, limit)) {
          hits.push({ ...r, profile: d.profile });
        }
      } finally { db.close(); }
    } catch { /* no fts in this db: skip */ }
  }
  return hits.slice(0, limit);
}

// Subagent tree: sessions grouped by parent_session_id.
export function sessionTree({ limit = 200 } = {}) {
  const all = listSessions({ limit });
  const byId = new Map(all.map((s) => [s.id, { ...s, children: [] }]));
  const roots = [];
  for (const s of byId.values()) {
    if (s.parent_session_id && byId.has(s.parent_session_id)) byId.get(s.parent_session_id).children.push(s);
    else roots.push(s);
  }
  return roots;
}

// Read a past session's transcript directly from its profile DB (NOT via ACP session/load, which
// would hijack the live session). Honest "view a past session" without replay side effects.
export function viewSession(sessionId, profile = "main") {
  const path = profile === "main" ? join(H, ".hermes/state.db") : join(H, ".hermes/profiles", profile, "state.db");
  if (!existsSync(path)) return { messages: [] };
  try {
    const db = openRo(path);
    try {
      const messages = db.prepare(`SELECT role, content, tool_name, timestamp FROM messages WHERE session_id=? ORDER BY rowid ASC LIMIT 400`).all(sessionId);
      return { messages };
    } finally { db.close(); }
  } catch { return { messages: [] }; }
}
