# TRACE Pod BLE protocol, version 1

The TRACE GNSS Pod (rev A) streams GNSS, IMU and status data to the TRACE app
over BLE. This document is the contract the app implements. The reference
implementation is `src/pod_protocol.{h,c}` (encoder and decoder). The
env:native unit tests round-trip every frame type and check the example
frames in §8 byte for byte.

All multi-byte fields are **little-endian**. Signed integers are two's
complement. `f32` is IEEE-754 binary32.

## 1. GATT

| Item | UUID | Properties | Content |
|---|---|---|---|
| Service "TRACE Pod" | `be030001-cb14-41a4-a6af-b14223e0a8cf` | primary, advertised | |
| DATA | `be030002-cb14-41a4-a6af-b14223e0a8cf` | NOTIFY | one pod→app frame per notification |
| CONTROL | `be030003-cb14-41a4-a6af-b14223e0a8cf` | WRITE, WRITE WITHOUT RESPONSE | one CONTROL frame per write |
| INFO | `be030004-cb14-41a4-a6af-b14223e0a8cf` | READ | a STATUS frame (type 0x03) with `seq = 0xFFFF`: a consistent snapshot, at most ~100 ms old (also refreshed during the pod's blocking GNSS operations) |

Advertising name: `TRACE-Pod-XXXX` (the last two bytes of the BT MAC, in hex).
The service UUID is in the advertising packet and the name is in the scan response.

### Connection requirements

- **ATT MTU.** The pod asks for 247. A notification carries at most MTU − 3 bytes, and a
  GNSS frame is 86 bytes, so **the MTU must be ≥ 89**. Below that, GNSS frames are
  dropped and counted in `tx_drops`. iOS negotiates 185 or more by itself. On
  Android, call `requestMtu(247)` after connecting. The number of IMU samples per
  frame follows the MTU: 9 at MTU 185, 13 at MTU 247.
- **PHY.** On every connection the pod asks for LE 2M in both directions. If the
  phone refuses, the link stays on 1M. That is allowed but gives less headroom.
- **Connection interval.** The pod asks for 7.5–15 ms, latency 0 and a 4 s supervision
  timeout. The phone decides the final values.
- **Security.** Rev A has no pairing or bonding. Any central can connect. There is one
  connection at a time.
- **Streams start OFF on every connection.** Subscribe to DATA (write the CCCD with
  notifications on), then send `SET_STREAMS` (§5). Streams reset to off on
  disconnect.

## 2. Frame format (both directions)

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u8 | version | `1` for this document. A receiver MUST reject any other value. |
| 1 | u8 | type | §3–§6 |
| 2 | u16 | seq | pod→app: see §7. app→pod: chosen by the app and echoed in CONTROL_RESULT. |
| 4 | u16 | len | payload length N |
| 6 | N bytes | payload | |
| 6+N | u16 | crc | CRC-16/CCITT-FALSE over bytes [0, 6+N) |

**CRC-16/CCITT-FALSE:** poly 0x1021, init 0xFFFF, no input or output reflection,
xorout 0x0000. Check value: `"123456789"` → `0x29B1`.

```c
uint16_t crc16(const uint8_t *d, size_t n) {
  uint16_t c = 0xFFFF;
  while (n--) { c ^= (uint16_t)(*d++) << 8;
    for (int b = 0; b < 8; b++) c = (c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1; }
  return c;
}
```

A frame is valid when `len + 8 == notification length` and the CRC matches.
Drop frames that fail either check and count them.

Types:

| type | Direction | Name |
|---|---|---|
| 0x01 | pod→app | GNSS |
| 0x02 | pod→app | IMU batch |
| 0x03 | pod→app | STATUS |
| 0x04 | pod→app | CONTROL_RESULT |
| 0x80 | app→pod | CONTROL |

Ignore unknown types. They may be added in later minor revisions (§9).

## 3. GNSS frame (type 0x01), payload 78 bytes

The pod sends one frame per navigation epoch (10, 20 or 25 Hz). The source is
UBX-NAV-PVT from the u-blox SAM-M10Q. The fields keep u-blox's units (UBX-21035062
R03 §3.15.11).

| Offset | Type | Field | Unit / scale | Notes |
|---|---|---|---|---|
| 0 | u64 | pod_us | µs, pod clock | the epoch time on the pod clock, see §7.2 |
| 8 | i64 | unix_us | µs since 1970-01-01 UTC | the epoch in UTC; 0 unless flag bit 7 is set |
| 16 | u32 | itow_ms | ms | GPS time of week of the epoch |
| 20 | i32 | lat_e7 | 1e-7 deg | |
| 24 | i32 | lon_e7 | 1e-7 deg | |
| 28 | i32 | hmsl_mm | mm | height above mean sea level |
| 32 | i32 | vel_n_mm_s | mm/s | NED north |
| 36 | i32 | vel_e_mm_s | mm/s | NED east |
| 40 | i32 | vel_d_mm_s | mm/s | NED down |
| 44 | i32 | g_speed_mm_s | mm/s | 2-D ground speed |
| 48 | i32 | head_mot_e5 | 1e-5 deg | heading of motion, 0..360 |
| 52 | u32 | h_acc_mm | mm | horizontal accuracy estimate |
| 56 | u32 | v_acc_mm | mm | vertical accuracy estimate |
| 60 | u32 | s_acc_mm_s | mm/s | speed accuracy estimate |
| 64 | u32 | head_acc_e5 | 1e-5 deg | heading accuracy estimate |
| 68 | u32 | t_acc_ns | ns | time accuracy estimate |
| 72 | u16 | p_dop_e2 | 0.01 | position DOP |
| 74 | u8 | fix_type | enum | 0 none, 1 DR, 2 2-D, 3 3-D, 4 GNSS+DR, 5 time only |
| 75 | u8 | num_sv | count | satellites used in the solution |
| 76 | u8 | flags | bits | see below |
| 77 | u8 | rate_hz | Hz | the pod's navigation rate at this epoch. **0 = the receiver's mode is unverified** (a readback after a rate change did not match); treat the rate as unknown |

`flags`:

| Bit | Meaning |
|---|---|
| 0 | gnssFixOK: the fix is inside the receiver's DOP and accuracy masks. **Use only fixes with this bit set.** |
| 1 | diffSoln: SBAS corrections were applied |
| 2 | invalidLlh: lat, lon and height are invalid |
| 3 | validDate (UTC) |
| 4 | validTime (UTC) |
| 5 | fullyResolved: UTC time of day has no seconds ambiguity |
| 6 | pod_us comes from the PPS-disciplined timebase. When clear, pod_us is the time the frame was received (includes 20–100 ms of output latency, not compensated). |
| 7 | unix_us is valid (validDate and validTime) |

## 4. IMU batch frame (type 0x02)

The IMU is an LSM6DSV16X sampled at 480 Hz: accelerometer ±16 g, gyroscope ±2000
dps, box-car decimated by N (1, 2, 4 or 8; default 4 = 120 Hz). Each sample
carries its own time, taken from the IMU's hardware timestamp and mapped to the
pod clock.

Header (20 bytes):

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u64 | t0_pod_us | pod time of sample 0 |
| 8 | f32 | acc_g_per_lsb | 0.000488 at ±16 g (ST DS13510 Table 3) |
| 12 | f32 | gyr_dps_per_lsb | 0.070 at ±2000 dps |
| 16 | u16 | rate_hz | nominal output rate (480 / N) |
| 18 | u8 | count | samples in this frame, 1..32 |
| 19 | u8 | flags | bit 0: sample times come from the IMU hardware timestamp |

Then `count` samples of 16 bytes each, sample i at offset 20 + 16·i:

| Offset | Type | Field | Notes |
|---|---|---|---|
| +0 | u32 | dt_us | sample time = t0_pod_us + dt_us |
| +4 | i16 ×3 | acc x, y, z | raw LSB; × acc_g_per_lsb = g |
| +10 | i16 ×3 | gyr x, y, z | raw LSB; × gyr_dps_per_lsb = deg/s |

The axes are the sensor's own axes (ST DS13510 pin-1 orientation, as marked on
the PCB silkscreen, DESIGN-REV-A §8). The pod does **no** mounting-orientation
correction. The app solves orientation from gravity plus the first
straight-line acceleration.

Rules for the samples:

- Frame length is 8 + 20 + 16·count.
- Consecutive samples are 1/rate apart only nominally. Always use `dt_us`.
- A gap in `seq` (§7) or a jump in time larger than 1.5 sample periods means
  samples were lost.

## 5. CONTROL (type 0x80, app→pod) and CONTROL_RESULT (type 0x04)

CONTROL payload: `u8 opcode` followed by its arguments.

| Opcode | Name | Args | Effect |
|---|---|---|---|
| 0x01 | SET_STREAMS | u8 mask: bit 0 GNSS, bit 1 IMU, bit 2 STATUS at 1 Hz | replaces the stream mask |
| 0x02 | SET_RATE | u8 hz: 10, 20 or 25 | GNSS nav rate. 10 Hz = GPS+Galileo(+SBAS+QZSS). 20 Hz = GPS+Galileo. 25 Hz = GPS(+SBAS+QZSS) only. 20 and 25 need the receiver's high-performance OTP (STATUS `hp_state` = 2); otherwise the result is 3. The constellations and the rate go to the receiver in **one** configuration message (all or nothing) and are read back; OK only if the readback matches. On failure the pod restores and re-verifies the previous mode and answers 6 FAILED; if even that cannot be verified, `rate_hz` reads 0. The result is 4 BUSY while the WiFi coexistence test runs. The pod may take up to ~5 s. |
| 0x03 | SET_IMU_DECIM | u8: 1, 2, 4 or 8 | IMU output rate = 480 / N |
| 0x04 | GET_STATUS | none | a STATUS frame follows the result |

The pod answers every CONTROL with one CONTROL_RESULT, payload 4 bytes. Rules:

- The pod queues up to 8 CONTROL writes and executes **one per main-loop
  pass**, in order. A write that finds the queue full is **not executed** and
  is answered 4 BUSY (resend it later). Only if the pod is flooded beyond a
  second 8-entry overflow queue is a write dropped without any result
  (counted on the console, `ble info`).
- Accepted controls and BUSY answers are served alternately, so a stream of
  overflowing writes cannot stop accepted controls from running.
- Controls belong to the connection they were written in.
  - A disconnect discards every queued control.
  - A control runs only if, at the moment of execution, its connection is
    still the current, connected one.
  - Its result is sent only on that same connection. A control whose
    connection ended while it ran gets no result.
  - A SET_STREAMS never takes effect in a later connection.
  - The pod-wide effect of a SET_RATE that was already running when the
    peer left (the receiver's rate) stays in place: it is device state, not
    session state.
- Wait for the result of a SET_RATE before sending the next control.

Payload:

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | opcode (echo) |
| 1 | u8 | result: 0 OK, 1 BAD_FRAME (CRC, length or version), 2 BAD_ARG, 3 REFUSED_HP_NOT_SET, 4 BUSY (queue full, or the pod is busy: no receiver, bridge or WiFi test active; not executed), 5 UNKNOWN_OPCODE, 6 FAILED (not applied or not verified) |
| 2 | u16 | echo_seq: the `seq` of the CONTROL frame |

The pod has no control command for the one-time-programmable high-performance
setting. It is deliberately available only as a confirmed USB console command
(README).

## 6. STATUS (type 0x03), payload 56 bytes

The pod sends STATUS at 1 Hz when stream bit 2 is on, after a GET_STATUS, and as
the value of the INFO characteristic.

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u64 | pod_us | pod time when the frame was built |
| 8 | u8 ×3 | fw major, minor, patch | 0.1.0 for this firmware |
| 11 | u8 | hw_rev | 1 = rev A |
| 12 | u8 | rate_hz | current GNSS rate, verified by readback. 0 = unverified (see SET_RATE) |
| 13 | u8 | hp_state | 0 unknown, 1 not set, 2 set (high-performance OTP). 2 only if all four verification keys hold the high-clock value; 1 only if all four differ; any mix reads 0 |
| 14 | u8 | pps_state | 0 none, 1 acquiring, 2 locked, 3 holdover |
| 15 | u8 | flags | bit 0 USB power present (PGOOD), 1 GNSS talking, 2 IMU ok, 3 GNSS stream on, 4 IMU stream on, 5 WiFi on, 6 charging enabled (always 0 on rev A) |
| 16 | u64 | tb_anchor_pod_us | timebase anchor: pod time of a PPS edge (0 if none) |
| 24 | i64 | tb_anchor_unix_us | UTC of that edge, whole second, µs |
| 32 | i32 | tb_rate_ppb | clock-rate correction, ppb |
| 36 | u32 | pps_age_ms | age of the last accepted PPS edge. 0xFFFFFFFF = none yet |
| 40 | u8 | fix_type | from the latest NAV-PVT |
| 41 | u8 | num_sv | |
| 42 | u8 | imu_decim | |
| 43 | u8 | reserved | 0 |
| 44 | u32 | tx_drops | notifications the pod generated but could not send |
| 48 | u32 | imu_overruns | IMU FIFO overruns (samples lost inside the pod) |
| 52 | u32 | ubx_errors | UBX checksum, sync and length errors on the GNSS UART |

## 7. Time and loss detection

### 7.1 Sequence numbers

`seq` is one u16 counter per connection, shared by all pod→app frame types. It
starts at 0 on connect, goes up by 1 for **every frame the pod generates** (even
when the BLE stack then refuses it) and wraps from 65535 to 0. The number of lost
frames between two received frames is `(cur − prev − 1) mod 65536`. INFO reads use
seq 0xFFFF and are not part of the sequence.

### 7.2 Pod clock and UTC

Every timestamp is **pod time**: the ESP32 microsecond counter since boot
(monotonic; it restarts at 0 on reboot, so a new connection may mean new pod
times). The pod disciplines it to GNSS: the SAM-M10Q time pulse (1 PPS, on the
top of each GPS second, output only while the receiver is locked to GNSS time) is
captured in an interrupt and paired with the NAV-PVT UTC time. To convert any pod
time to UTC:

```
d        = pod_us − tb_anchor_pod_us
unix_us  = tb_anchor_unix_us + d + d · tb_rate_ppb / 1e9
```

Use the most recent STATUS. The anchor moves forward with every PPS edge, and
the formula stays valid for any pod_us near the anchor. In `holdover` (pps_state
3) the mapping free-runs on the last rate. Expect tens of µs of drift per second
without PPS. With pps_state 0 or 1 there is no mapping. Use pod_us only as a
relative clock then, and GNSS `unix_us` for wall time.

GNSS frames with flag bit 6 already carry the epoch's exact pod time. IMU samples
are in pod time via the IMU hardware timestamp. Their absolute offset to pod time
is unvalidated (§10).

## 8. Example frames (hex)

| Frame | Bytes |
|---|---|
| CONTROL seq 1, SET_STREAMS mask 7 (GNSS+IMU+STATUS) | `01 80 01 00 02 00 01 07 0A 36` |
| CONTROL seq 2, SET_RATE 20 | `01 80 02 00 02 00 02 14 EB 8F` |
| CONTROL seq 3, SET_IMU_DECIM 4 | `01 80 03 00 02 00 03 04 4B EB` |
| CONTROL seq 4, GET_STATUS | `01 80 04 00 01 00 04 3D 63` |
| CONTROL_RESULT pod seq 17: SET_RATE OK, echo seq 2 | `01 04 11 00 04 00 02 00 02 00 5F E5` |

## 9. Versioning

- `version` (byte 0) changes only for incompatible changes: a field moves or
  changes meaning, or the header or CRC changes. The app rejects frames with an
  unknown version and should tell the user to update.
- Compatible additions keep version 1:
  - New fields go only at the **end** of a payload. Decoders must accept
    `len` ≥ the length in this document and ignore the extra bytes. The reference
    decoder does this for GNSS and STATUS.
  - New frame types and opcodes may be added. Unknown ones are ignored, and the
    pod answers 5 UNKNOWN_OPCODE.
- Planned (phase 2): an OBD frame type from the pod's BLE-central link to an
  ELM327 adapter, stamped in pod time.

## 10. Known limits (rev A, not yet measured on hardware)

- None of this has run on a real pod yet. The rates, drops and PPS lock
  above are design values.
- The absolute offset between IMU sample times and pod time comes from I2C reads
  of the IMU timestamp bracketed by the ESP32 clock. A bias of roughly ±100 µs is
  expected and has not been measured.
- GNSS frames without flag bit 6 are stamped at receive time. The UART and
  processing latency is not compensated.
- One central, no security (§1).
