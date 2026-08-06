export { CURRENT_SCHEMA_VERSION, circuitProfileSchema } from './schema';
export { migrateProfile } from './migration';
export { loadProfileFromJson, MAX_PROFILE_JSON_BYTES } from './loader';
export { validateProfile } from './validation';
export type { ProfileValidationResult, ProjectedGate, RuntimeProfile } from './validation';
export { makeTestProfile } from './test-fixture';
export type { TestProfileOptions } from './test-fixture';

