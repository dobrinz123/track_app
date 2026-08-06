# Core pipeline performance verification

Measured 2026-08-06 on an Intel(R) Core(TM) Ultra 9 285H (16 logical CPUs), Windows
10.0.26200 x64, Node.js v24.18.0. Tests ran from the repository root without coverage
instrumentation.

## Results and targets

The application receives foreground GNSS fixes at approximately 1 Hz, so one update has a
1,000 ms wall-time budget. Throughput-derived per-update values below are single-threaded CPU
time on this machine; headroom is `1,000 ms / measured per-update time`.

| Component                             |                           Guard target |                 Measured | Time per update | 1 Hz headroom |
| ------------------------------------- | -------------------------------------: | -----------------------: | --------------: | ------------: |
| Track matcher, 150-vertex TMR profile | >=5,000 matches/s and >=3x forced-full | 388,047 matches/s, 3.86x |      0.00258 ms |      388,047x |
| Full production pipeline              |                 Five laps in <1,000 ms |   459 samples in 2.35 ms |      0.00512 ms |      195,319x |
| `LiveDeltaEngine.onMatch`             |                         >=20,000 ops/s |          2,022,433 ops/s |     0.000494 ms |    2,022,433x |

The five-lap batch itself has approximately 426x headroom against its 1,000 ms regression
limit. That guard remains in
[`replay-harness.integration.test.ts`](../../packages/core/test/replay/replay-harness.integration.test.ts)
(`processes a roughly 400-sample five-lap session in under one second`); it is cross-referenced
rather than duplicated in the performance test suite.

| Resource guard                                  |                         Target |                                                          Measured |
| ----------------------------------------------- | -----------------------------: | ----------------------------------------------------------------: |
| Serialized 3,600-sample `SessionPipelineResult` |                         <5 MiB |                                                          0.72 MiB |
| Matcher mutable state after 3,600 samples       | Constant-size; no sample array | 586 bytes (one-sample state was measured separately by the guard) |

## Matcher before and after

The comparison uses the same 10,000-sample, noise-free kinematic lap over the checked-in real
Transilvania Motor Ring profile (150 vertices). `auditIntervalSamples: 1` is the forced-full
control: it performs the global disagreement projection for every valid hinted match. The
production default is 25.

| Mode                                   | Median wall time |        Throughput |
| -------------------------------------- | ---------------: | ----------------: |
| Forced global audit every sample       |         99.57 ms | 100,432 matches/s |
| Periodic global audit every 25 samples |         25.77 ms | 388,047 matches/s |
| Improvement                            |        **3.86x** |         **3.86x** |

Between global audits, matching uses only the hinted window and retains the most recently
audited hint-disagreement value for confidence scoring. No-history and lost-mode updates still
perform a full projection. The matcher-local hinted projection operates on the already
validated runtime profile; a 500-update equivalence test compares its distance and lateral
outputs exactly with the canonical geometry projection helper.

## Methodology

- Matcher: generate one deterministic TMR lap at 125 Hz, take 10,000 samples, warm each mode
  with 1,000 samples, then alternate three timed runs per mode and report the median. A checksum
  equality assertion ensures both modes process equivalent projection results.
- Full pipeline: use the existing seed-118 five-lap replay fixture, warm it five times, then
  report the median of seven complete `runSessionPipeline` calls. The committed integration
  guard independently asserts the same fixture completes five laps in under one second.
- Delta: warm 5,000 calls, then time 100,000 `onMatch` calls against a complete 10 m reference
  grid.
- Memory: process exactly 3,600 deterministic 10 Hz samples, serialize the complete pipeline
  result with `JSON.stringify`, and count UTF-8 bytes. The test also compares the matcher's
  exposed mutable-state JSON size after one and 3,600 samples and rejects a top-level array,
  guarding against per-sample accumulation.
- Performance thresholds intentionally leave substantial margin for shared CI machines. The
  recorded values are observations, not promises of identical results on other hardware.

The automated performance guards are in
[`core-pipeline.benchmark.test.ts`](../../packages/core/test/perf/core-pipeline.benchmark.test.ts).

## Not measured here

These desktop replay benchmarks do not measure iPhone execution speed, Core Location delivery
jitter, thermal throttling, background/foreground transitions, battery consumption, rendering,
or persistence I/O. They also do not establish real-world timing accuracy. Those require a
standalone build and the on-device procedure in the
[`real-track-validation-checklist.md`](real-track-validation-checklist.md), especially its GNSS
rate, 30-minute thermal, battery, live-delta stability, and independent-timer checks.
