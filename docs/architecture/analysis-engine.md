# Analysis engine — algorithm foundations (Phase 5, deterministic, on-device)

Status: binding design for `packages/core/src/coaching/**` (2026-08-28). No LLM, no backend. Everything here is
deterministic, testable, circuit-agnostic (catalog corners) and car-agnostic (channel availability drives depth).

## 1. Inputs and the channel matrix

A session = laps; a lap = time-ordered samples. Tier 0 is mandatory, higher tiers enrich.

| Channel | Source | Tier | Used for |
|---|---|---|---|
| position (lat/lon → ENU), speed, heading, GNSS accuracy, timestamp | GPS (already in the session pipeline) | 0 | distance along centreline `s`, speed profile `v(s)`, delta, corner sectors |
| longG, latG (device IMU, gravity-compensated, vehicle frame after calibration) | phone | 0 | braking onset/peak, cornering load, friction-circle use, yaw/decel anomalies |
| yaw rate | phone gyro (optional) | 0 | turn-in detection, anomaly (spin) |
| accelPedalPct | OBD 0x5A/0x49 (any ELM327 or ENET) | 1 | lift point, throttle-on point, full-throttle fraction |
| rpm, gear (derived) | OBD | 1 | shift points (informational) |
| brakePct / brake pressure | brand DID (vehicle profile) | 2 | exact brake start/end, trail-braking, brake-release rate |
| steeringDeg | brand DID (vehicle profile) | 2 | turn-in point, steering smoothness, corrections |

Rule: every metric declares which channels it needs; `availability` (from `unsupportedChannels`) selects the
best available estimator and the report states the limitation. Never fabricate a missing channel.

## 2. Distance-domain alignment (the backbone)

1. Project each sample onto the circuit centreline (catalog geometry, `RuntimeProfile` ENU) → `s` in metres
   from start/finish, monotone within a lap (guard against back-steps with a small hysteresis).
2. Resample every channel to a fixed grid `Δs = 1 m` (linear interpolation; speed from GPS Doppler when present,
   else from Δs/Δt smoothed). Everything downstream works on the grid, so laps are comparable point-by-point.
3. Time-at-distance: `t(s) = Σ Δs / v(s)`. **Delta vs reference**: `Δt(s) = t_lap(s) − t_ref(s)`; the slope of
   `Δt(s)` inside a corner sector is *where* time is lost or gained. Reference = the driver's best CLEAN lap.
4. Corner sectors come from the catalog corners (entry/apex/exit distances). Per corner: braking zone
   `[entry − L_b, apex]`, exit zone `[apex, exit + L_e]` with `L_b, L_e` derived from the corner's speed drop.

## 3. Lap classification (clean vs anomalous)

A lap is CLEAN unless: off-track (lateral distance to centreline > corridor), GNSS accuracy worse than the
threshold for > 5 % of the lap, sample gap > 1.5 s, `|longG|` spike > 1.2 g (or ABS-like oscillation),
yaw-rate spike inconsistent with speed/curvature (spin/slide), incomplete lap. Only clean laps feed the
reference and the demonstrated envelope; anomalous laps are still reported as facts with the reason.

## 4. Per-corner metrics (per lap)

- **Lift point** `s_lift`: first `s` in the braking zone where `accelPedalPct` drops below 10 % (tier 1); fallback
  tier 0: first sustained `longG < −0.05 g` before braking onset.
- **Brake start** `s_brake`: brake channel > 5 % (tier 2); fallback: `longG < −0.15 g` sustained ≥ 0.3 s
  (tier 0, from IMU, cross-checked with `dv/ds`).
- **Peak decel** `min longG` in the braking zone; **brake-release profile** (tier 2): pressure vs `s` after apex
  (trail-braking length).
- **Min speed** `v_min` and its position `s_vmin` (relative to apex: early/late apex indicator).
- **Throttle-on** `s_throttle`: `accelPedalPct` > 20 % after `s_vmin` (tier 1); fallback: `longG > +0.05 g`.
- **Exit speed** `v` at the sector exit; **full-throttle fraction** of the exit zone (tier 1).
- **Max lateral G** and **friction-circle utilisation** `max √(latG² + longG²)` in the corner.
- **Turn-in** `s_turnin` (tier 2 steering, fallback yaw rate > threshold) and **steering smoothness**
  (RMS of d(steering)/ds; count of corrections = sign changes above a dead-band).
- **Sector time** and **Δt contribution** of the corner vs the reference lap.

## 5. Session insights (what the report says — V1 observations only)

1. **Time loss ranking**: corners sorted by `Δt` contribution of the *median* lap vs the best clean lap, with the
   underlying cause flags (later/earlier brake, lower `v_min`, later throttle-on, longer braking).
2. **Consistency** per corner: spread (P90−P10) of `s_brake`, `v_min`, sector time across clean laps → a 0–100
   score (100 = tight). Also lap-time consistency.
3. **Brake / lift table**: per corner × lap, `s_lift`, `s_brake`, peak decel — plus the driver's *demonstrated
   envelope* (latest clean brake, earliest lift, highest clean `v_min`) and which lap demonstrated it.
4. **Min / exit speed** per corner × lap and the best-clean reference.
5. **Honesty gates**: `< 2` clean laps → facts only; missing channels → the estimator used is named; unvalidated
   geometry (MotorPark today) → note that corner positions are approximate.

Suggestions (brake later, lift later, carry more speed) are OFF in V1. When enabled, they must stay inside the
demonstrated envelope and within `MAX_BRAKE_LATER_M = 10`, `MAX_MIN_SPEED_GAIN_KPH = 3`, one change per corner.

## 6. Report text (RO/EN)

Template-generated, every sentence carries its numbers and lap ids; coach tone; fixed disclaimer. Example (RO):
"T3: pe turul 4 ai frânat la 118 m înainte de apex și ai dus 74 km/h prin viraj (cel mai bun tur al tău); pe
turele 2 și 6 ai frânat la 145–150 m și ai avut 68–69 km/h — acolo pierzi ~0,4 s."

## 7. Tests

Synthetic laps with known ground truth (brake at exactly X m, v_min exactly Y) for every estimator and tier;
fixture laps for BOTH circuits; property tests (envelope never exceeded; no "undefined"/"NaN" in text; ordering
deterministic).
