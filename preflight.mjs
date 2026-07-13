// Preflight: fail fast with ONE actionable message if the runtime can't run the cockpit.
const errs = [];
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) errs.push(`Node ${process.versions.node} is too old. The cockpit needs node:sqlite (Node >= 22.5; 24+ runs it with no flag). Use \`nvm use\` (.nvmrc pins 24) or run with a newer node.`);
try { await import("node:sqlite"); } catch (e) { errs.push(`node:sqlite unavailable: ${e.message}. On Node 22.x it may need --experimental-sqlite; Node 24+ has it stable.`); }
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
const has = (bin) => { try { execFileSync("/usr/bin/which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
if (!has("qvac")) errs.push("`qvac` CLI not on PATH (needed to supervise the model serve).");
if (!existsSync(homedir() + "/.hermes") && !existsSync(homedir() + "/.openclaw")) errs.push("No harness found (~/.hermes or ~/.openclaw). Install Hermes or OpenClaw, or run onboarding.");
if (errs.length) { console.error("PREFLIGHT FAILED:\n- " + errs.join("\n- ")); process.exit(1); }
console.log(`preflight OK: node ${process.versions.node}, node:sqlite present, qvac on PATH.`);
