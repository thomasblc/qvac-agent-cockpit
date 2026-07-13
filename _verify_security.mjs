// Security regression tests for the audit P0 fixes (pure/mocked, no live agent, no user-file writes).
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeFile, safeWriteFile, underRoot } from "./server/safe-path.js";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.log("  FAIL " + name + " :: " + e.message); } };
const expectThrow = (fn, why) => { let threw = false; try { fn(); } catch { threw = true; } if (!threw) throw new Error("expected throw: " + why); };

const root = mkdtempSync(join(tmpdir(), "cockpit-sec-"));
const outside = mkdtempSync(join(tmpdir(), "cockpit-outside-"));
writeFileSync(join(root, "ok.md"), "# ok\nbody\n");
writeFileSync(join(outside, "secret.md"), "TOP SECRET\n");

// P0-02 jail:
t("plain in-jail file resolves", () => { const r = assertSafeFile(join(root, "ok.md"), [root]); if (!r.endsWith("ok.md")) throw new Error("bad resolve"); });
t("symlink to an outside file is rejected", () => { const link = join(root, "pwn.md"); symlinkSync(join(outside, "secret.md"), link); expectThrow(() => assertSafeFile(link, [root]), "symlink"); });
t("hardlink (nlink>1) is rejected", () => { const hl = join(root, "hard.md"); linkSync(join(root, "ok.md"), hl); expectThrow(() => assertSafeFile(hl, [root]), "hardlink"); });
t("sibling-prefix path does NOT pass as in-jail (workspace-evil vs workspace)", () => { const evil = root + "-evil"; mkdirSync(evil, { recursive: true }); writeFileSync(join(evil, "x.md"), "x"); if (underRoot(join(evil, "x.md"), [root])) throw new Error("prefix escape"); });
t("safeWriteFile refuses to write through a symlink", () => { const link = join(root, "pwn2.md"); symlinkSync(join(outside, "secret.md"), link); expectThrow(() => safeWriteFile(link, "HACKED", [root]), "write via symlink"); if (readFileSync(join(outside, "secret.md"), "utf8").includes("HACKED")) throw new Error("outside file was overwritten!"); });
t("safeWriteFile writes a fresh in-jail regular file", () => { const fresh = join(root, "fresh.md"); writeFileSync(fresh, "# fresh\n"); safeWriteFile(fresh, "# fresh\nEDITED\n", [root]); if (!readFileSync(fresh, "utf8").includes("EDITED")) throw new Error("write failed"); });

// P0-03 permission logic (pure): mirror the client's decision table
function decide(handlerResult, opts, hasHandler) {
  if (handlerResult) return { outcome: "selected", optionId: handlerResult };
  const reject = opts.find((o) => /reject|deny/i.test(o.optionId + " " + (o.kind || "")));
  if (hasHandler) return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}
const OPTS = [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "allow_always", kind: "allow_always" }, { optionId: "reject_once", kind: "reject_once" }];
t("human allow is honored", () => { if (decide("allow_once", OPTS, true).optionId !== "allow_once") throw new Error("x"); });
t("timeout (null) picks reject, never allow", () => { const d = decide(null, OPTS, true); if (/allow/.test(d.optionId || "")) throw new Error("AUTO-ALLOWED"); if (d.optionId !== "reject_once") throw new Error("expected reject"); });
t("allow-only options + null -> cancelled, never allow", () => { const d = decide(null, [{ optionId: "allow_once", kind: "allow_once" }], true); if (d.outcome !== "cancelled") throw new Error("expected cancelled, got " + JSON.stringify(d)); });


// P1-01 multi-harness: connect-failure hints map to actionable operator fixes (OpenClaw gateway/pairing).
import { AcpClient } from "./server/acp-client.js";
t("OpenClaw no-gateway -> 'start the Gateway' hint", () => { const h = AcpClient.hintFor("openclaw", "ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789"); if (!/Gateway is not running|Start it/i.test(h || "")) throw new Error("got: " + h); });
t("OpenClaw unpaired -> 'pair this device' hint", () => { const h = AcpClient.hintFor("openclaw", "scope upgrade pending approval; pairing-required operator.admin"); if (!/paired|onboard/i.test(h || "")) throw new Error("got: " + h); });
t("missing binary -> 'not found on PATH' hint", () => { const h = AcpClient.hintFor("pi", "spawn-error: ENOENT"); if (!/not found on PATH/i.test(h || "")) throw new Error("got: " + h); });
t("clean Hermes stderr -> no false hint", () => { if (AcpClient.hintFor("hermes", "some benign log line") !== null) throw new Error("hinted on benign"); });


// P0-04 egress display state: never claim "0 bytes" without a real measured sample.
import { formatEgressChip } from "./public/egress-format.js";
t("unavailable substrate -> 'unmonitored', never a 0-byte claim", () => { const v = formatEgressChip({ substrate: { unavailable: true, pids: 3 } }, "14:03"); if (/0 external bytes|0 bytes to cloud/.test(v.text)) throw new Error("false claim: " + v.text); if (!/unmonitored/.test(v.text) || v.live) throw new Error("got: " + JSON.stringify(v)); });
t("available but NO first-sample timestamp -> 'measuring', no 0 claim", () => { const v = formatEgressChip({ substrate: { bytes: 0 } }, null); if (/0 external bytes/.test(v.text)) throw new Error("claimed before a sample: " + v.text); if (v.live) throw new Error("live before sample"); });
t("real 0-byte sample within a window -> window-scoped claim, live", () => { const v = formatEgressChip({ substrate: { bytes: 0 }, agentWeb: { bytes: 0 } }, "14:03"); if (v.text !== "0 external bytes since 14:03" || !v.live) throw new Error("got: " + JSON.stringify(v)); });
t("non-zero substrate -> KB, not live, no false 0", () => { const v = formatEgressChip({ substrate: { bytes: 4096 } }, "14:03"); if (/0 external bytes/.test(v.text) || v.live) throw new Error("got: " + JSON.stringify(v)); if (!/KB/.test(v.text)) throw new Error("expected KB: " + v.text); });
t("no phrasing ever contains the banned 'bytes to cloud' claim", () => { for (const d of [{ substrate: { unavailable: true } }, { substrate: { bytes: 0 } }, { substrate: { bytes: 9 } }]) { if (/bytes to cloud/.test(formatEgressChip(d, "14:03").text)) throw new Error("banned phrase"); } });

// P1-05 scale degrade: buildGraph disables the O(N^2) semantic pass above the threshold, visibly.
import { buildGraph, SEMANTIC_MAX } from "./server/brain.js";
t("SEMANTIC_MAX is a sane positive bound", () => { if (!(SEMANTIC_MAX > 0 && SEMANTIC_MAX <= 100000)) throw new Error("bad bound: " + SEMANTIC_MAX); });
t("buildGraph returns the semantic-state fields (disabled flag + reason slot)", () => { const g = buildGraph(process.env.HOME + "/.hermes"); if (!("semanticDisabled" in g) || !("nodes" in g) || !("edges" in g)) throw new Error("missing scale-state fields: " + Object.keys(g).join(",")); if (g.semanticDisabled && !g.semanticReason) throw new Error("disabled without a reason string"); });

rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(root + "-evil", { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
