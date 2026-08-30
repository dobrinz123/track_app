# Signal Finder — Brake pressure

**Signal found** — engine off (ignition on)

- Session: `signal-finder-1788090488977-bn7z65` (2026-08-30T11:48:08.977Z)
- Read: 24 DIDs across 2 ECUs in 2 rounds — 0x12, 0x29
- Not read: 1412 (tap Next round)
- 39.7 req/s measured

| DID | ECU | verdict | edges | baseline | raw |
| --- | --- | --- | --- | --- | --- |
| 0x4002 | 0x12 | found | 6/6 | 0 | 83 → 131..155 |
| 0x500B | 0x29 | found | 6/6 | 0 | 0002 → 2..6 |

_… 22 × unrelated (+22 more)_

**Confirmed bindings:** brakePressure = 0x12 0x4002 — whole response: 83 at rest, 131..155 observed, brakeSwitch = 0x29 0x500C — whole response: 04 at rest, 4..5 observed

_Generated: 2026-08-30T11:49:31.373Z · trace-signal-finder v4_