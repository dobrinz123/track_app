import type { TelemetryChannelId } from './contracts';

/** Channels with binding standard mode-01 PID definitions. */
export type Mode01TelemetryChannelId =
  | 'rpm'
  | 'speedKph'
  | 'throttlePct'
  | 'accelPedalPct'
  | 'coolantC'
  | 'intakeC'
  | 'engineLoadPct'
  | 'engineOilC';

interface PidDefinition {
  pid: string;
  byteCount: number;
  decode(bytes: readonly number[]): number;
}

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, pedal PID fallback):
 * "primary source PID 0x5A ... if the DME answers NRC/unsupported for 0x5A,
 * fall back to 0x49." Both PIDs share the IDENTICAL decode formula
 * (100/255·A) -- only the PID byte itself differs -- so `accelPedalPct`'s
 * `PID_BY_CHANNEL` entry below reads this mutable module-level flag via a
 * getter, rather than a fixed literal like every other channel.
 *
 * WHY mutable module state, here specifically: `elm327Session.ts` (not in
 * this ticket's write scope) calls `encodeMode01Request(channel)` exactly
 * ONCE per channel, at session CONSTRUCTION time, to build that channel's
 * fixed poll command for the session's entire lifetime -- there is no
 * per-poll re-evaluation to hook a runtime PID switch into. The mobile
 * provider (`telemetryProvider.ts`) is therefore the only thing that CAN
 * "switch" the source: it calls {@link setAccelPedalPidSource} then tears
 * down and relaunches a FRESH session, which reads the flag anew at ITS OWN
 * construction. Correctness relies on the provider never flipping this flag
 * while an existing session built from the OLD value is still alive/polling
 * (true in practice: the switch only ever happens after that session has
 * fully stopped) -- see `telemetryProvider.ts`'s own pedal-fallback comment.
 */
export type AccelPedalPidSource = '5A' | '49';
let accelPedalPidSource: AccelPedalPidSource = '5A';

/** Sets which PID {@link encodeMode01Request}/{@link decodeMode01Response} use for `accelPedalPct` -- see the module-state doc comment above for why, and its caller-discipline requirement. */
export function setAccelPedalPidSource(source: AccelPedalPidSource): void {
  accelPedalPidSource = source;
}

/** Current `accelPedalPct` PID source (test/diagnostic visibility). */
export function getAccelPedalPidSource(): AccelPedalPidSource {
  return accelPedalPidSource;
}

const PID_BY_CHANNEL: Record<Mode01TelemetryChannelId, PidDefinition> = {
  rpm: {
    pid: '0C',
    byteCount: 2,
    decode: ([a = 0, b = 0]) => (256 * a + b) / 4,
  },
  speedKph: {
    pid: '0D',
    byteCount: 1,
    decode: ([a = 0]) => a,
  },
  throttlePct: {
    pid: '11',
    byteCount: 1,
    decode: ([a = 0]) => (a * 100) / 255,
  },
  // Field revision (2026-08-27, binding): "Accelerator pedal position D"
  // (SAE J1979 PID 0x49) -- EMPIRICAL on the Supra: must read ~0% released
  // and rise with the pedal (distinct from throttlePct's plate opening,
  // which idles at ~14-15%). Vector: A=0x80 (128) -> 128*100/255 = 50.2%.
  //
  // Field revision 2 (2026-08-27, binding): primary source is now PID 0x5A
  // ("Relative accelerator pedal position", 0 at rest -- EMPIRICAL on the
  // Supra); 0x49 is the fallback when the DME answers NRC/unsupported for
  // 0x5A. `pid` is a GETTER reading the mutable module flag above -- see its
  // own doc comment for why.
  accelPedalPct: {
    get pid() {
      return accelPedalPidSource;
    },
    byteCount: 1,
    decode: ([a = 0]) => (a * 100) / 255,
  },
  coolantC: {
    pid: '05',
    byteCount: 1,
    decode: ([a = 0]) => a - 40,
  },
  intakeC: {
    pid: '0F',
    byteCount: 1,
    decode: ([a = 0]) => a - 40,
  },
  engineLoadPct: {
    pid: '04',
    byteCount: 1,
    decode: ([a = 0]) => (a * 100) / 255,
  },
  engineOilC: {
    pid: '5C',
    byteCount: 1,
    decode: ([a = 0]) => a - 40,
  },
};

const CHANNEL_BY_REQUEST = new Map<string, Mode01TelemetryChannelId>(
  Object.entries(PID_BY_CHANNEL).map(([channel, definition]) => [
    `01${definition.pid}`,
    channel as Mode01TelemetryChannelId,
  ]),
);
// Field revision 2 (binding): `accelPedalPct` has TWO valid source PIDs
// (0x5A primary, 0x49 fallback) -- the map-building line above only ever
// captured whichever ONE was active in `accelPedalPidSource` at MODULE LOAD
// time, so the other must be added explicitly here, unconditionally,
// regardless of the mutable flag's current value. This is what lets
// `channelForMode01Request`/`isMode01TelemetryChannel`-driven consumers
// (notably `enetChannelSpecs.ts`'s spec validator) recognize EITHER PID as
// a legitimate `accelPedalPct` request at any time.
CHANNEL_BY_REQUEST.set('0149', 'accelPedalPct');
CHANNEL_BY_REQUEST.set('015A', 'accelPedalPct');

/** Encodes the binding mode-01 live-data request for a telemetry channel. */
export function encodeMode01Request(channel: Mode01TelemetryChannelId): string {
  const definition = PID_BY_CHANNEL[channel];
  if (definition === undefined) throw new Error(`No standard mode 01 PID for ${channel}`);
  return `01${definition.pid}`;
}

/** Resolves a mode-01 command to one of the supported standard-PID channels. */
export function channelForMode01Request(request: string): Mode01TelemetryChannelId | undefined {
  return CHANNEL_BY_REQUEST.get(request.trim().replace(/\s+/g, '').toUpperCase());
}

export function isMode01TelemetryChannel(
  channel: TelemetryChannelId,
): channel is Mode01TelemetryChannelId {
  return Object.prototype.hasOwnProperty.call(PID_BY_CHANNEL, channel);
}

/**
 * Decodes one ELM327 response. Echoes and unrelated CAN frames are ignored;
 * both compact (`410C1AF8`) and whitespace-delimited (`41 0C 1A F8`) hex are
 * accepted, including a target frame surrounded by adapter chatter.
 */
export function decodeMode01Response(
  channel: Mode01TelemetryChannelId,
  response: string,
): number {
  const definition = PID_BY_CHANNEL[channel];
  if (definition === undefined) throw new Error(`No standard mode 01 PID for ${channel}`);
  const separator = '(?:\\s|:)*';
  const dataCaptures = Array.from({ length: definition.byteCount }, () =>
    `(${separator}[0-9A-F]{2})`,
  ).join('');
  const pattern = new RegExp(`41${separator}${definition.pid}${dataCaptures}`, 'i');
  const match = pattern.exec(response.toUpperCase());
  if (match === null) {
    throw new Error(`Missing mode 01 PID ${definition.pid} response for ${channel}`);
  }

  const bytes: number[] = [];
  for (let index = 1; index <= definition.byteCount; index += 1) {
    const capture = match[index];
    if (capture === undefined) throw new Error(`Incomplete response for ${channel}`);
    const byte = Number.parseInt(capture.replace(/[\s:]/g, ''), 16);
    if (!Number.isFinite(byte)) throw new Error(`Invalid hex response for ${channel}`);
    bytes.push(byte);
  }
  return definition.decode(bytes);
}

// Concise aliases for callers that already know this module only handles mode 01.
export const encodePidRequest = encodeMode01Request;
export const decodePidResponse = decodeMode01Response;
