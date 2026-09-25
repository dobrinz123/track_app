/**
 * TRACE Pod frames -> core sample types.
 *
 * TWO SEAMS ARE DELIBERATELY LEFT TO THE CALLER. Neither is solved here.
 *
 * 1. CLOCK ALIGNMENT (`PodClockMapper`). Every pod timestamp is POD TIME: the
 *    ESP32 microsecond counter since the POD booted (PROTOCOL.md §7.2). It is
 *    monotonic but restarts at 0 when the pod reboots, runs on the pod's own
 *    crystal, and has no defined relation to the app's monotonic clock
 *    (`LocationSample.tMono` / `TelemetrySample.tMonoMs`, ms). The protocol
 *    gives pod->UTC (see `podUsToUnixUs`), never pod->app-monotonic. So the
 *    caller supplies `podUsToMonoMs`; how it is built (receive-time offset
 *    estimation, UTC bridging, drift handling, reboot detection) is the app's
 *    decision. This module only calls it.
 *
 * 2. MOUNT ROTATION (`PodMountTransform`). The pod reports IMU data in the
 *    SENSOR's own axes (LSM6DSV16X pin-1 orientation) with no mounting
 *    correction (§4). The `latG`/`longG`/`yawRateDps` channels are
 *    VEHICLE-frame quantities (see `telemetry/contracts.ts`: gravity removed,
 *    lateral/longitudinal, yaw right-turn positive). The caller supplies the
 *    device->vehicle transform (solved from gravity + first straight-line
 *    acceleration, per §4); until it can, it returns null and no channel
 *    samples are produced. `podImuBatchToRaw` exposes the raw axes.
 *
 * The third seam, the BLE transport itself (scan, connect, MTU >= 89, DATA
 * subscription, CONTROL writes, INFO reads), lives in the app.
 */

import type { LocationSample } from '../../contracts';
import type { TelemetrySample } from '../contracts';
import { POD_PPS_STATE, type PodGnss, type PodImuBatch, type PodStatus } from './podProtocol';

/** Caller-supplied pod-time -> app-monotonic mapping (seam 1). */
export interface PodClockMapper {
  /** Pod µs (since pod boot) -> app monotonic ms, the clock of `LocationSample.tMono`. */
  podUsToMonoMs(podUs: number): number;
}

// ---------- GNSS ----------

export type PodGnssRejectReason = 'NO_FIX_OK' | 'INVALID_LLH';

export type PodGnssMapResult =
  | {
      ok: true;
      sample: LocationSample;
      /** The pod time the sample was stamped with (µs). */
      podUs: number;
      /**
       * false: pod_us is the RECEIVE time, 20-100 ms after the epoch, not
       * compensated (§3 flag bit 6). The caller decides whether to trust it for timing.
       */
      podTimeFromPps: boolean;
    }
  | { ok: false; reason: PodGnssRejectReason };

/**
 * One GNSS frame -> `LocationSample` (source 'gnss').
 *
 * Rejected (never mapped): fixes without gnssFixOK ("use only fixes with this
 * bit set", §3) and fixes with invalidLlh.
 *
 *  - tMono      clock.podUsToMonoMs(podUs)                     (seam 1)
 *  - tUtc       unixUs / 1000, only when the unixValid flag is set
 *  - lat/lon    deg (1e-7 deg on the wire)
 *  - speedMps   2-D ground speed (mm/s on the wire)
 *  - headingDeg heading of motion (1e-5 deg on the wire), 0 = N, clockwise
 *  - accuracyM  u-blox hAcc "horizontal accuracy estimate" (mm on the wire).
 *               u-blox does not state a sigma level; passed through as-is.
 *  - altitudeM  height above MSL (mm on the wire)
 */
export function podGnssToLocationSample(gnss: PodGnss, clock: PodClockMapper): PodGnssMapResult {
  if (!gnss.flags.fixOk) return { ok: false, reason: 'NO_FIX_OK' };
  if (gnss.flags.invalidLlh) return { ok: false, reason: 'INVALID_LLH' };
  const sample: LocationSample = {
    tMono: clock.podUsToMonoMs(gnss.podUs),
    lat: gnss.latDeg,
    lon: gnss.lonDeg,
    accuracyM: gnss.hAccM,
    speedMps: gnss.groundSpeedMps,
    headingDeg: gnss.headMotDeg,
    altitudeM: gnss.hMslM,
    source: 'gnss',
  };
  if (gnss.flags.unixValid) sample.tUtc = gnss.unixUs / 1000;
  return { ok: true, sample, podUs: gnss.podUs, podTimeFromPps: gnss.flags.podTimeFromPps };
}

// ---------- Pod time -> UTC (the protocol's own formula, §7.2) ----------

/**
 * Pod time -> UTC µs using the most recent STATUS timebase (§7.2):
 *
 *   d       = podUs - tbAnchorPodUs
 *   unixUs  = tbAnchorUnixUs + d + d * tbRatePpb / 1e9
 *
 * Returns null when there is no mapping: ppsState NONE/ACQUIRING (the doc:
 * "use pod_us only as a relative clock then") or no anchor (tbAnchorPodUs 0).
 * In HOLDOVER the mapping free-runs on the last rate (tens of µs/s drift).
 * This is pod -> UTC only; it is NOT an alignment to the app's monotonic clock.
 */
export function podUsToUnixUs(podUs: number, status: PodStatus): number | null {
  if (status.ppsState !== POD_PPS_STATE.LOCKED && status.ppsState !== POD_PPS_STATE.HOLDOVER) {
    return null;
  }
  if (status.tbAnchorPodUs === 0) return null;
  const d = podUs - status.tbAnchorPodUs;
  return status.tbAnchorUnixUs + d + (d * status.tbRatePpb) / 1e9;
}

// ---------- IMU ----------

export type PodVec3 = { x: number; y: number; z: number };

/** One IMU sample in the pod's RAW SENSOR axes, in physical units. */
export interface PodImuRawSample {
  /** Pod time, µs (t0PodUs + dtUs). */
  tPodUs: number;
  /** Acceleration incl. gravity, g, sensor axes. */
  accG: PodVec3;
  /** Angular rate, deg/s, sensor axes (right-handed, as the sensor reports it). */
  gyrDps: PodVec3;
}

/** Batch -> raw-axis samples in g and deg/s. No rotation, no gravity removal. */
export function podImuBatchToRaw(batch: PodImuBatch): PodImuRawSample[] {
  return batch.samples.map((s) => ({
    tPodUs: s.tPodUs,
    accG: { x: s.accG[0], y: s.accG[1], z: s.accG[2] },
    gyrDps: { x: s.gyrDps[0], y: s.gyrDps[1], z: s.gyrDps[2] },
  }));
}

/**
 * Vehicle-frame values for the three existing IMU channels, in their
 * documented units (`telemetry/contracts.ts`):
 *  - latG        g, gravity removed, lateral
 *  - longG       g, gravity removed, longitudinal
 *  - yawRateDps  deg/s about the vertical, COMPASS sense (right turn positive)
 */
export interface PodVehicleImu {
  latG: number;
  longG: number;
  yawRateDps: number;
}

/**
 * Caller-supplied device->vehicle transform (seam 2). Return null while the
 * mount orientation is not yet known: the sample then yields no channel rows.
 */
export type PodMountTransform = (raw: PodImuRawSample) => PodVehicleImu | null;

/**
 * Raw IMU samples -> `TelemetrySample` rows for `latG`, `longG`, `yawRateDps`
 * (three rows per sample, all stamped `clock.podUsToMonoMs(tPodUs)`). The
 * rotation and gravity removal are entirely the `toVehicle` transform's job.
 */
export function podImuToTelemetrySamples(
  raw: readonly PodImuRawSample[],
  clock: PodClockMapper,
  toVehicle: PodMountTransform,
): TelemetrySample[] {
  const out: TelemetrySample[] = [];
  for (const s of raw) {
    const v = toVehicle(s);
    if (v === null) continue;
    const tMonoMs = clock.podUsToMonoMs(s.tPodUs);
    out.push({ channel: 'latG', value: v.latG, tMonoMs });
    out.push({ channel: 'longG', value: v.longG, tMonoMs });
    out.push({ channel: 'yawRateDps', value: v.yawRateDps, tMonoMs });
  }
  return out;
}
