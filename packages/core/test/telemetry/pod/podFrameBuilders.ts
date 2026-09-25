/**
 * Test-only frame builders. Payloads are written field by field at the
 * OFFSETS printed in firmware-pod/PROTOCOL.md (§3, §4, §6) with a DataView --
 * independent of the decoder under test. The values mirror the C reference
 * tests (firmware-pod/test/test_pod_protocol/test_pod_protocol.c).
 */
import { podCrc16 } from '../../../src/telemetry/pod/podProtocol';

export function frame(type: number, seq: number, payload: Uint8Array, version = 1): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, version);
  v.setUint8(1, type);
  v.setUint16(2, seq, true);
  v.setUint16(4, payload.byteLength, true);
  out.set(payload, 6);
  v.setUint16(6 + payload.byteLength, podCrc16(out, 0, 6 + payload.byteLength), true);
  return out;
}

export function hex(s: string): Uint8Array {
  return Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16)),
  );
}

/**
 * C test `sample_gnss()`; flags FIX_OK | POD_TIME_FROM_PPS | UNIX_VALID = 0xC1.
 * EXCEPT pod_us: the C vector's 0x0102030405060708 exceeds 2^53 and is refused
 * by the TS decoder (not exactly representable as a JS number), so the default
 * here keeps its low 6 bytes, 0x030405060708 (~38 days of pod uptime).
 */
export const C_SAMPLE_GNSS_POD_US = 0x0102030405060708n;
export function sampleGnssPayload(extra = 0, podUs = 0x0000030405060708n): Uint8Array {
  const p = new Uint8Array(78 + extra);
  const v = new DataView(p.buffer);
  v.setBigUint64(0, podUs, true); // pod_us
  v.setBigInt64(8, 1790251182099999n, true); // unix_us
  v.setUint32(16, 388800100, true); // itow_ms
  v.setInt32(20, 465234567, true); // lat_e7
  v.setInt32(24, 244123456, true); // lon_e7
  v.setInt32(28, -1234, true); // hmsl_mm
  v.setInt32(32, -1234, true); // vel_n
  v.setInt32(36, 23456, true); // vel_e
  v.setInt32(40, -12, true); // vel_d
  v.setInt32(44, 23488, true); // g_speed
  v.setInt32(48, 9301234, true); // head_mot_e5
  v.setUint32(52, 1234, true); // h_acc_mm
  v.setUint32(56, 2345, true); // v_acc_mm
  v.setUint32(60, 150, true); // s_acc_mm_s
  v.setUint32(64, 543210, true); // head_acc_e5
  v.setUint32(68, 25, true); // t_acc_ns
  v.setUint16(72, 132, true); // p_dop_e2
  v.setUint8(74, 3); // fix_type
  v.setUint8(75, 14); // num_sv
  v.setUint8(76, 0xc1); // flags
  v.setUint8(77, 20); // rate_hz
  return p;
}

/** C test `test_status_round_trip` values. */
export function sampleStatusPayload(extra = 0): Uint8Array {
  const p = new Uint8Array(56 + extra);
  const v = new DataView(p.buffer);
  v.setBigUint64(0, 99n, true); // pod_us
  v.setUint8(8, 0); // fw major
  v.setUint8(9, 1); // fw minor
  v.setUint8(10, 2); // fw patch
  v.setUint8(11, 1); // hw_rev
  v.setUint8(12, 10); // rate_hz
  v.setUint8(13, 1); // hp_state
  v.setUint8(14, 2); // pps_state
  v.setUint8(15, 0x03); // flags USB_POWER | GNSS_OK
  v.setBigUint64(16, 5000000n, true); // tb_anchor_pod_us
  v.setBigInt64(24, 1790251100000000n, true); // tb_anchor_unix_us
  v.setInt32(32, -20123, true); // tb_rate_ppb
  v.setUint32(36, 0xffffffff, true); // pps_age_ms (none yet)
  v.setUint8(40, 3); // fix_type
  v.setUint8(41, 12); // num_sv
  v.setUint8(42, 4); // imu_decim
  v.setUint8(43, 0); // reserved
  v.setUint32(44, 5, true); // tx_drops
  v.setUint32(48, 6, true); // imu_overruns
  v.setUint32(52, 7, true); // ubx_errors
  return p;
}

/** C test `test_imu_round_trip_and_mtu_sizing` values: 13 samples at 120 Hz. */
export function sampleImuPayload(count = 13): Uint8Array {
  const p = new Uint8Array(20 + 16 * count);
  const v = new DataView(p.buffer);
  v.setBigUint64(0, 123456789012n, true);
  v.setFloat32(8, 0.000488, true);
  v.setFloat32(12, 0.07, true);
  v.setUint16(16, 120, true);
  v.setUint8(18, count);
  v.setUint8(19, 1);
  for (let i = 0; i < count; i++) {
    const o = 20 + 16 * i;
    v.setUint32(o, i * 8333, true);
    for (let k = 0; k < 3; k++) {
      v.setInt16(o + 4 + 2 * k, -32768 + i * 1000 + k, true);
      v.setInt16(o + 10 + 2 * k, 32767 - i * 1000 - k, true);
    }
  }
  return p;
}
