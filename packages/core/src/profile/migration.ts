import { CURRENT_SCHEMA_VERSION } from './schema';

type JsonObject = Record<string, unknown>;
type Migration = (raw: JsonObject) => JsonObject;

const migrations: Readonly<Record<number, Migration>> = {
  0: (raw) => {
    const { trackName, ...rest } = raw;
    return {
      ...rest,
      schemaVersion: 1,
      ...(typeof trackName === 'string' && rest.displayName === undefined
        ? { displayName: trackName }
        : {}),
    };
  },
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function migrateProfile(raw: unknown): unknown {
  if (!isObject(raw) || typeof raw.schemaVersion !== 'number') return raw;
  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 0) {
    throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  }

  let migrated = raw;
  let version = raw.schemaVersion;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[version];
    if (migration === undefined) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
    migrated = migration(migrated);
    if (typeof migrated.schemaVersion !== 'number' || !Number.isInteger(migrated.schemaVersion)) {
      throw new Error('UNSUPPORTED_SCHEMA_VERSION');
    }
    version = migrated.schemaVersion;
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  }
  return migrated;
}
