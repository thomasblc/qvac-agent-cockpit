// Egress meter, SCOPED to the inference substrate (deep plan): the sovereignty counter measures
// bytes leaving the serve + cockpit + SDK worker pids ONLY ("0 bytes of your prompts to cloud").
// Agent web traffic (hermes) is a SEPARATE labeled lane, never mixed in. nettop per-pid; if it
// can't be parsed truthfully we report "requests observed", never fake bytes.
import { execFile } from "node:child_process";

function pidsFor(pattern) {
  return new Promise((res) => execFile("pgrep", ["-f", pattern], (e, out) => res(e ? [] : out.trim().split("\n").filter(Boolean))));
}
function nettopBytes(pids) {
  if (!pids.length) return Promise.resolve({ ok: false, bytes: 0 });
  // nettop -P (per-process) -x (raw bytes) -L 1 (one sample) -t external (skip loopback)
  return new Promise((res) => execFile("nettop", ["-P", "-x", "-L", "1", "-t", "external", ...pids.flatMap((p) => ["-p", p])], { timeout: 5000 }, (e, out) => {
    if (e) return res({ ok: false, bytes: 0 });
    let bytes = 0, matched = false;
    for (const line of out.split("\n")) {
      const cols = line.trim().split(/,|\s{2,}/).map((s) => s.trim());
      const nums = cols.filter((c) => /^\d+$/.test(c)).map(Number);
      if (nums.length >= 2) { bytes += nums[nums.length - 2] + nums[nums.length - 1]; matched = true; } // bytes_in + bytes_out
    }
    res({ ok: matched, bytes });
  }));
}

export async function sample() {
  // the cockpit process itself IS substrate (audit P0-04): include process.pid.
  const substratePids = [String(process.pid), ...await pidsFor("qvac serve"), ...await pidsFor("qvac/sdk/dist/server/worker")];
  const agentPids = await pidsFor("hermes");
  const sub = await nettopBytes(substratePids);
  const agent = await nettopBytes(agentPids);
  return {
    substrate: sub.ok ? { bytes: sub.bytes, pids: substratePids.length } : { unavailable: true, pids: substratePids.length },
    agentWeb: agent.ok ? { bytes: agent.bytes, pids: agentPids.length } : { unavailable: true, pids: agentPids.length },
  };
}
