// Kanban live feed: poll task_events by COPYING db + wal to tmp and opening the copy
// (an immutable=1 connection is a snapshot that misses un-checkpointed WAL rows).
// P0 spike: copy+read = 6ms, so a 3s poll is trivial.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(homedir(), ".hermes/kanban.db");
const TMP = join(tmpdir(), "cockpit-kanban.db");

function snapshot() {
  copyFileSync(SRC, TMP);
  if (existsSync(SRC + "-wal")) copyFileSync(SRC + "-wal", TMP + "-wal");
  return new DatabaseSync(TMP);
}

export function kanbanAvailable() { return existsSync(SRC); }

export function readBoard() {
  if (!kanbanAvailable()) return { tasks: [] };
  const db = snapshot();
  try {
    const rows = db.prepare(`SELECT * FROM tasks WHERE status NOT IN ('archived') LIMIT 100`).all();
    const tasks = rows.map((r) => ({ id: r.id, title: r.title, status: r.status, assignee: r.assignee, priority: r.priority, heartbeat: r.last_heartbeat_at ?? null }));
    return { tasks };
  } finally { db.close(); }
}

// Poll for new task_events (id > since). Returns { events, maxId }.
export function eventsSince(since = 0, limit = 100) {
  if (!kanbanAvailable()) return { events: [], maxId: since };
  const db = snapshot();
  try {
    const events = db.prepare(`SELECT id, task_id, run_id, kind, payload, created_at
      FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?`).all(since, limit);
    return { events, maxId: events.length ? events[events.length - 1].id : since };
  } finally { db.close(); }
}

export class KanbanWatcher {
  constructor(onEvents, intervalMs = 3000) {
    this.onEvents = onEvents;
    this.last = null; // primed on first tick so we only stream NEW activity
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }
  tick() {
    try {
      if (this.last === null) { this.last = eventsSince(0, 1e9).maxId; return; }
      const { events, maxId } = eventsSince(this.last);
      if (events.length) { this.last = maxId; this.onEvents(events); }
    } catch { /* db mid-write copy race: retry next tick */ }
  }
  stop() { clearInterval(this.timer); }
}
