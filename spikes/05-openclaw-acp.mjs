// Prove the parameterized AcpClient can DRIVE OpenClaw (not just detect it): spawn `openclaw acp`,
// initialize, read its capabilities. Full turn needs OpenClaw pointed at qvac serve; this proves
// the connect path (audit P1-01: multi-harness was detection-only).
import { AcpClient } from "../server/acp-client.js";
const c = new AcpClient({ bin: "openclaw", acpArgs: ["acp"], harnessId: "openclaw", cwd: "/tmp", onEvent: () => {} });
let stderr = "";
c.on("stderr", (d) => { stderr += d; });
c.on("exit", (code) => { if (code && String(code).includes("spawn")) { console.log("spawn failed:", code); process.exit(1); } });
try {
  const info = await Promise.race([c.connect(), new Promise((_, r) => setTimeout(() => r(new Error("connect timeout")), 30000))]);
  console.log("OpenClaw connected:", JSON.stringify(info.agent), "| capabilities:", JSON.stringify(c.capabilities));
  console.log("CONNECT OK: the cockpit can drive OpenClaw over ACP");
  c.stop();
  process.exit(0);
} catch (e) {
  console.log("connect failed:", e.message);
  console.log("stderr:", stderr.slice(0, 300));
  c.stop();
  process.exit(2);
}
