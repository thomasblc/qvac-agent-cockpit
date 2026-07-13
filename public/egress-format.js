// Pure egress-chip formatter, shared by the browser (app.js) and the audit gate (node ESM).
// INVARIANT (audit P0-04): never emit a zero-byte sovereignty claim without a REAL measured sample.
// - substrate unavailable (nettop can't attribute per-pid)  -> "unmonitored", no byte claim, not live
// - no first-sample timestamp yet                           -> "measuring", no byte claim, not live
// - a real sample of 0 bytes since we started monitoring    -> "0 external bytes since HH:MM" (window-scoped)
// - a real non-zero sample                                  -> substrate KB, not "live"
export function formatEgressChip(data, since) {
  const sub = (data && data.substrate) || {};
  const web = (data && data.agentWeb) || {};
  if (sub.unavailable || typeof sub.bytes !== "number") {
    return {
      text: `egress unmonitored (${sub.pids ?? 0} pids)`, live: false,
      title: "per-pid egress accounting unavailable in this environment; no sovereignty claim made",
    };
  }
  if (!since) {
    return { text: "egress: measuring...", live: false, title: "waiting for the first substrate sample" };
  }
  const text = sub.bytes === 0 ? `0 external bytes since ${since}` : `${(sub.bytes / 1024).toFixed(0)} KB substrate egress`;
  return {
    text, live: sub.bytes === 0,
    title: `substrate (your prompts + model): ${sub.bytes} B. Agent web lane: ${web.unavailable ? "n/a" : (web.bytes ?? 0) + " B"} (separate).`,
  };
}
