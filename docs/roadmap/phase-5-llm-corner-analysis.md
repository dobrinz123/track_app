# Phase 5 — LLM corner-by-corner analysis (handoff for future sessions)

Written 2026-08-27 by the LEAD after the user's directive. **Read this before touching telemetry,
coaching, or session export.** It records WHY the telemetry data exists, WHAT must be built on top
of it, and in WHICH ORDER — so an agent in a fresh session can pick it up without the conversation.

## 0. The goal, in the user's words

> "Scopul datelor ăstea e ca pe viitor să introducem un LLM care analizează limitele mașinii și ne
> zice în ce viraje pierdem secunde și unde putem merge mai tare pe limitele mașinii (analizând
> forțele G, frâna, accelerația etc.)"

Product outcome: after a track session, the driver gets a **per-corner verdict** — where time was
lost versus their own best/reference lap, whether the car's limit (grip, braking, traction) was
reached, and one concrete instruction per corner ("brake 15 m later into C6", "you lift mid-corner
in C8 while the car still has 0.3 g of lateral margin"). Advisory only, never safety-critical.

## 1. The car and the data source (decided)

- Car: **2026 Toyota GR Supra MK5** (A90/J29), BMW **B58** engine, **ZF 8HP** automatic.
- OBD source: the user's **MHD WiFi Adapter** — a BMW **ENET (HSFZ/UDS over WiFi TCP)** bridge,
  NOT ELM327 (verified: mhdtuning.com, manuals.plus manual "WiFi ENET Module", forum reports; see
  `.foreman/scratch/mhd-adapter-research*.md` and `enet-protocol-research.md` for citations).
  → Phase 4e builds an ENET transport next to the existing ELM327 engine.
- **Out of scope by decision**: transmission (8HP) oil temperature — its DID is proprietary and
  "too complicated to find". Engine oil temperature: nice-to-have only.
- Custom ESP32 dongle (`hardware/`, `firmware/`): designed and reviewed (rev A4) but **no longer the
  first path**; keep for CAN listen-only later.

## 2. Data that matters for corner analysis (priority order)

| Channel | Source | Why it matters | Status |
|---|---|---|---|
| position / speed on track | GNSS 1 Hz + track matcher (`packages/core/src/matching`) | corner entry/apex/exit speeds, distance-from-S/F for every sample | shipped |
| lap / sector times, validity | timing engine, session records | "seconds lost" needs a reference lap per corner | shipped |
| corner geometry & IDs | `analyzeCorners` (version pinned, `CORNER_ANALYSIS_VERSION`) | the unit of analysis is the corner id; ids REMAP on version bump | shipped |
| latG / longG | phone accelerometer (`gforceProvider`, ~25 Hz, recorded) | grip usage vs the car's envelope, braking/traction limits | shipped (recorded, not yet analysed) |
| vehicle speed (ECU) | ENET/UDS from DME | better resolution than GNSS speed; consistency check | Phase 4e |
| rpm, throttle/accelerator pedal | ENET/UDS from DME | where the driver lifts, how early full throttle is applied | Phase 4e |
| brake pressure / pedal | ENET/UDS from DSC (brake ECU) if a DID is found | braking point, brake release timing (trail braking) | Phase 4e — DID to be discovered |
| steering angle | ENET/UDS from SZL/DSC if a DID is found | steering vs lateral G (understeer signature) | Phase 4e — optional |
| coolant / engine oil temp | ENET/UDS | context only (cold tyres/oil, heat soak) | optional |

Everything is recorded through the SAME telemetry sample path (`telemetry_samples`, monotonic
timestamps, retention cap 200k rows/session — contracts.md Telemetry addendum) and joined to laps
by session id + monotonic time. Do not invent a second storage.

## 3. What to build, in order (each step is its own foreman ticket)

1. **P4e — ENET transport** (in flight): `EnetTransport` (HSFZ framing over TCP), `UdsSession`
   (ReadDataByIdentifier 0x22 + standard OBD service 0x01 where the DME answers it), poll plan per
   channel, decode tables with provenance, simulator for tests, settings (host/port/adapter type),
   monitor screen. Read-only rule stays absolute: **no writes, no session control beyond
   DiagnosticSessionControl/TesterPresent, no coding, no flashing** — the whitelist model from
   `customPidValidation.ts` extends to UDS services.
2. **Corner metrics module (pure, deterministic, in `packages/core`)** — `cornerMetrics/`:
   for every (lap, corner) compute: entry speed, minimum speed + its distance, exit speed,
   braking start distance (from longG and/or brake channel), throttle-on distance, peak lateral G,
   peak braking G, time in corner, time delta vs reference lap in that corner (needs a per-corner
   split of the reference lap — extend the reference-lap record, versioned). Output = a
   `CornerFeatureTable` (JSON-serialisable). Unit-tested with synthetic laps where the answers are
   known analytically. THIS is what the LLM consumes — never raw samples.
3. **Car envelope model** — per car, learned from the driver's own data: max sustained lateral G,
   max braking G, traction-limited acceleration curve vs speed; stored per circuit+car, versioned,
   with provenance. Start simple (percentile-based), keep it explainable.
4. **Session export + LLM analysis** — the app is **100 % offline at runtime** (hard constraint,
   ADR-0004). The LLM step is therefore an explicit, opt-in, post-session action: export the
   `CornerFeatureTable` + envelope + corner geometry (never raw GNSS) as JSON, then either (a) an
   online "Analyse" action that the user triggers with a visible network step, or (b) a desktop
   toolchain script. Model choice per `claude-api` skill at build time; prompt = feature table +
   fixed rubric; output = ranked list of corners with seconds lost and one instruction each,
   labelled ADVISORY. Never ship an LLM call inside the timing path.
5. **UI** — a "Corner report" section on the session Results / Lap detail screens reading the stored
   analysis; dashboard stays GT-minimal (playbook lesson 4).

## 4. Constraints every agent must respect

- Offline mandate, advisory labeling, nothing "official", ODbL attribution kept (memory + playbook).
- Read-only vehicle bus; ENET transport must refuse anything outside the read whitelist.
- Corner ids are tied to `CORNER_ANALYSIS_VERSION`; any stored analysis records the version and
  is invalidated on bump (same rule as observed speeds).
- G data comes from the phone: mount orientation matters (portrait assumed, documented limitation);
  the envelope model must be robust to mount noise (percentiles, not maxima).
- Gates on real exit codes; foreman process (`docs/NEXT-CIRCUIT-PLAYBOOK.md` §0); cross-family
  review when Codex is available.

## 5. Where things are

- Research (cited): `.foreman/scratch/mhd-adapter-research.md`, `mhd-adapter-research-2.md`,
  `enet-protocol-research.md`.
- Ledger: `.foreman/ledger.md` "Phase 4e" section onward.
- Telemetry contracts: `docs/architecture/contracts.md` Telemetry addendum (+ ENET addendum once
  P4e lands). Memory: `user-car-and-obd`, `phase4-obd-telemetry`.

## Scope clarification (user, 2026-08-28)
The goal is NOT MotorPark-only: corner analysis and the LLM car-limit analysis must work for **every circuit in the catalog** — today Transilvania Motor Ring (`transilvania-motor-ring`, field-validated geometry) and MotorPark România (`motorpark-romania`, OSM geometry, field-unvalidated). Everything in Phase 5 keys on `selectedCircuitId` + the catalog entry's corners; no circuit id may be hard-coded, fixtures/tests must cover both circuits, and the car-envelope model is per car (shared across circuits), while corner metrics/references are per circuit+layout.

## Product constraint: not a Supra app (user, 2026-08-28)
The product target is an **AI circuit trainer for beginners on any car**. Three data tiers, each useful alone:
tier 0 phone-only (GPS + IMU: laps, delta, G, inferred braking points, min corner speed, consistency — most of
the coaching value); tier 1 any ELM327 (standard mode-01: rpm, throttle, pedal, temps); tier 2 brand-specific
(ENET/UDS DIDs: brake, steering — the Supra B58 is the FIRST vehicle profile, not the foundation).
Rules: (1) a **vehicle-profile registry** (like the circuit catalog): `{make, model, engine, transport, channel map
with provenance}` as data files, never constants in generic code; the DID sweep + guided observation are the tool
for adding cars. (2) Corner analysis / LLM export consume **channels** (respect `unsupportedChannels`) and degrade
gracefully (no OBD brake → IMU deceleration). (3) The car envelope is **learned from the car's own sessions**
(max lateral G, braking G, acceleration), never from spec sheets — works for any car.
