import { migrateProfile } from './migration';
import { validateProfile, type ProfileValidationResult } from './validation';

export const MAX_PROFILE_JSON_BYTES = 5 * 1024 * 1024;

export function loadProfileFromJson(json: string): ProfileValidationResult {
  try {
    if (new TextEncoder().encode(json).byteLength > MAX_PROFILE_JSON_BYTES) {
      return { ok: false, errors: ['PROFILE_TOO_LARGE'] };
    }
    const raw: unknown = JSON.parse(json);
    return validateProfile(migrateProfile(raw));
  } catch (error) {
    if (error instanceof Error && error.message === 'UNSUPPORTED_SCHEMA_VERSION') {
      return { ok: false, errors: ['UNSUPPORTED_SCHEMA_VERSION'] };
    }
    return { ok: false, errors: ['INVALID_JSON'] };
  }
}

