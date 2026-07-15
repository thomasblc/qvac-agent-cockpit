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
    if (pane === "mission") window.cockpit.loadHistory?.();
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
    if (w.data?.conflict) { $("files-banner").className = "show"; $("files-banner").textContent = "the agent changed this file; reopen to merge (your edit was NOT saved)"; currentHash = w.data.contentHash; }
    else if (w.data?.contentHash) currentHash = w.data.contentHash;
  }, 1500);
});

// ---------- SCHEDULE ----------
async function openSchedule() {
  const r = await rpc("cron.list", {});
  if (r.data?.unavailable) { $("sched-banner").textContent = ""; $("sched-banner").className = ""; renderUnavailable($("sched-list"), r.data); return; }
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
  if (r.data?.unavailable) { renderUnavailable(grid, r.data); return; }
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
  const sb = $("gov-sandbox-body");
  if (opts.dockerAvailable) sb.textContent = `Docker detected. Sandbox mode: ${gov.sandboxMode}, workspace access: ${gov.workspaceAccess}. (Container isolation configurable next.)`;
  else sb.textContent = "Not available: OpenClaw's OS sandbox needs Docker, which was not detected. Governance falls back to the working folder + tool policy above.";
}
async function openSettings() {
  const r = await rpc("settings.get", {});
  if (!r.ok) return;
  const d = r.data;
  setConnected = !!d.agentAlive;
  $("set-install-hint").textContent = d.installed ? "" : "OpenClaw was not detected - install it first (npm i -g openclaw @qvac/openclaw-plugin @qvac/cli @qvac/sdk).";
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
  // model (restart is automatic; feedback while it reloads)
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
