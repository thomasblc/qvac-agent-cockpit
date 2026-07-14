// Supervises the persistent `qvac serve openai` on the FIXED port 11434 (Hermes cron fires with
// the cockpit closed, so the endpoint must outlive us: detached child + pidfile, reattach, never
// idle-reap). Spike lesson: a serve can be HALF-dead (models list ok, completions erroring after
// its worker dies) -> health = a real 1-token completion, and unhealthy means restart.
import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DIR = join(homedir(), ".qvac-cockpit");
const PIDFILE = join(DIR, "serve.pid");
const LOG = join(DIR, "serve.log");

export class ServeManager {
  constructor({ port = 11434, model = "qwen3.6-moe", configPath, onState } = {}) {
    this.port = port; this.model = model; this.configPath = configPath;
    this.onState = onState || (() => {});
    this.state = "unknown"; // unknown | healthy | degraded | down | starting
  }
  base() { return `http://127.0.0.1:${this.port}/v1`; }

  async modelsOk() {
    try { const r = await fetch(this.base() + "/models", { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; }
  }
  async completionOk() {
    try {
      const r = await fetch(this.base() + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      });
      const d = await r.json();
      return !!d.choices;
    } catch { return false; }
  }

  _set(state) { if (state !== this.state) { this.state = state; this.onState(state); } }

  // Single-flight: ensure() can run minutes; overlapping calls (the watcher) must not stampede spawns (review P0-1).
  async ensure() {
    if (this._inflight) return this._inflight;
    this._inflight = this._ensureImpl().finally(() => { this._inflight = null; });
    return this._inflight;
  }
  async _ensureImpl() {
    if (await this.modelsOk()) {
      for (let i = 0; i < 3; i++) { if (await this.completionOk()) { this._set("healthy"); return this.state; } } // cold model: retry (review P1-7)
      this._set("degraded"); // half-dead: worker gone under a live HTTP server
      await this._kill();
    } else this._set("down");
    await this._spawn();
    return this.state;
  }

  async _kill() {
    // pidfile kill, but only if that pid still looks like our serve (pid reuse after reboot, review P1-11)
    try {
      const pid = Number(readFileSync(PIDFILE, "utf8").trim());
      if (pid) {
        const comm = (await import("node:child_process")).execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`).toString();
        if (/qvac|node/.test(comm)) process.kill(pid, "SIGKILL");
      }
    } catch { /* */ }
    // reclaim the port from a foreign/half-dead serve too (review P0-2)
    try { (await import("node:child_process")).execSync(`lsof -ti tcp:${this.port} 2>/dev/null | xargs kill -9 2>/dev/null || true`); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 1500));
  }

  async _spawn() {
    mkdirSync(DIR, { recursive: true });
    this._set("starting");
    const args = ["serve", "openai", "-p", String(this.port), "--model", this.model];
    if (this.configPath) args.splice(2, 0, "-c", this.configPath);
    const out = openSync(LOG, "a");
    const child = spawn("qvac", args, { detached: true, stdio: ["ignore", out, out] });
    child.on("error", (e) => { appendFileSync(LOG, `[cockpit] spawn error: ${e.message}\n`); this._set("down"); }); // no listener = process crash (review P0-3)
    child.unref(); // survives the cockpit: cron depends on it
    writeFileSync(PIDFILE, String(child.pid) + "\n");
    appendFileSync(LOG, `\n[cockpit] spawned serve pid ${child.pid} @ ${new Date().toISOString()}\n`);
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 5000)); if (await this.modelsOk()) break; }
    this._set((await this.completionOk()) ? "healthy" : "down");
  }

  // Switch the served model: kill the current serve and respawn with the new --model alias (all
  // aliases are defined in the bundled config with the tools/static settings harnesses need). The
  // serve is shared by any running harness, so a switch affects the whole cockpit. MUST hold the
  // same _inflight mutex ensure() uses (review P1): otherwise the 60s watcher fires mid-respawn,
  // sees the still-loading model as "degraded", and SIGKILLs the serve we just spawned (port
  // contention on the always-on endpoint).
  async setModel(model) {
    if (model === this.model && this.state === "healthy") return this.state;
    if (this._inflight) { try { await this._inflight; } catch { /* */ } }
    this._inflight = (async () => {
      this.model = model;
      await this._kill();
      await this._spawn();
      return this.state;
    })().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  // periodic watch (cheap models check every 60s; full completion check every 10min)
  watch() {
    setInterval(async () => { if (this.state !== "healthy" || !(await this.modelsOk())) await this.ensure(); }, 60000).unref();
    setInterval(() => this.ensure(), 600000).unref();
  }
}
