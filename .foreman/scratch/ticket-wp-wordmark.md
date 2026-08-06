TASK: Turn the S1 header into a proper TRACE brand hero, visually in-theme with the logo (metallic silver + glowing amber telemetry gradient on near-black). Tasteful and premium — not flashy.

EXPECTED OUTCOME: `npm run typecheck`, `npm run lint` pass from repo root; `npm run export:ios` exits 0 in apps/mobile. Paste decisive output. Do NOT start any dev server (the foreman runs one on port 8081 and will review visually).

CONTEXT: Read first: apps/mobile/src/ui/screens/CircuitSelectionScreen.tsx (current brandRow: TraceLogo 44px + kicker CIRCUITS + heading TRACE), apps/mobile/src/ui/components/TraceLogo.tsx, apps/mobile/src/ui/theme/index.ts (palette: background #0A0A0C, accent #FFB300; fonts Space Grotesk/Inter/JetBrains Mono), apps/mobile/assets/trace_logo.svg (the brand reference: amber gradient #FF9100→#FFC400→#FFE57F, silver #E2E8F0→#1E293B).

CONSTRAINTS: You MAY add ONLY these deps via `npx expo install expo-linear-gradient @react-native-masked-view/masked-view` (both bundled in Expo Go — required constraint). Only files in WRITE SET. TypeScript strict. Do not touch the circuit list below the header, navigation, or any other screen.

MUST DO:
1. New component apps/mobile/src/ui/components/TraceWordmark.tsx: renders "TRACE" in Space Grotesk Bold, large (~40-44), letterSpacing ~4, with the logo's amber gradient applied to the TEXT via MaskedView + LinearGradient (gradient colors ['#FF9100','#FFC400','#FFE57F'], diagonal). Accept size/style props. Accessibility: accessibilityRole="header", label "TRACE".
2. Under the wordmark, a thin "telemetry line" motif: a 2-3px horizontal LinearGradient bar (amber fading to transparent right), width ~60% of the wordmark, echoing the logo's glowing trace. Subtle — no animation.
3. Restructure the S1 brandRow: TraceLogo at 56px, wordmark + kicker arrangement refined: kicker "CIRCUITS" stays above the wordmark in muted micro-caps; spacing balanced (logo optically aligned with the two text lines). The result must feel like one lockup, not stacked leftovers.
4. Fallback safety: if MaskedView is unavailable at runtime (web edge cases), the component must degrade to solid accent-colored text (feature-detect via try/require or Platform-safe import — document approach). No crashes on web.
5. Run `npx expo install expo-linear-gradient @react-native-masked-view/masked-view` (lockfile update expected), then all three gates.

MUST NOT: modify theme tokens, other screens/components, packages/core; no new deps beyond the two named; no dev server; no subagents; no git commit.

OUTPUT FORMAT: First line DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then files changed, commands + pasted results, limitations.

WRITE SET: apps/mobile/src/ui/components/TraceWordmark.tsx, apps/mobile/src/ui/screens/CircuitSelectionScreen.tsx (header section only), apps/mobile/package.json, package-lock.json.
