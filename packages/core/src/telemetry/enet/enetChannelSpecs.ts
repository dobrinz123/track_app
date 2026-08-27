import type { TelemetryChannelId } from '../contracts';
import {
  channelForMode01Request,
  decodeMode01Response,
  encodeMode01Request,
  isMode01TelemetryChannel,
  type Mode01TelemetryChannelId,
} from '../pidCodec';

/** Channels that are never a valid ENET/OBD request target (device-sensor channels, per the ENET addendum: "no latG/longG"). */
const NON_ENET_CHANNELS: ReadonlySet<TelemetryChannelId> = new Set(['latG', 'longG']);

/**
 * P4e-FIX3 H1(a) fix (binding, Codex P4e-REV3): every channel a `did`/`obd01`
 * ENET spec may legitimately name -- every `TelemetryChannelId` EXCEPT the
 * device-sensor channels `latG`/`longG` (contracts.md ENET addendum: "no
 * latG/longG"). Exported as the single source of truth for channel-membership
 * checks BOTH here (`rejectionReason` below, additive: `latG`/`longG` keep
 * their existing specific "device-sensor channel" message; anything else
 * outside this set is newly rejected too) AND at the mobile layer's
 * untrusted-JSON structural validation (`enetSettingsValidation.ts`), which
 * previously only checked `channel` was a non-empty STRING -- an arbitrary
 * unknown channel name (a typo, or a channel this app doesn't have at all)
 * used to survive both layers and become a real poll entry/sample channel.
 */
export const ENET_SPEC_CHANNELS: ReadonlySet<TelemetryChannelId> = new Set([
  'rpm',
  'speedKph',
  'throttlePct',
  'accelPedalPct',
  'coolantC',
  'intakeC',
  'engineLoadPct',
  'engineOilC',
  'transOilC',
]);

/**
 * Binding poll rate table (contracts.md "poll plan, probe & robustness
 * amendment"): the ENET poll plan is derived from the RESOLVED channel specs
 * (built-in defaults plus any user `did` specs), one rate per channel, rather
 * than reusing the fixed ELM327 poll plan (which silently drops any ENET-only
 * channel, e.g. `intakeC`/`engineLoadPct`, and gates `transOilC` on an
 * unrelated ELM setting). A channel with no entry here falls back to 1 Hz --
 * every channel currently reachable over ENET (obd01 defaults + any `did`
 * channel) IS listed, so that fallback is only ever exercised for a future
 * channel this table hasn't been updated for yet.
 */
export const ENET_DEFAULT_CHANNEL_RATES_HZ: Readonly<Partial<Record<TelemetryChannelId, number>>> = {
  rpm: 5,
  speedKph: 5,
  throttlePct: 5,
  accelPedalPct: 5,
  coolantC: 0.2,
  engineOilC: 0.5,
  transOilC: 0.5,
  intakeC: 1,
  engineLoadPct: 1,
};

export interface EnetChannelDecodeSpec {
  byteOffset: number;
  byteLength: 1 | 2;
  signed?: boolean;
  scale: number;
  offset: number;
}

export interface EnetChannelSpec {
  channel: TelemetryChannelId;
  mode: 'obd01' | 'did';
  /** obd01: 2 hex chars (PID); did: 4 hex chars (DID). */
  requestHex: string;
  targetAddress?: number;
  /** did only: how to decode the ReadDataByIdentifier response's data bytes. */
  decode?: EnetChannelDecodeSpec;
  /** REQUIRED for did specs: where the DID/decode formula came from (no public DID table exists -- every did spec is a user-supplied empirical finding). */
  provenance: string;
}

/**
 * Built-in default specs (ENET addendum): obd01 for rpm 0x0C, speedKph 0x0D,
 * throttlePct 0x11, coolantC 0x05, engineOilC 0x5C -- all EMPIRICAL on the
 * A90 (never confirmed to answer over ENET-direct-to-DME, see
 * enet-protocol-research.md #3). No default `did` specs: no public B58/DSC
 * DID table exists, so any `did` spec must be supplied by the caller with
 * its own `provenance`.
 */
export const DEFAULT_ENET_CHANNEL_SPECS: readonly EnetChannelSpec[] = [
  {
    channel: 'rpm',
    mode: 'obd01',
    requestHex: '0C',
    provenance: 'standard mode-01 PID 0x0C; EMPIRICAL whether the DME answers it over ENET (see enet-protocol-research.md #3)',
  },
  {
    channel: 'speedKph',
    mode: 'obd01',
    requestHex: '0D',
    provenance: 'standard mode-01 PID 0x0D; EMPIRICAL whether the DME answers it over ENET (see enet-protocol-research.md #3)',
  },
  {
    channel: 'throttlePct',
    mode: 'obd01',
    requestHex: '11',
    provenance: 'standard mode-01 PID 0x11; EMPIRICAL whether the DME answers it over ENET (see enet-protocol-research.md #3)',
  },
  {
    channel: 'accelPedalPct',
    mode: 'obd01',
    requestHex: '5A',
    provenance:
      'Field revision 2 (2026-08-27, binding): standard mode-01 PID 0x5A ("Relative accelerator pedal position") -- primary source, EMPIRICAL on the Supra (0 at rest, unlike 0x49\'s ~15% rest offset). Supersedes the 0x49 default this spec previously used (added after the driveway test found throttlePct/0x11 is the throttle PLATE, not the pedal) -- 0x49 remains the mobile provider\'s fallback source (`telemetryProvider.ts`) when the DME answers NRC/unsupported for 0x5A over ENET; EMPIRICAL whether the DME answers 0x5A over ENET at all (not yet field-tested; see enet-protocol-research.md #3).',
  },
  {
    channel: 'coolantC',
    mode: 'obd01',
    requestHex: '05',
    provenance: 'standard mode-01 PID 0x05; EMPIRICAL whether the DME answers it over ENET (see enet-protocol-research.md #3)',
  },
  {
    channel: 'engineOilC',
    mode: 'obd01',
    requestHex: '5C',
    provenance: 'standard mode-01 PID 0x5C; EMPIRICAL whether the DME answers it over ENET (see enet-protocol-research.md #3)',
  },
];

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, pedal PID fallback):
 * the `accelPedalPct` spec the mobile provider (`telemetryProvider.ts`)
 * swaps in for the primary 0x5A spec above when the DME answers
 * NRC/unsupported for 0x5A over ENET (`session.getDiagnostics().unsupportedChannels`
 * -- see `enetSession.ts`). Exported so the provider never hand-builds a
 * raw `requestHex`/`provenance` pair itself; the resulting raw pedal
 * percentage still needs the SAME rest-offset normalization the ELM327
 * fallback path uses (`pedalNormalization.ts`, mobile) -- 0x49's rest
 * offset is not 0 like 0x5A's.
 */
export const ACCEL_PEDAL_FALLBACK_ENET_SPEC: EnetChannelSpec = {
  channel: 'accelPedalPct',
  mode: 'obd01',
  requestHex: '49',
  provenance:
    'Field revision 2 (2026-08-27, binding): standard mode-01 PID 0x49 fallback source -- used when the DME answers NRC/unsupported for the primary 0x5A ("Relative accelerator pedal position") over ENET. Decoded with the SAME rest-offset normalization as the ELM327 fallback path (telemetryProvider.ts / pedalNormalization.ts) -- 0x49 has a non-zero rest offset (~15% EMPIRICAL on the Supra), unlike 0x5A.',
};

export interface EnetChannelSpecValidation {
  valid: EnetChannelSpec[];
  warnings: string[];
}

/**
 * Validates a list of channel specs: rejects device-sensor channels
 * (latG/longG), malformed `requestHex` (not hex, or the wrong length for the
 * spec's `mode`), and `did` specs missing `decode` or a non-empty
 * `provenance`. A channel repeated across specs keeps only the LAST entry
 * (with a warning) -- never silently merges or picks the first.
 */
export function validateEnetChannelSpecs(specs: readonly EnetChannelSpec[]): EnetChannelSpecValidation {
  const byChannel = new Map<TelemetryChannelId, EnetChannelSpec>();
  const warnings: string[] = [];

  for (const spec of specs) {
    const reason = rejectionReason(spec);
    if (reason !== null) {
      warnings.push(`Ignoring ENET channel spec for ${spec.channel}: ${reason}`);
      continue;
    }
    if (byChannel.has(spec.channel)) {
      warnings.push(`Duplicate ENET channel spec for ${spec.channel}: the last one wins`);
    }
    byChannel.set(spec.channel, spec);
  }

  return { valid: [...byChannel.values()], warnings };
}

function rejectionReason(spec: EnetChannelSpec): string | null {
  if (NON_ENET_CHANNELS.has(spec.channel)) {
    return `channel ${spec.channel} is a device-sensor channel, never a valid ENET/OBD request target`;
  }
  // P4e-FIX3 H1(a) fix: a channel string that survived JSON parsing (or, at
  // this pure-core layer, was constructed programmatically) but names
  // nothing in `ENET_SPEC_CHANNELS` -- a typo, or a channel this app has no
  // decoder/rate/UI for at all -- must be refused here too, the SAME way an
  // out-of-range `requestHex` already is, rather than silently becoming a
  // real poll entry.
  if (!ENET_SPEC_CHANNELS.has(spec.channel)) {
    return `channel "${spec.channel}" is not a recognized ENET/OBD telemetry channel`;
  }
  const compact = spec.requestHex.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[0-9A-Fa-f]+$/.test(compact)) {
    return `requestHex "${spec.requestHex}" is not valid hex`;
  }
  if (spec.mode === 'obd01') {
    if (compact.length !== 2) {
      return `obd01 requestHex must be exactly 2 hex characters (one PID byte), got ${compact.length}`;
    }
    // Channel<->PID consistency table: the requestHex must be the ONE
    // standard mode-01 PID that decodes into THIS channel -- otherwise the
    // response bytes get run through the wrong decode formula (e.g. RPM
    // bytes decoded as speedKph). `channelForMode01Request` is the single
    // source of truth for that mapping (see `pidCodec.ts`); a channel with
    // no mode-01 decoder at all (e.g. transOilC) never matches any PID.
    const matchedChannel = channelForMode01Request(`01${compact}`);
    if (matchedChannel !== spec.channel) {
      if (!isMode01TelemetryChannel(spec.channel)) {
        return `no mode-01 decoder exists for channel ${spec.channel} (obd01 mode is not valid for this channel)`;
      }
      return `obd01 requestHex "${compact}" does not match the mode-01 PID for channel ${spec.channel} (expected ${encodeMode01Request(spec.channel).slice(2)})`;
    }
    return null;
  }
  if (compact.length !== 4) {
    return `did requestHex must be exactly 4 hex characters (one DID), got ${compact.length}`;
  }
  if (spec.decode === undefined) {
    return 'did spec is missing a decode definition';
  }
  if (!Number.isInteger(spec.decode.byteOffset) || spec.decode.byteOffset < 0) {
    return `did spec byteOffset must be a non-negative integer, got ${spec.decode.byteOffset}`;
  }
  if (spec.decode.byteLength !== 1 && spec.decode.byteLength !== 2) {
    return `did spec byteLength must be 1 or 2, got ${spec.decode.byteLength}`;
  }
  if (!Number.isFinite(spec.decode.scale) || !Number.isFinite(spec.decode.offset)) {
    return 'did spec scale/offset must be finite numbers';
  }
  if (spec.provenance.trim() === '') {
    return 'did spec is missing provenance';
  }
  return null;
}

/**
 * Decodes one channel's raw UDS response data bytes into its telemetry
 * value. `obd01` specs REUSE `pidCodec`'s own decode formulas by round-
 * tripping the raw bytes through the same ASCII response shape
 * `decodeMode01Response` already parses (`41 <pid> <data...>`) -- this keeps
 * exactly one decode formula per standard PID in the whole codebase, rather
 * than a second hand-copied one here.
 */
export function decodeEnetChannelValue(spec: EnetChannelSpec, dataBytes: Uint8Array): number {
  if (spec.mode === 'obd01') {
    if (!isMode01TelemetryChannel(spec.channel)) {
      throw new Error(`No mode-01 decoder for channel ${spec.channel}`);
    }
    return decodeObd01DataBytes(spec.channel, dataBytes);
  }
  if (spec.decode === undefined) throw new Error(`Channel ${spec.channel} did spec has no decode definition`);
  return decodeDidBytes(dataBytes, spec.decode);
}

function decodeObd01DataBytes(channel: Mode01TelemetryChannelId, dataBytes: Uint8Array): number {
  const pidHex = encodeMode01Request(channel).slice(2);
  const syntheticResponse = `41 ${pidHex} ${bytesToHexPairs(dataBytes)}`;
  return decodeMode01Response(channel, syntheticResponse);
}

function decodeDidBytes(dataBytes: Uint8Array, decode: EnetChannelDecodeSpec): number {
  const { byteOffset, byteLength, signed, scale, offset } = decode;
  if (byteOffset < 0 || byteOffset + byteLength > dataBytes.length) {
    throw new Error(
      `DID decode byteOffset ${byteOffset} + byteLength ${byteLength} is out of range for a ${dataBytes.length}-byte payload`,
    );
  }
  let raw = 0;
  for (let index = 0; index < byteLength; index += 1) {
    raw = raw * 256 + (dataBytes[byteOffset + index] ?? 0);
  }
  if (signed === true) {
    const bits = byteLength * 8;
    const signBit = 2 ** (bits - 1);
    if (raw >= signBit) raw -= 2 ** bits;
  }
  return raw * scale + offset;
}

function bytesToHexPairs(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
