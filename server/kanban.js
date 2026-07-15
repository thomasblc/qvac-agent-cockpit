// Kanban store, file-backed so OpenClaw can participate. Each task is one markdown file in
// <workspace>/tasks/<id>.md. The cockpit and the agent both read/write these files: the cockpit
// via this module, the agent via its normal file tools. The format is deliberately LLM-friendly
// (a title, a few `key: value` lines, and `## Files` / `## Comments` sections) so the agent can
// edit a task by hand without needing an API.
//
// Round-trip integrity (agent <-> cockpit is the whole point):
//   - The `## Files` / `## Comments` sections are parsed for the UI but their ORIGINAL lines are
//     kept and re-emitted verbatim UNLESS the cockpit actually mutated that section. So a status
//     drag or a title edit never rewrites (and never drops) an agent's multi-line comments or prose.
//   - Any `## Section` the cockpit does not recognize (e.g. an agent's `## Notes`) is preserved
//     verbatim.
//   - `status:` / `owner:` lines are only read from the metadata block right under the title, so a
//     description line that happens to start with "status: ..." is NOT hijacked.
// Security: reads reject symlinks/hardlinks/jail-escape via safe-path.js (a compromised agent must
// not be able to point tasks/x.md at ~/.ssh/id_rsa and have the cockpit slurp it into the UI).
import { readdirSync, readFileSync, renameSync, unlinkSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertSafeFile } from "./safe-path.js";

const STATUSES = ["planned", "now", "done", "needs"];
const OWNERS = ["you", "agent"];
const META_KEYS = ["status", "owner", "updated", "date"];
const MAX_FILE_BYTES = 512 * 1024; // a task .md bigger than this is abnormal; skip it (DoS guard)

function tasksDir(ws) { return path.join(ws, "tasks"); }
function ensureDir(ws) { const d = tasksDir(ws); mkdirSync(d, { recursive: true }); return d; }
function pad2(n) { return String(n).padStart(2, "0"); }
function today() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function normStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (/(^|\b)(now|doing|wip|in[-\s]?progress|active)($|\b)/.test(v)) return "now";
  if (/(^|\b)(done|complete|completed|finished|shipped)($|\b)/.test(v)) return "done";
  if (/(^|\b)(needs|needs[-\s]?you|blocked|waiting|review|help)($|\b)/.test(v)) return "needs";
  return "planned"; // todo / backlog / planned / anything else
}
function normOwner(s) {
  const v = String(s || "").trim().toLowerCase();
  if (/(agent|openclaw|ai|bot|assistant)/.test(v)) return "agent";
  return "you"; // me / human / user / you / default
}
// A safe file id: lowercase slug of the title + a short time suffix, collision-checked.
function makeId(dir, title) {
  const slug = String(title || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
  const suffix = Date.now().toString(36).slice(-5);
  let id = `${slug}-${suffix}`, n = 2;
  while (existsSync(path.join(dir, id + ".md"))) { id = `${slug}-${suffix}-${n++}`; }
  return id;
}
// A task id from the client is untrusted: it must be a bare basename that maps to a file inside the
// tasks dir (no path separators, no "..", no leading "_" which is reserved for docs like _FORMAT.md).
function fileForId(ws, id) {
  const base = String(id || "");
  if (!base || base.startsWith("_") || base.includes("/") || base.includes("\\") || base.includes("..") || path.isAbsolute(base)) return null;
  const p = path.join(tasksDir(ws), base + ".md");
  if (path.dirname(p) !== tasksDir(ws)) return null; // defense in depth
  return p;
}
// Read a task file only if it is a plain regular file inside the tasks jail and not too big.
function safeRead(ws, absFile) {
  const root = tasksDir(ws);
  assertSafeFile(absFile, [root]); // throws on symlink / hardlink / jail escape
  if (statSync(absFile).size > MAX_FILE_BYTES) throw new Error("task file too large");
  return readFileSync(absFile, "utf8");
}

// ---- tolerant parse: title + metadata block + ## Files / ## Comments + unknown sections ----
function parse(id, raw) {
  const lines = String(raw).replace(/\r\n/g, "\n").split("\n");
  let title = id, i = 0;
  for (; i < lines.length; i++) { const m = lines[i].match(/^#\s+(.*)$/); if (m) { title = m[1].trim() || id; i++; break; } if (lines[i].trim()) break; }
  const header = [];
  const sections = []; // {name, lines[]}
  let cur = null;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (m) { cur = { name: m[1].trim(), lines: [] }; sections.push(cur); continue; }
    if (cur) cur.lines.push(lines[i]); else header.push(lines[i]);
  }
  // metadata block: leading blanks, then a CONTIGUOUS run of known `key: value` lines. The run ends
  // at the first line that is not a known-key line (blank or prose), and everything from there is the
  // description. This is why a description that later contains "status: ..." is not consumed.
  let status = "planned", owner = "you", updated = "", idx = 0;
  while (idx < header.length && !header[idx].trim()) idx++;
  for (; idx < header.length; idx++) {
    const kv = header[idx].match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!kv || !META_KEYS.includes(kv[1].toLowerCase())) break;
    const k = kv[1].toLowerCase();
    if (k === "status") status = normStatus(kv[2]);
    else if (k === "owner") owner = normOwner(kv[2]);
    else updated = kv[2].trim(); // updated | date
  }
  const description = header.slice(idx).join("\n").trim();

  const files = [], comments = [], extra = [];
  let filesRaw = null, commentsRaw = null;
  for (const s of sections) {
    const nm = s.name.toLowerCase();
    if (/^files?$/.test(nm)) {
      filesRaw = (filesRaw || []).concat(s.lines); // duplicate ## Files blocks: keep raw consistent with files[]
      for (const ln of s.lines) { const m = ln.match(/^\s*[-*]\s+(.*)$/); if (m && m[1].trim()) files.push(m[1].trim()); }
    } else if (/^comments?$/.test(nm)) {
      commentsRaw = (commentsRaw || []).concat(s.lines); // duplicate ## Comments blocks: keep raw consistent with comments[]
      let curC = null;
      for (const ln of s.lines) {
        const m = ln.match(/^\s*[-*]\s+(.*)$/);
        if (m) {
          const c = m[1].match(/^\[([^\]\s]+)\s+([^\]]+)\]\s*(.*)$/);
          curC = c ? { date: c[1], who: normOwner(c[2]) === "agent" ? "agent" : (c[2].trim() || "you"), text: c[3] } : { date: "", who: "", text: m[1] };
          comments.push(curC);
        } else if (curC && ln.trim()) {
          curC.text += "\n" + ln.replace(/^\s{1,2}/, ""); // continuation line of the current comment
        }
      }
      for (const c of comments) c.text = c.text.trim();
    } else {
      extra.push(s); // preserve unknown sections verbatim
    }
  }
  return { id, title, status, owner, updated, description, files, comments, extra, filesRaw, commentsRaw, filesDirty: false, commentsDirty: false };
}

function serialize(t) {
  const out = [];
  out.push(`# ${t.title || t.id}`, "");
  out.push(`status: ${t.status}`, `owner: ${t.owner}`, `updated: ${t.updated || today()}`, "");
  if (t.description && t.description.trim()) out.push(t.description.trim(), "");
  // Files: re-emit the agent's original lines verbatim unless the cockpit changed the list.
  out.push("## Files");
  if (!t.filesDirty && t.filesRaw) out.push(...t.filesRaw.filter((_, k, a) => !(k === a.length - 1 && a[k] === "")));
  else for (const f of t.files || []) out.push(`- ${f}`);
  out.push("");
  // Comments: same rule; canonical form keeps multi-line comment bodies (continuation lines indented).
  out.push("## Comments");
  if (!t.commentsDirty && t.commentsRaw) out.push(...t.commentsRaw.filter((_, k, a) => !(k === a.length - 1 && a[k] === "")));
  else for (const c of t.comments || []) {
    const head = (c.date || c.who) ? `[${c.date || today()} ${c.who || "you"}] ` : "";
    const [first, ...rest] = String(c.text).split("\n");
    out.push(`- ${head}${first}`);
    for (const r of rest) out.push(`  ${r}`);
  }
  for (const s of t.extra || []) {
    const ls = s.lines.slice();
    while (ls.length && ls[ls.length - 1] === "") ls.pop(); // strip trailing blanks so a single "" separator can't accumulate per write
    out.push("", `## ${s.name}`, ...ls);
  }
  // trim trailing blanks, guarantee one final newline (no global newline-collapse: extra sections
  // are verbatim, and everything we emit is already single-blank-separated).
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

// Atomic + symlink-safe write: unique tmp name with exclusive create ("wx" -> O_CREAT|O_EXCL, which
// fails rather than follows if a *.tmp symlink was pre-planted), then rename over the destination
// (which atomically replaces a planted destination symlink with our plain regular file).
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* */ } throw e; }
}

function readTask(ws, id) {
  const f = fileForId(ws, id); if (!f || !existsSync(f)) return null;
  try { return parse(id, safeRead(ws, f)); } catch { return null; }
}
function saveTask(ws, t) {
  ensureDir(ws);
  const f = fileForId(ws, t.id); if (!f) throw new Error("bad task id");
  t.updated = today();
  writeAtomic(f, serialize(t));
  return t;
}

// ---- public API (all take the workspace root) ----
export function list(ws) {
  const dir = tasksDir(ws);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name.startsWith("_") || name.endsWith(".tmp")) continue;
    try { out.push(parse(name.slice(0, -3), safeRead(ws, path.join(dir, name)))); } catch { /* skip symlink/oversize/unreadable */ }
  }
  const rank = { now: 0, needs: 1, planned: 2, done: 3 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || a.title.localeCompare(b.title));
  return out;
}

export function add(ws, { title, status, owner, description } = {}) {
  const dir = ensureDir(ws);
  const id = makeId(dir, title);
  const t = { id, title: (title || "Untitled task").trim(), status: normStatus(status), owner: normOwner(owner), updated: today(), description: (description || "").trim(), files: [], comments: [], extra: [], filesRaw: null, commentsRaw: null, filesDirty: true, commentsDirty: true };
  return saveTask(ws, t);
}

export function update(ws, id, patch = {}) {
  const t = readTask(ws, id); if (!t) throw new Error("task not found");
  if (patch.title != null) t.title = String(patch.title).trim() || t.title;
  if (patch.status != null) t.status = normStatus(patch.status);
  if (patch.owner != null) t.owner = normOwner(patch.owner);
  if (patch.description != null) t.description = String(patch.description).trim();
  return saveTask(ws, t); // files/comments untouched -> emitted verbatim from raw
}

export function comment(ws, id, { who, text } = {}) {
  const t = readTask(ws, id); if (!t) throw new Error("task not found");
  const body = String(text || "").trim(); if (!body) throw new Error("empty comment");
  t.comments.push({ date: today(), who: who === "agent" ? "agent" : "you", text: body });
  t.commentsDirty = true;
  return saveTask(ws, t);
}

// Link a workspace file. The path is stored RELATIVE to the workspace and must resolve inside it.
export function link(ws, id, { path: rel } = {}) {
  const t = readTask(ws, id); if (!t) throw new Error("task not found");
  let p = String(rel || "").trim(); if (!p) throw new Error("empty path");
  if (p.startsWith("~")) p = p.replace(/^~/, process.env.HOME || "");
  const abs = path.isAbsolute(p) ? p : path.join(ws, p);
  const relPath = path.relative(ws, abs);
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) throw new Error("file must be inside the workspace");
  if (!t.files.includes(relPath)) t.files.push(relPath);
  t.filesDirty = true;
  return saveTask(ws, t);
}
export function unlink(ws, id, { path: rel } = {}) {
  const t = readTask(ws, id); if (!t) throw new Error("task not found");
  t.files = (t.files || []).filter((f) => f !== rel);
  t.filesDirty = true;
  return saveTask(ws, t);
}

export function remove(ws, id) {
  const f = fileForId(ws, id); if (!f || !existsSync(f)) return { ok: false };
  unlinkSync(f); return { ok: true }; // unlink removes the entry (or a planted symlink), never its target
}

// A short spec dropped in the tasks dir so the agent knows the format when asked to edit a task.
const FORMAT_DOC = `# Task board format

Each file in this folder is one task on the Glass Cockpit board. To create or edit a task,
write a markdown file here shaped like this:

    # Short task title

    status: planned        # planned | now | done | needs   (needs = blocked / needs the human)
    owner: agent           # you | agent
    updated: 2026-07-15

    A sentence or two describing the task.

    ## Files
    - relative/path/inside/the-workspace.md

    ## Comments
    - [2026-07-15 agent] progress note or question

Rules:
- Keep the "status" and "owner" lines directly under the title. Use only the allowed values above.
- File links are paths RELATIVE to this workspace.
- Add a comment (do not overwrite old ones) when you make progress or need a decision.
- The cockpit shows these as cards, grouped by status and tagged by owner.
`;
export function ensureFormatDoc(ws) {
  try { const f = path.join(ensureDir(ws), "_FORMAT.md"); if (!existsSync(f)) writeFileSync(f, FORMAT_DOC, "utf8"); } catch { /* best effort */ }
}

export const meta = { statuses: STATUSES, owners: OWNERS };
