import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

export interface LifecycleCallbacks {
  /** App came to (or started in) the foreground. */
  onActive?: () => void;
  /** App was backgrounded (home screen / other app) — used later for checkpoint-on-background. */
  onBackground?: () => void;
  /** iOS-only transitional state (multitasking view, Notification Center, incoming call). */
  onInactive?: () => void;
  /** Fires on every transition, including states not covered above, with the raw status. */
  onChange?: (state: AppStateStatus) => void;
}

export interface LifecycleController {
  stop: () => void;
  getCurrentState: () => AppStateStatus;
}

/**
 * Thin wrapper over React Native's `AppState` (per
 * `.foreman/scratch/platform-research.md` §10 "Process Death & State
 * Restoration" / "React Native: AppState API") that dedupes repeated events
 * for the same status and dispatches to named callbacks for the common
 * `active`/`background`/`inactive` transitions.
 *
 * This ticket only wires the listener utility; the checkpoint-on-background
 * behavior it will drive (flush SQLite / session snapshot per
 * platform-research.md §10 "Practical Impact on Lap-Timing") is out of
 * scope here and left for the session-orchestration work package.
 */
export function startLifecycleListener(callbacks: LifecycleCallbacks): LifecycleController {
  let previous: AppStateStatus = AppState.currentState;

  const handleChange = (next: AppStateStatus): void => {
    callbacks.onChange?.(next);
    if (next === previous) return;
    previous = next;
    if (next === 'active') callbacks.onActive?.();
    else if (next === 'background') callbacks.onBackground?.();
    else if (next === 'inactive') callbacks.onInactive?.();
  };

  const subscription: NativeEventSubscription = AppState.addEventListener('change', handleChange);

  return {
    stop: () => subscription.remove(),
    getCurrentState: () => AppState.currentState,
  };
}
