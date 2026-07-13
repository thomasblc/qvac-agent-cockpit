// P1 gate: text prompt -> ACP frames relayed -> tool one-liner data -> final text.
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8150");
let hello = null, sawToolCall = false, sawStatus = false, finalMsg = null, chunks = 0;
const done = new Promise((res) => {
  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === "hello") { hello = m; ws.send(JSON.stringify({ id: 1, type: "chat", text: "Create a file named p1-gate.txt containing the word cockpit, then reply with just: gate ok" })); }
    if (m.type === "agentStatus") sawStatus = true;
    if (m.type === "acp" && m.update?.sessionUpdate === "tool_call") sawToolCall = true;
    if (m.type === "acp" && m.update?.sessionUpdate === "agent_message_chunk") chunks++;
    if (m.type === "final") { finalMsg = m; res(); }
    if (m.type === "error") { console.log("push error:", m.message); }
  });
});
await Promise.race([done, new Promise((r) => setTimeout(r, 240000))]);
ws.close();
const { existsSync, readFileSync } = await import("fs");
const file = new URL("./workspace/p1-gate.txt", import.meta.url).pathname;
const fileOk = existsSync(file);
console.log("hello:", !!hello, "| status frames:", sawStatus, "| tool_call:", sawToolCall, "| chunks:", chunks);
console.log("final:", finalMsg && finalMsg.stopReason, "| text:", JSON.stringify((finalMsg?.text || "").slice(0, 60)));
console.log("workspace file:", fileOk, fileOk ? JSON.stringify(readFileSync(file, "utf8").slice(0, 20)) : "");
const pass = hello && sawStatus && sawToolCall && finalMsg?.stopReason === "end_turn" && fileOk;
console.log(pass ? "P1 GATE PASS" : "P1 GATE FAIL");
process.exit(pass ? 0 : 1);
