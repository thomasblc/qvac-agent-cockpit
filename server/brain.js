// Second Brain backend: corpus walk (the harness's markdown), embedding index (incremental),
// graph build (links + tags + semantic edges), and RAG link proposals (cosine candidates ->
// the local serve judges -> the hardened inserter writes the link).
import { loadModel, embed, EMBEDDINGGEMMA_300M_Q4_0 } from "@qvac/sdk";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, relative, dirname, resolve, isAbsolute } from "node:path";
import { ContextIndex } from "./context.js";
import { cosine, topKPairs } from "./text-utils.js";

// ---- corpus roots (existence-checked; .md only; cap per plan) ----
const H = homedir();

// User-chosen Second Brain / Files folder ("vault"), persisted in the cockpit config. When set, the
// corpus IS that folder (recursively, like Obsidian/Second Self) instead of the harness's own dirs.
// The default corpus is Hermes-specific (~/.hermes/*), which is why it did not follow the harness;
// pointing this at any folder (e.g. ~/.openclaw/workspace, or your notes vault) overrides that.
const CFG = join(H, ".qvac-cockpit", "config.json");
function expandHome(p) { const s = String(p || "").trim(); if (!s) return ""; return s.startsWith("~") ? join(H, s.slice(1)) : (isAbsolute(s) ? s : resolve(s)); }
function loadCfg() { try { return JSON.parse(readFileSync(CFG, "utf8")); } catch { return {}; } }
let brainRoot = (() => { const p = loadCfg().brainRoot; return p && existsSync(p) ? p : null; })();
export function getBrainRoot() { return brainRoot; }
export function setBrainRoot(p) {
  if (p) {
    const abs = expandHome(p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error("not a folder: " + abs);
    brainRoot = abs;
  } else brainRoot = null;
  const cfg = loadCfg(); cfg.brainRoot = brainRoot;
  mkdirSync(dirname(CFG), { recursive: true }); writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  return brainRoot;
}

export function corpusRoots(workspace) {
  // A chosen vault takes over entirely (+ the agent's own workspace, so its writes still show).
  if (brainRoot) {
    const roots = [{ root: brainRoot, tag: "vault" }];
    if (workspace && resolve(workspace) !== resolve(brainRoot)) roots.push({ root: workspace, tag: "workspace" });
    return roots.filter((r) => existsSync(r.root));
  }
  const roots = [
    { root: H + "/.hermes", only: ["SOUL.md"] },
    { root: H + "/.hermes/memories" },
    ...(existsSync(H + "/.hermes/profiles") ? readdirSync(H + "/.hermes/profiles").flatMap((p) => [
      { root: `${H}/.hermes/profiles/${p}`, only: ["SOUL.md"], tag: p },
      { root: `${H}/.hermes/profiles/${p}/memories`, tag: p },
      { root: `${H}/.hermes/profiles/${p}/plans`, tag: p },
      { root: `${H}/.hermes/profiles/${p}/workspace`, tag: p },
    ]) : []),
    { root: H + "/.hermes/kanban/workspaces" },
    ...(workspace ? [{ root: workspace, tag: "workspace" }] : []),
  ];
  return roots.filter((r) => existsSync(r.root));
}

const MAX_FILES = 5000, MAX_SIZE = 2 * 1024 * 1024, MAX_DIRS = 20000;
export function walkCorpus(workspace) {
  const out = [];
  let dirsScanned = 0; // bound the DFS itself, not just .md collected (review P1): a user-chosen
  // vault pointed at ~ or / is .md-sparse, so MAX_FILES alone never trips and the sync walk would
  // descend the whole filesystem, freezing the WS server. Cap directories visited too.
  for (const r of corpusRoots(workspace)) {
    const stack = [r.root];
    while (stack.length && out.length < MAX_FILES && dirsScanned < MAX_DIRS) {
      const dir = stack.pop(); dirsScanned++;
      let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".") || ["node_modules", "venv"].includes(e.name)) continue;
        if (e.isSymbolicLink()) continue; // never follow symlinks: a *.md link to ~/.ssh/... would escape the jail (review P0)
        const abs = join(dir, e.name);
        if (e.isDirectory()) { stack.push(abs); continue; }
        if (!e.name.endsWith(".md")) continue;
        if (r.only && !r.only.includes(e.name)) continue;
        let st; try { st = statSync(abs); } catch { continue; }
        if (!st.size || st.size > MAX_SIZE) continue;
        out.push({ abs, id: relative(H, abs), profile: r.tag || "main", mtime: st.mtimeMs });
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

// ---- embedder (in-process EmbeddingGemma, coexistence spike-proven) ----
let embId = null;
async function ensureEmb() {
  if (embId) return embId;
  embId = await loadModel({ modelSrc: EMBEDDINGGEMMA_300M_Q4_0, modelType: EMBEDDINGGEMMA_300M_Q4_0.engine, modelConfig: { verbosity: 0 } });
  return embId;
}
export async function embedMany(texts, { onProgress } = {}) {
  await ensureEmb();
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push((await embed({ modelId: embId, text: String(texts[i]).slice(0, 3500) })).embedding);
    onProgress?.(i + 1, texts.length);
  }
  return out;
}

// realpath jail: the resolved file must live under a realpath'd corpus root (review P0 belt).
export function isInCorpus(realAbs, workspace) {
  return corpusRoots(workspace).some((r) => { try { return realAbs.startsWith(realpathSync(r.root)); } catch { return false; } });
}

// ---- index (incremental by mtime, obsidian daemon pattern) ----
const idx = new ContextIndex(join(H, ".qvac-cockpit", "index"));
export async function indexCorpus(workspace, push) {
  const files = walkCorpus(workspace);
  const manifest = idx.manifest();
  const seen = new Set();
  let done = 0, changed = 0;
  for (const f of files) {
    seen.add(f.id);
    const m = manifest[f.id];
    if (!m || Math.floor(m.mtime) !== Math.floor(f.mtime)) {
      let text; try { text = readFileSync(f.abs, "utf8"); } catch { continue; }
      await idx.upsertDoc(f.id, text, f.mtime, embedMany, "vault", { save: false });
      changed++;
    }
    push?.({ type: "brain.progress", done: ++done, total: files.length });
  }
  for (const known of Object.keys(manifest)) if (!seen.has(known)) idx.dropDoc(known, { save: false });
  idx._save(); // one write at the end, not per doc (review P1: 5000 files = 5000 full rewrites)
  return { files: files.length, changed, chunks: idx.records.length };
}

// ---- doc-level vectors (obsidian noteVectors, hardened) ----
function docVectors() {
  const groups = new Map();
  for (let i = 0; i < idx.records.length; i++) {
    const r = idx.records[i], v = idx.vectors[i];
    if (!Array.isArray(v) || !v.length) continue;
    if (!groups.has(r.source)) groups.set(r.source, { vecs: [], text: "" });
    const g = groups.get(r.source);
    g.vecs.push(v);
    if (g.text.length < 600) g.text += (g.text ? " " : "") + r.text;
  }
  const out = [];
  for (const [source, g] of groups) {
    if (!g.vecs.length) continue;
    const dim = g.vecs[0].length, avg = new Array(dim).fill(0);
    let used = 0;
    for (const v of g.vecs) { if (v.length !== dim) continue; for (let d = 0; d < dim; d++) avg[d] += v[d]; used++; }
    if (!used) continue;
    for (let d = 0; d < dim; d++) avg[d] /= used;
    out.push({ source, vec: avg, text: g.text.slice(0, 500) });
  }
  return out;
}

// ---- graph: explicit md links + shared tags + semantic edges ----
const LINK_RE = /\[\[([^\]|#]+)/g, MDLINK_RE = /\]\(([^)]+\.md)\)/g, TAG_RE = /(^|\s)#([a-z0-9][\w-]{1,30})/gi;
// Above this doc count the pairwise-cosine semantic pass (O(N^2), 768-dim) would block the event
// loop for seconds, so we DISABLE semantic edges and say so (audit P1-05). Explicit [[links]], md
// links, and shared tags are O(N) and always render. Override with COCKPIT_SEMANTIC_MAX.
export const SEMANTIC_MAX = Number(process.env.COCKPIT_SEMANTIC_MAX) || 3000;
export function buildGraph(workspace, { semantic = true } = {}) {
  const files = walkCorpus(workspace);
  const byBase = new Map(files.map((f) => [basename(f.abs, ".md").toLowerCase(), f.id]));
  const nodes = [], edges = [], tagMap = new Map();
  const freshCut = Date.now() - 30 * 24 * 3600e3;
  for (const f of files) {
    let text = ""; try { text = readFileSync(f.abs, "utf8"); } catch { /* */ }
    nodes.push({ id: f.id, label: basename(f.abs, ".md"), path: f.id, group: f.profile, size: 4, degree: 0, stale: f.mtime < freshCut, tags: [] });
    for (const m of text.matchAll(LINK_RE)) { const t = byBase.get(m[1].trim().toLowerCase()); if (t && t !== f.id) edges.push({ source: f.id, target: t, kind: "link", weight: 2 }); }
    for (const m of text.matchAll(MDLINK_RE)) { const t = byBase.get(basename(m[1], ".md").toLowerCase()); if (t && t !== f.id) edges.push({ source: f.id, target: t, kind: "link", weight: 2 }); }
    for (const m of text.matchAll(TAG_RE)) { const tag = m[2].toLowerCase(); if (!tagMap.has(tag)) tagMap.set(tag, []); tagMap.get(tag).push(f.id); }
  }
  for (const [tag, ids] of tagMap) if (ids.length >= 2 && ids.length <= 12) for (let i = 1; i < ids.length; i++) edges.push({ source: ids[0], target: ids[i], kind: "tag", weight: 0.5, tag });
  let semanticDisabled = false, semanticReason = null;
  if (semantic && idx.records.length) {
    const dv = docVectors();
    if (dv.length > SEMANTIC_MAX) { semanticDisabled = true; semanticReason = `semantic edges disabled above ${SEMANTIC_MAX} docs (${dv.length} indexed)`; }
    else {
      const pairs = topKPairs(dv.map((d) => d.source), dv.map((d) => d.vec), 4, 0.55);
      for (const p of pairs) edges.push({ source: p.a, target: p.b, kind: "embed", weight: p.score, evidence: null });
    }
  }
  const deg = new Map();
  for (const e of edges) { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;
  return { nodes, edges, semanticDisabled, semanticReason };
}

// ---- RAG link proposals: cosine candidates -> the serve judges -> reason ----
function pairKey(a, b) { const x = String(a), y = String(b); return JSON.stringify(x < y ? [x, y] : [y, x]); }
export async function scanLinks({ serveBase, model, existingPairs = [], minScore = 0.35, maxCandidates = 12, scope = null }, push) {
  // scope: an id prefix to restrict the scan (e.g. just the workspace), so near-identical
  // boilerplate elsewhere (profile SOULs) cannot crowd the candidate list.
  let dv = docVectors();
  if (scope) dv = dv.filter((d) => d.source.startsWith(scope));
  if (dv.length < 2) return { candidates: [], notes: dv.length };
  const linked = new Set();
  for (const p of (existingPairs || []).slice(0, 200000)) if (Array.isArray(p) && p.length >= 2) linked.add(pairKey(p[0], p[1]));
  const pairs = [];
  // Bound the O(N^2) cosine pass so a big vault cannot freeze the loop; report the cap honestly
  // (audit P1-05). Narrow with `scope` to scan a big corpus in slices instead of truncating.
  const CAP = Math.min(2000, SEMANTIC_MAX);
  const capped = dv.slice(0, CAP);
  const degraded = dv.length > capped.length;
  for (let i = 0; i < capped.length; i++) for (let j = i + 1; j < capped.length; j++) {
    if (linked.has(pairKey(capped[i].source, capped[j].source))) continue;
    const score = cosine(capped[i].vec, capped[j].vec);
    if (score >= minScore) pairs.push({ a: capped[i], b: capped[j], score });
  }
  pairs.sort((x, y) => y.score - x.score);
  const top = pairs.slice(0, Math.max(1, Math.min(30, maxCandidates)));
  const out = [];
  let n = 0;
  for (const p of top) {
    push?.({ type: "brain.judging", done: ++n, total: top.length });
    try {
      const r = await fetch(serveBase + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ model, max_tokens: 40, messages: [
          { role: "system", content: "You decide whether two documents from an AI agent's workspace should be cross-linked. Link only if they share a genuinely related project, person, topic, or task, such that a reader of one would want the other. Generic overlap is NOT enough. Reply with exactly one line: `YES - <reason, max 8 words>` or `NO`." },
          { role: "user", content: `Doc A (${p.a.source}):\n${p.a.text}\n\nDoc B (${p.b.source}):\n${p.b.text}\n\nLink A and B?` },
        ] }),
      }).then((x) => x.json());
      const line = String(r.choices?.[0]?.message?.content || "").trim().split("\n")[0];
      if (/^yes\b/i.test(line)) out.push({ a: p.a.source, b: p.b.source, score: Number(p.score.toFixed(3)), reason: (line.replace(/^yes\s*[-:]?\s*/i, "").trim() || "related").slice(0, 80) });
    } catch { /* judge failure: skip candidate */ }
  }
  return { candidates: out, scanned: top.length, notes: dv.length, degraded, capScanned: capped.length };
}

// ---- accept: write the link via the hardened inserter, then re-embed both docs ----
import { insertRelatedSection } from "./links.js";
import { assertSafeFile, safeWriteFile } from "./safe-path.js";
export async function acceptLink(aId, bId, workspace = null) {
  // Jail: only ids the corpus walker produces are writable (covers ~/.hermes roots AND the workspace).
  const f = walkCorpus(workspace).find((x) => x.id === aId);
  if (!f) throw new Error("path outside the corpus");
  const roots = corpusRoots(workspace).map((r) => r.root);
  const abs = assertSafeFile(f.abs, roots); // rejects symlink/hardlink/escape
  const content = readFileSync(abs, "utf8");
  const link = `[[${basename(bId, ".md")}]]`;
  const next = insertRelatedSection(content, link);
  if (next !== content) {
    safeWriteFile(abs, next, roots);
    const st = statSync(abs);
    await idx.upsertDoc(aId, next, st.mtimeMs, embedMany, "vault");
  }
  return { written: next !== content, link };
}
// Read a single corpus doc by its walker id (e.g. ".hermes/SOUL.md"), jailed to the corpus roots.
// The Second Brain pane uses this to preview a clicked node WITHOUT leaving the pane; corpus docs
// live outside the workspace (~/.hermes/...), so files.read (workspace-only) cannot serve them.
export function readCorpusDoc(id, workspace = null) {
  const f = walkCorpus(workspace).find((x) => x.id === id);
  if (!f) throw new Error("doc not in corpus");
  const roots = corpusRoots(workspace).map((r) => r.root);
  const abs = assertSafeFile(f.abs, roots); // rejects symlink/hardlink/escape (same jail as accept)
  return { id, content: readFileSync(abs, "utf8").slice(0, 200000), profile: f.profile };
}
export { idx as brainIndex };
