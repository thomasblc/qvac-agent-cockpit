// Brain / Files / Schedule / Skills panes (P4+P5 UI). Rides on app.js's WS via window.cockpit.
import { Graph } from "./graph.js";
import { renderMarkdown } from "./md.js";

const $ = (id) => document.getElementById(id);
const { rpc, onFrame } = window.cockpit; // exposed by app.js

// Some store panes don't exist for every harness (OpenClaw has no kanban/cron). The server replies
// {ok:true, data:{unavailable:true, reason}} for those; render an honest placeholder, not an error.
function renderUnavailable(container, data) {
  container.textContent = "";
  const d = document.createElement("div");
  d.className = "placeholder";
  d.style.minHeight = "120px";
  d.textContent = data?.reason || "Not available for this harness.";
  container.appendChild(d);
}

// ---------- pane routing (replaces app.js's placeholder routing) ----------
const PANES = ["cockpit", "mission", "brain", "files", "schedule", "skills", "settings"];
document.querySelectorAll(".rail-btn[data-pane]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".rail-btn[data-pane]").forEach((x) => x.classList.toggle("active", x === b));
    const pane = b.dataset.pane;
    for (const p of PANES) $("pane-" + p)?.classList.toggle("active", p === pane);
    $("pane-other").classList.toggle("active", !PANES.includes(pane));
    if (pane === "mission") openMission();
    if (pane === "brain") openBrain();
    if (pane === "files") openFiles();
    if (pane === "schedule") openSchedule();
    if (pane === "skills") openSkills();
    if (pane === "settings") openSettings();
  };
});
// Pin the sidebar open (persisted). Without a pin the rail expands on hover only.
const railPin = $("rail-pin");
if (railPin) {
  const setPinned = (on) => { $("rail").classList.toggle("pinned", on); localStorage.setItem("cockpit-rail-pinned", on ? "1" : ""); railPin.querySelector(".rail-label").textContent = on ? "Collapse" : "Keep open"; };
  setPinned(localStorage.getItem("cockpit-rail-pinned") === "1");
  railPin.onclick = () => setPinned(!$("rail").classList.contains("pinned"));
}

// ---------- MISSION CONTROL: a real kanban, file-backed in the agent's workspace ----------
// Cards are tasks/*.md the agent also reads/writes. Columns = status; each card is tagged by owner.
// Drag a card to a column to change its status. Click a card to open a drawer (edit / comment / link).
const KB_COLS = [
  { status: "planned", lane: "lane-planned", count: "kc-planned" },
  { status: "now", lane: "lane-now", count: "kc-now" },
  { status: "needs", lane: "lane-needs", count: "kc-needs" },
  { status: "done", lane: "lane-done", count: "kc-done" },
];
let kbTasks = [];
let kbLoaded = false;

async function openMission() {
  if (!kbLoaded) { await refreshKanban(); kbLoaded = true; }
  else refreshKanban();
}
async function refreshKanban() {
  const r = await rpc("kanban.list", {});
  if (!r.ok) return;
  kbTasks = r.data?.tasks || [];
  const ws = r.data?.workspace || "";
  if (ws) $("kb-ws").textContent = ws.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~") + "/tasks/";
  renderBoard();
  // if the drawer is open, refresh its content from the latest data - but NOT while the user is
  // typing in one of its fields (a background refresh, e.g. the agent editing another task, would
  // otherwise rebuild the drawer and drop the in-progress keystrokes).
  const drawer = $("task-drawer");
  const openId = drawer?.dataset.taskId;
  if (openId && !drawer.classList.contains("hidden")) {
    if (drawer.contains(document.activeElement)) return; // editing in progress: leave it be
    const t = kbTasks.find((x) => x.id === openId);
    if (t) renderDrawer(t); else closeDrawer();
  }
}
function ownerFilter() { return $("kb-owner-filter")?.value || ""; }
function renderBoard() {
  const filt = ownerFilter();
  for (const col of KB_COLS) {
    const lane = $(col.lane); lane.textContent = "";
    const cards = kbTasks.filter((t) => t.status === col.status && (!filt || t.owner === filt));
    $(col.count).textContent = String(cards.length);
    if (!cards.length) { const e = document.createElement("div"); e.className = "kb-empty"; e.textContent = "-"; lane.appendChild(e); }
    for (const t of cards) lane.appendChild(cardEl(t));
  }
}
function cardEl(t) {
  const c = document.createElement("div");
  c.className = "kb-card"; c.draggable = true; c.dataset.taskId = t.id;
  const title = document.createElement("div"); title.className = "kb-card-title"; title.textContent = t.title; c.appendChild(title);
  const meta = document.createElement("div"); meta.className = "kb-card-meta";
  const own = document.createElement("span"); own.className = "kb-owner " + t.owner; own.textContent = t.owner === "agent" ? "agent" : "you"; meta.appendChild(own);
  if (t.files?.length) { const f = document.createElement("span"); f.className = "kb-chip"; f.textContent = "⎘ " + t.files.length; meta.appendChild(f); }
  if (t.comments?.length) { const cm = document.createElement("span"); cm.className = "kb-chip"; cm.textContent = "💬 " + t.comments.length; meta.appendChild(cm); }
  c.appendChild(meta);
  c.onclick = () => openDrawer(t.id);
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", t.id); c.classList.add("dragging"); });
  c.addEventListener("dragend", () => c.classList.remove("dragging"));
  return c;
}
// drag-drop: dropping a card in a column sets its status
function wireDnd() {
  document.querySelectorAll("#kanban-board .kcol").forEach((colEl) => {
    const status = colEl.dataset.status;
    colEl.addEventListener("dragover", (e) => { e.preventDefault(); colEl.classList.add("drop-hot"); });
    colEl.addEventListener("dragleave", () => colEl.classList.remove("drop-hot"));
    colEl.addEventListener("drop", async (e) => {
      e.preventDefault(); colEl.classList.remove("drop-hot");
      const id = e.dataTransfer.getData("text/plain"); if (!id) return;
      const t = kbTasks.find((x) => x.id === id);
      if (!t || t.status === status) return;
      await rpc("kanban.update", { taskId: id, status });
      await refreshKanban();
    });
  });
}
// ---- task drawer (detail: title/status/owner/description + files + comments) ----
function openDrawer(id) { const t = kbTasks.find((x) => x.id === id); if (t) renderDrawer(t); }
function closeDrawer() { $("task-drawer").classList.add("hidden"); $("task-scrim").classList.add("hidden"); $("task-drawer").dataset.taskId = ""; }
function renderDrawer(t) {
  const d = $("task-drawer"); d.dataset.taskId = t.id;
  const inner = $("task-drawer-inner"); inner.textContent = "";
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const head = mk("div", "td-head");
  const titleIn = mk("input", "td-title"); titleIn.value = t.title; titleIn.spellcheck = false;
  titleIn.onchange = async () => { await rpc("kanban.update", { taskId: t.id, title: titleIn.value.trim() }); await refreshKanban(); };
  const x = mk("button", "ghost td-x", "✕"); x.onclick = closeDrawer;
  head.appendChild(titleIn); head.appendChild(x); inner.appendChild(head);

  const row = mk("div", "td-row");
  const st = mk("select", "td-status");
  for (const [v, lbl] of [["planned", "To do"], ["now", "In progress"], ["needs", "Blocked / needs you"], ["done", "Done"]]) { const o = mk("option", null, lbl); o.value = v; if (t.status === v) o.selected = true; st.appendChild(o); }
  st.onchange = async () => { await rpc("kanban.update", { taskId: t.id, status: st.value }); await refreshKanban(); };
  const ow = mk("select", "td-owner");
  for (const [v, lbl] of [["you", "Owner: you"], ["agent", "Owner: agent"]]) { const o = mk("option", null, lbl); o.value = v; if (t.owner === v) o.selected = true; ow.appendChild(o); }
  ow.onchange = async () => { await rpc("kanban.update", { taskId: t.id, owner: ow.value }); await refreshKanban(); };
  row.appendChild(st); row.appendChild(ow); inner.appendChild(row);

  inner.appendChild(mk("label", "td-label", "Description"));
  const desc = mk("textarea", "td-desc"); desc.value = t.description || ""; desc.spellcheck = false; desc.placeholder = "What is this task about?";
  desc.onchange = async () => { await rpc("kanban.update", { taskId: t.id, description: desc.value }); await refreshKanban(); };
  inner.appendChild(desc);

  // files
  inner.appendChild(mk("label", "td-label", "Linked files"));
  const files = mk("div", "td-files");
  for (const f of t.files || []) {
    const chip = mk("div", "td-file");
    const nm = mk("span", "td-file-name", f); nm.title = "open in Files"; nm.onclick = () => openFileFromTask(f);
    const rm = mk("button", "ghost", "✕"); rm.onclick = async () => { await rpc("kanban.link", { taskId: t.id, path: f, remove: true }); await refreshKanban(); };
    chip.appendChild(nm); chip.appendChild(rm); files.appendChild(chip);
  }
  if (!(t.files || []).length) files.appendChild(mk("div", "td-muted", "none yet"));
  inner.appendChild(files);
  const addFile = mk("div", "td-addrow");
  const fin = mk("input", "td-fileinput"); fin.placeholder = "path relative to the workspace (e.g. docs/note.md)"; fin.spellcheck = false;
  const fbtn = mk("button", "ghost", "Link file");
  const doLink = async () => { const p = fin.value.trim(); if (!p) return; const r = await rpc("kanban.link", { taskId: t.id, path: p }); if (!r.ok) { fin.classList.add("bad"); return; } fin.value = ""; await refreshKanban(); };
  fbtn.onclick = doLink; fin.onkeydown = (e) => { if (e.key === "Enter") doLink(); };
  addFile.appendChild(fin); addFile.appendChild(fbtn); inner.appendChild(addFile);

  // comments
  inner.appendChild(mk("label", "td-label", "Comments"));
  const cl = mk("div", "td-comments");
  for (const c of t.comments || []) {
    const cm = mk("div", "td-comment");
    cm.appendChild(mk("div", "td-comment-head", `${c.who || "you"}${c.date ? " · " + c.date : ""}`));
    cm.appendChild(mk("div", "td-comment-body", c.text));
    cl.appendChild(cm);
  }
  if (!(t.comments || []).length) cl.appendChild(mk("div", "td-muted", "no comments yet"));
  inner.appendChild(cl);
  const addC = mk("div", "td-addrow");
  const cin = mk("input", "td-cinput"); cin.placeholder = "add a comment"; cin.spellcheck = false;
  const cbtn = mk("button", "ghost", "Comment");
  const doComment = async () => { const txt = cin.value.trim(); if (!txt) return; await rpc("kanban.comment", { taskId: t.id, who: "you", text: txt }); cin.value = ""; await refreshKanban(); };
  cbtn.onclick = doComment; cin.onkeydown = (e) => { if (e.key === "Enter") doComment(); };
  addC.appendChild(cin); addC.appendChild(cbtn); inner.appendChild(addC);

  // footer: delete
  const foot = mk("div", "td-foot");
  const del = mk("button", "ghost td-del", "Delete task");
  del.onclick = async () => { if (!confirm("Delete this task?")) return; await rpc("kanban.remove", { taskId: t.id }); closeDrawer(); await refreshKanban(); };
  foot.appendChild(del); inner.appendChild(foot);

  d.classList.remove("hidden"); $("task-scrim").classList.remove("hidden");
}
function openFileFromTask(rel) {
  // jump to the Files pane; the Files pane keys by a fileId, so just open the pane and let the user
  // pick it. (A deep-link by path is a later nicety.)
  const btn = document.querySelector('.rail-btn[data-pane="files"]'); btn?.click();
}
// New task: create a "To do" card owned by you and open the drawer with the title selected, so you
// edit inline (Linear-style) instead of hitting a native prompt dialog.
async function newTaskFlow() {
  const r = await rpc("kanban.add", { title: "New task", status: "planned", owner: "you" });
  await refreshKanban();
  if (r.ok && r.data?.task) {
    openDrawer(r.data.task.id);
    const ti = $("task-drawer-inner").querySelector(".td-title");
    if (ti) { ti.focus(); ti.select(); }
  }
}
function wireMission() {
  wireDnd();
  $("kb-new").onclick = newTaskFlow;
  $("kb-refresh").onclick = refreshKanban;
  $("kb-owner-filter").onchange = renderBoard;
  $("task-scrim").onclick = closeDrawer;
  const histToggle = $("kb-history-toggle"), hist = $("mission-history");
  histToggle.onclick = () => { const show = hist.classList.contains("hidden"); hist.classList.toggle("hidden", !show); if (show) window.cockpit.loadHistory?.(); };
  $("mh-close").onclick = () => hist.classList.add("hidden");
}
wireMission();
onFrame("kanbanChanged", () => { if ($("pane-mission").classList.contains("active")) refreshKanban(); });
window.cockpit.refreshKanban = refreshKanban;

// ---------- BRAIN ----------
let graph = null, graphData = null;
function ensureGraph() {
  if (graph) return graph;
  graph = new Graph($("brain-canvas"));
  // Click a node -> preview the doc in the side panel, WITHOUT leaving Second Brain, so you can
  // click through several docs to find the one you want. (Was: jump to the Files pane, which broke
  // for corpus docs outside the workspace.)
  graph.onClick = (n) => openDocInBrain(n.path, n.label);
  const r = $("brain-canvas").getBoundingClientRect();
  graph.resize(r.width, r.height);
  return graph;
}
async function openDocInBrain(id, label) {
  const box = $("brain-doc");
  box.classList.remove("hidden");
  $("brain-doc-title").textContent = label || id;
  $("brain-doc-body").textContent = "loading...";
  // NB: the doc id goes as `docId`, NOT `id` - rpc()'s envelope uses `id` and `...extra` would
  // clobber it, sending the doc path as the request id so the reply never matches (silent hang).
  const r = await rpc("brain.doc", { docId: id });
  if (!r.ok) { $("brain-doc-body").textContent = "could not read: " + (r.error || "unknown"); return; }
  $("brain-doc-body").innerHTML = renderMarkdown(r.data.content || "");
  $("brain-side").scrollTop = 0;
}
$("brain-doc-close").onclick = () => $("brain-doc").classList.add("hidden");
async function openBrain() {
  ensureGraph();
  if (!graphData) await refreshGraph();
}
async function refreshGraph() {
  $("brain-status").textContent = "building graph...";
  const g = await rpc("brain.graph", {});
  // Resilience: a transient server hiccup (e.g. a slow/failed rebuild) must NOT wipe a good graph.
  // Only replace when we actually got nodes back; otherwise keep what is on screen and say so.
  if (!g.ok || !g.data || !Array.isArray(g.data.nodes) || !g.data.nodes.length) {
    $("brain-status").textContent = graphData
      ? "graph rebuild returned nothing; kept the current view" + (g.error ? " (" + g.error + ")" : "")
      : "no docs indexed yet - click Index corpus";
    return;
  }
  graphData = g.data;
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
    // On conflict do NOT advance currentHash: keeping the stale hash means the next auto-save also
    // conflicts (instead of silently succeeding and clobbering the agent's change). The user must
    // reopen to merge (review P1 data-loss). Only advance the hash on a clean save.
    if (w.data?.conflict) { $("files-banner").className = "show"; $("files-banner").textContent = "the agent changed this file on disk; reopen it to merge (your unsaved edit is kept in the box but not written)"; }
    else if (w.data?.contentHash) currentHash = w.data.contentHash;
  }, 1500);
});

// ---------- SCHEDULE (OpenClaw Gateway cron) ----------
async function openSchedule() {
  const r = await rpc("cron.list", {});
  const banner = $("sched-banner");
  const st = r.data?.status || {};
  const down = st.scheduler === "gateway-down" || st.scheduler === "down";
  const running = st.enabled === true || st.running === true || st.scheduler === "running";
  banner.textContent = down ? "Gateway not running: connect to OpenClaw (Settings) so jobs can fire."
    : running ? `OpenClaw cron scheduler running (${(r.data?.jobs || []).length} job${(r.data?.jobs || []).length === 1 ? "" : "s"})`
    : "OpenClaw cron scheduler: idle";
  banner.className = down ? "dead" : "";
  const list = $("sched-list");
  list.textContent = "";
  const jobs = r.data?.jobs || [];
  if (!jobs.length) { const d = document.createElement("div"); d.className = "placeholder"; d.style.height = "80px"; d.textContent = "No scheduled jobs yet. Add one above (cron expr + what the agent should do)."; list.appendChild(d); }
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "-");
  for (const j of jobs) {
    const card = document.createElement("div"); card.className = "job-card";
    const enabled = j.enabled !== false && j.disabled !== true;
    const expr = j.schedule?.expr || j.schedule?.display || j.cron || (j.schedule?.kind === "every" ? "every " + j.schedule?.every : "");
    const next = j.state?.nextRunAtMs || j.nextRunAtMs || j.state?.nextRunAt;
    const title = document.createElement("div"); title.className = "job-title";
    const nm = document.createElement("span"); nm.textContent = j.name || j.id;
    const sc = document.createElement("span"); sc.className = "job-sched"; sc.textContent = expr;
    title.append(nm, sc);
    const line = document.createElement("div"); line.className = "job-line"; line.textContent = (j.message || j.payload?.message || j.command || "").slice(0, 140);
    const meta = document.createElement("div"); meta.className = "job-meta";
    meta.textContent = `next ${fmt(next)} · ${enabled ? "enabled" : "disabled"} · delivery: ${j.channel || j.delivery?.channel || "last"}`;
    const acts = document.createElement("div"); acts.className = "job-acts";
    for (const verb of [enabled ? "disable" : "enable", "run", "rm"]) {
      const b = document.createElement("button"); b.textContent = verb === "rm" ? "remove" : verb;
      b.onclick = async () => { b.disabled = true; const a = await rpc("cron.action", { verb, jobId: j.id }); if (!a.ok) { b.textContent = "failed"; banner.textContent = a.error || "action failed"; banner.className = "dead"; } openSchedule(); };
      acts.appendChild(b);
    }
    card.append(title, line, meta, acts);
    list.appendChild(card);
  }
}
$("sched-add").onclick = async () => {
  const name = $("sched-name").value.trim(), cron = $("sched-cron").value.trim(), message = $("sched-msg").value.trim();
  if (!cron || !message) { $("sched-banner").textContent = "need a cron expression and a message"; $("sched-banner").className = "dead"; return; }
  const b = $("sched-add"); b.disabled = true; b.textContent = "adding...";
  const r = await rpc("cron.add", { name, cron, message });
  b.disabled = false; b.textContent = "Add job";
  if (!r.ok) { $("sched-banner").textContent = "add failed: " + (r.error || "unknown"); $("sched-banner").className = "dead"; return; }
  $("sched-name").value = $("sched-cron").value = $("sched-msg").value = "";
  openSchedule();
};

// ---------- SKILLS ----------
async function openSkills() {
  const grid = $("skills-grid");
  grid.textContent = "";
  const r = await rpc("skills.list", {});
  if (r.data?.unavailable) { renderUnavailable(grid, r.data); return; }
  const skills = r.data?.skills || [];
  // header: what this pane is + the honest caveat about local-model tool use
  const note = document.createElement("div"); note.className = "skills-note";
  const ready = skills.filter((s) => s.ready).length;
  note.innerHTML = `<b>${ready} of ${skills.length} skills are ready</b> (their CLI/credentials are present). "needs setup" tells you exactly what's missing (a CLI to install, an env var, or a channel token). `
    + `<br><span class="skills-caveat">Note: a small local model often can't reliably <i>invoke</i> a skill on its own (it loops searching for tools). Ready just means the skill's dependencies are met. For reliable skill use in chat, run a larger agent model (Settings &rarr; Agent model).</span>`;
  grid.appendChild(note);
  // group by category (source)
  const groups = new Map();
  for (const s of skills) { const g = s.category || "other"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  for (const [cat, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const nReady = list.filter((s) => s.ready).length;
    const h = document.createElement("h3"); h.className = "skills-group"; h.textContent = `${cat}  (${nReady}/${list.length} ready)`;
    grid.appendChild(h);
    const wrap = document.createElement("div"); wrap.className = "skills-cards";
    for (const s of list.sort((a, b) => (b.ready - a.ready) || a.name.localeCompare(b.name))) {
      const card = document.createElement("div"); card.className = "skill-card" + (s.ready ? " ready" : "");
      const top = document.createElement("div"); top.className = "skill-name";
      const nm = document.createElement("span"); nm.textContent = (s.emoji ? s.emoji + " " : "") + s.name;
      const st = document.createElement("span"); st.className = "skill-status " + (s.ready ? "ok" : "warn"); st.textContent = s.ready ? "ready" : "needs setup";
      top.append(nm, st);
      const desc = document.createElement("div"); desc.className = "skill-desc"; desc.textContent = s.description;
      card.append(top, desc);
      if (!s.ready && s.reason) {
        const why = document.createElement("div"); why.className = "skill-reason"; why.textContent = s.reason;
        if (s.homepage && /^https?:\/\//i.test(s.homepage)) { const a = document.createElement("a"); a.href = s.homepage; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " install guide"; why.appendChild(a); }
        card.appendChild(why);
      }
      wrap.appendChild(card);
    }
    grid.appendChild(wrap);
  }
}

// ---------- SETTINGS (OpenClaw-only: connect + governance + model + vault) ----------
let setConnected = false;
function setDot(el, cls) { $(el).className = "set-dot " + cls; }
function renderConn() {
  setDot("set-conn-dot", setConnected ? "up" : "down");
  $("set-conn-status").textContent = setConnected ? "connected to OpenClaw" : "not connected";
  $("set-connect").textContent = setConnected ? "Reconnect" : "Connect";
}
function renderGateway(g) {
  setDot("set-gw-dot", g?.up ? "up" : "down");
  $("set-gw-status").textContent = "gateway: " + (g?.up ? `running :${g.port}${g.pid ? " (pid " + g.pid + ")" : ""}` : "not running");
}
function renderGovernance(gov, opts) {
  $("gov-workspace").value = gov.workspace || "";
  const prof = $("gov-profile"); prof.textContent = "";
  for (const p of opts.toolProfiles) { const o = document.createElement("option"); o.value = p; o.textContent = p; if (p === gov.toolProfile) o.selected = true; prof.appendChild(o); }
  const ex = $("gov-exec"); ex.textContent = "";
  const EXLABEL = { off: "Never ask (auto-run)", "on-miss": "Ask only for unlisted commands", always: "Always ask before shell" };
  for (const e of opts.execAsk) { const o = document.createElement("option"); o.value = e; o.textContent = EXLABEL[e] || e; if (e === gov.execAsk) o.selected = true; ex.appendChild(o); }
  if ($("gov-lean")) $("gov-lean").value = gov.lean ? "on" : "off";
  const sb = $("gov-sandbox-body");
  if (opts.dockerAvailable) sb.textContent = `Docker detected. Sandbox mode: ${gov.sandboxMode}, workspace access: ${gov.workspaceAccess}. (Container isolation configurable next.)`;
  else sb.textContent = "Not available: OpenClaw's OS sandbox needs Docker, which was not detected. Governance falls back to the working folder + tool policy above.";
}
function renderSetup(st) {
  const incomplete = !st.openclawInstalled || !st.providerReady;
  $("set-setup-card").classList.toggle("hidden", !incomplete);
  setDot("setup-oc-dot", st.openclawInstalled ? "up" : "down");
  setDot("setup-prov-dot", st.providerReady ? "up" : "down");
  $("setup-install").style.display = st.openclawInstalled ? "none" : "";
  $("setup-provider").style.display = st.providerReady ? "none" : "";
  $("setup-prov-label").textContent = st.providerReady ? `QVAC provider configured (${st.providerModel || ""})` : "QVAC provider not configured";
}
function setupLog(line) { const el = $("setup-log"); el.classList.remove("hidden"); el.textContent = (el.textContent + line + "\n").split("\n").slice(-200).join("\n"); el.scrollTop = el.scrollHeight; }
onFrame("setup.log", (m) => setupLog(m.line));
async function openSettings() {
  const r = await rpc("settings.get", {});
  if (!r.ok) return;
  const d = r.data;
  setConnected = !!d.agentAlive;
  $("set-install-hint").textContent = d.installed ? "" : "OpenClaw was not detected - use Setup below to install it.";
  // setup status + actions
  const st0 = await rpc("setup.status", {});
  if (st0.ok) renderSetup(st0.data);
  $("setup-install").onclick = async () => {
    const b = $("setup-install"); b.disabled = true; setupLog("starting install...");
    const rr = await rpc("setup.install", {});
    b.disabled = false;
    if (rr.data?.status) renderSetup(rr.data.status);
  };
  $("setup-provider").onclick = async () => {
    const b = $("setup-provider"); b.disabled = true; setupLog("configuring provider...");
    const rr = await rpc("setup.provider", {});
    b.disabled = false;
    if (rr.data?.status) renderSetup(rr.data.status);
  };
  renderGateway(d.gateway);
  renderConn();
  // Connect: the one "launch it" action. Starts the OpenClaw gateway for you, then opens the session.
  const doConnect = async () => {
    const btn = $("set-connect"); btn.disabled = true;
    $("set-conn-status").textContent = "connecting..."; setDot("set-conn-dot", "starting");
    $("set-conn-hint").textContent = "starting gateway + opening ACP session...";
    const rr = await rpc("agent.connect", {});
    btn.disabled = false;
    if (rr.data?.gateway) renderGateway(rr.data.gateway);
    setConnected = !!rr.data?.connected;
    renderConn();
    const hint = $("set-conn-hint"); hint.textContent = "";
    if (rr.data?.connected) { hint.textContent = `ready${rr.data.startedGateway ? " (started the gateway)" : ""}. Go to Cockpit and send a message.`; return; }
    if (rr.data?.needsPairing) {
      hint.textContent = "This device needs to be paired with OpenClaw's Gateway once. ";
      const pb = document.createElement("button"); pb.textContent = "Pair this device"; pb.className = "";
      pb.onclick = async () => {
        pb.disabled = true; hint.textContent = "pairing..."; setDot("set-conn-dot", "starting");
        const pr = await rpc("device.pair", {});
        if (pr.data?.gateway) renderGateway(pr.data.gateway);
        setConnected = !!pr.data?.connected; renderConn();
        $("set-conn-hint").textContent = pr.data?.connected ? "paired + connected. Go to Cockpit and send a message." : ("pairing failed: " + (pr.data?.error || "unknown"));
      };
      hint.appendChild(pb);
      return;
    }
    hint.textContent = rr.data?.hint || ("could not connect: " + (rr.data?.error || rr.error || "unknown"));
  };
  $("set-connect").onclick = doConnect;
  $("set-gw-stop").onclick = async () => { const rr = await rpc("gateway.stop", {}); renderGateway(rr.data); };
  // governance (writes OpenClaw's real config)
  renderGovernance(d.governance, d);
  const govSet = async (patch, note) => {
    $("gov-state").textContent = "applying...";
    const rr = await rpc("governance.set", patch);
    if (!rr.ok) { $("gov-state").textContent = "failed: " + rr.error; return; }
    renderGovernance(rr.data.governance, d);
    $("gov-state").textContent = note || "saved to OpenClaw's config.";
  };
  $("gov-workspace-save").onclick = () => { const w = $("gov-workspace").value.trim(); if (w) govSet({ workspace: w }, "working folder set - reconnect to use it."); };
  $("gov-profile").onchange = (e) => govSet({ toolProfile: e.target.value });
  $("gov-exec").onchange = (e) => govSet({ execAsk: e.target.value });
  if ($("gov-lean")) $("gov-lean").onchange = (e) => govSet({ lean: e.target.value === "on" }, "tool set updated - reconnect to apply.");
  // channels: enable/disable + in-app credential setup. Tokens are entered by you, written straight
  // to OpenClaw's config, never logged or echoed back. CLI-based channels fall back to the Terminal.
  let channelFields = {};
  const renderChannels = (list) => {
    const box = $("chan-list"); box.textContent = "";
    for (const c of list) {
      const hasForm = !!channelFields[c.id];
      const row = document.createElement("div"); row.className = "chan-row";
      const nm = document.createElement("span"); nm.className = "chan-name"; nm.textContent = c.id;
      const state = document.createElement("span"); state.className = "chan-state";
      state.textContent = c.enabled ? "enabled" : (c.configured ? "configured, off" : (c.present ? "present, no token" : "not set up"));
      state.classList.add(c.enabled ? "on" : "off");
      const acts = document.createElement("span"); acts.className = "chan-acts";
      // enable/disable (only once a credential exists)
      if (c.configured || c.enabled) {
        const tgl = document.createElement("button"); tgl.className = c.enabled ? "ghost" : ""; tgl.textContent = c.enabled ? "Disable" : "Enable";
        tgl.onclick = async () => { tgl.disabled = true; const rr = await rpc("channels.toggle", { id: c.id, enabled: !c.enabled }); if (rr.ok) renderChannels(rr.data.channels); else { tgl.disabled = false; tgl.textContent = "failed"; } };
        acts.appendChild(tgl);
      }
      // set up / edit credentials (in-app for known channels; Terminal for CLI-based ones)
      const form = document.createElement("div"); form.className = "chan-form hidden";
      if (hasForm) {
        const setup = document.createElement("button"); setup.className = "ghost";
        setup.textContent = c.configured ? "Edit token" : "Set up";
        setup.onclick = () => form.classList.toggle("hidden");
        acts.appendChild(setup);
        const inputs = {};
        for (const f of channelFields[c.id]) {
          const label = document.createElement("label"); label.className = "chan-field";
          const span = document.createElement("span"); span.textContent = f.label; label.appendChild(span);
          const inp = document.createElement("input"); inp.type = "password"; inp.autocomplete = "off"; inp.spellcheck = false; inp.placeholder = f.placeholder || ""; label.appendChild(inp);
          inputs[f.key] = inp; form.appendChild(label);
        }
        const save = document.createElement("button"); save.textContent = "Save & enable"; save.className = "chan-save";
        const msg = document.createElement("span"); msg.className = "set-hint chan-form-msg";
        save.onclick = async () => {
          const payload = {}; for (const k in inputs) if (inputs[k].value) payload[k] = inputs[k].value;
          if (!Object.keys(payload).length) { msg.textContent = "enter the token first"; return; }
          save.disabled = true; msg.textContent = "saving...";
          const rr = await rpc("channels.configure", { id: c.id, fields: payload, enable: true });
          for (const k in inputs) inputs[k].value = ""; // clear the secret from the DOM immediately
          save.disabled = false;
          if (rr.ok) { renderChannels(rr.data.channels); } else { msg.textContent = rr.error || "failed"; }
        };
        form.append(save, msg);
      } else if (!c.configured && !c.enabled) {
        const hint = document.createElement("button"); hint.className = "ghost"; hint.textContent = "Set up in Terminal"; hint.title = "this channel uses its own CLI";
        hint.onclick = () => { $("chan-onboard").click(); };
        acts.appendChild(hint);
      }
      row.append(nm, state, acts); box.appendChild(row); box.appendChild(form);
    }
  };
  rpc("channels.list", {}).then((cr) => {
    if (cr.ok && cr.data?.channels) { channelFields = cr.data.fields || {}; renderChannels(cr.data.channels); }
    else $("chan-list").innerHTML = '<div class="set-hint" style="color:var(--warn)">Channels unavailable. If you just updated, restart the cockpit server (stop <code>node server/server.js</code> and start it again) - a page reload is not enough.</div>';
  });
  $("chan-onboard").onclick = async () => {
    $("chan-onboard-hint").textContent = "opening Terminal...";
    const rr = await rpc("channels.onboard", {});
    $("chan-onboard-hint").textContent = rr.ok ? "Terminal opened - follow OpenClaw's prompts (enter your token there, never in the cockpit)." : ("could not open: " + (rr.error || "unknown"));
  };
  // agent model (the model that actually answers you, via OpenClaw's plugin serve - distinct from the
  // cockpit serve below). Changing it re-runs the provider setup (streams to the setup log) then
  // reconnects. This is the fix for "picking a model did nothing" - the old picker only touched the
  // cockpit serve, never the agent.
  const am = $("set-agent-model");
  if (am) {
    am.textContent = "";
    const cur = String(d.agentModel || "").replace(/^qvac\//, "");
    for (const m of (d.agentModels || [])) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label; if (m.id === cur) o.selected = true; am.appendChild(o); }
    if (!cur) { const o = document.createElement("option"); o.textContent = "(not set)"; o.value = ""; o.selected = true; am.prepend(o); }
    am.onchange = async () => {
      const model = am.value; if (!model) return;
      am.disabled = true; $("set-agent-model-state").textContent = `switching the agent to ${model} - this reconfigures the provider and restarts it (~1 min). See the log below.`;
      $("setup-log").classList.remove("hidden");
      const rr = await rpc("setup.provider", { model });
      am.disabled = false;
      $("set-agent-model-state").textContent = rr.ok ? `agent model set to ${model}. Click Connect to start a session on it.` : ("failed: " + (rr.error || "unknown"));
      setConnected = false; renderConn();
    };
  }
  // cockpit serve model (voice/brain; restart is automatic; feedback while it reloads)
  const sel = $("set-model"); sel.textContent = "";
  for (const m of d.models) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label; if (m.id === d.model) o.selected = true; sel.appendChild(o); }
  $("set-model-state").textContent = "serve: " + d.serveState;
  sel.onchange = async () => {
    $("set-model-state").textContent = "restarting serve (up to ~60s)...";
    sel.disabled = true;
    const rr = await rpc("serve.setModel", { model: sel.value });
    sel.disabled = false;
    $("set-model-state").textContent = rr.ok ? `serve: ${rr.data.serveState} (${rr.data.model})` : "failed: " + rr.error;
  };
  // ---- local models: use GGUFs already on disk, no re-download ----
  const repopModels = (list) => { const cur = sel.value; sel.innerHTML = ""; for (const m of list) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label; sel.appendChild(o); } sel.value = list.some((m) => m.id === cur) ? cur : sel.value; };
  const renderAdded = (list) => {
    const box = $("lm-added"); box.textContent = "";
    for (const m of list) {
      const row = document.createElement("div"); row.className = "lm-row";
      const nm = document.createElement("span"); nm.textContent = `${m.alias}  (~${(m.sizeMB / 1000).toFixed(1)}GB)`; nm.title = m.src;
      const rm = document.createElement("button"); rm.className = "ghost"; rm.textContent = "Remove";
      rm.onclick = async () => { const rr = await rpc("models.remove", { alias: m.alias }); if (rr.ok) { renderAdded(rr.data.localModels); repopModels(rr.data.models); } };
      row.append(nm, rm); box.appendChild(row);
    }
  };
  renderAdded(d.localModels || []);
  $("lm-folder").value = d.modelsFolder || "";
  $("lm-scan").onclick = async () => {
    $("lm-state").textContent = "scanning..."; $("lm-found").textContent = "";
    const rr = await rpc("models.scan", { path: $("lm-folder").value.trim() });
    if (!rr.ok) { $("lm-state").textContent = "failed: " + rr.error; return; }
    const found = rr.data.models || [];
    $("lm-state").textContent = `${found.length} GGUF file(s) found in ${rr.data.folder}`;
    const added = new Set((d.localModels || []).map((m) => m.src));
    for (const f of found) {
      const row = document.createElement("div"); row.className = "lm-row";
      const nm = document.createElement("span"); nm.textContent = `${f.name}  (~${(f.sizeMB / 1000).toFixed(1)}GB)`; nm.title = f.path;
      const add = document.createElement("button"); add.textContent = added.has(f.path) ? "Added" : "Add"; add.disabled = added.has(f.path);
      add.onclick = async () => { add.disabled = true; add.textContent = "..."; const ar = await rpc("models.add", { path: f.path }); if (ar.ok) { add.textContent = "Added"; renderAdded(ar.data.localModels); repopModels(ar.data.models); $("lm-state").textContent = `added ${ar.data.added.alias} - pick it in the model list above`; } else { add.textContent = "Add"; add.disabled = false; $("lm-state").textContent = "failed: " + ar.error; } };
      row.append(nm, add); $("lm-found").appendChild(row);
    }
  };
  // second brain folder
  const inp = $("set-brain-root");
  inp.value = d.brainRoot || "";
  $("set-brain-state").textContent = d.brainRoot ? `indexing: ${d.brainRoot}` : `indexing the default (${d.brainDefault})`;
  const applyRoot = async (path) => {
    $("set-brain-state").textContent = "applying...";
    const rr = await rpc("brain.setRoot", { path });
    if (!rr.ok) { $("set-brain-state").textContent = "failed: " + rr.error; return; }
    inp.value = rr.data.brainRoot || "";
    $("set-brain-state").textContent = rr.data.brainRoot ? `set to ${rr.data.brainRoot} - open Second Brain and click Index corpus` : `reset to the default (${d.brainDefault})`;
    graphData = null; // force a rebuild next time Second Brain opens
  };
  $("set-brain-save").onclick = () => applyRoot(inp.value.trim());
  $("set-brain-reset").onclick = () => applyRoot("");
  inp.onkeydown = (e) => { if (e.key === "Enter") applyRoot(inp.value.trim()); };
}
// live pushes keep the panel fresh if it is open
onFrame("gatewayState", (m) => { if ($("pane-settings").classList.contains("active")) renderGateway(m); });
onFrame("agentState", (m) => {
  if (!$("pane-settings").classList.contains("active")) return;
  if (m.state === "ready") { setConnected = true; renderConn(); }
  else if (m.state === "down") { setConnected = false; renderConn(); }
});
