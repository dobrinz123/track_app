import { describe, expect, it } from 'vitest';

import type { Corner, LocationSample } from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { MAX_BRAKE_LATER_M, type CueUpdate } from '../../src/coaching';
import { analyzeCorners } from '../../src/corners';
import { cleanRecognitionLap, pbImprovementSession } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P5c-B D2 — the LIVE half of the trackday flow (contracts.md R2-3a):
 * the corner-coaching cue source (`deriveBrakingZones` -> `CoachEngine`, driven
 * by `SessionController.refreshCoachZones`) accepts bounded, evidence-backed
 * cue moves between laps, and refuses everything else. The controller is the
 * last line of defence: it re-checks the safety bounds itself rather than
 * trusting whatever computed the update.
 */

function coachingCorners(): Corner[] {
  return analyzeCorners(tmr().runtime);
}

function setup(coachingEnabled: boolean) {
  const { profile, runtime } = tmr();
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const scheduler = new FakeWatchdogScheduler();
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
  return { profile, controller, states, feed };
}

async function armed(coachingEnabled: boolean) {
  const rig = setup(coachingEnabled);
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
    const before = controller.activeCues().find((cue) => cue.brakeStartM !== null);
    if (before === undefined || before.brakeStartM === null) throw new Error('expected a brake cue');
    const target = before.brakeStartM - 6;

    const applied = controller.applyCueUpdates([
      update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target }),
    ]);

    expect(applied).toHaveLength(1);
    expect(applied[0]?.toM).toBeCloseTo(target, 6);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(target, 3);
  });

  it('refuses a step larger than MAX_BRAKE_LATER_M', async () => {
    const { controller } = await armed(true);
    const before = controller.activeCues().find((cue) => cue.brakeStartM !== null);
    if (before === undefined || before.brakeStartM === null) throw new Error('expected a brake cue');
    const applied = controller.applyCueUpdates([
      update({
        cornerId: before.cornerId,
        fromM: before.brakeStartM,
        toM: before.brakeStartM - (MAX_BRAKE_LATER_M + 1),
      }),
    ]);
    expect(applied).toEqual([]);
    const after = controller.activeCues().find((cue) => cue.cornerId === before.cornerId);
    expect(after?.brakeStartM).toBeCloseTo(before.brakeStartM, 6);
  });

  it('refuses an update that would move the cue PAST the demonstrated value', async () => {
    const { controller } = await armed(true);
    const before = controller.activeCues().find((cue) => cue.brakeStartM !== null);
    if (before === undefined || before.brakeStartM === null) throw new Error('expected a brake cue');
    const applied = controller.applyCueUpdates([
      update({
        cornerId: before.cornerId,
        fromM: before.brakeStartM,
        toM: before.brakeStartM - 8,
        demonstratedM: before.brakeStartM - 4,
      }),
    ]);
    expect(applied).toEqual([]);
  });

  it('applies at most ONE change per corner per stint', async () => {
    const { controller } = await armed(true);
    const before = controller.activeCues().find((cue) => cue.brakeStartM !== null);
    if (before === undefined || before.brakeStartM === null) throw new Error('expected a brake cue');
    controller.applyCueUpdates([
      update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: before.brakeStartM - 5 }),
    ]);
    const second = controller.applyCueUpdates([
      update({
        cornerId: before.cornerId,
        fromM: before.brakeStartM - 5,
        toM: before.brakeStartM - 9,
      }),
    ]);
    expect(second).toEqual([]);
    expect(controller.appliedCueUpdates()).toHaveLength(1);
  });

  it('publishes applied updates on the facade state and survives a mid-session zone refresh', async () => {
    const { profile, controller, states, feed } = await armed(true);
    const before = controller.activeCues().find((cue) => cue.brakeStartM !== null);
    if (before === undefined || before.brakeStartM === null) throw new Error('expected a brake cue');
    const target = before.brakeStartM - 7;
    controller.applyCueUpdates([
      update({ cornerId: before.cornerId, fromM: before.brakeStartM, toM: target }),
    ]);

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
    expect(controller.applyCueUpdates([update({ cornerId: 1, fromM: 100, toM: 95 })])).toEqual([]);
    expect(controller.appliedCueUpdates()).toEqual([]);
    expect(states.every((state) => state.coachCueUpdates.length === 0)).toBe(true);
  });

  it('refuses an update for a corner the coaching set does not contain', async () => {
    const { controller } = await armed(true);
    expect(controller.applyCueUpdates([update({ cornerId: 9_999, fromM: 200, toM: 195 })])).toEqual([]);
  });
});
