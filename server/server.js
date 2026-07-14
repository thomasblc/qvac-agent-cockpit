// QVAC Cockpit server (P1 skeleton): express static + WS hub on 8150.
// One AcpClient (hermes) + the supervised serve. Frames follow the house protocol:
// requests {id,type,...} -> replies {id,type,ok,data|error}; pushes {type,...} (no id).
// ACP session updates relay VERBATIM as {type:"acp", update} (the client owns rendering),
// plus a derived {type:"agentStatus"} line (UX law L1: verb + target + elapsed).
import express from "express";
import http from "node:http";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AcpClient } from "./acp-client.js";
import { ServeManager } from "./serve-manager.js";
import { GatewayManager } from "./gateway-manager.js";
import { VoiceEngine, TTS_SAMPLE_RATE } from "./voice-engine.js";
import { decideLanguage } from "./lang-id.js";
import { createWavHeader, int16ArrayToBuffer } from "./audio-utils.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as hermesHistory from "./history.js";
import { readBoard, KanbanWatcher, kanbanAvailable } from "./kanban.js";
import { indexCorpus, buildGraph, scanLinks, acceptLink, readCorpusDoc } from "./brain.js";
import { listFiles, readFileById, writeFileById, markReviewed, revertToReviewed, counters, bump } from "./files.js";
import { jobsWithSummaries, tickerAlive, cronAction } from "./cron.js";
import { listSkills as hermesListSkills } from "./skills.js";
import * as openclawStores from "./stores-openclaw.js";
import { recordMission, snapshot as gamifySnapshot } from "./gamify.js";
import { sample as egressSample } from "./egress.js";
import { detectHarnesses, explainPlan } from "./onboard.js";

// Which harness the cockpit drives. Runtime-switchable from the Settings panel (harness.set):
// `harness` + `caps` + `STORES` are recomputed together by applyHarness(); switching drops the
// current ACP client so the next turn reconnects against the new harness's bridge.
const HARNESS_CMD = {
  hermes: { bin: process.env.HOME + "/.local/bin/hermes", acpArgs: ["acp"] },
  openclaw: { bin: "openclaw", acpArgs: ["acp"] },
};
// Per-harness store capabilities. Hermes has all four store panes; OpenClaw exposes sessions +
// skills (via its CLI) but has no kanban board or cron scheduler, so those two panes report an
// honest "not available for this harness" instead of erroring. history/skills are always await-safe
// (the OpenClaw adapter returns promises; the Hermes modules return values -> Promise.resolve wraps).
const STORE_CAPS = {
  hermes: { history: true, skills: true, kanban: true, cron: true },
  openclaw: { history: true, skills: true, kanban: false, cron: false },
};
const OPENCLAW_STORES = { listSessions: openclawStores.listSessions, searchMessages: openclawStores.searchMessages, sessionTree: openclawStores.sessionTree, viewSession: openclawStores.viewSession, listSkills: openclawStores.listSkills };
const HERMES_STORES_IMPL = { listSessions: hermesHistory.listSessions, searchMessages: hermesHistory.searchMessages, sessionTree: hermesHistory.sessionTree, viewSession: hermesHistory.viewSession, listSkills: hermesListSkills };

let harness = process.env.COCKPIT_HARNESS || "hermes";
let caps = STORE_CAPS[harness] || STORE_CAPS.hermes;
let STORES = harness === "openclaw" ? OPENCLAW_STORES : HERMES_STORES_IMPL;
let HERMES_STORES = harness === "hermes";
function applyHarness(h) {
  if (!HARNESS_CMD[h]) throw new Error("unknown harness " + h);
  harness = h;
  caps = STORE_CAPS[h] || STORE_CAPS.hermes;
  STORES = h === "openclaw" ? OPENCLAW_STORES : HERMES_STORES_IMPL;
  HERMES_STORES = h === "hermes";
}
const unavailable = (pane) => ({ unavailable: true, harness, reason: `${pane} is not available for ${harness}: this harness does not have that store.` });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8150);
// The harness workspace the agent works in (P6 setup screen will set this; default = a scratch).
const WORKSPACE = process.env.COCKPIT_WORKSPACE || path.join(__dirname, "..", "workspace");
mkdirSync(WORKSPACE, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const serve = new ServeManager({
  port: 11434,
  model: process.env.COCKPIT_MODEL || "qwen3.6-moe",
  configPath: process.env.COCKPIT_SERVE_CONFIG || path.join(__dirname, "..", "config", "qvac.serve.config.json"),
  onState: (s) => broadcast({ type: "serveState", state: s }),
});

const gateway = new GatewayManager({ port: 18789 }); // OpenClaw Gateway, controlled from Settings

const voice = new VoiceEngine(); // lazy: loads nothing until the first voice use
const MIC_SAMPLE_RATE = 16000;

// Models the Settings picker offers. All defined in the bundled serve config with tools+static
// (required for external harnesses), so switching = restart the serve with a different --model alias.
const MODEL_CHOICES = [
  { id: "qwen3.5-4b", label: "Qwen3.5 4B (fast, ~4GB)" },
  { id: "qwen3.5-9b", label: "Qwen3.5 9B (balanced, ~7GB)" },
  { id: "qwen3.6-moe", label: "Qwen3.6 35B-A3B MoE (best, ~22GB)" },
];

const clients = new Set();
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === 1) ws.send(s); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---- the one agent connection (P1: single session; P3 adds history/multi) ----
let acp = null, connecting = null;
let turn = null; // { startedAt, text, tools: Map(toolCallId -> {title,kind,status}), lastStatus }

const KIND_VERB = { read: "Reading", edit: "Editing", execute: "Running", search: "Searching", other: "Working on" };

function onAcpEvent(u) {
  if (!turn && !["plan", "available_commands_update", "current_mode_update"].includes(u.sessionUpdate)) return; // late events after cancel/timeout (review P1-9)
  broadcast({ type: "acp", update: u });
  if (!turn) return;
  if (u.sessionUpdate === "agent_message_chunk") {
    const t = typeof u.content === "string" ? u.content : (u.content?.text ?? "");
    turn.text += t;
  } else if (u.sessionUpdate === "tool_call") {
    turn.tools.set(u.toolCallId, { title: u.title, kind: u.kind, status: "running" });
    const target = u.locations?.[0]?.path ? path.basename(u.locations[0].path) : (u.title || "").slice(0, 60);
    pushStatus(`${KIND_VERB[u.kind] || "Working on"}`, target);
  } else if (u.sessionUpdate === "tool_call_update") {
    const t = turn.tools.get(u.toolCallId);
    if (t) t.status = u.status || "completed"; // updates can be missing: tolerate (spike lesson)
  }
}
function pushStatus(verb, target) {
  if (!turn) return;
  turn.lastStatus = { verb, target };
  broadcast({ type: "agentStatus", verb, target, elapsedMs: Date.now() - turn.startedAt });
}

// Needs You queue: pending permission requests awaiting a human answer.
let permSeq = 0;
const pendingPerms = new Map(); // permId -> resolve(optionId|null)
function askHuman(params) {
  return new Promise((resolve) => {
    const permId = ++permSeq;
    pendingPerms.set(permId, resolve);
    const tc = params?.toolCall || {};
    broadcast({ type: "needsYou", permId, title: tc.title || "Tool wants to run", kind: tc.kind, options: params?.options || [] });
    setTimeout(() => {
      if (!pendingPerms.has(permId)) return;
      pendingPerms.delete(permId);
      // Unattended = null -> the client picks an explicit reject option or answers `cancelled`.
      // NEVER resolve an allow here (audit P0-03).
      broadcast({ type: "needsYouResolved", permId, optionId: null, auto: true, denied: true });
      resolve(null);
    }, 120000);
  });
}

async function ensureAcp() {
  if (acp?.alive && acp.sessionId) return acp;
  if (connecting) return connecting;
  connecting = (async () => {
    try { acp?.stop(); } catch { /* */ } // never leak a half-connected child (review P1-8)
    const prevSession = acp?.sessionId || null;
    const cmd = HARNESS_CMD[harness] || HARNESS_CMD.hermes;
    acp = new AcpClient({ ...cmd, harnessId: harness, cwd: WORKSPACE, onEvent: onAcpEvent }); // cwd = workspace (spike lesson)
    acp.setPermissionHandler(askHuman);
    acp.setCancelHook(() => { for (const [permId, r] of pendingPerms) { pendingPerms.delete(permId); broadcast({ type: "needsYouResolved", permId, cancelled: true }); r(null); } });
    acp.on("exit", (code) => broadcast({ type: "agentState", state: "down", code }));
    acp.on("stderr", () => { /* logged by hermes itself */ });
    const info = await acp.connect();
    if (prevSession && info.sessionId !== prevSession) broadcast({ type: "contextReset", message: "new agent session (previous context lost)" });
    broadcast({ type: "agentState", state: "ready", agent: info.agent, sessionId: info.sessionId, harness: harness, capabilities: acp.capabilities, hermesStores: HERMES_STORES, storeCaps: caps });
    return acp;
  })().finally(() => { connecting = null; });
  return connecting;
}

// One turn at a time (voice or text). speak=true reads the FINAL summary aloud, never chunks.
async function runTurn(text, { speak = false } = {}) {
  if (turn) return { busy: true };
  turn = { startedAt: Date.now(), text: "", tools: new Map(), lastStatus: null }; // claim the slot BEFORE any await (review P1-4)
  let a;
  try { a = await ensureAcp(); } catch (e) { turn = null; throw e; }
  broadcast({ type: "turnStart", text });
  pushStatus("Thinking", "");
  try {
    const r = await a.prompt(text);
    const toolCount = turn.tools.size;
    const finalText = turn.text;
    const byKind = {};
    for (const t of turn.tools.values()) byKind[t.kind || "other"] = (byKind[t.kind || "other"] || 0) + 1;
    broadcast({ type: "final", stopReason: r.stopReason, text: finalText, toolCount, elapsedMs: Date.now() - turn.startedAt });
    broadcast({ type: "debrief", stopReason: r.stopReason, toolCount, byKind, elapsedMs: Date.now() - turn.startedAt, at: Date.now() });
    if (r.stopReason === "end_turn") { recordMission({ toolCount, at: Date.now() }); broadcast({ type: "gamify", ...gamifySnapshot() }); }
    if (speak && r.stopReason === "end_turn" && finalText.trim()) speakFinal(text, finalText).catch((e) => broadcast({ type: "error", message: "voice: " + e.message }));
    return { stopReason: r.stopReason, text: finalText };
  } finally { turn = null; }
}

// Voice policy (deep plan): auto-detect the user's language (sticky), compress long finals
// to two spoken sentences via the local serve, stream the speech phrase by phrase.
let speaking = false;
async function speakFinal(userText, finalText) {
  if (speaking) return;
  speaking = true;
  try {
    const lang = decideLanguage(userText, voice.language);
    if (lang !== voice.language) broadcast({ type: "langSwitched", lang });
    await voice.ensureTTS(lang);
    let toSpeak = finalText;
    if (toSpeak.length > 600) {
      try {
        const r = await fetch(serve.base() + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
          body: JSON.stringify({ model: serve.model, messages: [
            { role: "system", content: "Compress the assistant reply below to at most two short spoken sentences in its own language. Output only the sentences." },
            { role: "user", content: toSpeak.slice(0, 4000) },
          ], max_tokens: 120 }),
        }).then((x) => x.json());
        const sum = r.choices?.[0]?.message?.content?.trim();
        if (sum) { toSpeak = sum; broadcast({ type: "spokenSummary", text: sum }); }
      } catch { /* fall back to the full text */ }
    }
    broadcast({ type: "speakStart" });
    await voice.speakStream(toSpeak, (samples) => {
      const pcm = int16ArrayToBuffer(samples);
      const wav = Buffer.concat([createWavHeader(pcm.length, TTS_SAMPLE_RATE), pcm]);
      for (const c of clients) if (c.readyState === 1) c.send(wav, { binary: true });
    });
    broadcast({ type: "speakEnd" });
  } finally { speaking = false; }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  send(ws, { type: "hello", workspace: WORKSPACE, serveState: serve.state, agent: acp?.agentInfo || null, model: serve.model, harness: harness, capabilities: acp?.capabilities || null, hermesStores: HERMES_STORES, storeCaps: caps });
  ws.on("message", async (buf, isBinary) => {
    if (isBinary) {
      // one utterance per frame (push-to-talk release sends the whole recording)
      try {
        if (turn) { send(ws, { type: "info", message: "busy" }); return; }
        broadcast({ type: "sttStart" });
        const pcm = Buffer.from(buf);
        const wav = Buffer.concat([createWavHeader(pcm.length, MIC_SAMPLE_RATE), pcm]);
        const tmp = path.join(tmpdir(), `cockpit-mic-${Date.now()}.wav`);
        writeFileSync(tmp, wav);
        let userText = "";
        try { userText = await voice.transcribeWav(tmp); } finally { try { unlinkSync(tmp); } catch { /* */ } }
        if (!userText || userText.replace(/[^\p{L}\p{N}]/gu, "").length < 2) { broadcast({ type: "info", message: "no speech detected" }); return; }
        broadcast({ type: "userTranscript", text: userText });
        const r = await runTurn(userText, { speak: true });
        if (r?.busy) broadcast({ type: "info", message: "busy: utterance dropped" });
      } catch (e) { broadcast({ type: "error", message: String(e?.message || e).slice(0, 300) }); turn = null; }
      return;
    }
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const reply = (ok, data, error) => send(ws, { id: msg.id, type: msg.type, ok, data, error });
    try {
      if (msg.type === "chat") {
        const r = await runTurn(String(msg.text || ""), { speak: !!msg.speak });
        if (r.busy) return reply(false, null, "a turn is already running");
        reply(true, r);
      } else if (msg.type === "cancel") {
        acp?.cancel(); reply(true, {});
      } else if (msg.type === "permission") {
        const r = pendingPerms.get(msg.permId);
        if (r) { pendingPerms.delete(msg.permId); broadcast({ type: "needsYouResolved", permId: msg.permId, optionId: msg.optionId }); r(msg.optionId || null); }
        reply(true, {});
      } else if (msg.type === "history.list") {
        if (!caps.history) return reply(true, unavailable("session history"));
        reply(true, { sessions: await STORES.listSessions({ limit: msg.limit || 60 }) });
      } else if (msg.type === "history.search") {
        if (!caps.history) return reply(true, unavailable("session history"));
        reply(true, { hits: await STORES.searchMessages(msg.q, { limit: 30 }) });
      } else if (msg.type === "history.tree") {
        if (!caps.history) return reply(true, unavailable("session history"));
        reply(true, { roots: await STORES.sessionTree({}) });
      } else if (msg.type === "history.view") {
        if (!caps.history) return reply(true, unavailable("session history"));
        reply(true, await STORES.viewSession(msg.sessionId, msg.profile || "main"));
      } else if (msg.type === "kanban.board") {
        if (!caps.kanban) return reply(true, unavailable("a kanban board"));
        reply(true, readBoard());
      } else if (msg.type === "brain.index") {
        reply(true, await indexCorpus(WORKSPACE, (f) => send(ws, f)));
      } else if (msg.type === "brain.graph") {
        reply(true, buildGraph(WORKSPACE, { semantic: msg.semantic !== false }));
      } else if (msg.type === "brain.scan") {
        reply(true, await scanLinks({ serveBase: serve.base(), model: serve.model, existingPairs: msg.existingPairs || [], scope: msg.scope || null }, (f) => send(ws, f)));
      } else if (msg.type === "brain.doc") {
        reply(true, readCorpusDoc(msg.docId, WORKSPACE));
      } else if (msg.type === "brain.accept") {
        const r = await acceptLink(msg.a, msg.b, WORKSPACE); bump("links_created");
        broadcast({ type: "linkCreated", a: msg.a, b: msg.b });
        reply(true, r);
      } else if (msg.type === "files.list") {
        reply(true, { files: listFiles(WORKSPACE) });
      } else if (msg.type === "files.read") {
        reply(true, readFileById(msg.fileId, WORKSPACE));
      } else if (msg.type === "files.write") {
        reply(true, writeFileById(msg.fileId, msg.content, WORKSPACE, msg.knownHash));
      } else if (msg.type === "files.review") {
        reply(true, markReviewed(msg.fileId, WORKSPACE));
      } else if (msg.type === "files.revert") {
        reply(true, revertToReviewed(msg.fileId, WORKSPACE, msg.knownHash));
      } else if (msg.type === "cron.list") {
        if (!caps.cron) return reply(true, unavailable("a cron scheduler"));
        reply(true, { jobs: await jobsWithSummaries({ serveBase: serve.base(), model: serve.model }), ticker: tickerAlive() });
      } else if (msg.type === "cron.action") {
        if (!caps.cron) return reply(true, unavailable("a cron scheduler"));
        reply(true, await cronAction(msg.verb, msg.jobId, msg.profile));
      } else if (msg.type === "skills.list") {
        if (!caps.skills) return reply(true, unavailable("a skills catalog"));
        reply(true, { skills: await STORES.listSkills() });
      } else if (msg.type === "gamify") {
        reply(true, gamifySnapshot());
      } else if (msg.type === "egress") {
        reply(true, await egressSample());
      } else if (msg.type === "onboard.scan") {
        const evidence = detectHarnesses();
        reply(true, await explainPlan({ serveBase: serve.base(), model: serve.model }, evidence));
      } else if (msg.type === "setup.detect") {
        // one-click: is a hermes home present? which model?
        const { existsSync } = await import("node:fs");
        reply(true, { hermes: existsSync(process.env.HOME + "/.hermes"), workspace: WORKSPACE, model: serve.model, serveState: serve.state });
      } else if (msg.type === "settings.get") {
        reply(true, {
          harness, harnesses: Object.keys(HARNESS_CMD),
          model: serve.model, models: MODEL_CHOICES, serveState: serve.state,
          gateway: gateway.status(), gatewayNeeded: harness === "openclaw",
          agentAlive: !!acp?.alive,
        });
      } else if (msg.type === "harness.set") {
        if (!HARNESS_CMD[msg.harness]) return reply(false, null, "unknown harness");
        if (msg.harness !== harness) {
          applyHarness(msg.harness);
          try { acp?.cancel(); } catch { /* */ } // fire the cancel hook first: clears pending permission cards (review P2)
          try { acp?.stop(); } catch { /* */ } // drop the old bridge; next turn reconnects to the new one
          acp = null; connecting = null;
          broadcast({ type: "harnessSwitched", harness, storeCaps: caps, hermesStores: HERMES_STORES });
          broadcast({ type: "agentState", state: "down", code: "harness-switch" });
        }
        reply(true, { harness, storeCaps: caps, gatewayNeeded: harness === "openclaw", gateway: gateway.status() });
      } else if (msg.type === "gateway.status") {
        reply(true, gateway.status());
      } else if (msg.type === "gateway.start") {
        reply(true, await gateway.start());
        broadcast({ type: "gatewayState", ...gateway.status() });
      } else if (msg.type === "gateway.stop") {
        reply(true, gateway.stop());
        broadcast({ type: "gatewayState", ...gateway.status() });
      } else if (msg.type === "serve.setModel") {
        if (!MODEL_CHOICES.some((m) => m.id === msg.model)) return reply(false, null, "unknown model");
        broadcast({ type: "serveState", state: "starting" });
        const state = await serve.setModel(msg.model);
        broadcast({ type: "modelSwitched", model: serve.model, serveState: state });
        reply(true, { model: serve.model, serveState: state });
      } else if (msg.type === "counters") {
        reply(true, counters());
      } else if (msg.type === "health") {
        reply(true, { serveState: serve.state, agentAlive: !!acp?.alive, sessionId: acp?.sessionId || null, workspace: WORKSPACE });
      } else reply(false, null, "unknown type " + msg.type);
    } catch (e) {
      broadcast({ type: "error", message: String(e?.message || e).slice(0, 300) });
      reply(false, null, String(e?.message || e).slice(0, 300));
    }
  });
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[cockpit] http://localhost:${PORT} | workspace ${WORKSPACE}`);
  await serve.ensure();
  serve.watch();
  if (kanbanAvailable()) new KanbanWatcher((events) => broadcast({ type: "kanban", events }));
  console.log(`[cockpit] serve ${serve.state} on :${serve.port} (${serve.model})`);
});
