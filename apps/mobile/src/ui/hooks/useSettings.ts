import { useEffect, useState } from 'react';
import type { AppSettings, SettingsStore } from '../../session/settingsStore';

/** Subscribes a component to a `SettingsStore`'s live value for its lifetime. */
export function useSettings(store: SettingsStore): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(() => store.getSettings());

  useEffect(() => {
    return store.subscribe(setSettings);
  }, [store]);

  return settings;
}
