import { describe, expect, it } from 'vitest';

import { sampleAtLapDistance } from '../../src/fixtures';
import { SessionPipelineCore } from '../../src/controller';

import { tmr } from './testSupport';

/**
 * MUST DO #1: `CircuitProfile.corridorWidthM` (15 m for the real bundled TMR
 * profile -- `packages/core/assets/circuits/transilvania-motor-ring.v1.json`)
 * must reach the live `TrackMatcher` `SessionPipelineCore` builds, as the
 * corridor BASE, with an explicit `matcher.corridorWidthM` override still
 * winning. Proven behaviorally at the corridor boundary: `TrackMatcher.match`
 * never returns `null` for an off-corridor sample (it only degrades
 * `confidence`, see `matching/track-matcher.ts`), so a wide-vs-narrow
 * corridor is observed as a confidence swing rather than accept/reject.
 */
describe('SessionPipelineCore corridorWidthM wiring (MUST DO #1)', () => {
  it('applies PipelineCoreConfig.corridorWidthM as the matcher base', () => {
    const { profile, runtime } = tmr();
    const sample = sampleAtLapDistance(profile, 500, 0, { lateralOffsetM: 15, accuracyM: 3 });

    const narrow = new SessionPipelineCore(runtime, { corridorWidthM: 8 });
    const wide = new SessionPipelineCore(runtime, { corridorWidthM: 30 });

    const narrowResult = narrow.ingest(sample);
    const wideResult = wide.ingest(sample);

    expect(narrowResult.match).not.toBeNull();
    expect(wideResult.match).not.toBeNull();
    // 15 m is beyond an 8 m corridor (lateralScore clamps to 0) but well
    // inside a 30 m one (lateralScore = 1 - 15/30 = 0.5) -- a real
    // corridor-boundary behavioral difference, not just a config echo.
    expect(narrowResult.match!.confidence).toBe(0);
    expect(wideResult.match!.confidence).toBeGreaterThan(0.3);
  });

  it('lets an explicit matcher.corridorWidthM override the corridorWidthM base', () => {
    const { profile, runtime } = tmr();
    const sample = sampleAtLapDistance(profile, 500, 0, { lateralOffsetM: 15, accuracyM: 3 });

    // Base says narrow (8 m, would zero out confidence at 15 m lateral), but
    // the explicit matcher override says wide (30 m) -- override must win.
    const core = new SessionPipelineCore(runtime, {
      corridorWidthM: 8,
      matcher: { corridorWidthM: 30 },
    });

    const result = core.ingest(sample);
    expect(result.match).not.toBeNull();
    expect(result.match!.confidence).toBeGreaterThan(0.3);
  });

  it('defaults to the matcher/calibration engines own default (20 m) when corridorWidthM is unset', () => {
    const { runtime, profile } = tmr();
    const sample = sampleAtLapDistance(profile, 500, 0, { lateralOffsetM: 15, accuracyM: 3 });

    const core = new SessionPipelineCore(runtime, {});
    const result = core.ingest(sample);
    expect(result.match).not.toBeNull();
    // 15 m is inside the 20 m engine default (lateralScore = 1 - 15/20 =
    // 0.25, so confidence stays positive, unlike the 8 m-corridor case
    // above) -- documents the pre-fix baseline this ticket's wiring now
    // overrides for a profile whose own corridorWidthM (15 m for TMR) is
    // narrower than this default.
    expect(result.match!.confidence).toBeGreaterThan(0.15);
  });
});
