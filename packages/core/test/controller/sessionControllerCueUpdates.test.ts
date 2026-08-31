import { describe, expect, it } from 'vitest';

import type { CircuitProfile, Corner, LocationSample, SessionMachineSnapshot } from '../../src/contracts';
import {
  CUE_POSITION_TOLERANCE_M,
  SessionController,
  VOICE_LIFT_MAX_SEVERITY,
  type CueUpdateRequest,
  type FacadeStateCore,
} from '../../src/controller';
import {
  MAX_BRAKE_LATER_M,
  sealCueEvidence,
  type CueEvidenceEntry,
  type CueUpdate,
} from '../../src/coaching';
import { analyzeCorners } from '../../src/corners';
import {
  cleanRecognitionLap,
  pbImprovementSession,
  pitLaneTransitLap,
  runtimeFor,
  sampleAtLapDistance,
} from '../../src/fixtures';
import { polylineCumulative } from '../../src/geometry';
import { InMemorySessionRepository } from '../../src/persistence';
import type { ProjectedGate, RuntimeProfile } from '../../src/profile';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P5c-B D2 — the LIVE half of the trackday flow (contracts.md R2-3a):
 * the corner-coaching cue source (`deriveBrakingZones` -> `CoachEngine`, driven
 * by `SessionController.refreshCoachZones`) accepts bounded, evidence-backed
 * cue moves between laps, and refuses everything else. The controller is the
 * last line of defence: it re-checks the safety bounds itself rather than
 * trusting whatever computed the update.
 *
 * Ticket P5c-FIX1 (Codex P5c-REV1 findings 1, 2, 3, 10) hardens exactly that
 * claim, which the first version only half kept: the controller now reads the
 * cue it is moving from ITSELF, recomputes the bound from a SEALED evidence
 * set instead of believing the update's own numbers, refuses a pass that
 * outlived its session/generation/stint, validates a cue the voice speaks as
 * "Lift." against the LIFT envelope, and re-arms the one-change allowance at a
 * pit exit without moving anything back.
 */

function coachingCorners(): Corner[] {
  return analyzeCorners(tmr().runtime);
}

/** A checkpoint the recovery flow would hand `restoreFromCheckpoint`. */
const RESTORED_SNAPSHOT: SessionMachineSnapshot = {
  state: 'armed',
  lapNumber: 0,
  context: {
    lapNumber: 0,
    priorState: null,
    pendingInvalidReasons: [],
    gnssDegraded: false,
    preflightFailureReasons: [],
  },
};

function setup(coachingEnabled: boolean, runtimeOverride?: RuntimeProfile) {
  const { profile, runtime: tmrRuntime } = tmr();
  const runtime = runtimeOverride ?? tmrRuntime;
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const scheduler = new FakeWatchdogScheduler();
  const logged: string[] = [];
  const controller = new SessionController({
    runtimeProfile: runtime,
    circuitProfile: profile,
    locationProvider: provider,
    clock,
    repository: new InMemorySessionRepository(),
    userId: 'driver-1',
    appVersion: 'cue-update-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    logger: (message) => logged.push(message),
    config: { scheduler, watchdogTimeoutMs: 5_000, watchdogPollMs: 1_000 },
    coaching: { enabled: coachingEnabled, corners: coachingCorners() },
  });
  const states: FacadeStateCore[] = [];
  controller.subscribe((s) => states.push(s));

  let wallClock = clock.now();
  let previousTMono: number | null = null;
  function feed(samples: readonly LocationSample[]): void {
    for (const sample of samples) {
      const delta = previousTMono === null ? 0 : Math.max(0, sample.tMono - previousTMono);
      previousTMono = sample.tMono;
      wallClock += delta;
      clock.set(wallClock);
      provider.push(sample);
    }
  }
  return { profile, controller, states, feed, logged };
}

async function armed(coachingEnabled: boolean, runtimeOverride?: RuntimeProfile) {
  const rig = setup(coachingEnabled, runtimeOverride);
  await rig.controller.start('calibration');
  rig.feed(cleanRecognitionLap(rig.profile, 901));
  rig.controller.acceptCalibration();
  await rig.controller.flush();
  rig.controller.arm();
  return rig;
}

function update(overrides: Partial<CueUpdate> & { cornerId: number; fromM: number; toM: number }): CueUpdate {
  return {
    point: 'brake',
    movedLaterM: overrides.fromM - overrides.toM,
    demonstratedM: overrides.toM,
    evidenceLapNumber: 2,
    cleanLapCount: 3,
    ...overrides,
  };
}

/** Evidence for BOTH spoken points of one corner, at the same demonstrated point. */
function entriesFor(cornerId: number, demonstratedM: number): CueEvidenceEntry[] {
  return (['brake', 'lift'] as const).map((point) => ({
    cornerId,
    point,
    demonstratedM,
    evidenceLapNumber: 2,
    cleanLapCount: 3,
  }));
}

/** A request sealed to the controller's OWN live context — the honest case. */
function request(
  controller: SessionController,
  entries: readonly CueEvidenceEntry[],
): CueUpdateRequest {
  const context = controller.cueContext();
  return {
    context,
    evidence: sealCueEvidence({
      sessionId: context.sessionId ?? '',
      generation: context.generation,
      stintIndex: context.stintIndex,
      entries: [...entries],
    }),
  };
}

/** The first corner with a live brake cue whose voice says the given word. */
function cueOfVoice(controller: SessionController, voice: 'lift' | 'brake') {
  const corners = coachingCorners();
  for (const cue of controller.activeCues()) {
    if (cue.brakeStartM === null) continue;
    const corner = corners.find((entry) => entry.id === cue.cornerId);
    if (corner === undefined) continue;
    const spoken = corner.severity <= VOICE_LIFT_MAX_SEVERITY ? 'lift' : 'brake';
    if (spoken === voice) return { cornerId: cue.cornerId, brakeStartM: cue.brakeStartM };
  }
  throw new Error(`expected a cue voiced as "${voice}"`);
}

describe('SessionController — live cue updates', () => {
  it('reports the live cue set as metres before each corner entry', async () => {
    const { controller } = await armed(true);
    const cues = controller.activeCues();
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.map((cue) => cue.cornerId)).toEqual([...cues.map((cue) => cue.cornerId)].sort((a, b) => a - b));
    for (const cue of cues) {
      if (cue.brakeStartM === null) continue;
      expect(cue.brakeStartM).toBeGreaterThan(0);
      expect(Number.isFinite(cue.brakeStartM)).toBe(true);
    }
  });

  it('moves the brake cue later and reports it as an applied update', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - 6;

    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, entriesFor(before.cornerId, target)),
    );

    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(target, 6);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(target, 3);
  });

  it('refuses a step larger than MAX_BRAKE_LATER_M', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - (MAX_BRAKE_LATER_M + 1);
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, entriesFor(before.cornerId, target)),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('beyond-bound');
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(before.brakeStartM, 6);
  });

  it('refuses an update that would move the cue PAST the demonstrated value', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const applied = controller.applyCueUpdates(
      [
        update({
          cornerId: before.cornerId,
          fromM: before.brakeStartM,
          toM: before.brakeStartM - 8,
          demonstratedM: before.brakeStartM - 4,
        }),
      ],
      request(controller, entriesFor(before.cornerId, before.brakeStartM - 4)),
    );
    // Clamped back onto the demonstrated point, never past it.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(before.brakeStartM - 4, 6);
    expect(applied[0]?.demonstratedM).toBeCloseTo(before.brakeStartM - 4, 6);
  });

  it('applies at most ONE change per corner per stint', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 5 })],
      request(controller, entriesFor(before.cornerId, before.brakeStartM - 5)),
    );
    const second = controller.applyCueUpdates(
      [
        update({
          cornerId: before.cornerId,
          fromM: before.brakeStartM - 5,
          toM: before.brakeStartM - 9,
        }),
      ],
      request(controller, entriesFor(before.cornerId, before.brakeStartM - 9)),
    );
    expect(second).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('already-updated-this-stint');
    expect(controller.appliedCueUpdates()).toHaveLength(1);
  });

  it('publishes applied updates on the facade state and survives a mid-session zone refresh', async () => {
    const { profile, controller, states, feed } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - 7;
    controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, entriesFor(before.cornerId, target)),
    );

    const published = states[states.length - 1]?.coachCueUpdates ?? [];
    expect(published).toHaveLength(1);
    expect(published[0]?.cornerId).toBe(before.cornerId);

    // Three successively faster laps: every one replaces the PB and rebuilds
    // the braking zones from the new reference. A cue the driver's own laps
    // moved must not be silently rolled back by that refresh.
    feed(pbImprovementSession(profile, 902));
    await controller.flush();
    expect(controller.diagnostics().coachZoneRefreshes).toBeGreaterThan(0);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(target, 3);
  });

  it('is inert when coaching is disabled — no cues, no updates, no state change', async () => {
    const { controller, states } = await armed(false);
    expect(controller.activeCues()).toEqual([]);
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: 1, fromM: 100, toM: 95 })],
        request(controller, entriesFor(1, 95)),
      ),
    ).toEqual([]);
    expect(controller.appliedCueUpdates()).toEqual([]);
    expect(states.every((state) => state.coachCueUpdates.length === 0)).toBe(true);
  });

  it('refuses an update for a corner the coaching set does not contain', async () => {
    const { controller } = await armed(true);
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: 9_999, fromM: 200, toM: 195 })],
        request(controller, entriesFor(9_999, 195)),
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('unknown-corner');
  });
});

/**
 * Ticket P5c-FIX1 E2 (Codex P5c-REV1 finding 2, HIGH): the update's own
 * `fromM`/`demonstratedM` are a CLAIM, not evidence. The controller compares
 * them with the cue it actually has and with a sealed evidence set, and
 * refuses — loudly — when they disagree.
 */
describe('SessionController — the update is validated, not trusted (E2)', () => {
  it('refuses a forged update that cites a cue position the controller does not have', async () => {
    const { controller, logged } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    // The forger claims the cue is 60 m further out than it is, so that a
    // "6 m later" move actually lands 66 m later than the real cue.
    const forgedFrom = before.brakeStartM + 60;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: forgedFrom, toM: forgedFrom - 6 })],
      request(controller, entriesFor(before.cornerId, forgedFrom - 6)),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('cue-moved-underneath');
    expect(logged.some((line) => line.includes('cue-moved-underneath'))).toBe(true);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(before.brakeStartM, 6);
  });

  it('refuses an update whose cited evidence disagrees with the sealed evidence', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const applied = controller.applyCueUpdates(
      [
        update({
          cornerId: before.cornerId,
          fromM: before.brakeStartM,
          toM: before.brakeStartM - 6,
          // Claims the driver demonstrated 6 m later; the evidence says 2 m.
          demonstratedM: before.brakeStartM - 6,
        }),
      ],
      request(controller, entriesFor(before.cornerId, before.brakeStartM - 2)),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('evidence-mismatch');
  });

  it('refuses evidence whose checksum no longer matches its contents', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const honest = request(controller, entriesFor(before.cornerId, before.brakeStartM - 2));
    const tampered: CueUpdateRequest = {
      context: honest.context,
      evidence: {
        ...honest.evidence,
        // The seal still says "2 m later"; the entries now say "9 m later".
        entries: entriesFor(before.cornerId, before.brakeStartM - 9),
      },
    };
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 9 })],
      tampered,
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['evidence-unsealed']);
  });

  it('clamps to the demonstrated point even when the update asks for more', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const demonstrated = before.brakeStartM - 3;
    const applied = controller.applyCueUpdates(
      [
        update({
          cornerId: before.cornerId,
          fromM: before.brakeStartM,
          toM: before.brakeStartM - 9,
          demonstratedM: demonstrated,
        }),
      ],
      request(controller, entriesFor(before.cornerId, demonstrated)),
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(demonstrated, 6);
    expect(applied[0]?.movedLaterM).toBeCloseTo(3, 6);
  });
});

/**
 * Ticket P5c-FIX1 E1 (Codex P5c-REV1 finding 1, HIGH): an analysis pass is
 * bound to a session, a controller generation and a stint. Anything else is a
 * pass talking about an outing that is no longer live.
 */
describe('SessionController — the apply-time context re-check (E1)', () => {
  it('refuses a pass computed for another session', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const honest = request(controller, entriesFor(before.cornerId, before.brakeStartM - 4));
    const stale: CueUpdateRequest = {
      context: { ...honest.context, sessionId: 'some-other-outing' },
      evidence: honest.evidence,
    };
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 4 })],
        stale,
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['context-mismatch']);
  });

  it('refuses a pass computed for an earlier controller generation', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const honest = request(controller, entriesFor(before.cornerId, before.brakeStartM - 4));
    const stale: CueUpdateRequest = {
      context: { ...honest.context, generation: honest.context.generation - 1 },
      evidence: honest.evidence,
    };
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 4 })],
        stale,
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['context-mismatch']);
  });

  it('mints a new generation when a recovered session is restored into this controller', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - 4;
    const stale = request(controller, entriesFor(before.cornerId, target));
    const first = controller.cueContext();

    controller.restoreFromCheckpoint('recovered-outing', RESTORED_SNAPSHOT, []);
    const second = controller.cueContext();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.sessionId).toBe('recovered-outing');

    // The pass that was in flight across the restore applies to nothing.
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
        stale,
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['context-mismatch']);
  });

  it('refuses evidence sealed for a different context even with a live context object', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const context = controller.cueContext();
    const foreign: CueUpdateRequest = {
      context,
      evidence: sealCueEvidence({
        sessionId: 'another-outing',
        generation: context.generation,
        stintIndex: context.stintIndex,
        entries: entriesFor(before.cornerId, before.brakeStartM - 4),
      }),
    };
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 4 })],
        foreign,
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['evidence-context-mismatch']);
  });
});

/**
 * Ticket P5c-FIX1 E3 (Codex P5c-REV1 finding 3, HIGH): a BRAKE cue of severity
 * 1-4 is SPOKEN as "Lift.", and lifting precedes braking — so the braking
 * envelope must not bound it.
 */
describe('SessionController — a cue voiced "Lift." is bounded by the LIFT envelope (E3)', () => {
  it('refuses to move a lift-voiced cue when the pass carried no lift evidence', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'lift');
    const brakeOnly: CueEvidenceEntry[] = [
      {
        cornerId: before.cornerId,
        point: 'brake',
        demonstratedM: before.brakeStartM - 8,
        evidenceLapNumber: 2,
        cleanLapCount: 3,
      },
    ];
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 8 })],
      request(controller, brakeOnly),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('no-evidence-for-point');
  });

  it('bounds a lift-voiced cue by the demonstrated LIFT, not the demonstrated brake point', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'lift');
    // The driver braked 8 m later at some point, but never lifted later than 2 m.
    const mixed: CueEvidenceEntry[] = [
      {
        cornerId: before.cornerId,
        point: 'brake',
        demonstratedM: before.brakeStartM - 8,
        evidenceLapNumber: 2,
        cleanLapCount: 3,
      },
      {
        cornerId: before.cornerId,
        point: 'lift',
        demonstratedM: before.brakeStartM - 2,
        evidenceLapNumber: 3,
        cleanLapCount: 3,
      },
    ];
    const applied = controller.applyCueUpdates(
      [
        update({
          cornerId: before.cornerId,
          fromM: before.brakeStartM,
          toM: before.brakeStartM - 8,
          demonstratedM: before.brakeStartM - 8,
        }),
      ],
      request(controller, mixed),
    );
    expect(applied).toHaveLength(1);
    // Clamped onto the LIFT envelope: 2 m later, not the braking evidence's 8.
    expect(applied[0]?.toM).toBeCloseTo(before.brakeStartM - 2, 6);
    expect(applied[0]?.evidenceLapNumber).toBe(3);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(before.brakeStartM - 2, 3);
  });

  it('keeps a brake-voiced cue on the braking envelope', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - 6;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, [
        {
          cornerId: before.cornerId,
          point: 'brake',
          demonstratedM: target,
          evidenceLapNumber: 4,
          cleanLapCount: 3,
        },
      ]),
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.evidenceLapNumber).toBe(4);
  });
});

/**
 * Ticket P5c-FIX1 E10 (Codex P5c-REV1 finding 10, LOW): "stint", not "outing".
 * The detector is the pipeline's own pit signal — the hysteresis-debounced
 * `inPit` state / the per-match `onPitLane` flag — so no second heuristic
 * exists to disagree with it.
 */
describe('SessionController — the stint boundary re-arms the allowance (E10)', () => {
  it('re-arms one change per corner after a pit transit, without moving the cue back', async () => {
    const { profile, controller, feed } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const firstTarget = before.brakeStartM - 4;
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: firstTarget })],
        request(controller, entriesFor(before.cornerId, firstTarget)),
      ),
    ).toHaveLength(1);
    const stintBefore = controller.cueContext().stintIndex;

    feed(pitLaneTransitLap(profile, 903));
    await controller.flush();
    expect(controller.cueContext().stintIndex).toBeGreaterThan(stintBefore);

    // The cue is still where the driver's own evidence put it...
    const between = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(between?.brakeStartM).toBeCloseTo(firstTarget, 3);

    // ...and the corner may take its ONE change of the NEW stint.
    const secondTarget = firstTarget - 3;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: firstTarget, toM: secondTarget })],
      request(controller, entriesFor(before.cornerId, secondTarget)),
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(secondTarget, 3);
  });

  it('refuses a pass computed in the previous stint', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const stale = request(controller, entriesFor(before.cornerId, before.brakeStartM - 4));
    controller.beginStint();
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 4 })],
        stale,
      ),
    ).toEqual([]);
    expect(controller.cueUpdateRejections()).toEqual(['context-mismatch']);
  });
});

/** A `ProjectedGate` placeholder that sits nowhere near anything this file
 * feeds -- so overriding `runtime.pitLane` with a synthetic one never also
 * injects a live entry/exit gate the crossing detector could fire on. */
function farAwayGate(id: string, kind: 'pitEntry' | 'pitExit'): ProjectedGate {
  return {
    gate: { id, kind, a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 0.0001 } },
    a: { e: 1_000_000, n: 1_000_000 },
    b: { e: 1_000_001, n: 1_000_000 },
    distanceM: 0,
  };
}

/**
 * A synthetic pit lane, laterally offset from the REAL TMR centerline at one
 * short stretch far from the real S/F and sector gates (H13 repro). Its own
 * entry/exit gates are placed far away (never crossed by anything this file
 * feeds), so the pipeline's crossing-based `pendingPitEntryProgressM`/
 * `pitEvidenceSamples` accumulation (`pipelineCore.ts`) NEVER engages here --
 * exactly isolating the raw, single-sample `TrackMatcher.isOnPitLane` flag
 * from the debounced session-state transition it is otherwise coupled to.
 */
function flappingPitLane(profile: CircuitProfile, atDistanceM: number, offsetM: number) {
  const runtime = runtimeFor(profile);
  const points = [atDistanceM - 30, atDistanceM, atDistanceM + 30].map((distanceM) => {
    const sample = sampleAtLapDistance(profile, distanceM, 0, { lateralOffsetM: offsetM });
    return runtime.projection.toLocal({ lat: sample.lat, lon: sample.lon });
  });
  return {
    polyline: points,
    cumulativeDistancesM: polylineCumulative(points),
    entryGate: farAwayGate('fake-pit-entry', 'pitEntry'),
    exitGate: farAwayGate('fake-pit-exit', 'pitExit'),
  };
}

/**
 * Ticket P5c-FIX2 H13 (Codex P5c-REV2 finding 13, HIGH). A driver simply
 * running a few metres wide of the racing line near a pit lane that
 * parallels the straight -- or one moment of GPS jitter -- can flip the raw,
 * undebounced `onPitLane` match flag true for a single sample and false the
 * next, with the session state never leaving `timing`. That must never
 * re-arm the one-change-per-corner allowance.
 */
describe('SessionController — a noisy raw onPitLane flag never re-arms the stint (H13)', () => {
  it('one blip on/off the pit-lane geometry, with no real pit-entry/exit, changes nothing', async () => {
    const { profile: tmrProfile } = tmr();
    const baseRuntime = runtimeFor(tmrProfile);
    // Safely between S/F and sector 1 -- nowhere near TMR's real pit gates.
    const blipDistanceM = (baseRuntime.sectorGates[0]?.distanceM ?? 1_000) / 2;
    const runtimeOverride: RuntimeProfile = {
      ...baseRuntime,
      pitLane: flappingPitLane(tmrProfile, blipDistanceM, 8),
    };

    const { controller, feed } = await armed(true, runtimeOverride);
    const before = cueOfVoice(controller, 'brake');
    const firstTarget = before.brakeStartM - 4;
    expect(
      controller.applyCueUpdates(
        [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: firstTarget })],
        request(controller, entriesFor(before.cornerId, firstTarget)),
      ),
    ).toHaveLength(1);
    const stintBefore = controller.cueContext().stintIndex;

    // Normal on-line sample, ONE blip laterally onto the synthetic pit-lane
    // geometry (onPitLane flips true for exactly one sample), then straight
    // back on line. The session state must stay OFF `inPit` throughout --
    // no real pit-entry gate was ever crossed.
    let t = 2_000_000;
    const step = (distanceM: number, offsetM = 0) => {
      const s = sampleAtLapDistance(tmrProfile, distanceM, t, { lateralOffsetM: offsetM });
      t += 750;
      return s;
    };
    feed([
      step(blipDistanceM - 60),
      step(blipDistanceM - 30),
      step(blipDistanceM, 8), // the blip: onPitLane -> true for this one sample
      step(blipDistanceM + 30),
      step(blipDistanceM + 60),
    ]);
    await controller.flush();

    expect(controller.cueContext().stintIndex).toBe(stintBefore);
    // The corner has NOT re-armed: its one change this stint is still spent.
    const secondAttempt = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: firstTarget, toM: firstTarget - 3 })],
      request(controller, entriesFor(before.cornerId, firstTarget - 3)),
    );
    expect(secondAttempt).toEqual([]);
  });
});

describe('SessionController — the cue position tolerance is tight (E2)', () => {
  it('accepts a cue reading that differs by less than the tolerance', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const drifted = before.brakeStartM + CUE_POSITION_TOLERANCE_M / 2;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: drifted, toM: drifted - 5 })],
      request(controller, entriesFor(before.cornerId, drifted - 5)),
    );
    expect(applied).toHaveLength(1);
    // The APPLIED numbers are the controller's own, not the caller's reading.
    expect(applied[0]?.fromM).toBeCloseTo(before.brakeStartM, 6);
  });

  // Ticket P5c-FIX2 L17 (Codex P5c-REV2 finding 17, LOW): the prior test suite
  // only ever exercised ACCEPTANCE below the tolerance. These pin the OTHER
  // side of the same boundary.
  it('rejects a cue reading just ABOVE the tolerance (cue-moved-underneath)', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const drifted = before.brakeStartM + CUE_POSITION_TOLERANCE_M + 0.01;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: drifted, toM: drifted - 5 })],
      request(controller, entriesFor(before.cornerId, drifted - 5)),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('cue-moved-underneath');
  });
});

describe('SessionController — the MAX_BRAKE_LATER_M clamp edge is exact (L17)', () => {
  it('accepts a step of EXACTLY MAX_BRAKE_LATER_M', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - MAX_BRAKE_LATER_M;
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, entriesFor(before.cornerId, target)),
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(target, 6);
  });

  it('rejects a step of MAX_BRAKE_LATER_M + 0.01 (beyond-bound)', async () => {
    const { controller } = await armed(true);
    const before = cueOfVoice(controller, 'brake');
    const target = before.brakeStartM - (MAX_BRAKE_LATER_M + 0.01);
    const applied = controller.applyCueUpdates(
      [update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target })],
      request(controller, entriesFor(before.cornerId, target)),
    );
    expect(applied).toEqual([]);
    expect(controller.cueUpdateRejections()).toContain('beyond-bound');
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(before.brakeStartM, 6);
  });
});
