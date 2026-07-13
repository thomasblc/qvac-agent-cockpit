// P0 spike 02: full ACP round-trip against `hermes acp`.
import { spawn } from "child_process";
import { appendFileSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, "scratch"); mkdirSync(SCRATCH, { recursive: true });
const EVID = join(HERE, "evidence-acp-events.jsonl"); writeFileSync(EVID, "");
const child = spawn(process.env.HOME + "/.local/bin/hermes", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1;
const pending = new Map();
const hist = {}; // sessionUpdate histogram
let sessionId = null, permissionsAnswered = 0, cancelled = null, replayChunks = 0, stops = [];
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const rpc = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej, method }); send({ jsonrpc: "2.0", id, method, params }); });
child.stderr.on("data", (d) => appendFileSync(join(HERE, "acp-stderr.log"), d));
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    appendFileSync(EVID, line + "\n");
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(p.method + ": " + JSON.stringify(m.error).slice(0, 200))) : p.res(m.result); }
      continue;
    }
    if (m.method === "session/update") {
      const u = m.params?.update || {};
      hist[u.sessionUpdate] = (hist[u.sessionUpdate] || 0) + 1;
      if (u.sessionUpdate === "agent_message_chunk" && phase === "replay") replayChunks++;
    } else if (m.method === "session/request_permission") {
      const opts = m.params?.options || [];
      const allow = opts.find((o) => /allow|approve|yes/i.test(o.optionId + " " + (o.name || "") + " " + (o.kind || ""))) || opts[0];
      permissionsAnswered++;
      send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    } else if (m.method && m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} }); // any other agent->client request: empty ok
    }
  }
});
let phase = "run";
const t0 = Date.now();
const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
console.log("init ok:", init.agentInfo?.name, init.agentInfo?.version);
try { if ((init.authMethods || []).some((a) => a.id === "custom")) await rpc("authenticate", { methodId: "custom" }); console.log("auth ok"); } catch (e) { console.log("auth skipped:", e.message.slice(0, 80)); }
const ns = await rpc("session/new", { cwd: SCRATCH, mcpServers: [] });
sessionId = ns.sessionId; console.log("session:", sessionId);
const r1 = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Create a file named hello.txt in the current directory containing exactly the word hello. Then say done." }] });
stops.push(r1.stopReason); console.log("turn1 stop:", r1.stopReason, "| elapsed", ((Date.now() - t0) / 1000).toFixed(0) + "s");
const fileOk = existsSync(join(SCRATCH, "hello.txt"));
console.log("hello.txt exists:", fileOk, fileOk ? "| content: " + JSON.stringify(readFileSync(join(SCRATCH, "hello.txt"), "utf8").slice(0, 20)) : "");
// turn 2 + mid-stream cancel
const p2 = rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Count slowly from one to fifty, one number per line." }] });
setTimeout(() => send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }), 4000);
const r2 = await p2.catch((e) => ({ stopReason: "error:" + e.message.slice(0, 60) }));
cancelled = r2.stopReason; console.log("turn2 stop (expect cancelled):", cancelled);
// replay
phase = "replay";
try { await rpc("session/load", { sessionId, cwd: SCRATCH, mcpServers: [] }); console.log("session/load ok, replayed agent chunks:", replayChunks); }
catch (e) { console.log("session/load FAILED:", e.message.slice(0, 120)); }
console.log("histogram:", JSON.stringify(hist));
console.log("permissions answered:", permissionsAnswered);
const pass = fileOk && stops[0] === "end_turn" && cancelled === "cancelled";
console.log(pass ? "SPIKE02 PASS" : "SPIKE02 PARTIAL (see above)");
child.kill(); process.exit(0);
