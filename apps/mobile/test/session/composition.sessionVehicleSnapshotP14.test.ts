import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlSessionRepository, type LocationSample, type SqlDatabase } from '@circuit/core';

import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { bundled, TMR_CIRCUIT_ID } from '../support/analysisHarness';

/**
 * Ticket P14 H7 (Codex P13 round, composition.ts:4493) -- A HISTORICAL
 * SESSION'S REPORT USED THE PROFILE THAT IS ACTIVE TODAY.
 *
 * The reviewer's reproduction, end to end through `buildSessionReport`: a
 * session was recorded with profile A and its bindings; the owner then
 * switched to profile B; exporting A's session produced a document carrying
 * B's bindings. With B empty it went further and claimed "no OBD channel was
 * decoded from one" -- about a session that decoded plenty. A trace is only
 * interpretable against the bindings that produced it, so this corrupts
 * exactly the offline analysis the build exists to enable.
 *
 * Boot pattern (mocks, sql.js db, fresh module per test) copied from
 * `composition.activeVehicleProfile.test.ts`.
 */

const LOCAL_USER_ID = 'local-driver';
const SESSION_A = 'local-driver--recorded-with-profile-a';

const seeded = vi.hoisted(() => ({
  db: undefined as unknown,
  repository: undefined as unknown,
}));

vi.mock('../../src/session/gforceProvider', async () => ({
  ...(await vi.importActual<typeof import('../../src/session/gforceProvider')>(
    '../../src/session/gforceProvider',
  )),
  createGForceProvider: () => ({
    start: () => undefined,
    stop: async () => undefined,
    onSample: () => () => undefined,
  }),
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: 'session-vehicle-snapshot-test' } },
}));

vi.mock('../../src/platform', () => {
  class StubLocationProviderBase {
    listeners = new Set<(s: LocationSample) => void>();
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    subscribe(cb: (s: LocationSample) => void): () => void {
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
    }
    getDiagnostics(): unknown {
      return {
        samplesEmitted: 0,
        samplesRejectedMocked: 0,
        sampleIntervalHistogramMs: [],
        accuracyDistributionM: { sampleCount: 0, minM: null, p50M: null, p95M: null },
        reducedAccuracy: false,
      };
    }
  }
  class StubClock {
    now(): number {
      return Date.now();
    }
  }
  return {
    GnssLocationProvider: class extends StubLocationProviderBase {},
    PerformanceNowClock: StubClock,
    ReplayLocationProvider: class extends StubLocationProviderBase {},
    startLifecycleListener: () => {},
  };
});

vi.mock('../../src/persistence/expoSqlDatabase', () => ({
  openAppDatabase: async () => ({ db: seeded.db, repository: seeded.repository }),
}));

vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends MultiEcuFakeTransport {
      constructor() {
        super({ answer: () => 'nrc' });
      }
    },
  };
});

/**
 * Seeds a device that recorded SESSION_A under profile A and is now set to
 * profile B -- the owner switched cars between the drive and the export.
 */
async function seedDb(options: { withSnapshot: boolean }): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  await migrateTelemetrySchema(db);
  await migrateDidSweepSchema(db);

  const circuit = bundled(TMR_CIRCUIT_ID);
  await repository.saveSession({
    sessionId: SESSION_A,
    userId: LOCAL_USER_ID,
    circuitId: circuit.profile.circuitId,
    layoutId: circuit.profile.layoutId,
    layoutVersion: circuit.profile.layoutVersion,
    startedAtUtc: '2026-09-20T09:00:00.000Z',
    laps: [],
    calibrationStatus: 'validated',
    trace: { unwrittenSampleCount: 0, failedWriteCount: 0, recordingFinalized: true },
  });

  if (options.withSnapshot) {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      `vehicle-profile-snapshot:${SESSION_A}`,
      JSON.stringify({
        profileId: 'toyota-supra-b58',
        bindings: [{ profileId: 'toyota-supra-b58', channel: 'brakePressure', ecu: 0x12, did: 0x58b7 }],
        capturedAtUtc: '2026-09-20T09:00:00.000Z',
      }),
    ]);
  }

  // Today's active profile is a DIFFERENT, empty one.
  await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    'app-settings',
    JSON.stringify({ activeVehicleProfileId: 'generic', activeVehicleProfileSource: 'user' }),
  ]);

  seeded.db = db;
  seeded.repository = repository;
  return db;
}

async function boot(): Promise<typeof import('../../src/session/composition')> {
  vi.resetModules();
  const composition = await import('../../src/session/composition');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return composition;
}

function extra(doc: unknown, source: string): { state?: string; detail?: string; data?: unknown } {
  const document = doc as { extras: { source: string; state?: string; detail?: string; data?: unknown }[] };
  return document.extras.find((row) => row.source === source) ?? {};
}

describe('P14 H7 -- an exported session carries the profile IT was recorded with', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('reports the SNAPSHOTTED profile and bindings, not the one active today', async () => {
    await seedDb({ withSnapshot: true });
    const composition = await boot();

    // Today's profile is `generic`, and it has no bindings at all.
    expect(composition.getActiveVehicleProfileId()).toBe('generic');
    expect(composition.getVehicleProfileBindingsCache()).toHaveLength(0);

    const doc = await composition.buildSessionReport(SESSION_A, '2026-09-22T12:00:00.000Z');
    expect(typeof doc).not.toBe('string');

    const profile = extra(doc, 'vehicleProfile');
    // BEFORE: `state: 'empty'`, and the detail claimed that profile "generic"
    // had no binding "so no OBD channel was decoded from one" -- about a
    // session recorded under a profile that had one.
    expect(profile.state).toBe('present');
    const data = profile.data as { profileId: string; bindings: { channel: string }[] };
    expect(data.profileId).toBe('toyota-supra-b58');
    expect(data.bindings.map((binding) => binding.channel)).toEqual(['brakePressure']);

    // Ticket P15 F2 (Codex P14 round, disclosed limit): the row says what it
    // IS -- a snapshot taken at session start -- so a reader never takes it
    // for an account of a configuration that may have changed mid-recording.
    const described = (doc as { extras: { source: string; description: string }[] }).extras.find(
      (row) => row.source === 'vehicleProfile',
    );
    expect(described?.description).toContain('snapshot taken at session start');
    expect(described?.description).toContain('changed mid-session is not visible here');
  });

  it('says UNAVAILABLE -- never today’s profile -- when no snapshot was taken', async () => {
    await seedDb({ withSnapshot: false });
    const composition = await boot();

    const doc = await composition.buildSessionReport(SESSION_A, '2026-09-22T12:00:00.000Z');
    const profile = extra(doc, 'vehicleProfile');
    expect(profile.state).toBe('unavailable');
    expect(profile.detail).toContain('deliberately NOT substituted');
    expect(profile.data).toBeNull();

    // And the document says so in `availability` too. UNAVAILABLE, not
    // `empty`: nothing went wrong, the device simply never recorded which car
    // this session was driven with -- and that is not "it had no bindings".
    const availability = (doc as { availability: { part: string; state: string }[] }).availability;
    expect(availability.find((row) => row.part === 'extras:vehicleProfile')?.state).toBe('unavailable');
  });

  it('reports the trackday journal as UNAVAILABLE for a session this app run never recorded', async () => {
    await seedDb({ withSnapshot: true });
    const composition = await boot();

    const doc = await composition.buildSessionReport(SESSION_A, '2026-09-22T12:00:00.000Z');
    const trackday = extra(doc, 'trackdayRecord');
    // BEFORE: `'empty'` -- "the trackday stage applied no cue move and showed
    // no pit suggestion in this session", said by a process that never saw it.
    expect(trackday.state).toBe('unavailable');
    expect(trackday.detail).toContain('did not record this session');
  });
});
