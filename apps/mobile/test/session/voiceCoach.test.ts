import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachCue } from '@circuit/core';
import type { FacadeState, SessionFacade } from '../../src/session/facade';
import type { AppSettings, SettingsStore } from '../../src/session/settingsStore';
import { DEFAULT_SETTINGS } from '../../src/session/settingsStore';
import {
  createClipSpeaker,
  phraseForCue,
  startVoiceCoach,
  voiceUtteranceIdForCue,
  type VoiceCoachSpeaker,
} from '../../src/session/voiceCoach';

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

/**
 * Fake `expo-audio` player, used by the `createClipSpeaker` tests below.
 * `startVoiceCoach`'s DEFAULT speaker only ever reaches `expo-audio`
 * through `createClipSpeaker`'s lazy `import('expo-audio')`, mirroring how
 * `speechMock` above intercepts the `expo-speech` dynamic import.
 */
interface FakeAudioPlayer {
  moduleId: number;
  playing: boolean;
  paused: boolean;
  removed: boolean;
  pause: () => void;
  remove: () => void;
  play: () => void;
  listeners: Array<(status: { didJustFinish: boolean; error?: string | null }) => void>;
  addListener: (
    event: string,
    listener: (status: { didJustFinish: boolean; error?: string | null }) => void,
  ) => { remove: () => void };
  emit: (status: { didJustFinish: boolean; error?: string | null }) => void;
}

const audioMock = vi.hoisted(() => ({
  players: [] as FakeAudioPlayer[],
  createAudioPlayer: vi.fn(),
}));

vi.mock('expo-audio', () => ({
  createAudioPlayer: audioMock.createAudioPlayer,
}));

function installFakeAudioPlayerFactory(): void {
  audioMock.players.length = 0;
  audioMock.createAudioPlayer.mockReset();
  audioMock.createAudioPlayer.mockImplementation((moduleId: number) => {
    const player: FakeAudioPlayer = {
      moduleId,
      playing: false,
      paused: false,
      removed: false,
      listeners: [],
      pause: () => {
        player.paused = true;
        player.playing = false;
      },
      remove: () => {
        player.removed = true;
      },
      play: () => {
        player.playing = true;
      },
      addListener: (_event, listener) => {
        player.listeners.push(listener);
        return {
          remove: () => {
            player.listeners = player.listeners.filter((candidate) => candidate !== listener);
          },
        };
      },
      emit: (status) => {
        for (const listener of [...player.listeners]) listener(status);
      },
    };
    audioMock.players.push(player);
    return player;
  });
}

// `../platform`'s `startLifecycleListener` wraps React Native's `AppState`,
// which vitest cannot parse unmocked (mirrors `composition.ts`'s own
// documented reason for avoiding a direct `react-native` import). Captures
// every registered callback set + counts `stop()` calls so tests can drive
// a synthetic background transition and assert the lifecycle controller was
// torn down on `dispose()` (M-voice-lifecycle fix).
const lifecycleMock = vi.hoisted(() => ({
  registrations: [] as Array<{ onBackground?: () => void }>,
  stopCalls: 0,
}));

vi.mock('../../src/platform', () => ({
  startLifecycleListener: (callbacks: { onBackground?: () => void }) => {
    lifecycleMock.registrations.push(callbacks);
    return {
      stop: () => {
        lifecycleMock.stopCalls += 1;
      },
      getCurrentState: () => 'active',
    };
  },
}));

beforeEach(() => {
  installFakeAudioPlayerFactory();
});

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

/** Flushes the microtask chain `enqueueSpeak()`'s `await`s run on. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Flushes repeatedly until `predicate()` is true (or `maxAttempts` is
 * reached). `createClipSpeaker`'s `playClip` resolves a dynamic
 * `import('expo-audio')` before touching `createAudioPlayer` -- vite-node's
 * FIRST resolution of a newly-touched dynamic import in a test run can take
 * more ticks than a single `flush()` macrotask, so a fixed flush count is
 * flaky. Polling avoids over/under-waiting regardless of environment.
 */
async function flushUntil(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
}

describe('phraseForCue', () => {
  it('BRAKE phrase always includes the live distance -- "Brake in {distance} meters. Corner {id}, {severity word}."', () => {
    expect(phraseForCue(brakeCue({ severity: 1, distanceToTargetM: 120.4 }))).toBe(
      'Brake in 120 meters. Corner 3, easy.',
    );
    expect(phraseForCue(brakeCue({ severity: 2 }))).toBe('Brake in 40 meters. Corner 3, easy.');
    expect(phraseForCue(brakeCue({ severity: 3 }))).toBe('Brake in 40 meters. Corner 3, medium.');
    expect(phraseForCue(brakeCue({ severity: 4 }))).toBe('Brake in 40 meters. Corner 3, medium.');
    expect(phraseForCue(brakeCue({ severity: 5 }))).toBe('Brake in 40 meters. Corner 3, hard.');
    expect(phraseForCue(brakeCue({ severity: 6 }))).toBe('Brake in 40 meters. Corner 3, hairpin.');
  });

  it('CORNER_AHEAD phrase: "Corner {id} ahead, {left|right}, {speed} {unit word}." with the advisory speed rounded, default km/h', () => {
    expect(phraseForCue(cornerAheadCue({ cornerId: 7, direction: 'right', advisorySpeedKph: 129.6 }))).toBe(
      'Corner 7 ahead, right, 130 kilometers per hour.',
    );
    expect(phraseForCue(cornerAheadCue({ cornerId: 1, direction: 'left', advisorySpeedKph: 64.4 }))).toBe(
      'Corner 1 ahead, left, 64 kilometers per hour.',
    );
  });

  it('F5: mph setting converts and speaks "miles per hour", never a bare number', () => {
    expect(phraseForCue(cornerAheadCue({ cornerId: 9, direction: 'right', advisorySpeedKph: 112 }), 'mph')).toBe(
      'Corner 9 ahead, right, 70 miles per hour.',
    );
  });

  it('F5: km/h default is unchanged whether passed explicitly or omitted', () => {
    const cue = cornerAheadCue({ advisorySpeedKph: 90 });
    expect(phraseForCue(cue)).toBe(phraseForCue(cue, 'kmh'));
  });
});

describe('voiceUtteranceIdForCue (scope amendment: beginner-first 3-word vocabulary)', () => {
  it('severity 6 (hairpin) -> "brake-hard"', () => {
    expect(voiceUtteranceIdForCue(brakeCue({ severity: 6 }))).toBe('brake-hard');
  });

  it('severity 5 (hard) -> "brake"', () => {
    expect(voiceUtteranceIdForCue(brakeCue({ severity: 5 }))).toBe('brake');
  });

  it('severity 1-4 (medium/easy/kink) -> "lift", including a T3-style fast-kink corner (small observed speed drop)', () => {
    expect(voiceUtteranceIdForCue(brakeCue({ cornerId: 3, severity: 1 }))).toBe('lift');
    expect(voiceUtteranceIdForCue(brakeCue({ cornerId: 3, severity: 2 }))).toBe('lift');
    expect(voiceUtteranceIdForCue(brakeCue({ severity: 3 }))).toBe('lift');
    expect(voiceUtteranceIdForCue(brakeCue({ severity: 4 }))).toBe('lift');
  });

  it('is corner-id-independent -- the SAME severity maps to the SAME utterance regardless of which corner', () => {
    expect(voiceUtteranceIdForCue(brakeCue({ cornerId: 1, severity: 6 }))).toBe(
      voiceUtteranceIdForCue(brakeCue({ cornerId: 11, severity: 6 })),
    );
  });

  it('CORNER_AHEAD never speaks -- returns null regardless of severity', () => {
    expect(voiceUtteranceIdForCue(cornerAheadCue({ severity: 6 }))).toBeNull();
    expect(voiceUtteranceIdForCue(cornerAheadCue({ severity: 1 }))).toBeNull();
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
    // A BRAKE cue (not CORNER_AHEAD -- which never speaks regardless of this
    // gate, so it would trivially pass even if the gate were broken).
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
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

  it('CORNER_AHEAD cues never speak (visual strip only, scope amendment) -- a later BRAKE cue for the SAME corner and lap still speaks (distinct dedupe keys, and CORNER_AHEAD never touches the chain)', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: cornerAheadCue({ cornerId: 5 }) }));
    await flush();
    expect(calls).toHaveLength(0); // CORNER_AHEAD: no stop, no speak

    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 5, severity: 5 }) }));
    await flush();

    expect(calls).toEqual(['stop', 'speak:Brake.']);
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

  it('M-voice-serialization: rapid C8 -> C9 with a DELAYED stop() resolution never overlaps -- order preserved, C9 speaks only after C8s stop+speak both settle', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const calls: string[] = [];
    const deferred: { resolveFirstStop: (() => void) | null; stopCallCount: number } = {
      resolveFirstStop: null,
      stopCallCount: 0,
    };
    const speaker: VoiceCoachSpeaker = {
      speak: (text) => calls.push(`speak:${text}`),
      stop: () => {
        deferred.stopCallCount += 1;
        if (deferred.stopCallCount === 1) {
          calls.push('stop:start:1');
          return new Promise<void>((resolve) => {
            deferred.resolveFirstStop = () => {
              calls.push('stop:resolve:1');
              resolve();
            };
          });
        }
        calls.push(`stop:${deferred.stopCallCount}`);
        return Promise.resolve();
      },
    };

    startVoiceCoach(facade, settingsStore, speaker);
    // C8 (hairpin -- "Brake hard.") then C9 (hard -- "Brake.") in immediate
    // succession -- BEFORE the first stop() resolves.
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 8, severity: 6 }) }));
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 9, severity: 5 }) }));
    await flush();

    // Only C8's stop() has been called so far -- C9's stop() must NOT have
    // started (proves the chain, not two independent tasks racing).
    expect(calls).toEqual(['stop:start:1']);
    expect(deferred.stopCallCount).toBe(1);

    deferred.resolveFirstStop?.();
    await flush();
    await flush();

    expect(calls).toEqual([
      'stop:start:1',
      'stop:resolve:1',
      'speak:Brake hard.',
      'stop:2',
      'speak:Brake.',
    ]);
  });

  it('M-voice-lifecycle: turning coachingEnabled or voiceCoachEnabled off stops in-flight/queued speech immediately, guarded against a stop() rejection', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const stopCalls: number[] = [];
    let call = 0;
    const speaker: VoiceCoachSpeaker = {
      speak: () => {},
      stop: async () => {
        call += 1;
        stopCalls.push(call);
      },
    };

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();
    expect(stopCalls).toHaveLength(1); // the normal stop-before-speak for the cue itself

    settingsStore.update({ voiceCoachEnabled: false });
    await flush();
    expect(stopCalls).toHaveLength(2); // the toggle-off stop

    // Turning it back on, then off via coachingEnabled instead, also stops.
    settingsStore.update({ voiceCoachEnabled: true });
    await flush();
    settingsStore.update({ coachingEnabled: false });
    await flush();
    expect(stopCalls).toHaveLength(3);
  });

  it('M-voice-lifecycle: an app-background transition stops speech, guarded against a stop() rejection', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    let stopCalls = 0;
    const speaker: VoiceCoachSpeaker = {
      speak: () => {},
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 2) throw new Error('background stop failed (test double)');
      },
    };

    startVoiceCoach(facade, settingsStore, speaker);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    await flush();
    expect(stopCalls).toBe(1);

    const registration = lifecycleMock.registrations[lifecycleMock.registrations.length - 1];
    expect(() => registration?.onBackground?.()).not.toThrow();
    await flush();

    expect(stopCalls).toBe(2);
  });

  it('dispose() stops the app-lifecycle listener too', () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });
    const beforeStopCalls = lifecycleMock.stopCalls;

    const controller = startVoiceCoach(facade, settingsStore, recordingSpeaker().speaker);
    controller.dispose();

    expect(lifecycleMock.stopCalls).toBe(beforeStopCalls + 1);
  });
});

describe('startVoiceCoach (default speaker, mocked expo-speech)', () => {
  it('the default speaker resolves the SAME mocked expo-speech module through its lazy dynamic import, calling stop() then speak() with the English phrase', async () => {
    speechMock.speak.mockClear();
    speechMock.stop.mockClear();

    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: true });

    startVoiceCoach(facade, settingsStore); // no speaker override -- exercises the real `createClipSpeaker()` default, backed by the checked-in EMPTY voiceClips.gen.ts
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ severity: 5 }) }));
    // Polls rather than a fixed flush count: the chain's `await speaker.stop()`
    // (itself now an extra hop through `ClipSpeaker.stop()`) plus the dynamic
    // `import('expo-speech')` inside the fallback's `speak()` can take a
    // variable number of ticks depending on the surrounding test run. Waiting
    // for the actual call (rather than guessing a tick count) also prevents
    // this test's in-flight promise chain from leaking into the NEXT test.
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(speechMock.stop).toHaveBeenCalledTimes(1);
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
    expect(speechMock.speak.mock.calls[0]![0]).toBe('Brake.');
    // Empty clip pack -- every lookup misses, so `expo-audio` is never touched.
    expect(audioMock.createAudioPlayer).not.toHaveBeenCalled();
  });

  it('zero expo-speech calls when disabled, using the default speaker too', async () => {
    speechMock.speak.mockClear();
    speechMock.stop.mockClear();

    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({ ...DEFAULT_SETTINGS, coachingEnabled: true, voiceCoachEnabled: false });

    startVoiceCoach(facade, settingsStore);
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue() }));
    // voiceCoachEnabled is false, so `enqueueSpeak` is never even called --
    // there is nothing to positively wait for, only a generous margin to be
    // confident nothing fires late.
    for (let attempt = 0; attempt < 5; attempt += 1) await flush();

    expect(speechMock.stop).not.toHaveBeenCalled();
    expect(speechMock.speak).not.toHaveBeenCalled();
  });
});

describe('voice gated for the whole backgrounded interval (Codex re-verify MEDIUM fix)', () => {
  it('cues arriving WHILE backgrounded are silent; speech resumes after onActive', async () => {
    const facade = new FakeFacade();
    const settingsStore = new FakeSettingsStore({
      ...DEFAULT_SETTINGS,
      coachingEnabled: true,
      voiceCoachEnabled: true,
    });
    const { speaker, calls } = recordingSpeaker();

    startVoiceCoach(facade, settingsStore, speaker);
    const lifecycle = lifecycleMock.registrations[lifecycleMock.registrations.length - 1] as {
      onBackground?: () => void;
      onActive?: () => void;
    };

    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 1 }) }));
    await flush();
    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(1);

    lifecycle.onBackground?.();
    await flush();
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 2 }) }));
    await flush();
    // Nothing new spoken while pocketed — the whole interval is gated, not
    // just the utterance in flight at the transition.
    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(1);

    lifecycle.onActive?.();
    facade.emit(baseState({ lapNumber: 1, coachCue: brakeCue({ cornerId: 3 }) }));
    await flush();
    expect(calls.filter((c) => c.startsWith('speak:'))).toHaveLength(2);
  });
});

describe('createClipSpeaker (MUST DO #3: clip present vs missing -> fallback, stop-halts-clip, mixed serialization)', () => {
  beforeEach(() => {
    speechMock.speak.mockClear();
    speechMock.stop.mockClear();
  });

  it('plays the bundled clip when one exists for the utterance id, never touching expo-speech', async () => {
    const speaker = createClipSpeaker({ clips: { brake: 42 } });

    speaker.speak('Brake.', 'brake');
    await flushUntil(() => audioMock.players.length > 0);

    expect(audioMock.createAudioPlayer).toHaveBeenCalledWith(42);
    const player = audioMock.players[0]!;
    expect(player.playing).toBe(true);
    expect(speechMock.speak).not.toHaveBeenCalled();
  });

  it('falls back to expo-speech transparently when the clip map has no entry for the utterance id', async () => {
    const speaker = createClipSpeaker({ clips: {} });

    speaker.speak('Lift.', 'lift');
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(audioMock.createAudioPlayer).not.toHaveBeenCalled();
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
    expect(speechMock.speak.mock.calls[0]![0]).toBe('Lift.');
  });

  it('falls back to expo-speech when `speak()` is called with no utteranceId at all (e.g. a plain-text caller)', async () => {
    const speaker = createClipSpeaker({ clips: { brake: 42 } });

    speaker.speak('Some text');
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(audioMock.createAudioPlayer).not.toHaveBeenCalled();
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
  });

  it('falls back to expo-speech transparently the instant clip playback errors, and releases the failed player', async () => {
    const speaker = createClipSpeaker({ clips: { 'brake-hard': 7 } });

    speaker.speak('Brake hard.', 'brake-hard');
    await flushUntil(() => audioMock.players.length > 0);
    const player = audioMock.players[0]!;
    player.emit({ didJustFinish: false, error: 'decode failed' });
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(speechMock.speak).toHaveBeenCalledTimes(1);
    expect(speechMock.speak.mock.calls[0]![0]).toBe('Brake hard.');
    expect(player.removed).toBe(true);
  });

  it('a clip that finishes normally (didJustFinish) never falls back to expo-speech', async () => {
    const speaker = createClipSpeaker({ clips: { lift: 3 } });

    speaker.speak('Lift.', 'lift');
    await flushUntil(() => audioMock.players.length > 0);
    const player = audioMock.players[0]!;
    player.emit({ didJustFinish: true });
    await flush();

    expect(speechMock.speak).not.toHaveBeenCalled();
    expect(player.removed).toBe(true);
  });

  it('stop() halts an in-flight clip -- pauses and releases the player', async () => {
    const speaker = createClipSpeaker({ clips: { brake: 42 } });

    speaker.speak('Brake.', 'brake');
    await flushUntil(() => audioMock.players.length > 0);
    const player = audioMock.players[0]!;
    expect(player.playing).toBe(true);

    await speaker.stop();

    expect(player.paused).toBe(true);
    expect(player.removed).toBe(true);
  });

  it('stop() never throws even if the underlying player throws on pause/remove (voice failure must never affect the session)', async () => {
    const speaker = createClipSpeaker({ clips: { brake: 42 } });

    speaker.speak('Brake.', 'brake');
    await flushUntil(() => audioMock.players.length > 0);
    const player = audioMock.players[0]!;
    player.pause = () => {
      throw new Error('native pause failed (test double)');
    };

    await expect(speaker.stop()).resolves.toBeUndefined();
  });

  it('mixed clip/TTS serialization: stopping a clip utterance, then speaking a missing-clip utterance, halts the clip before the TTS fallback speaks', async () => {
    const speaker = createClipSpeaker({ clips: { 'brake-hard': 1 } }); // 'brake' has no bundled clip

    speaker.speak('Brake hard.', 'brake-hard');
    await flushUntil(() => audioMock.players.length > 0);
    const clipPlayer = audioMock.players[0]!;
    expect(clipPlayer.playing).toBe(true);

    await speaker.stop(); // mirrors voiceCoach's chain: always stop() before the next speak()
    speaker.speak('Brake.', 'brake');
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(clipPlayer.paused).toBe(true);
    expect(clipPlayer.removed).toBe(true);
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
    expect(speechMock.speak.mock.calls[0]![0]).toBe('Brake.');
    // The missing-clip utterance never touched expo-audio.
    expect(audioMock.createAudioPlayer).toHaveBeenCalledTimes(1);
  });

  it('defaults to the checked-in voiceClips.gen.ts VOICE_CLIPS map (currently EMPTY) when no `clips` option is given -- behaves exactly like plain expo-speech', async () => {
    const speaker = createClipSpeaker();

    speaker.speak('Brake.', 'brake');
    await flushUntil(() => speechMock.speak.mock.calls.length > 0);

    expect(audioMock.createAudioPlayer).not.toHaveBeenCalled();
    expect(speechMock.speak).toHaveBeenCalledTimes(1);
  });
});
