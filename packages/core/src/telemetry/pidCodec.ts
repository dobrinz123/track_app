import type { TelemetryChannelId } from './contracts';

/** Channels with binding standard mode-01 PID definitions. */
export type Mode01TelemetryChannelId =
  | 'rpm'
  | 'speedKph'
  | 'throttlePct'
  | 'coolantC'
  | 'intakeC'
  | 'engineLoadPct'
  | 'engineOilC';

interface PidDefinition {
  pid: string;
  byteCount: number;
  decode(bytes: readonly number[]): number;
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
