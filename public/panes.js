// Brain / Files / Schedule / Skills panes (P4+P5 UI). Rides on app.js's WS via window.cockpit.
import { Graph } from "./graph.js";
import { renderMarkdown } from "./md.js";

const $ = (id) => document.getElementById(id);
const { rpc, onFrame } = window.cockpit; // exposed by app.js

// ---------- pane routing (replaces app.js's placeholder routing) ----------
const PANES = ["cockpit", "mission", "brain", "files", "schedule", "skills"];
document.querySelectorAll(".rail-btn").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".rail-btn").forEach((x) => x.classList.toggle("active", x === b));
    const pane = b.dataset.pane;
    for (const p of PANES) $("pane-" + p)?.classList.toggle("active", p === pane);
    $("pane-other").classList.toggle("active", !PANES.includes(pane));
    if (pane === "mission") window.cockpit.loadHistory?.();
    if (pane === "brain") openBrain();
    if (pane === "files") openFiles();
    if (pane === "schedule") openSchedule();
    if (pane === "skills") openSkills();
  };
});

// ---------- BRAIN ----------
let graph = null, graphData = null;
function ensureGraph() {
  if (graph) return graph;
  graph = new Graph($("brain-canvas"));
  graph.onClick = (n) => openFileById(n.path);
  const r = $("brain-canvas").getBoundingClientRect();
  graph.resize(r.width, r.height);
  return graph;
}
async function openBrain() {
  ensureGraph();
  if (!graphData) await refreshGraph();
}
async function refreshGraph() {
  $("brain-status").textContent = "building graph...";
  const g = await rpc("brain.graph", {});
  graphData = g.data || { nodes: [], edges: [] };
  ensureGraph().setData(graphData);
  applyLens($("brain-lens").value);
  const sem = graphData.edges.filter((e) => e.kind === "embed").length;
  const semNote = g.data?.semanticDisabled ? ` · ${g.data.semanticReason}` : ` (${sem} semantic)`;
  $("brain-status").textContent = `${graphData.nodes.length} docs, ${graphData.edges.length} edges${semNote}`;
}
function applyLens(lens) {
  if (!graphData) return;
  if (!lens) return ensureGraph().clearHighlight();
  const ids = graphData.nodes.filter((n) => (lens === "orphans" ? n.degree === 0 : n.stale)).map((n) => n.id);
  ensureGraph().setHighlight(ids);
}
$("brain-lens").onchange = (e) => applyLens(e.target.value);
$("brain-index-btn").onclick = async () => {
  $("brain-status").textContent = "indexing...";
  onFrame("brain.progress", (f) => { $("brain-status").textContent = `embedding ${f.done}/${f.total}`; });
  const r = await rpc("brain.index", {});
  $("brain-status").textContent = r.ok ? `indexed: ${r.data.changed} changed of ${r.data.files}` : "index failed: " + r.error;
  await refreshGraph();
};
$("brain-scan-btn").onclick = async () => {
  const lane = $("brain-proposals");
  lane.textContent = "";
  $("brain-status").textContent = "scanning...";
  onFrame("brain.judging", (f) => { $("brain-status").textContent = `judging ${f.done}/${f.total}`; });
  const r = await rpc("brain.scan", {});
  const cands = r.data?.candidates || [];
  const cap = r.data?.degraded ? ` · scanned first ${r.data.capScanned} of ${r.data.notes} docs` : "";
  $("brain-status").textContent = `${cands.length} link(s) proposed of ${r.data?.scanned ?? 0} judged${cap}`;
  if (!cands.length) lane.textContent = "no missing links found";
  for (const c of cands) {
    const card = document.createElement("div");
    card.className = "proposal-card";
    const short = (x) => x.split("/").pop().replace(/\.md$/, "");
    card.innerHTML = `<div class="pc-pair"></div><div class="pc-reason"></div><div></div>`;
    card.querySelector(".pc-pair").textContent = `${short(c.a)} <-> ${short(c.b)} (${Math.round(c.score * 100)}%)`;
    card.querySelector(".pc-reason").textContent = c.reason;
    const acts = card.lastElementChild;
    const yes = document.createElement("button"); yes.textContent = "Link";
    yes.onclick = async () => { const a = await rpc("brain.accept", { a: c.a, b: c.b }); if (a.ok) { yes.textContent = "Linked"; yes.disabled = true; refreshGraph(); } };
    const skip = document.createElement("button"); skip.className = "skip"; skip.textContent = "Skip";
    skip.onclick = () => card.remove();
    acts.append(yes, skip);
    lane.appendChild(card);
  }
};

// ---------- FILES ----------
let currentFile = null, saveTimer = null, currentHash = null;
async function openFiles() {
  const list = $("files-list");
  list.textContent = "";
  const r = await rpc("files.list", {});
  for (const f of (r.data?.files || [])) {
    const row = document.createElement("div");
    row.className = "file-row" + (currentFile === f.id ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "file-dot " + (f.reviewState === "changed" ? "changed" : f.reviewState === "reviewed" ? "reviewed" : "");
    const name = document.createElement("span");
    name.textContent = f.id.split("/").slice(-2).join("/");
    name.title = f.id;
    row.append(dot, name);
    row.onclick = () => openFileById(f.id);
    list.appendChild(row);
  }
}
async function openFileById(fileId) {
  // jump to the Files pane if we came from the graph
  document.querySelector('.rail-btn[data-pane="files"]').classList.add("active");
  for (const p of PANES) $("pane-" + p)?.classList.toggle("active", p === "files");
  currentFile = fileId;
  const r = await rpc("files.read", { fileId });
  if (!r.ok) { $("files-banner").className = "show"; $("files-banner").textContent = r.error; return; }
  $("files-text").value = r.data.content;
  currentHash = r.data.contentHash;
  renderPreview(r.data.content);
  const banner = $("files-banner");
  banner.className = r.data.changed ? "show" : "";
  banner.textContent = "";
  if (r.data.changed) {
    const span = document.createElement("span");
    span.textContent = "changed since your last review";
    const ok = document.createElement("button"); ok.textContent = "Mark reviewed";
    ok.onclick = async () => { await rpc("files.review", { fileId }); banner.className = ""; openFiles(); };
    banner.append(span, ok);
    if (r.data.baseline !== null) {
      const rev = document.createElement("button"); rev.textContent = "Revert to reviewed";
      rev.onclick = async () => { const rr = await rpc("files.revert", { fileId, knownHash: currentHash }); if (rr.data?.conflict) { $("files-banner").textContent = "file changed since you opened it; reopen before reverting"; } else openFileById(fileId); };
      banner.append(rev);
    }
  }
  openFiles(); // refresh dots + active row
}
function renderPreview(text) { $("files-preview").innerHTML = renderMarkdown(text); }
$("files-text").addEventListener("input", () => {
  renderPreview($("files-text").value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!currentFile) return;
    const w = await rpc("files.write", { fileId: currentFile, content: $("files-text").value, knownHash: currentHash });
    if (w.data?.conflict) { $("files-banner").className = "show"; $("files-banner").textContent = "the agent changed this file; reopen to merge (your edit was NOT saved)"; currentHash = w.data.contentHash; }
    else if (w.data?.contentHash) currentHash = w.data.contentHash;
  }, 1500);
});

// ---------- SCHEDULE ----------
async function openSchedule() {
  const r = await rpc("cron.list", {});
  const banner = $("sched-banner");
  const t = r.data?.ticker || {};
  banner.textContent = t.alive ? `scheduler alive (heartbeat ${t.ageS}s ago)` : "SCHEDULER DOWN: jobs will not fire (start hermes gateway)";
  banner.className = t.alive ? "" : "dead";
  const list = $("sched-list");
  list.textContent = "";
  const jobs = r.data?.jobs || [];
  if (!jobs.length) { const d = document.createElement("div"); d.className = "placeholder"; d.style.height = "120px"; d.textContent = "No scheduled jobs yet. Create one: hermes cron create \"every 2h\" \"your task\""; list.appendChild(d); return; }
  for (const j of jobs) {
    const card = document.createElement("div");
    card.className = "job-card";
    const title = document.createElement("div"); title.className = "job-title";
    const nm = document.createElement("span"); nm.textContent = j.name || j.id;
    const sc = document.createElement("span"); sc.className = "job-sched"; sc.textContent = j.schedule_display || j.schedule?.display || "";
    title.append(nm, sc);
    const line = document.createElement("div"); line.className = "job-line"; line.textContent = j.oneliner || (j.prompt || j.script || "").slice(0, 110);
    const meta = document.createElement("div"); meta.className = "job-meta";
    const fmt = (x) => (x ? new Date(x).toLocaleString() : "never");
    meta.textContent = `next ${fmt(j.next_run_at)} · last ${fmt(j.last_run_at)} ${j.last_status ? "(" + j.last_status + ")" : ""} · ${j.state || (j.enabled ? "scheduled" : "paused")} · ${j.profile}`;
    const acts = document.createElement("div"); acts.className = "job-acts";
    const mainProfile = !j.profile || j.profile === "main";
    for (const verb of [j.state === "paused" ? "resume" : "pause", "run", "remove"]) {
      const b = document.createElement("button"); b.textContent = verb;
      b.disabled = !mainProfile;
      if (mainProfile) b.onclick = async () => { b.disabled = true; const a = await rpc("cron.action", { verb, jobId: j.id, profile: j.profile }); if (!a.ok) b.textContent = "failed"; openSchedule(); };
      else b.title = `read-only: job lives in profile "${j.profile}"`;
      acts.appendChild(b);
    }
    card.append(title, line, meta, acts);
    list.appendChild(card);
  }
}

// ---------- SKILLS ----------
async function openSkills() {
  const grid = $("skills-grid");
  grid.textContent = "";
  const r = await rpc("skills.list", {});
  for (const s of (r.data?.skills || [])) {
    const card = document.createElement("div");
    card.className = "skill-card";
    const top = document.createElement("div"); top.className = "skill-name";
    const nm = document.createElement("span"); nm.textContent = s.name;
    const use = document.createElement("span"); use.className = "skill-use"; use.textContent = s.useCount ? `${s.useCount} uses` : "";
    top.append(nm, use);
    const cat = document.createElement("div"); cat.className = "skill-cat"; cat.textContent = s.category;
    const desc = document.createElement("div"); desc.className = "skill-desc"; desc.textContent = s.description;
    card.append(top, cat, desc);
    grid.appendChild(card);
  }
}
