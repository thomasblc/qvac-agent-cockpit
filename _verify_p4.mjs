import WebSocket from "ws";
import { readFileSync } from "fs";
const ws = new WebSocket("ws://localhost:8150");
let nextId = 1; const pending = new Map();
const rpc = (type, extra = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, type, ...extra })); });
await new Promise((r) => ws.on("open", r));
ws.on("message", (buf, isBin) => { if (isBin) return; let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const idx = await rpc("brain.index", {});
console.log("index:", JSON.stringify(idx.data));
const g = await rpc("brain.graph", {});
console.log("graph:", g.data?.nodes?.length, "nodes,", g.data?.edges?.length, "edges (semantic:", g.data?.edges?.filter((e) => e.kind === "embed").length + ")");
const scan = await rpc("brain.scan", { scope: "Documents/PRO/QVAC/QVAC-agent/test/28-agent-cockpit/workspace" });
console.log("scan:", scan.data?.scanned, "judged ->", scan.data?.candidates?.length, "proposals");
for (const c of (scan.data?.candidates || []).slice(0, 3)) console.log(`  [${c.score}] ${c.a} <-> ${c.b} (${c.reason})`);
const pair = (scan.data?.candidates || []).find((c) => /aurora|marco/.test(c.a + c.b));
let linkOk = false;
if (pair) {
  const acc = await rpc("brain.accept", { a: pair.a, b: pair.b });
  const content = readFileSync(process.env.HOME + "/" + pair.a, "utf8");
  linkOk = acc.ok && content.includes("## Related");
  console.log("accept:", acc.ok, "| link in doc:", linkOk);
}
const files = await rpc("files.list", {});
const seeded = (files.data?.files || []).find((f) => f.id.endsWith("coffee-ritual.md"));
console.log("files:", files.data?.files?.length, "| coffee state:", seeded?.reviewState);
let reviewOk = false;
if (seeded) {
  await rpc("files.review", { fileId: seeded.id });
  await rpc("files.write", { fileId: seeded.id, content: "# Coffee ritual\nEDITED BY AGENT\n" });
  const rd = await rpc("files.read", { fileId: seeded.id });
  reviewOk = rd.data?.changed === true && !!rd.data?.baseline;
  console.log("diff-first: changed =", rd.data?.changed, "| baseline present =", !!rd.data?.baseline);
  await rpc("files.revert", { fileId: seeded.id });
  const back = await rpc("files.read", { fileId: seeded.id });
  console.log("revert restores:", !back.data.changed);
}
const pass = idx.ok && g.data?.nodes?.length >= 4 && (scan.data?.candidates?.length ?? 0) >= 1 && !!pair && linkOk && reviewOk;
console.log(pass ? "P4 GATE PASS" : "P4 GATE FAIL");
ws.close(); process.exit(pass ? 0 : 1);
