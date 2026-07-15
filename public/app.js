// QVAC Cockpit P1 client: WS to the hub, transcript with tool one-liners (append-only, UX L5),
// the orb as the AGENT's avatar (states from real ACP events), L1 status line with a live timer.
import { Orb } from "./orb.js";
import { formatEgressChip } from "./egress-format.js";
import { renderMarkdown } from "./md.js";

const $ = (id) => document.getElementById(id);
const orb = new Orb($("orb-canvas"));
orb.start();
orb.setColor("#16E3C1", null);

let ws, nextId = 1;
const pending = new Map();
let busy = false, turnStart = 0, elapsedTimer = null;
let agentEl = null, agentText = ""; // the streaming agent message element of the current turn
const toolRows = new Map(); // toolCallId -> row element

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const sock = new WebSocket(`ws://${location.host}`);
  sock.binaryType = "arraybuffer";
  sock.onmessage = onMessage;
  sock.onclose = () => { if (ws === sock) { for (const [, res] of pending) res({ ok: false, error: "connection lost" }); pending.clear(); if (busy) endTurn(); setStatus("OFFLINE", "cockpit server unreachable"); setTimeout(connect, 1500); } };
  ws = sock;
}
connect();
function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }
function rpc(type, extra = {}) {
  return new Promise((res) => { const id = nextId++; pending.set(id, res); send({ id, type, ...extra }); });
}

// ---- status line (L1) ----
function setStatus(verb, target) {
  $("status-verb").textContent = verb;
  $("status-target").textContent = target || "";
}
// Capability chips in the top bar: show ONLY what the connected harness actually supports (the
// enabled ones), as subtle status pills - not a row of struck-through "off" noise. The full
// tri-state stays discoverable via each pill's tooltip; disabled caps are summarized in one muted
// "no: ..." pill so the bar stays clean but honest.
function renderCaps(harness, caps, storeCaps) {
  const el = $("agent-caps");
  if (!el || !harness) return;
  const all = [];
  if (caps) {
    all.push(["replay", caps.loadSession, "session replay (session/load)"]);
    all.push(["plan", caps.plan, "streams a plan"]);
    all.push(["gated", caps.permission, "asks permission before tools"]);
  }
  if (storeCaps) for (const k of ["history", "skills", "kanban", "cron"]) all.push([k, storeCaps[k], `${k} store`]);
  el.textContent = "";
  const on = all.filter(([, v]) => v === true);
  const off = all.filter(([, v]) => v === false).map(([l]) => l);
  for (const [label, , title] of on) {
    const b = document.createElement("span"); b.className = "cap-pill"; b.textContent = label; b.title = title + ": yes";
    el.appendChild(b);
  }
  if (off.length) { const b = document.createElement("span"); b.className = "cap-pill off"; b.textContent = "no " + off.join(" / "); b.title = "not available on this harness"; el.appendChild(b); }
}
function startElapsed() {
  stopElapsed();
  elapsedTimer = setInterval(() => { $("status-elapsed").textContent = ((Date.now() - turnStart) / 1000).toFixed(0) + "s"; }, 1000);
}
function stopElapsed() { clearInterval(elapsedTimer); elapsedTimer = null; }

// ---- transcript (append-only, persisted so a page reload keeps the conversation) ----
const transcript = $("transcript");
const CONVO_KEY = "cockpit-convo";
let convo = [];
try { convo = JSON.parse(localStorage.getItem(CONVO_KEY) || "[]"); } catch { convo = []; }
function saveConvo(role, text) { convo.push({ role, text }); convo = convo.slice(-100); try { localStorage.setItem(CONVO_KEY, JSON.stringify(convo)); } catch { /* quota */ } }
function clearConvo() { convo = []; try { localStorage.removeItem(CONVO_KEY); } catch { /* */ } transcript.textContent = ""; }
function restoreConvo() {
  for (const m of convo) {
    if (m.role === "user") { const el = document.createElement("div"); el.className = "msg-user"; el.textContent = m.text; transcript.appendChild(el); }
    else { const el = document.createElement("div"); el.className = "msg-agent md"; el.innerHTML = renderMarkdown(m.text || ""); transcript.appendChild(el); }
  }
  if (convo.length) { const d = document.createElement("div"); d.className = "final-meta"; d.textContent = "─── earlier in this conversation ───"; transcript.appendChild(d); scroll(); }
}
function addUser(text) {
  const el = document.createElement("div"); el.className = "msg-user"; el.textContent = text;
  transcript.appendChild(el); scroll();
}
restoreConvo(); // bring back the conversation after a page reload
function startAgentMsg() {
  agentText = "";
  agentEl = document.createElement("div"); agentEl.className = "msg-agent streaming";
  transcript.appendChild(agentEl);
}
function appendAgent(t) {
  if (!agentEl) startAgentMsg();
  agentText += t;
  agentEl.textContent = agentText;
  scroll();
}
const KIND_IC = { read: "▸", edit: "✎", execute: "⚡", search: "◎", other: "•" };
function addToolLine(u) {
  const row = document.createElement("div");
  row.className = "tool-line running";
  row.innerHTML = `<span class="t-ic"></span><span class="t-title"></span><span class="t-status">RUNNING</span>`;
  row.querySelector(".t-ic").textContent = KIND_IC[u.kind] || "•";
  row.querySelector(".t-title").textContent = u.title || u.kind || "tool";
  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.textContent = JSON.stringify(u.rawInput ?? u.locations ?? {}, null, 1).slice(0, 2000);
  row.onclick = () => detail.classList.toggle("open");
  transcript.appendChild(row); transcript.appendChild(detail);
  toolRows.set(u.toolCallId, row);
  agentEl = null; // next message chunk starts a fresh block after the tool line
  scroll();
}
function updateToolLine(u) {
  const row = toolRows.get(u.toolCallId);
  if (!row) return; // updates without a start: tolerate (spike lesson)
  row.classList.remove("running");
  row.classList.add(u.status === "failed" ? "failed" : "completed");
  row.querySelector(".t-status").textContent = (u.status || "completed").toUpperCase();
}
function scroll() { transcript.scrollTop = transcript.scrollHeight; }

// ---- frames ----
const frameListeners = new Map(); // type -> fn (panes register progress handlers)
function onFrame(type, fn) { frameListeners.set(type, fn); }
function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) { playWav(ev.data); return; }
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  frameListeners.get(m.type)?.(m);
  switch (m.type) {
    case "hello":
      if (m.agent?.name) $("agent-name").textContent = m.agent.name;
      renderCaps(m.harness, m.capabilities, m.storeCaps);
      setServeDot(m.serveState);
      setStatus("STANDBY", "");
      orb.setState("standby");
      break;
    case "serveState": setServeDot(m.state); break;
    case "agentState":
      if (m.state === "ready") { $("agent-name").textContent = m.agent?.name || "agent"; renderCaps(m.harness, m.capabilities, m.storeCaps); if (!busy) setStatus("STANDBY", ""); }
      else if (m.state === "down") { setStatus("AGENT DOWN", "restarting on next message"); orb.setState("standby"); }
      break;
    case "turnStart":
      if (!busy) { busy = true; turnStart = Date.now(); startElapsed(); addUser(m.text); saveConvo("user", m.text); startAgentMsg(); $("send").classList.add("stop"); $("send").textContent = "■"; }
      break;
    case "sttStart": setStatus("TRANSCRIBING", ""); orb.setState("listening"); break;
    case "userTranscript": break; // turnStart carries the text into the transcript
    case "langSwitched": setStatus("VOICE", m.lang.toUpperCase()); break;
    case "spokenSummary": break;
    case "speakStart": orb.setState("speaking"); setStatus("SPEAKING", ""); break;
    case "speakEnd": if (!busy) { orb.setState("standby"); setStatus("STANDBY", ""); } break;
    case "agentStatus":
      setStatus(m.verb.toUpperCase(), m.target);
      break;
    case "needsYou": needsYouCard(m); break;
    case "contextReset": { const d = document.createElement("div"); d.className = "final-meta"; d.textContent = "─── " + m.message + " ───"; transcript.appendChild(d); scroll(); break; }
    case "needsYouResolved": { const c = document.querySelector(`.needs-card[data-perm-id="${m.permId}"]`); c?.remove(); break; }
    case "acp": {
      const u = m.update || {};
      if (u.sessionUpdate === "agent_message_chunk") {
        const t = typeof u.content === "string" ? u.content : (u.content?.text ?? "");
        if (t) { appendAgent(t); orb.setState("thinking"); }
      } else if (u.sessionUpdate === "agent_thought_chunk") {
        orb.setState("thinking");
      } else if (u.sessionUpdate === "tool_call") {
        addToolLine(u); orb.setState("tool");
      } else if (u.sessionUpdate === "tool_call_update") {
        updateToolLine(u);
      } else if (u.sessionUpdate === "permission_answered") {
        setStatus("PERMISSION", u.optionId + " " + (u.title || ""));
      }
      break;
    }
    case "final": {
      // Render the finished reply as markdown (bold, lists, code) instead of the raw ** and - it
      // streamed as. renderMarkdown is escape-first, so agent-authored text cannot inject HTML.
      if (agentEl) {
        agentEl.classList.remove("streaming");
        const full = (m.text && m.text.trim()) ? m.text : agentText;
        if (full && full.trim()) { agentEl.classList.add("md"); agentEl.innerHTML = renderMarkdown(full); saveConvo("agent", full); }
      }
      const meta = document.createElement("div");
      meta.className = "final-meta";
      meta.textContent = `${m.stopReason} · ${m.toolCount} tool call(s) · ${(m.elapsedMs / 1000).toFixed(1)}s`;
      transcript.appendChild(meta); scroll();
      endTurn();
      break;
    }
    case "error":
      appendAgent("\n[error] " + m.message);
      endTurn();
      break;
  }
}
function setServeDot(state) { const d = $("serve-dot"); d.className = "rail-dot " + (state || ""); d.title = "serve: " + state; }
function endTurn() {
  busy = false; stopElapsed();
  $("status-elapsed").textContent = "";
  setStatus("STANDBY", "");
  orb.setState("standby");
  $("send").classList.remove("stop"); $("send").textContent = "↑";
  agentEl = null;
}

// ---- input ----
const input = $("input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
$("send").onclick = () => { if (busy) { send({ id: nextId++, type: "cancel" }); } else submit(); };
function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (ws?.readyState !== 1) { setStatus("OFFLINE", "reconnecting, retry in a moment"); return; }
  input.value = ""; input.style.height = "auto";
  busy = true; turnStart = Date.now(); startElapsed();
  addUser(text); startAgentMsg();
  orb.setState("thinking"); setStatus("THINKING", "");
  $("send").classList.add("stop"); $("send").textContent = "■";
  rpc("chat", { text }).then((r) => { if (!r.ok) endTurn(); }); // error text arrives once via the broadcast (review P1-12)
}

// rail: cockpit + mission are live; the rest placeholder until their phase
document.querySelectorAll(".rail-btn").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".rail-btn").forEach((x) => x.classList.toggle("active", x === b));
    const pane = b.dataset.pane;
    $("pane-cockpit").classList.toggle("active", pane === "cockpit");
    $("pane-mission").classList.toggle("active", pane === "mission");
    $("pane-other").classList.toggle("active", pane !== "cockpit" && pane !== "mission");
    if (pane === "mission") loadHistory();
  };
});

// ---- permission prompts (rendered inline in the cockpit transcript, where you are chatting, so
// you can answer without switching panes). Kept class "needs-card" so needsYouResolved removes it. ----
function needsYouCard(m) {
  const card = document.createElement("div");
  card.className = "needs-card";
  card.dataset.permId = m.permId;
  const t = document.createElement("div"); t.className = "nc-title"; t.textContent = m.title || "The agent needs your permission"; card.appendChild(t);
  const acts = document.createElement("div"); acts.className = "nc-acts";
  for (const o of m.options || []) {
    const b = document.createElement("button");
    if (/allow/i.test(o.optionId + (o.kind || ""))) b.className = "allow";
    b.textContent = o.name || o.optionId;
    b.onclick = () => send({ id: nextId++, type: "permission", permId: m.permId, optionId: o.optionId });
    acts.appendChild(b);
  }
  card.appendChild(acts);
  transcript.appendChild(card); scroll();
}
// history lives in the Mission Control "History" panel (search past agent sessions)
async function loadHistory(q) {
  const lane = $("lane-history");
  lane.textContent = "";
  const r = q ? await rpc("history.search", { q }) : await rpc("history.list", {});
  if (r.data?.unavailable) { const el = document.createElement("div"); el.className = "hist-row"; el.textContent = r.data.reason || "history not available for this harness"; lane.appendChild(el); return; }
  const rows = q ? (r.data?.hits || []) : (r.data?.sessions || []);
  for (const s of rows.slice(0, 40)) {
    const el = document.createElement("div");
    el.className = "hist-row";
    el.textContent = q
      ? `[${s.profile}] ${s.snip || ""}`
      : `[${s.profile}] ${(s.title || s.id).slice(0, 46)} · ${s.message_count ?? "?"} msgs`;
    el.style.cursor = "pointer";
    const sid = s.session_id || s.id; const prof = s.profile;
    el.onclick = () => viewPastSession(sid, prof);
    lane.appendChild(el);
  }
  if (!rows.length) { const el = document.createElement("div"); el.className = "hist-row"; el.textContent = q ? "no matches" : "no sessions"; lane.appendChild(el); }
}
$("hist-q").addEventListener("keydown", (e) => { if (e.key === "Enter") loadHistory(e.target.value.trim() || undefined); });


// ---- speech playback (WAV frames from the server, queued back to back) ----
let audioCtx = null;
const playQueue = [];
let playing = false;
function playWav(arrayBuf) {
  playQueue.push(arrayBuf);
  if (!playing) drainPlay();
}
async function drainPlay() {
  playing = true;
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  while (playQueue.length) {
    const buf = playQueue.shift();
    try {
      const audio = await audioCtx.decodeAudioData(buf.slice(0));
      await new Promise((res) => {
        const src = audioCtx.createBufferSource();
        src.buffer = audio; src.connect(audioCtx.destination);
        src.onended = res; src.start();
        currentSource = src;
      });
    } catch { /* skip undecodable chunk */ }
  }
  playing = false; currentSource = null;
}
let currentSource = null;
function stopPlayback() { playQueue.length = 0; try { currentSource?.stop(); } catch { /* */ } }

// ---- push-to-talk (hold Space, CORE pattern): mic -> 16k mono Int16 -> ONE binary frame ----
let mediaStream = null, recorder = null, recChunks = [], recording = false;
async function startRec() {
  if (recording) return;
  // Barge-in (audit P1-03): interrupt playback + cancel a running turn BEFORE the busy guard, so
  // holding Space during a long turn actually stops it. Only then do we start a fresh recording.
  stopPlayback();
  if (busy) { send({ id: nextId++, type: "cancel" }); endTurn(); }
  recording = true;
  orb.setState("listening"); setStatus("LISTENING", "release Space to send");
  try {
    mediaStream = mediaStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const srcNode = ctx.createMediaStreamSource(mediaStream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    recChunks = [];
    proc.onaudioprocess = (e) => { if (recording) recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    srcNode.connect(proc); proc.connect(ctx.destination);
    recorder = { ctx, proc, srcNode };
  } catch (e) { recording = false; setStatus("MIC ERROR", String(e.message || e).slice(0, 60)); }
}
function stopRec() {
  if (!recording) return;
  recording = false;
  const { ctx, proc, srcNode } = recorder || {};
  try { proc?.disconnect(); srcNode?.disconnect(); ctx?.close(); } catch { /* */ }
  recorder = null;
  const total = recChunks.reduce((n, c) => n + c.length, 0);
  if (total < 1600) { setStatus("STANDBY", ""); orb.setState("standby"); return; } // <0.1s: ignore
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of recChunks) for (let i = 0; i < c.length; i++) pcm[off++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
  recChunks = [];
  if (ws?.readyState === 1) ws.send(pcm.buffer);
  setStatus("TRANSCRIBING", ""); orb.setState("thinking");
}
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && document.activeElement !== input) { e.preventDefault(); startRec(); }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement !== input) { e.preventDefault(); stopRec(); }
});

// bridge for panes.js (brain/files/schedule/skills)
window.cockpit = { rpc, onFrame, loadHistory };


// ---- P6: theme, gamification chip, egress meter, model picker ----
const themePick = $("theme-pick");
themePick.value = localStorage.getItem("cockpit-theme") || "";
document.documentElement.dataset.theme = themePick.value;
themePick.onchange = () => { document.documentElement.dataset.theme = themePick.value; localStorage.setItem("cockpit-theme", themePick.value); };

onFrame("gamify", (m) => renderGamify(m));
function renderGamify(m) {
  const c = m.counters || {};
  $("chip-xp").textContent = `${c.missions || 0} missions · ${c.tool_calls || 0} tools`;
  const fresh = (m.achievements || []).filter((a) => a.unlocked && !window._ach?.has(a.id));
  window._ach = new Set((m.achievements || []).filter((a) => a.unlocked).map((a) => a.id));
  for (const a of fresh) if (a.name) { const el = $("chip-xp"); el.title = "unlocked: " + a.name; }
}
rpc("gamify", {}).then((r) => r.ok && renderGamify(r.data));

let egressSince = null; // set to a clock string on the first successful sample
async function pollEgress() {
  const r = await rpc("egress", {});
  if (r.ok) {
    const sub = r.data.substrate;
    // Stamp the monitoring window only once we have a REAL sample; the formatter refuses a byte
    // claim until then, so an early/unavailable poll can never read as "0 bytes to cloud".
    if (!sub.unavailable && typeof sub.bytes === "number" && !egressSince) egressSince = new Date().toLocaleTimeString();
    const view = formatEgressChip(r.data, egressSince);
    const chip = $("chip-sovereign");
    chip.textContent = view.text;
    chip.classList.toggle("live", view.live);
    chip.title = view.title;
  }
  setTimeout(pollEgress, 30000);
}
setTimeout(pollEgress, 3000);

// (model selection lives in the Settings pane now)

// View a past session's transcript (read from state.db, NOT an ACP session/load hijack).
async function viewPastSession(sessionId, profile) {
  const r = await rpc("history.view", { sessionId, profile });
  const msgs = r.data?.messages || [];
  let modal = document.getElementById("hist-modal");
  if (!modal) { modal = document.createElement("div"); modal.id = "hist-modal"; modal.onclick = (e) => { if (e.target === modal) modal.remove(); }; document.body.appendChild(modal); }
  modal.innerHTML = "";
  const box = document.createElement("div"); box.className = "hist-box";
  const h = document.createElement("div"); h.className = "hist-box-head"; h.textContent = `session ${String(sessionId).slice(0, 24)} (${profile}) - read only`;
  box.appendChild(h);
  for (const m of msgs) {
    const row = document.createElement("div"); row.className = "hist-msg " + (m.role || "");
    row.textContent = `${m.role}${m.tool_name ? " (" + m.tool_name + ")" : ""}: ${String(m.content || "").slice(0, 800)}`;
    box.appendChild(row);
  }
  if (!msgs.length) { const e = document.createElement("div"); e.className = "hist-msg"; e.textContent = "no messages"; box.appendChild(e); }
  modal.appendChild(box);
}
