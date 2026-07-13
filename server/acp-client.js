// ACP client: one `hermes acp` child per workspace, JSON-RPC 2.0 over newline-delimited stdio.
// Spike-proven (spikes/EVIDENCE.md): initialize -> authenticate(custom) -> session/new -> prompt;
// answer session/request_permission or the agent stalls; session/cancel yields stopReason
// "cancelled"; session/load replays history. GOTCHAS ENCODED HERE:
//  - spawn with child cwd = the workspace (hermes resolves file tools against the PROCESS cwd,
//    not the session/new cwd param),
//  - tool_call_update can be missing for a tool_call: consumers key by toolCallId and tolerate,
//  - session_info_update may carry _meta.hermes.sessionProvenance: rebind the active sessionId.
import { spawn } from "child_process";
import { EventEmitter } from "events";

export class AcpClient extends EventEmitter {
  constructor({ bin = process.env.HOME + "/.local/bin/hermes", acpArgs = ["acp"], harnessId = "hermes", cwd, onEvent } = {}) {
    super();
    this.bin = bin;
    this.acpArgs = acpArgs;
    this.harnessId = harnessId;
    this.capabilities = { loadSession: false, plan: false, permission: false }; // filled at connect + as events arrive
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.alive = false;
    this.turnActive = false;
    this._buf = "";
    this._stderrTail = ""; // last stderr, for actionable connect-failure hints
    this._permissionHandler = null; // set by the server: async (req) => optionId
  }

  // Map a harness-specific connect failure (from the child's stderr) to a one-line operator fix.
  // Encodes the VERIFIED per-harness preconditions found driving each bridge (audit: multi-harness).
  static hintFor(harnessId, stderrTail = "") {
    const s = String(stderrTail);
    if (harnessId === "openclaw") {
      // `openclaw acp` is a thin bridge to the OpenClaw Gateway; it needs (1) the Gateway running and
      // (2) THIS device paired with operator.admin scope (verified 2026-07-05: an unpaired device's
      // admin upgrade goes pending -> conn closes 1008).
      if (/ECONNREFUSED|gateway connect failed|closed before connect/i.test(s) && !/scope|pending|pairing/i.test(s))
        return "OpenClaw's Gateway is not running. Start it (`openclaw gateway`) or run `openclaw onboard`, then reconnect.";
      if (/scope upgrade pending|pairing-required|operator\.admin/i.test(s))
        return "OpenClaw needs this device paired with admin scope for the ACP bridge. Run `openclaw onboard` (or approve the pending device), then reconnect.";
    }
    if (/spawn-error|ENOENT/i.test(s)) return `The '${harnessId}' binary was not found on PATH.`;
    return null;
  }

  start() {
    if (this.child) return;
    this.child = spawn(this.bin, this.acpArgs, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.on("error", (e) => { this.alive = false; this.emit("exit", "spawn-error: " + e.message); }); // review P0-3
    this.child.stdin.on("error", () => { /* EPIPE after exit: ignore */ });
    this.alive = true;
    this.child.stdout.on("data", (d) => this._feed(d.toString()));
    this.child.stderr.on("data", (d) => { const s = d.toString(); this._stderrTail = (this._stderrTail + s).slice(-2000); this.emit("stderr", s); });
    this.child.on("exit", (code) => {
      this.alive = false; this.child = null;
      for (const p of this.pending.values()) p.rej(new Error("acp exited " + code));
      this.pending.clear();
      this.emit("exit", code);
    });
  }

  stop() { try { this.child?.kill(); } catch { /* */ } }

  _send(obj) { this.child?.stdin.write(JSON.stringify(obj) + "\n"); }

  _rpc(method, params, timeoutMs = 15 * 60 * 1000) {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(method + " timed out")); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); }, method });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  _feed(chunk) {
    this._buf += chunk;
    let i;
    while ((i = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, i); this._buf = this._buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      this._route(m);
    }
  }

  async _route(m) {
    // reply to one of our requests
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? p.rej(new Error(p.method + ": " + JSON.stringify(m.error).slice(0, 300))) : p.res(m.result);
      return;
    }
    // notification: session update stream
    if (m.method === "session/update") {
      const u = m.params?.update || {};
      if (u.sessionUpdate === "plan") this.capabilities.plan = true;
      const prov = u.sessionUpdate === "session_info_update" && u._meta?.hermes?.sessionProvenance;
      if (prov?.newSessionId) this.sessionId = prov.newSessionId; // rotation: rebind or history forks
      this.onEvent(u, m.params);
      return;
    }
    // agent -> client request: permissions (must answer or the tool stalls)
    if (m.method === "session/request_permission") {
      this.capabilities.permission = true;
      const opts = m.params?.options || [];
      let optionId = null;
      if (this._permissionHandler) { try { optionId = await this._permissionHandler(m.params); } catch { /* */ } }
      // SAFETY (audit P0-03): with a human gate installed, NEVER auto-allow. If the gate returns
      // null (timeout/no-reject/cancel), pick an explicit reject option; if none exists, answer the
      // protocol-level `cancelled` outcome. An allow is only ever sent when the human chose one.
      if (optionId) {
        this._send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId } } });
        this.onEvent({ sessionUpdate: "permission_answered", optionId, title: m.params?.toolCall?.title }, m.params);
      } else if (this._permissionHandler) {
        const reject = opts.find((o) => /reject|deny/i.test(o.optionId + " " + (o.kind || "")));
        if (reject) { this._send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: reject.optionId } } }); this.onEvent({ sessionUpdate: "permission_answered", optionId: reject.optionId, denied: true }, m.params); }
        else { this._send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } }); this.onEvent({ sessionUpdate: "permission_answered", cancelled: true }, m.params); }
      } else {
        // no handler at all (headless): default deny, not allow
        const reject = opts.find((o) => /reject|deny/i.test(o.optionId + " " + (o.kind || "")));
        this._send({ jsonrpc: "2.0", id: m.id, result: reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } } });
      }
      return;
    }
    // anything else the agent asks: acknowledge empty (spike: nothing critical arrives here)
    if (m.method && m.id !== undefined) this._send({ jsonrpc: "2.0", id: m.id, result: {} });
  }

  setPermissionHandler(fn) { this._permissionHandler = fn; }

  async connect() {
    this.start();
    let init;
    try {
      init = await this._rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, 30000);
    } catch (e) {
      // A bridge that dies during handshake (e.g. OpenClaw with no Gateway/pairing) surfaces the real
      // cause on stderr; attach a harness-specific fix so the UI shows an action, not "acp exited 1".
      const hint = AcpClient.hintFor(this.harnessId, this._stderrTail);
      if (hint) { e.hint = hint; e.message = hint + " (" + String(e.message) + ")"; }
      throw e;
    }
    this.agentInfo = init.agentInfo || {};
    const ac = init.agentCapabilities || {};
    this.capabilities.loadSession = !!ac.loadSession;
    this.capabilities.plan = ac.plan ?? null;         // many agents advertise nothing; observed events fill this
    this.capabilities.permission = ac.permission ?? null;
    this._authMethods = init.authMethods || [];
    if ((init.authMethods || []).some((a) => a.id === "custom")) {
      try { await this._rpc("authenticate", { methodId: "custom" }, 30000); } catch { /* some builds auth implicitly */ }
    }
    const ns = await this._rpc("session/new", { cwd: this.cwd, mcpServers: [] }, 60000);
    this.sessionId = ns.sessionId;
    return { agent: this.agentInfo, sessionId: this.sessionId };
  }

  async prompt(text) {
    if (!this.sessionId) throw new Error("no session");
    this.turnActive = true;
    try { return await this._rpc("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }); }
    catch (e) { if (/timed out/.test(String(e.message))) this.cancel(); throw e; } // desync guard (review P1-9)
    finally { this.turnActive = false; }
  }

  cancel() {
    if (this._onCancel) { try { this._onCancel(); } catch { /* */ } } // resolve pending permission cards as cancelled (server)
    if (this.sessionId) this._send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }
  setCancelHook(fn) { this._onCancel = fn; }

  async loadSession(sessionId) {
    const r = await this._rpc("session/load", { sessionId, cwd: this.cwd, mcpServers: [] }, 120000);
    this.sessionId = sessionId;
    return r;
  }
}
