import type { CoachCue } from '@circuit/core';
import type { FacadeState, SessionFacade } from './facade';
import type { SettingsStore } from './settingsStore';

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

/** Short English phrase for a cue, per the binding ticket spec. Exported for direct unit testing. */
export function phraseForCue(cue: CoachCue): string {
  if (cue.kind === 'BRAKE') {
    return `Brake. Corner ${cue.cornerId}, ${severityWord(cue.severity)}.`;
  }
  const direction = cue.direction === 'left' ? 'left' : 'right';
  return `Corner ${cue.cornerId}, ${direction}, ${Math.round(cue.advisorySpeedKph)}.`;
}

/** Dedupe key: cornerId + kind (lap-scoped separately via `spokenThisLap`'s per-lap clear below). */
function cueKey(cue: CoachCue): string {
  return `${cue.cornerId}:${cue.kind}`;
}

/** Speaks one cue: stop (never queue-stack) then speak, each independently guarded so a failure in one never blocks/throws past this function. */
async function speakCue(cue: CoachCue, speaker: VoiceCoachSpeaker): Promise<void> {
  try {
    await speaker.stop();
  } catch {
    // Voice failure must never affect the session.
  }
  try {
    speaker.speak(phraseForCue(cue));
  } catch {
    // Voice failure must never affect the session.
  }
}

export interface VoiceCoachController {
  /** Unsubscribes from the facade; safe to call multiple times. */
  dispose(): void;
}

/**
 * Subscribes to `facade` and, while `coachingEnabled && voiceCoachEnabled`
 * are both true, speaks each NEW `FacadeState.coachCue` exactly once --
 * deduped by `cornerId + kind + lap` (the per-lap `spokenThisLap` set is
 * cleared whenever `lapNumber` changes, matching `CoachEngine.reset()`'s own
 * per-lap rearm at S/F crossing). Settings are read fresh on every facade
 * update, so a toggle flip takes effect on the very next cue without
 * needing its own subscription.
 */
export function startVoiceCoach(
  facade: SessionFacade,
  settingsStore: SettingsStore,
  speaker: VoiceCoachSpeaker = defaultSpeaker,
): VoiceCoachController {
  const spokenThisLap = new Set<string>();
  let trackedLap: number | null = null;

  const unsubscribe = facade.subscribe((state: FacadeState) => {
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

    void speakCue(cue, speaker);
  });

  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
