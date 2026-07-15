// Read/write the OpenClaw config so the cockpit can govern the harness with NO CLI. OpenClaw already
// ships a mature model (Docker sandbox + tool profiles + exec-ask + workspace), so we surface and set
// those, we do not reinvent them. Reads parse ~/.openclaw/openclaw.json directly (fast, no spawn);
// writes go through `openclaw config set/patch` (respects OpenClaw's validation + file lock - never
// hand-write, same rule as Hermes cron).
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const H = homedir();
export const OPENCLAW_CONFIG = join(H, ".openclaw", "openclaw.json");
const OC = process.env.OPENCLAW_BIN || "openclaw";

export function readConfig() {
  try { return JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8")); } catch { return {}; }
}
export function getPath(dot) {
  return dot.split(".").reduce((o, k) => (o == null ? o : o[k]), readConfig());
}
export function installed() { return existsSync(OPENCLAW_CONFIG) || !!process.env.OPENCLAW_BIN; }

// The agent's working directory (its default file-access root). Falls back to the OpenClaw default.
export function workspace() {
  return getPath("agents.defaults.workspace") || join(H, ".openclaw", "workspace");
}

// Governance snapshot the Settings panel renders.
export function governance() {
  const c = readConfig();
  const ad = c.agents?.defaults || {};
  return {
    workspace: workspace(),
    toolProfile: ad.tools?.profile || c.tools?.profile || "coding",
    execAsk: ad.tools?.exec?.ask || c.tools?.exec?.ask || "off",
    sandboxMode: ad.sandbox?.mode || "off",
    workspaceAccess: ad.sandbox?.workspaceAccess || "rw",
    model: ad.model?.primary || null,
  };
}

// `openclaw config set <dotpath> <value>` (value passed raw; strings without --strict-json). Returns
// {ok, out|error}. For JSON values pass strictJson:true.
export function configSet(dotPath, value, { strictJson = false } = {}) {
  return new Promise((resolve) => {
    const args = ["config", "set", dotPath, typeof value === "string" && !strictJson ? value : JSON.stringify(value)];
    if (strictJson) args.push("--strict-json");
    execFile(OC, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (String(stderr || err.message)).slice(0, 300) });
      else resolve({ ok: true, out: String(stdout).slice(0, 200) });
    });
  });
}

// `openclaw config patch '<json5>'` - one validated write for nested objects (merge semantics).
export function configPatch(obj) {
  return new Promise((resolve) => {
    execFile(OC, ["config", "patch", JSON.stringify(obj)], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (String(stderr || err.message)).slice(0, 300) });
      else resolve({ ok: true, out: String(stdout).slice(0, 200) });
    });
  });
}

// The local Gateway token (from openclaw.json). Grants admin operations like device approval, so the
// cockpit can pair THIS device without the CLI (the user authorized local pairing).
export function gatewayToken() { return getPath("gateway.auth.token") || null; }

function run(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(OC, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Keep FULL stdout: callers (pendingRequests) JSON.parse it - a 600-char slice would corrupt the
      // document (review P1). Only the error string is truncated for logging.
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "").slice(0, 600) });
    });
  });
}

// List pending requests from the local Gateway that belong to the ACP bridge (displayName "ACP").
// SCOPING (review P1): approve ONLY the ACP bridge's own requests, never a foreign device that
// happens to be pending at the same instant (would be a confused-deputy admin escalation).
async function pendingRequests(token) {
  const r = await run(["devices", "list", "--token", token, "--json"], 12000);
  try {
    const d = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
    return (d.pending || []).filter((p) => p && p.displayName === "ACP").map((p) => p.requestId).filter(Boolean);
  } catch { return []; }
}

// Approve THIS device's pending scope requests against the local Gateway with the Gateway token.
// MUST approve the EXACT requestId (not --latest: --latest only re-grants operator.pairing and never
// escalates to the operator.admin the ACP bridge needs). Returns {approved, count}.
export async function pairDevice() {
  const token = gatewayToken();
  if (!token) return { approved: false, error: "no gateway token in openclaw.json (start the gateway once)" };
  const ids = await pendingRequests(token);
  let approved = 0;
  for (const rid of ids) { const r = await run(["devices", "approve", rid, "--token", token], 15000); if (/\bApproved\b/i.test(r.out)) approved++; }
  return { approved: approved > 0, count: approved };
}
export function pendingScope(errOrHint = "") {
  // Match BOTH the raw bridge stderr ("scope upgrade pending approval") AND the rewritten hint the
  // AcpClient surfaces ("...device paired with admin scope...", "run openclaw onboard").
  return /scope upgrade pending|pairing-required|operator\.admin|pending approval|paired with admin scope|admin scope for the acp|openclaw onboard/i.test(String(errOrHint));
}

// ---- first-run setup: install OpenClaw + wire the QVAC provider, all from the UI (no CLI) ----
import { spawn } from "node:child_process";

// Which prerequisites are satisfied. Drives the Setup card (show install / provider buttons).
export async function setupStatus() {
  const oc = installed();
  let pluginEnabled = false, providerModel = null;
  if (oc) {
    const pl = await run(["plugins", "list"], 12000);
    pluginEnabled = /\bqvac\b[^\n]*\benabled\b/i.test(pl.out);
    providerModel = getPath("agents.defaults.model.primary") || null;
  }
  return { openclawInstalled: oc, pluginEnabled, providerModel, providerReady: pluginEnabled && !!providerModel };
}

// Stream a spawned command's output line-by-line to onLine; resolve {code}. Used for the long npm
// install + the provider-setup sequence so the UI shows live progress.
function stream(cmd, args, onLine, { timeoutMs = 600000, env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    const t = setTimeout(() => { if (!done) { try { child.kill(); } catch { /* */ } onLine("[timed out]"); resolve({ code: 124 }); done = true; } }, timeoutMs);
    const feed = (buf) => { for (const line of String(buf).split("\n")) if (line.trim()) onLine(line.slice(0, 300)); };
    child.stdout?.on("data", feed); child.stderr?.on("data", feed);
    child.on("error", (e) => { if (!done) { onLine("[error] " + e.message); clearTimeout(t); resolve({ code: 1 }); done = true; } });
    child.on("exit", (code) => { if (!done) { clearTimeout(t); resolve({ code: code ?? 0 }); done = true; } });
  });
}

// Install OpenClaw + the QVAC plugin/CLI/SDK globally via npm, streaming progress.
export async function installOpenClaw(onLine) {
  onLine("Installing OpenClaw + QVAC packages via npm (this can take a few minutes)...");
  const r = await stream("npm", ["install", "-g", "openclaw", "@qvac/openclaw-plugin", "@qvac/cli", "@qvac/sdk"], onLine, { timeoutMs: 600000 });
  onLine(r.code === 0 ? "npm install finished." : `npm install exited with code ${r.code}.`);
  return r;
}

// Wire the QVAC provider into OpenClaw (the exact sequence proven to work), streaming each step.
// Idempotent: safe to re-run. Model defaults to qwen3.5-9b.
export async function setupProvider(onLine, { model = "qwen3.5-9b", port = 11434 } = {}) {
  const qvacBin = which("qvac") || "qvac";
  const steps = [
    ["plugins", "install", "@qvac/openclaw-plugin", "--force"],
    ["plugins", "enable", "qvac"],
    ["config", "set", "plugins.allow", '["qvac"]', "--strict-json"],
    ["config", "set", "plugins.entries.qvac.config", JSON.stringify({ model, qvacCommand: qvacBin, port }), "--strict-json"],
    ["models", "set", `qvac/${model}`],
  ];
  for (const args of steps) {
    onLine("$ openclaw " + args.filter((a) => a !== "--strict-json").join(" "));
    const r = await stream(OC, args, onLine, { timeoutMs: 60000 });
    if (r.code !== 0) { onLine(`(step exited ${r.code}; continuing)`); }
  }
  const st = await setupStatus();
  onLine(st.providerReady ? "QVAC provider is configured." : "provider setup ran, but the provider is not fully ready yet.");
  return st;
}
function which(bin) {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(H, ".local/bin")]) {
    const p = join(dir, bin); if (existsSync(p)) return p;
  }
  return null;
}

// ---- channels: enable/disable OpenClaw's messaging channels (Telegram, Discord, ...) ----
// We NEVER handle secrets: tokens/keys are only reported as "configured" (redacted), and adding a
// token is left to `openclaw onboard` (credential entry stays out of the cockpit). We only flip the
// `enabled` boolean, which is what makes an already-configured channel (e.g. a Telegram bot with a
// token already set) go live.
const SECRETISH = /token|secret|key|password|apikey|api_key|credential/i;
const COMMON_CHANNELS = ["telegram", "whatsapp", "discord", "slack", "signal", "imessage", "sms", "matrix", "msteams", "googlechat"];
export function channels() {
  const cfg = readConfig().channels || {};
  const out = [];
  for (const id of COMMON_CHANNELS) {
    const c = cfg[id];
    const configured = !!c && Object.keys(c).some((k) => SECRETISH.test(k) && c[k]);
    out.push({ id, present: !!c, enabled: !!(c && c.enabled), configured });
  }
  // any other configured channels not in the common list
  for (const id of Object.keys(cfg)) if (!COMMON_CHANNELS.includes(id)) {
    const c = cfg[id]; out.push({ id, present: true, enabled: !!(c && c.enabled), configured: !!c && Object.keys(c).some((k) => SECRETISH.test(k) && c[k]) });
  }
  return out;
}
export function setChannelEnabled(id, on) { return configSet(`channels.${id}.enabled`, !!on, { strictJson: true }); }

// ---- cron: OpenClaw HAS a Gateway cron system (openclaw cron ...). Manage it from the cockpit. ----
function withToken(args) { const t = gatewayToken(); return t ? [...args, "--token", t] : args; }
export async function cronList() {
  const r = await run(withToken(["cron", "list", "--json"]), 12000);
  try { const d = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)); return d.jobs || []; } catch { return []; }
}
export async function cronStatus() {
  const r = await run(withToken(["cron", "status", "--json"]), 10000);
  try { return JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)); } catch { return { scheduler: r.ok ? "unknown" : "down" }; }
}
export async function cronAdd({ cron, message, channel = "last", announce = true, name }) {
  if (!cron || !message) return { ok: false, error: "need a cron expression and a message" };
  const args = ["cron", "add", "--cron", cron, "--message", message, "--channel", channel];
  if (name) args.push("--name", name);
  if (announce) args.push("--announce");
  return run(withToken(args), 20000);
}
export async function cronAction(verb, id) {
  if (!["enable", "disable", "rm", "run"].includes(verb) || !id) return { ok: false, error: "bad cron action" };
  return run(withToken(["cron", verb, id]), 15000);
}

// Is Docker available? OpenClaw's OS-level sandbox (workspaceAccess ro/rw isolation) is Docker-based,
// so the cockpit only offers it when Docker is present; otherwise governance = workspace + tool policy.
export function dockerAvailable() {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo yes || echo no"],
      { timeout: 6000 }, (_e, out) => resolve(String(out).trim() === "yes"));
  });
}
