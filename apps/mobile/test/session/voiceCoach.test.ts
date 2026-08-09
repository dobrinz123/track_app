import { describe, expect, it, vi } from 'vitest';
import type { CoachCue } from '@circuit/core';
import type { FacadeState, SessionFacade } from '../../src/session/facade';
import type { AppSettings, SettingsStore } from '../../src/session/settingsStore';
import { DEFAULT_SETTINGS } from '../../src/session/settingsStore';
import { phraseForCue, startVoiceCoach, type VoiceCoachSpeaker } from '../../src/session/voiceCoach';

// Hoisted so `vi.mock` below (itself hoisted above every import by Vitest)
// can reference it. `startVoiceCoach`'s DEFAULT speaker only ever reaches
// `expo-speech` through a lazy `import('expo-speech')` inside the speaker
// functions -- this mock intercepts that dynamic import the same way it
// would a static one.
const speechMock = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(async () => undefined),
}));

vi.mock('expo-speech', () => speechMock);

function baseState(overrides: Partial<FacadeState> = {}): FacadeState {
  return {
    sessionState: 'timing',
    lapNumber: 1,
    currentLapMs: 0,
    lastLapMs: null,
    pbMs: null,
    delta: null,
    sector: 0,
    gnssQuality: 'good',
    calibration: null,
    calibrationResult: null,
    laps: [],
    speedKph: null,
    coachCue: null,
    lastError: null,
    ...overrides,
  };
}

/** Minimal in-test `SessionFacade` double -- `startVoiceCoach` only ever calls `subscribe()`; every command is an unused no-op. */
class FakeFacade implements SessionFacade {
  private readonly listeners = new Set<(s: FacadeState) => void>();
  private current: FacadeState = baseState();

  emit(state: FacadeState): void {
    this.current = state;
    for (const listener of [...this.listeners]) listener(state);
  }

  subscribe(cb: (s: FacadeState) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => {
      this.listeners.delete(cb);
    };
  }
  startPreflight(): void {}
  beginCalibration(): void {}
  acceptCalibration(): void {}
  rejectCalibration(): void {}
  arm(): void {}
  endSession(): void {}
  pause(): void {}
  resume(): void {}
}

class FakeSettingsStore implements SettingsStore {
  private settings: AppSettings;
  private readonly listeners = new Set<(s: AppSettings) => void>();

  constructor(initial: AppSettings) {
    this.settings = initial;
  }

  getSettings(): AppSettings {
    return this.settings;
  }
  subscribe(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb);
    cb(this.settings);
    return () => {
      this.listeners.delete(cb);
    };
  }
  update(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    for (const listener of [...this.listeners]) listener(this.settings);
  }
}

function brakeCue(overrides: Partial<CoachCue> = {}): CoachCue {
  return {
    kind: 'BRAKE',
    cornerId: 3,
    severity: 5,
    direction: 'left',
    distanceToTargetM: 40,
    advisorySpeedKph: 90,
    confidence: 0.9,
    ...overrides,
  };
}

function cornerAheadCue(overrides: Partial<CoachCue> = {}): CoachCue {
  return {
    kind: 'CORNER_AHEAD',
    cornerId: 2,
    severity: 3,
    direction: 'right',
    distanceToTargetM: 120,
    advisorySpeedKph: 130,
    confidence: 0.8,
    ...overrides,
  };
}

/** Records both speaker methods, in call order, so tests can assert stop-before-speak ordering as well as call counts. */
function recordingSpeaker(): { speaker: VoiceCoachSpeaker; calls: string[] } {
  const calls: string[] = [];
  const speaker: VoiceCoachSpeaker = {
    speak: (text) => {
      calls.push(`speak:${text}`);
    },
    stop: async () => {
      calls.push('stop');
    },
  };
  return { speaker, calls };
}

/** Flushes the microtask chain `speakCue()`'s `await`s run on. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('phraseForCue', () => {
  it('BRAKE phrase: "Brake. Corner {id}, {severity word}." -- severity word buckets per the binding ticket spec', () => {
    expect(phraseForCue(brakeCue({ severity: 1 }))).toBe('Brake. Corner 3, easy.');
    expect(phraseForCue(brakeCue({ severity: 2 }))).toBe('Brake. Corner 3, easy.');
    expect(phraseForCue(brakeCue({ severity: 3 }))).toBe('Brake. Corner 3, medium.');
    expect(phraseForCue(brakeCue({ severity: 4 }))).toBe('Brake. Corner 3, medium.');
    expect(phraseForCue(brakeCue({ severity: 5 }))).toBe('Brake. Corner 3, hard.');
    expect(phraseForCue(brakeCue({ severity: 6 }))).toBe('Brake. Corner 3, hairpin.');
  });

  it('CORNER_AHEAD phrase: "Corner {id}, {left|right}, {speed}." with the advisory speed rounded', () => {
    expect(phraseForCue(cornerAheadCue({ cornerId: 7, direction: 'right', advisorySpeedKph: 129.6 }))).toBe(
      'Corner 7, right, 130.',
    );
    expect(phraseForCue(cornerAheadCue({ cornerId: 1, direction: 'left', advisorySpeedKph: 64.4 }))).toBe(
      'Corner 1, left, 64.',
    );
  });
});

describe('startVoiceCoach (dedupe + gating, custom speaker double)', () => {
  it('speaks once for a new cue when coaching and voice are both enabled', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();

    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(1);
  });

  it('never speaks when voiceCoachEnabled is false, even with coachingEnabled true and a live cue', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: false });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();

    expect(calls).toHaveLength(0);
  });

  it('never speaks when coachingEnabled is false, even with voiceCoachEnabled true', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: false, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: cornerAheadCue() }));
    await flush();

    expect(calls).toHaveLength(0);
  });

  it('never speaks while coachCue is null, and a toggle flip mid-session is honored on the NEXT cue without a fresh subscription', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: false });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: null }));
    await flush();
    expect(calls).toHaveLength(0);

    settingsStore.update({ voiceCoachEnabled: true });
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();

    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(1);
  });

  it('dedupes the SAME cue (cornerId+kind) on the SAME lap -- speaks exactly once across repeated facade emissions', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    const cue = brakeCue();
    facade.emit(baseState({ lapNumber: 1, coachCue: cue }));
    await flush();
    facade.emit(baseState({ lapNumber: 1, coachCue: cue }));
    await flush();
    facade.emit(baseState({ lapNumber: 1, coachCue: { ...cue } }));
    await flush();

    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(1);
  });

  it('the SAME cornerId+kind speaks again on a LATER lap (per-lap rearm, matching CoachEngine.reset() at S/F crossing)', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();
    facade.emit(baseState({ lapNumber: 1, coachCue: null }));
    await flush();
    facade.emit(baseState({ lapNumber: 2, coachCue: brakeCue() }));
    await flush();

    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(2);
  });

  it('a different kind for the SAME corner on the SAME lap (CORNER_AHEAD then BRAKE) speaks twice -- distinct dedupe keys', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: cornerAheadCue({ cornerId: 5 }) }));
    await flush();
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 5 }) }));
    await flush();

    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(2);
  });

  it('always calls stop() BEFORE speak() for every new cue (never queue-stack)', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();

    expect(calls[0]).toBe('stop');
    expect(calls[1]?.startsWith('speak:')).toBe(true);
  });

  it('a speaker.stop() rejection never throws out of the facade subscription and does not block speak()', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const calls: string[] = [];
    const speaker: VoiceCoachSpeaker = {
      speak: (text) => calls.push(`speak:${text}`),
      stop: async () => {
        throw new Error('stop failed (test double)');
      },
    };

    expect(() => {
      startVoiceCoach(facade, settingsStore, speaker);
      facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    }).not.toThrow();
    await flush();

    expect(calls).toHaveLength(1);
  });

  it('a speaker.speak() throw never throws out of the facade subscription', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const speaker: VoiceCoachSpeaker = {
      speak: () => {
        throw new Error('speak failed (test double)');
      },
      stop: async () => {},
    };

    expect(() => {
      startVoiceCoach(facade, settingsStore, speaker);
      facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    }).not.toThrow();
    await flush();
  });

  it('dispose() unsubscribes from the facade -- cues emitted afterward are never spoken', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    const controller = startVoiceCoach(facade, settingsStore, speaker);
    controller.dispose();
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();

    expect(calls).toHaveLength(0);
  });
});

describe('startVoiceCoach (default speaker, mocked expo-speech)', () => {
  it('the default speaker resolves the SAME mocked expo-speech module through its lazy dynamic import, calling stop() then speak() with the English phrase', async () => {
    speechMock.speak.mockClear();
    speechMock.stop.mockClear();

    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });

    startVoiceCoach(facade, settingsStore); // no speaker override -- exercises the real `defaultSpeaker`
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    // Two flushes: one for `speakCue()`'s `await speaker.stop()`, one for the
    // dynamic `import('expo-speech')` inside the default speaker's `speak()`.
    await flush();
    await flush();

    expect(speechMock.stop).toHaveBeenCalledTimes(1);
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
    expect(speechMock.speak.mock.calls[0]![0]).toBe('Brake. Corner 3, hard.');
  });

  it('zero expo-speech calls when disabled, using the default speaker too', async () => {
    speechMock.speak.mockClear();
    speechMock.stop.mockClear();

    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: false });

    startVoiceCoach(facade, settingsStore);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();
    await flush();

    expect(speechMock.stop).not.toHaveBeenCalled();
    expect(speechMock.speak).not.toHaveBeenCalled();
  });
});
