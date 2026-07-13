# P0 spike evidence (2026-07-03, run by Fable inline)

## Spike 01: serve substrate. PASS
- Found the 7-day-old `qvac serve` on 11434 BROKEN (GET /v1/models fine, completions = internal_error: its SDK worker had been killed by unrelated worker cleanups). Restarted it under cockpit supervision: `~/.qvac-cockpit/serve.pid` + serve.log, same hermes-demo config, model qwen3.6-moe. Completion verified ("OK"). This failure IS the argument for the plan's supervision policy (liveness watch + auto-restart in P1's serve-manager).
- `QvacManagedOptions` (ai-sdk-provider 0.2.2) DOES support `servePort` (pinned; reuse defaults false when pinned) + `serveIdleTimeout`. Managed mode is viable for fresh machines; the supervised direct-run stays the v1 default for full lifecycle control.

## Spike 02: ACP round-trip. PASS (1 caveat)
- initialize -> authenticate(custom) -> session/new -> prompt: stopReason `end_turn` in 37s.
- Event histogram: tool_call x2, tool_call_update x1, agent_message_chunk x2, user_message_chunk x2, usage_update x3, available_commands_update x1.
- `session/request_permission` received (options allow_once/deny), answered allow_once, the write tool proceeded to completed.
- hello.txt written with the right content. CAVEAT: it landed in the PROCESS cwd (spikes/), not the session/new `cwd` param (scratch/). Cockpit rule: spawn `hermes acp` with child_process `cwd` = the workspace; do not rely on the session cwd param for file-tool base paths.
- Mid-stream `session/cancel` -> stopReason `cancelled`. `session/load` replayed history (agent chunks re-streamed).
- Full wire log: `evidence-acp-events.jsonl`; stderr: `acp-stderr.log`.

## Spike 03: coexistence. PASS
- In ONE fresh process: Parakeet 15.6s cold load, Supertonic EN 0.2s, EmbeddingGemma 6.7s; synth (65744 samples) + embed (dim 768) instant; the serve answered a completion DURING residency. No worker conflict (the advisory ~/.qvac lock tolerates the multi-process setup).

## Spike 04: stores. PASS
- kanban.db copy-to-tmp (db + wal) + open + count: **6ms** (322 task_events, 49 tasks). Poll strategy validated; no immutable-snapshot staleness.
- FTS MATCH across all 9 state.dbs (main + 8 profiles): **17ms** total, all opened read-only while the gateway runs. No background index needed for v1.

## Verdict: GO for P1
Watchouts carried into P1: (1) serve-manager must health-check completions (not just /v1/models) and auto-restart, (2) acp child cwd rule above, (3) tool_call_update count can be lower than tool_call (dedupe by toolCallId, tolerate missing updates).
