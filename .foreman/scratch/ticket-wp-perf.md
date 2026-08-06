TASK: Performance pass on the core pipeline: fix the known matcher inefficiency, add benchmark guards, and document measured performance against the project's targets.

EXPECTED OUTCOME: `npm run typecheck`, `npm test`, `npm run lint` pass from repo root (all existing 474+ tests stay green — behavior must NOT change); new benchmark tests + docs/verification/performance.md with real measured numbers. Paste decisive output.

CONTEXT: Read first: docs/architecture/contracts.md; packages/core/src/matching/track-matcher.ts (KNOWN FINDING from blind verification, confirmed at track-matcher.ts:96-101: the matcher computes a full un-hinted projection on EVERY call for hint-disagreement scoring, so hinted search saves nothing — the spec requires no full-track global search while local search is valid); packages/core/src/replay/ (pipeline composition); packages/core/test/geometry/benchmark.test.ts (existing pattern); packages/core/src/controller/ if present (may have landed from a concurrent integration ticket — do not modify it).

CONSTRAINTS: behavior-preserving refactor ONLY in track-matcher.ts (matching semantics and all existing test outcomes unchanged); new benchmarks in packages/core/test/perf/; doc in docs/verification/performance.md. No new deps. Do NOT touch controller/, replay/ (except reading), apps/**, or any other module.

MUST DO:
1. Fix the matcher: full projection only when (a) no previous match, (b) lost mode, or (c) periodic audit every N samples (default 25, configurable) to detect hint divergence; otherwise hinted-window only. Confidence/disagreement semantics preserved (audit sample refreshes the disagreement signal). ALL existing matcher/calibration/replay tests must pass unchanged — if any fails, your refactor changed behavior: fix the refactor, not the test.
2. Benchmarks (vitest, generous thresholds so CI-class machines pass; record actuals in the doc): (a) matcher throughput on the real TMR profile (150-vertex): ≥ 5,000 matches/s sustained over 10,000 samples of a realistic lap (must show ≥ 3× improvement vs. forced-full-search mode — measure both and assert the ratio); (b) full pipeline (runSessionPipeline) 5-lap session wall time < 1 s (exists in replay tests — cross-link, don't duplicate); (c) delta engine onMatch ≥ 20,000 ops/s; (d) memory: process a 3,600-sample session and assert the pipeline result object (JSON size) stays < 5 MB and no per-sample accumulation in matcher internals (inspect exposed state size).
3. docs/verification/performance.md: measured numbers on this machine (state CPU from os.cpus()[0].model), targets table (per-update budget at 1 Hz vs measured, headroom factor), methodology, and honest notes on what is NOT measured (on-device iPhone perf — cross-ref validation checklist).

MUST NOT: change any public API or matching semantics; touch other modules; weaken tests; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, before/after benchmark numbers, commands + pasted results, limitations.

WRITE SET: packages/core/src/matching/track-matcher.ts, packages/core/test/perf/**, packages/core/test/matching/** (additions only), docs/verification/performance.md.
