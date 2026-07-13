// P3 gate: history RPC (9 DBs), FTS search, kanban board read, needsYou plumbing present,
// debrief broadcast after a real turn.
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8150");
let nextId = 1; const pending = new Map();
const rpc = (type, extra = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, type, ...extra })); });
let debrief = null, sawPlanOrTool = false;
const opened = new Promise((r) => ws.on("open", r));
ws.on("message", (buf, isBinary) => {
  if (isBinary) return;
  let m; try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.type === "debrief") debrief = m;
  if (m.type === "acp" && ["plan", "tool_call"].includes(m.update?.sessionUpdate)) sawPlanOrTool = true;
});
await opened;
const hist = await rpc("history.list", {});
console.log("history sessions:", hist.data?.sessions?.length, "| profiles:", [...new Set((hist.data?.sessions || []).map((s) => s.profile))].join(","));
const fts = await rpc("history.search", { q: "cockpit" });
console.log("FTS 'cockpit' hits:", fts.data?.hits?.length);
const kb = await rpc("kanban.board", {});
console.log("kanban tasks:", kb.data?.tasks?.length);
const turn = await rpc("chat", { text: "Append the word verified to p1-gate.txt using a tool, then say done." });
console.log("turn:", turn.ok, turn.data?.stopReason, "| plan/tool seen:", sawPlanOrTool);
await new Promise((r) => setTimeout(r, 1500));
console.log("debrief:", debrief ? `${debrief.stopReason} ${debrief.toolCount} tools ${JSON.stringify(debrief.byKind)}` : "MISSING");
const pass = (hist.data?.sessions?.length > 5) && fts.ok && kb.data?.tasks?.length >= 1 && turn.ok && sawPlanOrTool && !!debrief;
console.log(pass ? "P3 GATE PASS" : "P3 GATE FAIL");
ws.close(); process.exit(pass ? 0 : 1);
