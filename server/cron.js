// Schedule pane backend: read cron jobs from jobs.json (main + profiles), scheduler liveness
// from the ticker heartbeat, one-liners cached in cockpit.db, mutations via the hermes CLI
// (v1 never hand-writes jobs.json: the flock is fcntl-based, node has no native flock).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { cronSummary, setCronSummary } from "./files.js";

const H = homedir();
const HERMES = H + "/.local/bin/hermes";

function readJobsFile(p, profile) {
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    return (d.jobs || []).map((j) => ({ ...j, profile }));
  } catch { return []; }
}
export function listJobs() {
  const jobs = readJobsFile(join(H, ".hermes/cron/jobs.json"), "main");
  const prof = join(H, ".hermes/profiles");
  if (existsSync(prof)) for (const p of readdirSync(prof)) jobs.push(...readJobsFile(join(prof, p, "cron/jobs.json"), p));
  return jobs;
}
export function tickerAlive() {
  try {
    const t = Number(readFileSync(join(H, ".hermes/cron/ticker_heartbeat"), "utf8").trim());
    const ageS = (Date.now() / 1000) - t;
    return { alive: ageS < 120, ageS: Math.round(ageS) };
  } catch { return { alive: false, ageS: null }; }
}
const jobHash = (j) => createHash("sha256").update(String(j.id) + "|" + String(j.prompt || j.script || "")).digest("hex").slice(0, 16);

// One-liner per job, generated once by the local serve, cached in cockpit.db.
// Return jobs immediately with cached one-liners; generate the missing ones in the BACKGROUND
// (a fresh serve summary is a ~10-45s call; N serial would freeze the pane on first open, review P1).
export function jobsWithSummaries({ serveBase, model, onSummary } = {}) {
  const jobs = listJobs();
  const missing = [];
  for (const j of jobs) { const h = jobHash(j); j.oneliner = cronSummary(h); if (!j.oneliner && (j.prompt || j.script)) missing.push({ j, h }); }
  if (missing.length && serveBase) (async () => {
    for (const { j, h } of missing) {
      try {
        const r = await fetch(serveBase + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(45000),
          body: JSON.stringify({ model, max_tokens: 40, messages: [
            { role: "system", content: "Explain in ONE short plain-language sentence what this scheduled job does. Output only the sentence." },
            { role: "user", content: (j.name ? j.name + ": " : "") + String(j.prompt || j.script).slice(0, 1200) },
          ] }),
        }).then((x) => x.json());
        const s = r.choices?.[0]?.message?.content?.trim()?.split("\n")[0];
        if (s) { setCronSummary(h, s); onSummary?.(j.id, s); }
      } catch { /* try again next open */ }
    }
  })();
  return jobs;
}

// Mutations via the CLI only. Allowed verbs are a fixed set.
const VERBS = new Set(["pause", "resume", "remove", "run"]);
export function cronAction(verb, jobId, profile = "main") {
  if (!VERBS.has(verb)) return Promise.reject(new Error("verb not allowed"));
  // v1 safety (audit P1-06): the hermes CLI runs against the MAIN profile, so mutating a job that
  // lives in a named profile store could hit the wrong job or fail. Until profile flags are wired,
  // only main-profile jobs are mutable; others are read-only in the UI.
  if (profile && profile !== "main") return Promise.reject(new Error(`job lives in profile "${profile}"; mutate it from that profile (read-only here for now)`));
  return new Promise((res, rej) => {
    execFile(HERMES, ["cron", verb, String(jobId)],
      { timeout: 30000 }, (err, stdout, stderr) => err ? rej(new Error((stderr || err.message).slice(0, 200))) : res({ ok: true, out: stdout.slice(0, 200) }));
  });
}
