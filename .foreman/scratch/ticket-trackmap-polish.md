TASK: Two visual fixes on the calibration track map (user feedback on live preview): (1) the outline's corners stick out of / touch the map container edges — must be fully contained with a safe margin on a phone screen; (2) the line looks CHOPPY ("sacadat") — rotated 2px segments leave visible notches at joins; must read as one smooth continuous line. Designs BINDING.

P1 Containment:
  - trackMapModel.ts fitCenterline (and the auto-rotated wrapper): add an inner margin parameter marginFrac (default 0.06) — the fitted content occupies the central (1 - 2*marginFrac) of each axis, letterboxed as today. Tested: all projected fractions within [marginFrac - epsilon, 1 - marginFrac + epsilon] for a known input; existing pins updated to pass marginFrac 0 where they assert exact fills.
  - TrackMapView.tsx: container style gains overflow: 'hidden'; marker/dot positions subtract their own radius so an edge marker never renders past the boundary.
  - Container sizing on ActiveCalibrationScreen: width = screen width minus the screen's standard horizontal padding (as today), height chosen so the ROTATED track's aspect fits without cropping: derive height from the fit's used aspect (expose the post-rotation content aspect from the model) clamped to [0.4, 0.75] * width. Nothing may clip on a 360pt-wide phone.
P2 Smoothness:
  - densify to a target segment length: replace the fixed ~2x densification with densifyToSpacing(centerline, targetSpacingM = 12) (pure, tested: max segment length <= target within tolerance), then decimation cap raised to 400.
  - joint dots: buildOutlineSegments also returns joints: [{x, y}] (one per vertex); TrackMapView renders each joint as a filled circle with diameter == line thickness (2px) in the same color, absolutely positioned centered on the joint — this rounds every join and removes the notches. Joint layer memoized with the outline.
  - line thickness to 2.5px for visibility at phone DPI (constant).
P3 Verify: run the four gates (typecheck, test, lint, expo export — real exit codes). Visual verification is done by the LEAD afterwards — do not claim visual results.

CONTEXT: Repo D:\CODE\APLICTIE_Circuit, commit 2693193. Files: apps/mobile/src/session/trackMapModel.ts, apps/mobile/src/ui/components/TrackMapView.tsx, apps/mobile/src/ui/screens/ActiveCalibrationScreen.tsx, apps/mobile/test/session/trackMapModel.test.ts. Read all four first. Keep the loop-closure semantics (modulo pairing) intact.
CONSTRAINTS: No new deps; pure math in model; surgical.
MUST NOT: No subagents. Nothing outside the four files.
WRITE SET: the four files.
OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then per-design confirmation + pinning tests; gate exit codes + counts; concerns.
