// Supervises the OpenClaw Gateway (`openclaw gateway`), which the OpenClaw ACP bridge proxies.
// Unlike the serve, the Gateway is OpenClaw-only and optional (Hermes doesn't need it), so this is
// start/stop-on-demand from the Settings panel, not always-on. Status = is port 18789 listening.
// We spawn detached + pidfile so it can outlive a cockpit reload (same rationale as the serve),
// but we also expose an explicit stop for the user.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, openSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".qvac-cockpit");
const PIDFILE = join(DIR, "openclaw-gateway.pid");
const LOG = join(DIR, "openclaw-gateway.log");

export class GatewayManager {
  constructor({ port = 18789, bin = "openclaw" } = {}) {
    this.port = port; this.bin = bin;
  }

  listening() {
    try { return !!execSync(`/usr/sbin/lsof -ti tcp:${this.port} -sTCP:LISTEN 2>/dev/null || true`).toString().trim(); }
    catch { return false; }
  }

  status() {
    const up = this.listening();
    let pid = null;
    try { pid = Number(readFileSync(PIDFILE, "utf8").trim()) || null; } catch { /* */ }
    return { up, pid, port: this.port };
  }

  // Start the gateway if it is not already listening. Resolves once the port is up (or times out).
  async start() {
    if (this.listening()) return this.status();
    mkdirSync(DIR, { recursive: true });
    const out = openSync(LOG, "a");
    const child = spawn(this.bin, ["gateway", "--force"], { detached: true, stdio: ["ignore", out, out] });
    child.on("error", (e) => appendFileSync(LOG, `[cockpit] gateway spawn error: ${e.message}\n`));
    child.unref();
    writeFileSync(PIDFILE, String(child.pid) + "\n");
    appendFileSync(LOG, `\n[cockpit] spawned openclaw gateway pid ${child.pid} @ ${new Date().toISOString()}\n`);
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (this.listening()) break; }
    return this.status();
  }

  stop() {
    // Kill the pidfile process ONLY if it still looks like our gateway (review P1: guard against PID
    // reuse - the recycled pid could be an unrelated process). Then reclaim the port from any
    // listener (safe: only the gateway binds 18789).
    try {
      const pid = Number(readFileSync(PIDFILE, "utf8").trim());
      if (pid) {
        const comm = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`).toString();
        if (/openclaw|node/.test(comm)) process.kill(pid, "SIGTERM");
      }
    } catch { /* */ }
    // -sTCP:LISTEN so we only kill the listener, never a client socket on this port (same self-kill
    // hazard as the serve: a bare lsof would match anything connected to the gateway).
    try { execSync(`/usr/sbin/lsof -ti tcp:${this.port} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true`); } catch { /* */ }
    return { up: false, pid: null, port: this.port };
  }
}
