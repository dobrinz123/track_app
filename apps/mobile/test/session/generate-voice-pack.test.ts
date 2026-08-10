import { describe, expect, it } from 'vitest';
import { buildManifestEntries, phraseHash, VOCABULARY } from '../../scripts/generate-voice-pack.mjs';

/**
 * Unit tests for the generator's pure part (MUST DO #5) -- phrase
 * derivation and hashing, with no filesystem or network access. The
 * ElevenLabs-calling half of the script is deliberately NOT exercised here
 * (MUST NOT: never call ElevenLabs during tests).
 */
describe('generate-voice-pack.mjs (pure phrase derivation)', () => {
  it('VOCABULARY is exactly the three beginner-vocabulary callouts (scope amendment), corner- and unit-independent', () => {
    expect(VOCABULARY).toEqual([
      { id: 'brake-hard', phrase: 'Brake hard.' },
      { id: 'brake', phrase: 'Brake.' },
      { id: 'lift', phrase: 'Lift.' },
    ]);
  });

  it('phraseHash is a deterministic, stable function of the phrase text alone', () => {
    expect(phraseHash('Brake.')).toBe(phraseHash('Brake.'));
    expect(phraseHash('Brake.')).not.toBe(phraseHash('Brake hard.'));
  });

  it('buildManifestEntries: pinned snapshot -- id, phrase, filename, and hash for all three entries (hashes hard-coded, not recomputed, so a hash-function regression is actually caught)', () => {
    expect(buildManifestEntries()).toEqual([
      {
        id: 'brake-hard',
        phrase: 'Brake hard.',
        filename: 'brake-hard.mp3',
        hash: 'ebdc0852519ca8d8',
      },
      {
        id: 'brake',
        phrase: 'Brake.',
        filename: 'brake.mp3',
        hash: '4f0f578126abcde0',
      },
      {
        id: 'lift',
        phrase: 'Lift.',
        filename: 'lift.mp3',
        hash: '008878673537a2c4',
      },
    ]);
  });

  it('buildManifestEntries is pure -- calling it twice returns equal (not aliased-mutable) results', () => {
    expect(buildManifestEntries()).toEqual(buildManifestEntries());
  });
});
