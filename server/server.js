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
import { indexCorpus, buildGraph, scanLinks, acceptLink, readCorpusDoc, getBrainRoot, setBrainRoot } from "./brain.js";
import { listFiles, readFileById, writeFileById, markReviewed, revertToReviewed, counters, bump } from "./files.js";
import * as openclawStores from "./stores-openclaw.js";
import { recordMission, snapshot as gamifySnapshot } from "./gamify.js";
import { sample as egressSample } from "./egress.js";
import { detectHarnesses, explainPlan } from "./onboard.js";
import * as openclaw from "./openclaw.js";

// OpenClaw-only build (Hermes removed for now: fully integrating a harness is a lot of work, so we
// focus on making the OpenClaw experience complete). The harness abstraction is kept so a second
// harness can return later, but only openclaw is exposed.
const HARNESS_CMD = {
  openclaw: { bin: "openclaw", acpArgs: ["acp"] },
};
// Per-harness store capabilities. Hermes has all four store panes; OpenClaw exposes sessions +
// skills (via its CLI) but has no kanban board or cron scheduler, so those two panes report an
// honest "not available for this harness" instead of erroring. history/skills are always await-safe
// (the OpenClaw adapter returns promises; the Hermes modules return values -> Promise.resolve wraps).
const STORE_CAPS = {
  openclaw: { history: true, skills: true, kanban: false, cron: false },
};
const OPENCLAW_STORES = { listSessions: openclawStores.listSessions, searchMessages: openclawStores.searchMessages, sessionTree: openclawStores.sessionTree, viewSession: openclawStores.viewSession, listSkills: openclawStores.listSkills };

let harness = "openclaw"; // OpenClaw-only build
let caps = STORE_CAPS[harness];
let STORES = OPENCLAW_STORES;
let HERMES_STORES = false;
const unavailable = (pane) => ({ unavailable: true, harness, reason: `${pane} is not available for ${harness}: this harness does not have that store.` });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8150);
// The workspace the agent works in = OpenClaw's own configured workspace (agents.defaults.workspace),
// so the Files/Second Brain panes show what the agent actually touches. Override with COCKPIT_WORKSPACE.
// Mutable: governance.set can repoint it (then the ACP client is dropped so the next turn uses the new cwd).
let WORKSPACE = process.env.COCKPIT_WORKSPACE || openclaw.workspace();
mkdirSync(WORKSPACE, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
const server = http.createServer(app);
// Origin gate (review P1): the cockpit does privileged things (spawn processes, grant OpenClaw admin
// scope, write config), and a WS handshake is NOT bound by same-origin - so any web page the user
// visits could otherwise open ws://localhost:<port> and drive it drive-by. Accept only a same-host
// browser Origin (the cockpit page itself) or no Origin at all (non-browser clients: CLI, tests).
function originAllowed(origin) {
  if (!origin) return true;
  try { const h = new URL(origin).hostname; return h === "localhost" || h === "127.0.0.1" || h === "::1"; } catch { return false; }
}
const wss = new WebSocketServer({ server, verifyClient: (info) => originAllowed(info.origin || info.req?.headers?.origin) });

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
        reply(true, unavailable("a kanban board")); // OpenClaw has no kanban store
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
      } else if (msg.type === "cron.list" || msg.type === "cron.action") {
        reply(true, unavailable("a cron scheduler")); // OpenClaw has no cron store
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
      } else if (msg.type === "settings.get") {
        reply(true, {
          harness, installed: openclaw.installed(),
          model: serve.model, models: MODEL_CHOICES, serveState: serve.state,
          gateway: gateway.status(),
          agentAlive: !!acp?.alive,
          brainRoot: getBrainRoot(), brainDefault: "the OpenClaw workspace",
          governance: openclaw.governance(), dockerAvailable: await openclaw.dockerAvailable(),
          toolProfiles: ["minimal", "coding", "messaging", "full"], execAsk: ["off", "on-miss", "always"],
        });
      } else if (msg.type === "governance.set") {
        // Write OpenClaw's real config (workspace / tool profile / exec-ask / sandbox) - no CLI needed.
        // Allow-list the enums app-side (clean errors) even though OpenClaw validates its own config.
        try {
          const PROFILES = ["minimal", "coding", "messaging", "full"], ASK = ["off", "on-miss", "always"];
          const SBMODE = ["off", "non-main", "all"], SBACC = ["none", "ro", "rw"];
          if (msg.toolProfile && !PROFILES.includes(msg.toolProfile)) return reply(false, null, "invalid tool profile");
          if (msg.execAsk && !ASK.includes(msg.execAsk)) return reply(false, null, "invalid exec-ask value");
          if (msg.sandbox && (!SBMODE.includes(msg.sandbox.mode) || !SBACC.includes(msg.sandbox.workspaceAccess))) return reply(false, null, "invalid sandbox setting");
          if (msg.workspace) {
            const ws = String(msg.workspace).startsWith("~") ? path.join(process.env.HOME || "", String(msg.workspace).slice(1)) : String(msg.workspace);
            const r = await openclaw.configSet("agents.defaults.workspace", ws); if (!r.ok) return reply(false, null, r.error);
            WORKSPACE = ws; mkdirSync(WORKSPACE, { recursive: true }); // repoint the cockpit's own corpus/cwd too
            try { acp?.stop(); } catch { /* */ } acp = null; connecting = null; // next turn reconnects in the new cwd
            broadcast({ type: "agentState", state: "down", code: "workspace-change" });
          }
          if (msg.toolProfile) { const r = await openclaw.configSet("tools.profile", msg.toolProfile); if (!r.ok) return reply(false, null, r.error); }
          if (msg.execAsk) { const r = await openclaw.configSet("tools.exec.ask", msg.execAsk); if (!r.ok) return reply(false, null, r.error); }
          if (msg.sandbox) { const r = await openclaw.configPatch({ agents: { defaults: { sandbox: { mode: msg.sandbox.mode, workspaceAccess: msg.sandbox.workspaceAccess } } } }); if (!r.ok) return reply(false, null, r.error); }
          const gov = openclaw.governance();
          broadcast({ type: "governanceChanged", governance: gov });
          reply(true, { governance: gov });
        } catch (e) { reply(false, null, String(e?.message || e).slice(0, 200)); }
      } else if (msg.type === "brain.setRoot") {
        try { const root = setBrainRoot(msg.path || null); broadcast({ type: "brainRootChanged", brainRoot: root }); reply(true, { brainRoot: root }); }
        catch (e) { reply(false, null, String(e?.message || e).slice(0, 200)); }
      } else if (msg.type === "setup.status") {
        reply(true, await openclaw.setupStatus());
      } else if (msg.type === "setup.install") {
        const r = await openclaw.installOpenClaw((line) => send(ws, { type: "setup.log", line }));
        reply(true, { code: r.code, status: await openclaw.setupStatus() });
      } else if (msg.type === "setup.provider") {
        // model = an OpenClaw catalog id (qwen3.5-0.8b/2b/4b/9b, qwen3.6-27b/35b-a3b, gpt-oss-20b, gemma4-31b)
        const OC_MODELS = ["qwen3.5-0.8b", "qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b", "qwen3.6-27b", "qwen3.6-35b-a3b", "gpt-oss-20b", "gemma4-31b"];
        const st = await openclaw.setupProvider((line) => send(ws, { type: "setup.log", line }), { model: OC_MODELS.includes(msg.model) ? msg.model : "qwen3.5-9b" });
        reply(true, { status: st });
      } else if (msg.type === "agent.connect") {
        // The "launch it" action: for OpenClaw, bring the Gateway up first (its ACP bridge needs it),
        // then establish the ACP session so the user gets real feedback instead of a blind first msg.
        try {
          let startedGateway = false;
          if (harness === "openclaw" && !gateway.listening()) { await gateway.start(); startedGateway = true; }
          const info = await ensureAcp();
          reply(true, { connected: true, harness, agent: acp?.agentInfo || null, capabilities: acp?.capabilities || null, startedGateway, gateway: gateway.status() });
        } catch (e) {
          const msgTxt = String(e?.message || e);
          // Device not paired yet -> tell the client to offer one-click pairing instead of a dead error.
          const needsPairing = harness === "openclaw" && (openclaw.pendingScope(msgTxt) || openclaw.pendingScope(e?.hint || ""));
          reply(true, { connected: false, harness, error: msgTxt.slice(0, 300), hint: e?.hint || null, needsPairing, gateway: gateway.status() });
        }
      } else if (msg.type === "device.pair") {
        // Pair THIS device with the local Gateway (no CLI), then connect. The pending admin request is
        // only created WHEN the ACP bridge attempts to connect, so: attempt (creates the request) ->
        // approve it by exact id -> attempt again. A couple of rounds covers the scope escalation.
        try {
          if (!gateway.listening()) await gateway.start();
          let connected = false, lastErr = null;
          for (let i = 0; i < 3 && !connected; i++) {
            try { acp?.stop(); } catch { /* */ } acp = null; connecting = null; // fresh bridge each attempt
            try { await ensureAcp(); connected = true; break; }
            catch (e) { lastErr = String(e?.message || e); if (!openclaw.pendingScope(lastErr) && !openclaw.pendingScope(e?.hint || "")) break; }
            await openclaw.pairDevice(); // approve the pending request the failed attempt just created
          }
          reply(true, { connected, agent: acp?.agentInfo || null, capabilities: acp?.capabilities || null, error: connected ? null : (lastErr || "pairing did not complete"), gateway: gateway.status() });
        } catch (e) { reply(true, { connected: false, error: String(e?.message || e).slice(0, 300), gateway: gateway.status() }); }
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
  console.log(`[cockpit] serve ${serve.state} on :${serve.port} (${serve.model})`);
});
