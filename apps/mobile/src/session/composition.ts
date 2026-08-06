import type { SessionFacade } from './facade';
import { MockSessionFacade } from './mockFacade';
import type { SessionHistoryStore } from './mockHistory';
import { MockSessionHistoryStore } from './mockHistory';
import type { SettingsStore } from './settingsStore';
import { InMemorySettingsStore } from './settingsStore';

/**
 * Single composition root for session-layer singletons consumed by
 * `apps/mobile/src/ui/**`. This is the ONE file a later integration work
 * package needs to touch to wire the real pipeline in: replace the
 * right-hand sides below with production implementations of the same
 * `SessionFacade` / `SessionHistoryStore` / `SettingsStore` interfaces.
 * Screens must always import `facade`, `sessionHistoryStore`, and
 * `settingsStore` from here — never `Mock*` directly.
 */
export const facade: SessionFacade = new MockSessionFacade();

export const sessionHistoryStore: SessionHistoryStore = new MockSessionHistoryStore();

export const settingsStore: SettingsStore = new InMemorySettingsStore();
