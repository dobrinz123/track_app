# Signal Finder — Brake switch

**Signal found** — engine off (ignition on)

- Session: `signal-finder-1788083853393-j192yu` (2026-08-30T09:57:33.393Z)
- Read: 12 DIDs across 2 ECUs in 1 round — 0x12, 0x29
- Not read: 1424 (tap Next round)
- 36.3 req/s measured

| DID | ECU | verdict | edges | baseline | raw |
| --- | --- | --- | --- | --- | --- |
| 0x4002 | 0x12 | found | 6/6 | 0 | 01 → 1..25 |
| 0x500C | 0x29 | found | 6/6 | 0 | 04 → 4..5 |

_… 10 × unrelated (+10 more)_

**Confirmed bindings:** none

_Generated: 2026-08-30T09:58:20.212Z · trace-signal-finder v4_