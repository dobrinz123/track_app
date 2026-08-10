import type { CoachCue } from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';
import type { SettingsStore } from './settingsStore';
import { formatSpeedSpoken } from '../ui/format';
import { startLifecycleListener } from '../platform';

/**
 * Phase 3 coaching addendum: optional voice cues over `expo-speech`. Advisory
 * only, like every other coaching surface (contracts.md's Coaching addendum)
 * -- a failed/unavailable speech engine must never affect the session, so
 * every real `expo-speech` call is wrapped in try/catch here and nothing in
 * this module ever throws out to its caller.
 */

/** Minimal surface this module needs from `expo-speech` -- lets tests substitute a plain mock instead of the real native module. */
export interface VoiceCoachSpeaker {
  speak(text: string): void;
  /** Interrupts any in-progress utterance and clears the queue (never queue-stack). */
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
 * Short English phrase for a cue, per the binding ticket spec (F1/F2/F5
 * fixes). Exported for direct unit testing. `units` defaults to `'kmh'` so
 * every existing call site that doesn't yet care about the setting keeps
 * behaving exactly as before.
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
  speaker: VoiceCoachSpeaker = defaultSpeaker,
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

  /** Enqueues one cue's stop-then-speak pair onto the chain; never lets a rejection propagate out (voice failure must never affect the session or stall future cues). */
  function enqueueSpeak(cue: CoachCue, units: 'kmh' | 'mph'): void {
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
          speaker.speak(phraseForCue(cue, units));
        } catch {
          // Voice failure must never affect the session.
        }
      });
  }

  /** Enqueues a bare `stop()` onto the chain (M-voice-lifecycle fix) -- background transition or a mid-session toggle-off. Guarded the same way `enqueueSpeak` is. */
  function enqueueStop(): void {
    voiceChain = voiceChain.then(() => speaker.stop()).catch(() => undefined);
  }

  const unsubscribeFacade = facade.subscribe((state: FacadeState) => {
    if (trackedLap !== state.lapNumber) {
      trackedLap = state.lapNumber;
      spokenThisLap.clear();
    }

    const settings = settingsStore.getSettings();
    if (!settings.coachingEnabled || !settings.voiceCoachEnabled) return;

    const cue = state.coachCue;
    if (cue === null) return;

    const key = cueKey(cue);
    if (spokenThisLap.has(key)) return;
    spokenThisLap.add(key);

    enqueueSpeak(cue, settings.units);
  });

  const unsubscribeSettings = settingsStore.subscribe((settings) => {
    const voiceIsOn = settings.coachingEnabled && settings.voiceCoachEnabled;
    if (voiceWasOn && !voiceIsOn) enqueueStop();
    voiceWasOn = voiceIsOn;
  });

  const lifecycle = startLifecycleListener({
    onBackground: () => enqueueStop(),
  });

  return {
    dispose(): void {
      unsubscribeFacade();
      unsubscribeSettings();
      lifecycle.stop();
    },
  };
}
