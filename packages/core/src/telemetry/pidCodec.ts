// `AccelPedalPidSource` is declared in `./contracts` (with `Elm327Config`,
// which carries it per session) and re-exported from this package's barrel
// there -- imported here as a type only, never re-exported, so the barrel has
// exactly one source for the name.
import type { AccelPedalPidSource, TelemetryChannelId } from './contracts';

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
 * (100/255·A) -- only the PID byte itself differs.
 *
 * P4h-FIX1 H4 (after Codex P4h-REV1 HIGH): which PID `accelPedalPct` uses is
 * a per-call PARAMETER, defaulting to the primary source -- NEVER module
 * state. The previous `setAccelPedalPidSource()` global was read by
 * `decodeMode01Response` on every decode, so a second provider generation (or
 * another test in the same process) flipping it made a LIVE session built for
 * the other PID reject every valid response it received. `elm327Session.ts`
 * now takes the source in its own `Elm327Config`, frozen at construction, and
 * passes it to both the encode and the decode of its own poll entries; two
 * sessions with different sources cannot interfere.
 */
export const DEFAULT_ACCEL_PEDAL_PID_SOURCE: AccelPedalPidSource = '5A';

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
  // 0x5A. P4h-FIX1 H4: this literal is the DEFAULT source only -- a caller
  // that polls the fallback passes `'49'` explicitly (see `pidFor` below).
  accelPedalPct: {
    pid: DEFAULT_ACCEL_PEDAL_PID_SOURCE,
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
// (0x5A primary, 0x49 fallback) -- the map-building line above only captures
// the DEFAULT one, so the other is added explicitly here. This is what lets
// `channelForMode01Request`/`isMode01TelemetryChannel`-driven consumers
// (notably `enetChannelSpecs.ts`'s spec validator) recognize EITHER PID as
// a legitimate `accelPedalPct` request at any time.
CHANNEL_BY_REQUEST.set('0149', 'accelPedalPct');
CHANNEL_BY_REQUEST.set('015A', 'accelPedalPct');

/**
 * The PID byte a given channel is polled with. Only `accelPedalPct` has two
 * (P4h-FIX1 H4): `accelPedalPidSource` selects between the primary 0x5A and
 * the 0x49 fallback and is ignored for every other channel.
 */
function pidFor(definition: PidDefinition, channel: Mode01TelemetryChannelId, source: AccelPedalPidSource): string {
  return channel === 'accelPedalPct' ? source : definition.pid;
}

/** Encodes the binding mode-01 live-data request for a telemetry channel. */
export function encodeMode01Request(
  channel: Mode01TelemetryChannelId,
  accelPedalPidSource: AccelPedalPidSource = DEFAULT_ACCEL_PEDAL_PID_SOURCE,
): string {
  const definition = PID_BY_CHANNEL[channel];
  if (definition === undefined) throw new Error(`No standard mode 01 PID for ${channel}`);
  return `01${pidFor(definition, channel, accelPedalPidSource)}`;
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
  accelPedalPidSource: AccelPedalPidSource = DEFAULT_ACCEL_PEDAL_PID_SOURCE,
): number {
  const definition = PID_BY_CHANNEL[channel];
  if (definition === undefined) throw new Error(`No standard mode 01 PID for ${channel}`);
  const pid = pidFor(definition, channel, accelPedalPidSource);
  const separator = '(?:\\s|:)*';
  const dataCaptures = Array.from({ length: definition.byteCount }, () =>
    `(${separator}[0-9A-F]{2})`,
  ).join('');
  const pattern = new RegExp(`41${separator}${pid}${dataCaptures}`, 'i');
  const match = pattern.exec(response.toUpperCase());
  if (match === null) {
    throw new Error(`Missing mode 01 PID ${pid} response for ${channel}`);
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
