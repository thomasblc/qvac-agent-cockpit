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

// Is Docker available? OpenClaw's OS-level sandbox (workspaceAccess ro/rw isolation) is Docker-based,
// so the cockpit only offers it when Docker is present; otherwise governance = workspace + tool policy.
export function dockerAvailable() {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo yes || echo no"],
      { timeout: 6000 }, (_e, out) => resolve(String(out).trim() === "yes"));
  });
}
