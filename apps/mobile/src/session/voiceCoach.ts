import type { CoachCue } from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';
import type { SettingsStore } from './settingsStore';
import { formatSpeedSpoken } from '../ui/format';
import { startLifecycleListener } from '../platform';
import { VOICE_CLIPS } from './voiceClips.gen';
// Type-only -- erased at compile time, so this never actually loads
// `expo-audio`'s native-module entry point (mirrors `motionCapture.ts`'s
// `import type { EventSubscription } from 'expo-modules-core'`). The real
// module is only ever reached through `loadAudioModule`'s lazy dynamic
// `import()` below, same reasoning as `loadSpeechModule` for `expo-speech`.
import type { AudioPlayer, AudioStatus } from 'expo-audio';

/**
 * Phase 3 coaching addendum: voice cues, primarily a premium pre-generated
 * ElevenLabs clip pack (WP-C6) played through `expo-audio`, falling back
 * transparently to on-device `expo-speech` whenever a clip is missing or
 * fails to play (e.g. before the pack has been generated -- the checked-in
 * `voiceClips.gen.ts` ships EMPTY). Advisory only, like every other coaching
 * surface (contracts.md's Coaching addendum) -- a failed/unavailable speech
 * engine must never affect the session, so every real playback/speech call
 * is wrapped in try/catch here and nothing in this module ever throws out to
 * its caller.
 */

/**
 * Minimal surface this module needs from a speaker -- lets tests substitute
 * a plain mock instead of the real native modules. `utteranceId`, when
 * given, is the fixed vocabulary id (see `BrakeUtteranceId` below) the
 * caller is asking to be spoken; a `ClipSpeaker` uses it to pick a bundled
 * clip, and ignores it when absent. Existing implementations that only take
 * `text` (e.g. every test double in voiceCoach.test.ts) remain valid: JS
 * ignores an extra argument a callee never declared.
 */
export interface VoiceCoachSpeaker {
  speak(text: string, utteranceId?: BrakeUtteranceId): void;
  /** Interrupts any in-progress utterance/clip and clears the queue (never queue-stack). */
  stop(): Promise<void>;
}

/**
 * `expo-speech` is a native module (`requireNativeModule` at its own
 * top-level import) that vitest's pure-Node/Vite transform cannot parse --
 * mirrors why `composition.ts` never imports `../platform`'s real GNSS
 * implementation without a `vi.mock` in tests. Loading it lazily, only
 * inside the speaker functions actually invoked when a cue is spoken, keeps
 * `composition.ts`'s static import of this module (and every existing test
 * that imports composition.ts without mocking `expo-speech`) safe: the
 * dynamic `import('expo-speech')` below is never reached while
 * `voiceCoachEnabled` is `false` (the shipped default).
 */
async function loadSpeechModule(): Promise<typeof import('expo-speech')> {
  return import('expo-speech');
}

const defaultSpeaker: VoiceCoachSpeaker = {
  speak: (text) => {
    void loadSpeechModule()
      .then((Speech) => Speech.speak(text, { language: 'en-US' }))
      .catch(() => undefined);
  },
  stop: async () => {
    const Speech = await loadSpeechModule();
    await Speech.stop();
  },
};

/**
 * `expo-audio` is a native module (same reasoning as `loadSpeechModule`
 * above for `expo-speech`) -- loading it lazily, only inside `playClip`
 * below, keeps this module's own static imports (and every existing test
 * that imports `voiceCoach.ts` without mocking `expo-audio`) safe. Tests
 * substitute a fake module wholesale via `vi.mock('expo-audio', ...)`,
 * mirroring the existing `vi.mock('expo-speech', ...)`.
 */
async function loadAudioModule(): Promise<typeof import('expo-audio')> {
  return import('expo-audio');
}

export interface ClipSpeakerOptions {
  /** Static require-map of bundled clips; defaults to the generated `voiceClips.gen.ts` (EMPTY until the generator has produced audio -- MUST DO #3). */
  clips?: Partial<Record<BrakeUtteranceId, number>>;
  /** Speaker to fall back to when a clip is missing or playback fails; defaults to the plain `expo-speech` `defaultSpeaker`. */
  fallback?: VoiceCoachSpeaker;
}

/**
 * Premium pre-generated voice pack (MUST DO #3): plays a bundled mp3 clip
 * for the cue's fixed utterance id when one exists in `clips`; falls back
 * to `expo-speech` (via `fallback`, given the SAME fixed-vocabulary text as
 * the clip would have spoken -- see the deliberate-asymmetry note on
 * `phraseForCue` vs. `voiceUtteranceIdForCue`) the instant a clip is
 * missing OR playback errors. This is `startVoiceCoach`'s default speaker --
 * with the checked-in EMPTY `voiceClips.gen.ts`, every clip lookup misses,
 * so it behaves EXACTLY like plain `defaultSpeaker` until clips exist.
 */
export function createClipSpeaker(options: ClipSpeakerOptions = {}): VoiceCoachSpeaker {
  const clips = options.clips ?? VOICE_CLIPS;
  const fallback = options.fallback ?? defaultSpeaker;
  let currentPlayer: AudioPlayer | null = null;

  async function stopCurrentClip(): Promise<void> {
    const player = currentPlayer;
    currentPlayer = null;
    if (player === null) return;
    try {
      player.pause();
      player.remove();
    } catch {
      // Voice failure must never affect the session.
    }
  }

  async function playClip(moduleId: number, fallbackText: string): Promise<void> {
    try {
      const Audio = await loadAudioModule();
      const player = Audio.createAudioPlayer(moduleId);
      currentPlayer = player;
      const subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
        if (status.error) {
          subscription.remove();
          if (currentPlayer === player) currentPlayer = null;
          try {
            player.remove();
          } catch {
            // Voice failure must never affect the session.
          }
          fallback.speak(fallbackText);
        } else if (status.didJustFinish) {
          subscription.remove();
          if (currentPlayer === player) currentPlayer = null;
          try {
            player.remove();
          } catch {
            // Voice failure must never affect the session.
          }
        }
      });
      player.play();
    } catch {
      // Clip failed to load/create/play -- transparent fallback (MUST DO #3).
      currentPlayer = null;
      fallback.speak(fallbackText);
    }
  }

  return {
    speak(text, utteranceId) {
      const moduleId = utteranceId === undefined ? undefined : clips[utteranceId];
      if (moduleId === undefined) {
        fallback.speak(text);
        return;
      }
      void playClip(moduleId, text);
    },
    async stop() {
      // stop() must halt an in-flight clip (MUST DO #3) -- background
      // gating, dedupe, and the toggle-off stop all route through here
      // identically for clip and TTS utterances.
      await stopCurrentClip();
      await fallback.stop();
    },
  };
}

const SEVERITY_WORDS: Record<CoachCue['severity'], string> = {
  1: 'easy',
  2: 'easy',
  3: 'medium',
  4: 'medium',
  5: 'hard',
  6: 'hairpin',
};

function severityWord(severity: CoachCue['severity']): string {
  return SEVERITY_WORDS[severity];
}

/**
 * Long-form English phrase for a cue (F1/F2/F5 fixes' original design).
 * Exported for direct unit testing and kept as a pure utility (e.g. for a
 * future visual/accessibility transcript) -- but per the scope amendment
 * below, this is NO LONGER what gets spoken; see `voiceUtteranceIdForCue`.
 * `units` defaults to `'kmh'` so every existing call site that doesn't yet
 * care about the setting keeps behaving exactly as before.
 *
 * - BRAKE always includes the live distance-to-brake-point IN METERS (never
 *   a bare "Brake." command with no distance -- a driver hearing this must
 *   know how far away the brake point still is).
 * - CORNER_AHEAD always includes a full spoken unit word for the advisory
 *   speed (never a bare number, which a mph-setting driver could otherwise
 *   misread as already being in mph).
 */
export function phraseForCue(cue: CoachCue, units: 'kmh' | 'mph' = 'kmh'): string {
  if (cue.kind === 'BRAKE') {
    return `Brake in ${Math.round(cue.distanceToTargetM)} meters. Corner ${cue.cornerId}, ${severityWord(cue.severity)}.`;
  }
  const direction = cue.direction === 'left' ? 'left' : 'right';
  return `Corner ${cue.cornerId} ahead, ${direction}, ${formatSpeedSpoken(cue.advisorySpeedKph, units)}.`;
}

/**
 * Fixed vocabulary id for the premium clip pack's THREE bundled mp3s --
 * see `generate-voice-pack.mjs`'s `VOCABULARY` (kept in sync by hand).
 */
export type BrakeUtteranceId = 'brake-hard' | 'brake' | 'lift';

/**
 * Beginner-first voice vocabulary (GT-style callouts) -- SCOPE AMENDMENT
 * (binding product decision, 2026-08-10): the target users are beginners,
 * for whom `phraseForCue`'s long descriptive sentences are unprocessable at
 * speed. The SPOKEN vocabulary is deliberately tiny, calm, and imperative --
 * exactly THREE fixed, corner- and unit-independent callouts, mapped from
 * BRAKE severity:
 *
 * - severity 6 (hairpin)                -> "Brake hard."
 * - severity 5 (hard)                   -> "Brake."
 * - severity 1-4 (medium/easy/kink, e.g. TMR's T3/T7-style fast kinks where
 *   the observed speed drop is small)   -> "Lift."
 *
 * CORNER_AHEAD never speaks (returns `null`) -- the visual strip (corner #,
 * severity, advisory speed, live countdown) is unchanged and remains the
 * only surface for that cue. The units setting no longer affects voice at
 * all (nothing numeric is spoken); it still governs the visual strip and
 * corners list, untouched by this module.
 */
export function voiceUtteranceIdForCue(cue: CoachCue): BrakeUtteranceId | null {
  if (cue.kind !== 'BRAKE') return null;
  if (cue.severity === 6) return 'brake-hard';
  if (cue.severity === 5) return 'brake';
  return 'lift';
}

/** The three spoken words, keyed by `BrakeUtteranceId` -- kept in sync with `generate-voice-pack.mjs`'s `VOCABULARY` by hand. */
const BRAKE_UTTERANCES: Record<BrakeUtteranceId, string> = {
  'brake-hard': 'Brake hard.',
  brake: 'Brake.',
  lift: 'Lift.',
};

/** Dedupe key: cornerId + kind (lap-scoped separately via `spokenThisLap`'s per-lap clear below). */
function cueKey(cue: CoachCue): string {
  return `${cue.cornerId}:${cue.kind}`;
}

export interface VoiceCoachController {
  /** Unsubscribes from the facade and settings, and stops the app-lifecycle listener; safe to call multiple times. */
  dispose(): void;
}

/**
 * Subscribes to `facade` and, while `coachingEnabled && voiceCoachEnabled`
 * are both true, speaks each NEW `FacadeState.coachCue` exactly once --
 * deduped by `cornerId + kind + lap` (the per-lap `spokenThisLap` set is
 * cleared whenever `lapNumber` changes, matching `CoachEngine.reset()`'s own
 * per-lap rearm at S/F crossing). Settings are read fresh on every facade
 * update, so a toggle flip takes effect on the very next cue without
 * needing its own subscription for THAT purpose -- but a SEPARATE settings
 * subscription (M-voice-lifecycle fix) additionally stops any in-flight/
 * queued speech the INSTANT `coachingEnabled`/`voiceCoachEnabled` turns off,
 * rather than waiting for the next cue attempt. The app-lifecycle listener
 * (M-voice-lifecycle fix) does the same on backgrounding -- composition.ts
 * deliberately keeps the session running in the background, but speech must
 * not keep talking once the screen isn't in front of the driver.
 */
export function startVoiceCoach(
  facade: SessionFacade,
  settingsStore: SettingsStore,
  speaker: VoiceCoachSpeaker = createClipSpeaker(),
): VoiceCoachController {
  const spokenThisLap = new Set<string>();
  let trackedLap: number | null = null;
  let voiceWasOn = false;

  /**
   * Single serialized promise chain, SCOPED TO THIS `startVoiceCoach()`
   * instance (M-voice-serialization fix) -- EVERY utterance for this
   * instance's whole lifetime is `chain = chain.then(stop).then(speak)`, so
   * a rapid corner chain (e.g. C8 -> C9) can never overlap: the next
   * `stop()` never starts before the previous `stop()` AND `speak()` have
   * both settled, even if `stop()` itself is slow or rejects. A rejection
   * anywhere in the chain is caught and swallowed at that link so the chain
   * itself never breaks (a later cue must still get its turn).
   */
  let voiceChain: Promise<void> = Promise.resolve();

  /**
   * Enqueues one cue's stop-then-speak pair onto the chain; never lets a
   * rejection propagate out (voice failure must never affect the session or
   * stall future cues). CORNER_AHEAD cues resolve to `null`
   * (`voiceUtteranceIdForCue`) and are dropped here WITHOUT touching the
   * chain at all -- the scope amendment's "no voice at all" for
   * CORNER_AHEAD means there is nothing to stop-then-speak, not even a bare
   * stop.
   */
  function enqueueSpeak(cue: CoachCue): void {
    const utteranceId = voiceUtteranceIdForCue(cue);
    if (utteranceId === null) return;
    const text = BRAKE_UTTERANCES[utteranceId];
    voiceChain = voiceChain
      .then(() => speaker.stop())
      .catch(() => {
        // Voice failure must never affect the session, and must never skip
        // straight to overlapping the previous utterance -- proceed to
        // speak only after this settles, exactly as a successful stop()
        // would.
      })
      .then(() => {
        try {
          speaker.speak(text, utteranceId);
        } catch {
          // Voice failure must never affect the session.
        }
      });
  }

  /** Enqueues a bare `stop()` onto the chain (M-voice-lifecycle fix) -- background transition or a mid-session toggle-off. Guarded the same way `enqueueSpeak` is. */
  function enqueueStop(): void {
    voiceChain = voiceChain.then(() => speaker.stop()).catch(() => undefined);
  }

  // Codex re-verify MEDIUM fix: backgrounding must gate speech for the WHOLE
  // backgrounded interval, not just stop the utterance in flight at the
  // transition — the session keeps running in background by design, so new
  // cues keep arriving and would otherwise speak from a pocketed phone.
  let backgrounded = false;

  const unsubscribeFacade = facade.subscribe((state: FacadeState) => {
    if (trackedLap !== state.lapNumber) {
      trackedLap = state.lapNumber;
      spokenThisLap.clear();
    }

    if (backgrounded) return;
    const settings = settingsStore.getSettings();
    if (!settings.coachingEnabled || !settings.voiceCoachEnabled) return;

    const cue = state.coachCue;
    if (cue === null) return;

    const key = cueKey(cue);
    if (spokenThisLap.has(key)) return;
    spokenThisLap.add(key);

    enqueueSpeak(cue);
  });

  const unsubscribeSettings = settingsStore.subscribe((settings) => {
    const voiceIsOn = settings.coachingEnabled && settings.voiceCoachEnabled;
    if (voiceWasOn && !voiceIsOn) enqueueStop();
    voiceWasOn = voiceIsOn;
  });

  const lifecycle = startLifecycleListener({
    onBackground: () => {
      backgrounded = true;
      enqueueStop();
    },
    onActive: () => {
      backgrounded = false;
    },
  });

  return {
    dispose(): void {
      unsubscribeFacade();
      unsubscribeSettings();
      lifecycle.stop();
    },
  };
}
