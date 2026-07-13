// Files pane backend: path-jailed read/write over the corpus roots + the diff-first review
// model (cockpit.db file_reviews: reviewed hash + snapshot, since agent workspaces are not
// guaranteed git repos). v1 review granularity = whole file (mark reviewed / revert to the
// reviewed snapshot); per-hunk lands later.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { walkCorpus, corpusRoots } from "./brain.js";
import { assertSafeFile, safeWriteFile } from "./safe-path.js";

const DIR = join(homedir(), ".qvac-cockpit");
mkdirSync(join(DIR, "snapshots"), { recursive: true });
const db = new DatabaseSync(join(DIR, "cockpit.db"));
db.exec(`CREATE TABLE IF NOT EXISTS file_reviews (path TEXT PRIMARY KEY, reviewed_hash TEXT, snapshot_path TEXT, reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS cron_summaries (job_hash TEXT PRIMARY KEY, oneliner TEXT);`);

export function bump(key, by = 1) {
  db.prepare("INSERT INTO counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = value + ?").run(key, by, by);
}
export function counters() { return Object.fromEntries(db.prepare("SELECT key, value FROM counters").all().map((r) => [r.key, r.value])); }
export function cronSummary(hash) { return db.prepare("SELECT oneliner FROM cron_summaries WHERE job_hash=?").get(hash)?.oneliner || null; }
export function setCronSummary(hash, s) { db.prepare("INSERT OR REPLACE INTO cron_summaries(job_hash,oneliner) VALUES(?,?)").run(hash, s); }

const sha = (s) => createHash("sha256").update(s).digest("hex");
const H = homedir();

// Jail: only ids the corpus walker produces are addressable (review rule).
function resolveId(fileId, workspace) {
  const f = walkCorpus(workspace).find((x) => x.id === fileId);
  if (!f) throw new Error("not in the corpus");
  return assertSafeFile(f.abs, corpusRoots(workspace).map((r) => r.root)); // rejects symlink/hardlink/escape
}

export function listFiles(workspace) {
  return walkCorpus(workspace).map((f) => {
    let reviewState = "new";
    try {
      const content = readFileSync(f.abs, "utf8");
      const row = db.prepare("SELECT reviewed_hash FROM file_reviews WHERE path=?").get(f.id);
      reviewState = !row ? "unreviewed" : (row.reviewed_hash === sha(content) ? "reviewed" : "changed");
    } catch { /* */ }
    return { id: f.id, profile: f.profile, mtime: f.mtime, reviewState };
  });
}

export function readFileById(fileId, workspace) {
  const abs = resolveId(fileId, workspace);
  const content = readFileSync(abs, "utf8");
  const row = db.prepare("SELECT reviewed_hash, snapshot_path FROM file_reviews WHERE path=?").get(fileId);
  const changed = row ? row.reviewed_hash !== sha(content) : true;
  let baseline = null;
  if (changed && row?.snapshot_path && existsSync(row.snapshot_path)) baseline = readFileSync(row.snapshot_path, "utf8");
  return { content, changed, baseline, mtime: statSync(abs).mtimeMs, contentHash: sha(content) };
}

export function writeFileById(fileId, content, workspace, knownHash = null) {
  const abs = resolveId(fileId, workspace);
  // Conflict guard on CONTENT hash (mtime second-granularity misses same-second edits): re-read the
  // current bytes immediately before writing and refuse if they diverged from what the client saw.
  const current = readFileSync(abs, "utf8");
  if (knownHash != null && sha(current) !== knownHash) return { ok: false, conflict: true, contentHash: sha(current) };
  safeWriteFile(abs, content, corpusRoots(workspace).map((r) => r.root));
  bump("files_written");
  return { ok: true, mtime: statSync(abs).mtimeMs, contentHash: sha(String(content)) };
}

export function markReviewed(fileId, workspace) {
  const abs = resolveId(fileId, workspace);
  const content = readFileSync(abs, "utf8");
  const h = sha(content);
  const snap = join(DIR, "snapshots", h.slice(0, 24));
  if (!existsSync(snap)) writeFileSync(snap, content);
  db.prepare("INSERT OR REPLACE INTO file_reviews(path,reviewed_hash,snapshot_path,reviewed_at) VALUES(?,?,?,?)").run(fileId, h, snap, Date.now());
  bump("files_reviewed");
  return { ok: true };
}

export function revertToReviewed(fileId, workspace, knownHash = null) {
  const abs = resolveId(fileId, workspace);
  const row = db.prepare("SELECT snapshot_path FROM file_reviews WHERE path=?").get(fileId);
  if (!row?.snapshot_path || !existsSync(row.snapshot_path)) throw new Error("no reviewed snapshot");
  const current = readFileSync(abs, "utf8");
  if (knownHash != null && sha(current) !== knownHash) return { ok: false, conflict: true, contentHash: sha(current) };
  safeWriteFile(abs, readFileSync(row.snapshot_path, "utf8"), corpusRoots(workspace).map((r) => r.root));
  return { ok: true };
}
