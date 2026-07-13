// LLM-assisted onboarding: scan the machine for agent harnesses, gather non-secret evidence
// (installed binaries, known config dirs + config keys, whether the binary speaks ACP), then let
// the local model turn that evidence into a plain-language plug plan. Deterministic signatures do
// the heavy lifting (robust); the LLM adds the explanation + can flag an unknown config it finds,
// so a NEW harness is recognizable from its config shape without a code change (Thomas's idea).
//
// SECRET SAFETY: never read ~/.hermes/auth.json, .env, or any value whose key looks like a
// secret. We collect config KEY paths + non-secret scalar values only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

const H = homedir();

// Known harness signatures (2026). Each: how to detect, where the config + base_url live,
// how to probe ACP, and how to find the agent's workspace/stores for the cockpit panes.
const KNOWN = [
  {
    id: "hermes", name: "Hermes Agent", bins: ["hermes"], dirs: [join(H, ".hermes")],
    config: join(H, ".hermes/config.yaml"), format: "yaml",
    baseUrlPath: ["model", "base_url"], modelPath: ["model", "model"],
    acpProbe: (bin) => hasSub(bin, "acp"),
    workspace: () => join(H, ".hermes"),
    stores: ["state.db (sessions, FTS)", "kanban.db", "cron/jobs.json", "memories/*.md", "skills/*/*/SKILL.md"],
  },
  {
    id: "openclaw", name: "OpenClaw", bins: ["openclaw"], dirs: [join(H, ".openclaw")],
    config: join(H, ".openclaw/openclaw.json"), format: "json",
    baseUrlPath: null, // model connection now goes through @qvac/openclaw-plugin (native provider), not a raw base_url
    // VERIFIED 2026-07-05 (drove it E2E): `openclaw acp` (mission-control front-end) is a thin bridge
    // to the OpenClaw GATEWAY, not a standalone agent like `hermes acp`. Preconditions: (1) the
    // Gateway must be running (default ws://127.0.0.1:18789), (2) this device must be paired with
    // operator.admin scope (an unpaired device's admin upgrade goes pending -> conn closes 1008).
    // One-time: `openclaw onboard`. This is SEPARATE from the model connection below.
    acpProbe: (bin) => hasSub(bin, "acp"),
    acpNote: "Mission-control (ACP) bridge runs through the OpenClaw Gateway: needs the Gateway up + this device paired (admin scope). One-time `openclaw onboard`.",
    // Model connection (2026-07-13, SDK 0.15): @qvac/openclaw-plugin registers a native `qvac`
    // provider that owns OpenClaw's localService lifecycle for `qvac serve openai` - no more
    // hand-wiring base_url/:11434 like a generic Ollama endpoint.
    modelPlugin: {
      package: "@qvac/openclaw-plugin",
      note: "Native model connection: `npm install -g openclaw @qvac/openclaw-plugin @qvac/cli @qvac/sdk`, then `openclaw plugins install @qvac/openclaw-plugin && openclaw plugins enable qvac`. Registers provider `qvac` (owns the `qvac serve openai` lifecycle) instead of a manual OpenAI-endpoint base_url.",
    },
    gatewayPort: 18789,
    workspace: () => join(H, ".openclaw"),
    stores: ["skills/*/SKILL.md (same format as Hermes)"],
  },
  {
    id: "opencode", name: "OpenCode", bins: ["opencode"],
    dirs: [join(H, ".config/opencode")],
    config: firstExisting([join(H, ".config/opencode/opencode.json"), join(process.cwd(), "opencode.json")]),
    format: "json", baseUrlPath: null,
    acpProbe: () => false, // OpenCode is the CLIENT, not an ACP agent; use the @qvac/opencode-plugin
    workspace: () => process.cwd(),
    stores: ["opencode.json (project config)"],
  },
  {
    id: "aider", name: "Aider", bins: ["aider"], dirs: [],
    config: firstExisting([join(H, ".aider.conf.yml"), join(process.cwd(), ".aider.conf.yml")]),
    format: "yaml", baseUrlPath: null, acpProbe: () => false,
    workspace: () => process.cwd(), stores: [],
  },
];

function firstExisting(paths) { return paths.find((p) => existsSync(p)) || null; }
function portListening(port) {
  try { return !!execFileSync("/usr/sbin/lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 4000 }).trim(); }
  catch { return false; }
}
function which(bin) {
  for (const dir of [join(H, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const p = join(dir, bin); if (existsSync(p)) return p;
  }
  try { return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
let _lastProbeError = null;
function hasSub(bin, sub) {
  _lastProbeError = null;
  try { const h = execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }); return new RegExp(`\\b${sub}\\b`).test(h); }
  catch (e) { _lastProbeError = String(e.stderr || e.message || e).slice(0, 200); return false; }
}
const SECRET = /key|token|secret|password|passwd|api_?key|credential|seed|private/i;
function redact(obj, depth = 0) {
  if (depth > 4 || obj == null) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof obj === "object") { const o = {}; for (const k of Object.keys(obj).slice(0, 40)) o[k] = SECRET.test(k) ? "<redacted>" : redact(obj[k], depth + 1); return o; }
  if (typeof obj === "string" && obj.length > 200) return obj.slice(0, 200) + "...";
  return obj;
}
function loadConfig(path, format) {
  try {
    const raw = readFileSync(path, "utf8");
    let parsed = null;
    if (format === "json" || (format === "auto" && path.endsWith(".json"))) parsed = JSON.parse(raw);
    else parsed = yaml.load(raw);
    return redact(parsed);
  } catch { return null; }
}
function getPath(obj, path) { return path ? path.reduce((o, k) => (o == null ? o : o[k]), obj) : undefined; }

// ---- deterministic scan ----
export function detectHarnesses() {
  const found = [];
  for (const sig of KNOWN) {
    const bin = sig.bins.map(which).find(Boolean) || null;
    const dir = (sig.dirs || []).find(existsSync) || null;
    const hasConfig = sig.config && existsSync(sig.config);
    if (!bin && !dir && !hasConfig) continue;
    const config = hasConfig ? loadConfig(sig.config, sig.format) : null;
    const acp = bin && sig.acpProbe ? safe(() => sig.acpProbe(bin)) : false;
    const probeError = !acp && bin ? _lastProbeError : null; // e.g. "Node.js v22.19+ is required"
    found.push({
      id: sig.id, name: sig.name,
      installed: !!bin, binPath: bin, configFile: hasConfig ? sig.config : null,
      currentBaseUrl: config ? getPath(config, sig.baseUrlPath) ?? null : null,
      currentModel: config ? getPath(config, sig.modelPath) ?? null : null,
      speaksAcp: acp, probeError,
      acpNote: sig.acpNote || null,
      // For gateway-backed bridges (OpenClaw), report whether the precondition is already met so the
      // UI can say "ready to plug" vs "start the Gateway first" instead of failing at connect time.
      gatewayUp: sig.gatewayPort ? portListening(sig.gatewayPort) : null,
      plugMethod: acp ? "acp" : "openai-endpoint",
      // front-endable = the cockpit can DRIVE it + observe structured events (an ACP server).
      // OpenAI-endpoint clients (OpenCode/Aider/...) have their own UI and no event stream, so the
      // cockpit is not their face; we can only note that their model runs on QVAC serve.
      frontEndable: acp,
      category: acp ? "harness" : "endpoint-client",
      workspace: safe(() => sig.workspace()) || null,
      stores: sig.stores,
      modelPlugin: sig.modelPlugin || null,
      config, // redacted
    });
  }
  // unknown-config sniff: config-looking dirs under ~ we do not recognize
  const unknown = [];
  try {
    for (const e of readdirSync(H, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(".")) continue;
      if (KNOWN.some((s) => s.dirs?.some((d) => d.endsWith(e.name)))) continue;
      if (/agent|claw|coder|\bpi\b|hermes|codex|cline|continue|roo/i.test(e.name)) unknown.push(e.name);
    }
  } catch { /* */ }
  return { found, unknown };
}
function safe(fn) { try { return fn(); } catch { return null; } }

// ---- LLM enrichment: a plain plug plan per harness, + best-guess for unknowns ----
export async function explainPlan({ serveBase, model }, evidence) {
  const found = evidence.found || [];
  const PLAN = {
    acp: (f) => `Plug over ACP: cockpit spawns \`${f.id} acp\` in the workspace and streams structured plan/tool events. Point its config at the QVAC serve (127.0.0.1:11434).`,
    "openai-endpoint": (f) => `Plug over the OpenAI endpoint: point ${f.name}'s base_url at http://127.0.0.1:11434/v1. Model runs locally; structured mission-control events need an ACP/event API this harness may not expose.`,
  };
  const CLIENT_PLAN = (f) => `Detected, but ${f.name} is a coding-agent CLIENT with its own UI, not an ACP harness: the cockpit cannot front-end it. It can run on the same local model via QVAC serve (:11434), but there is no event stream to drive a mission-control view.`;
  const base = found.map((f) => {
    let plan = f.frontEndable ? (PLAN[f.plugMethod] || PLAN["openai-endpoint"])(f) : CLIENT_PLAN(f);
    if (f.acpNote) plan += " " + f.acpNote;
    if (f.gatewayUp === true) plan += " Gateway is up: ready to plug.";
    else if (f.gatewayUp === false) plan += " Gateway is not running yet.";
    if (f.modelPlugin) plan += ` Model connection: ${f.modelPlugin.note}`;
    return { ...f, plan };
  });
  const plugTargets = base.filter((f) => f.frontEndable);   // Hermes / OpenClaw / Pi
  const alsoDetected = base.filter((f) => !f.frontEndable);  // OpenCode / Aider ... (model-local only)
  if (!serveBase || !plugTargets.length) return { plugTargets, alsoDetected, unknown: evidence.unknown, summary: null };
  try {
    const r = await fetch(serveBase + "/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model, max_tokens: 200, messages: [
        { role: "system", content: "You are an onboarding assistant for a local-agent cockpit. Given evidence of installed agent harnesses (redacted, no secrets), write ONE short plain sentence per harness telling the user what was found and how the cockpit will plug it (ACP for structured events, or the OpenAI endpoint for model-only). Be concrete, no fluff. Output one line per harness as `name: sentence`." },
        { role: "user", content: JSON.stringify(plugTargets.map((f) => ({ name: f.name, installed: f.installed, acp: f.speaksAcp, baseUrl: f.currentBaseUrl, workspace: f.workspace }))) },
      ] }),
    }).then((x) => x.json());
    const summary = r.choices?.[0]?.message?.content?.trim() || null;
    return { plugTargets, alsoDetected, unknown: evidence.unknown, summary };
  } catch { return { plugTargets, alsoDetected, unknown: evidence.unknown, summary: null }; }
}
