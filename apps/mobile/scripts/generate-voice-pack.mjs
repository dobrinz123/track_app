#!/usr/bin/env node
/**
 * Generates the premium coaching voice pack (WP-C6) via ElevenLabs, then
 * regenerates the checked-in static require map Metro needs to bundle it.
 * ADR-0004's offline mandate means this script is the ONLY place that ever
 * talks to the network for voice audio -- the shipped app plays only
 * pre-generated, bundled mp3s (or falls back to on-device `expo-speech`)
 * and never fetches anything at runtime.
 *
 * SCOPE AMENDMENT (binding product decision, 2026-08-10): the target users
 * are beginners, so the spoken coaching vocabulary is Gran Turismo-style --
 * exactly THREE fixed, corner- and unit-independent imperative callouts,
 * mapped from BRAKE severity by `voiceUtteranceIdForCue` in
 * apps/mobile/src/session/voiceCoach.ts:
 *
 *   severity 6 (hairpin)      -> "brake-hard" -> "Brake hard."
 *   severity 5 (hard)         -> "brake"      -> "Brake."
 *   severity 1-4 (medium/easy/kink, e.g. TMR's T3/T7-style fast kinks where
 *     the observed speed drop is small) -> "lift" -> "Lift."
 *   CORNER_AHEAD               -> never spoken (visual strip only)
 *
 * There is therefore nothing to DERIVE from the corner table or the TMR
 * profile any more -- unlike a typical per-corner voice pack, VOCABULARY
 * below is a small, hand-maintained constant kept in sync with
 * voiceCoach.ts's `BRAKE_UTTERANCES` by hand (both are tiny and stable by
 * design). This script still keeps the two-phase, idempotent, manifest+hash
 * pipeline the original per-corner design called for -- it just runs over
 * three entries instead of dozens.
 *
 * Two responsibilities, one script:
 *   1. MANIFEST (no key required): writes apps/mobile/assets/voice/manifest.json,
 *      the single source of truth for what SHOULD exist, with a content hash
 *      per phrase so re-running only regenerates what changed.
 *   2. SYNTHESIS (ELEVENLABS_API_KEY required): for every manifest entry
 *      whose phrase hash changed since the last run, or whose mp3 is
 *      missing on disk, calls the ElevenLabs text-to-speech API and writes
 *      apps/mobile/assets/voice/{id}.mp3. Always finishes by regenerating
 *      the checked-in static require map at
 *      apps/mobile/src/session/voiceClips.gen.ts (Metro needs a literal
 *      `require(...)` per bundled asset -- see that file's own header).
 *
 * Usage (the exact commands the foreman/user runs):
 *   node apps/mobile/scripts/generate-voice-pack.mjs
 *     -- writes/refreshes the manifest only; prints how to synthesize and
 *        exits non-zero, since ELEVENLABS_API_KEY is unset.
 *
 *   ELEVENLABS_API_KEY=<your key> node apps/mobile/scripts/generate-voice-pack.mjs [--voice <voiceId>]
 *     -- also synthesizes every missing/changed clip and regenerates
 *        voiceClips.gen.ts.
 *
 * The key is read ONLY from `process.env.ELEVENLABS_API_KEY` -- never from a
 * file in this repo -- and this script never logs it or any header/URL that
 * would contain it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const ASSETS_DIRECTORY = resolve(scriptDirectory, '../assets/voice');
const MANIFEST_PATH = resolve(ASSETS_DIRECTORY, 'manifest.json');
const CLIPS_MODULE_PATH = resolve(scriptDirectory, '../src/session/voiceClips.gen.ts');
// Relative import path FROM voiceClips.gen.ts (apps/mobile/src/session/) TO the assets.
const ASSET_IMPORT_PREFIX = '../../assets/voice/';

// User-selected ElevenLabs voice (voice-library link supplied 2026-08-10).
// Override with `--voice <voiceId>` (see https://elevenlabs.io/docs for the
// current voice-library IDs; any other voice ID from your account also
// works here).
const DEFAULT_VOICE_ID = 'SLniEZuwscN3JIxjTknk';
const MODEL_ID = 'eleven_turbo_v2_5'; // cheap + fast (MUST DO #2)
const OUTPUT_FORMAT = 'mp3_44100_64'; // small (MUST DO #2)

/**
 * The full spoken vocabulary -- EXACTLY three entries, per the scope
 * amendment above. Keep in sync with voiceCoach.ts's `BRAKE_UTTERANCES`.
 */
export const VOCABULARY = [
  { id: 'brake-hard', phrase: 'Brake hard.' },
  { id: 'brake', phrase: 'Brake.' },
  { id: 'lift', phrase: 'Lift.' },
];

/** First 16 hex chars of the phrase's sha256 -- enough to detect a changed phrase, short enough to read in a diff. */
export function phraseHash(phrase) {
  return createHash('sha256').update(phrase, 'utf8').digest('hex').slice(0, 16);
}

function clipFilename(id) {
  return `${id}.mp3`;
}

/** Pure, unit-testable part of the manifest generator (MUST DO #5): the phrase list + derived filename/hash, with no filesystem or network access. */
export function buildManifestEntries() {
  return VOCABULARY.map(({ id, phrase }) => ({
    id,
    phrase,
    filename: clipFilename(id),
    hash: phraseHash(phrase),
  }));
}

function readExistingManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Writes apps/mobile/assets/voice/manifest.json (MUST DO #1) and returns
 * both the freshly-written manifest and whatever manifest existed on disk
 * BEFORE this call (used by `needsGeneration` below to detect a changed
 * phrase -- comparing against the OLD hash, not the new one, which would
 * always match itself).
 */
export function writeManifest() {
  const existing = readExistingManifest();
  const manifest = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    voice: { model: MODEL_ID, outputFormat: OUTPUT_FORMAT },
    entries: buildManifestEntries(),
  };
  mkdirSync(ASSETS_DIRECTORY, { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, existing };
}

/** Idempotent generation (MUST DO #2): regenerate only when the mp3 is missing on disk, or the phrase's hash changed since the manifest previously on disk. */
function needsGeneration(entry, previousManifest) {
  const mp3Path = resolve(ASSETS_DIRECTORY, entry.filename);
  if (!existsSync(mp3Path)) return true;
  const previousEntry = previousManifest?.entries?.find((candidate) => candidate.id === entry.id);
  return previousEntry?.hash !== entry.hash;
}

/**
 * Calls the ElevenLabs text-to-speech API for one manifest entry and writes
 * the resulting mp3. NEVER logs `apiKey` or any header/URL containing it.
 *
 * Endpoint verified against ElevenLabs' docs as of this script's authoring
 * (https://elevenlabs.io/docs/api-reference/text-to-speech/convert):
 * `POST /v1/text-to-speech/{voice_id}?output_format=...` with `xi-api-key`
 * header and a JSON body of `{ text, model_id }`. If ElevenLabs has since
 * changed this path/params and a run of this script fails, re-check that
 * page (and the sibling "output formats" reference) before editing this
 * function -- the failure surfaces the response body to help diagnose it.
 */
async function synthesize(entry, voiceId, apiKey) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({ text: entry.phrase, model_id: MODEL_ID }),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `ElevenLabs request for "${entry.id}" failed: ${response.status} ${response.statusText}. ` +
        `${bodyText.slice(0, 500)} -- verify the current API path/params against ` +
        'https://elevenlabs.io/docs/api-reference/text-to-speech if this endpoint has moved.',
    );
  }
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(resolve(ASSETS_DIRECTORY, entry.filename), audioBuffer);
}

/**
 * Regenerates apps/mobile/src/session/voiceClips.gen.ts (MUST DO #3): a
 * static, literal `require(...)` per mp3 that currently exists on disk.
 * Metro cannot resolve a dynamic `require(variable)`, so every entry must
 * be spelled out literally here -- this function is the only place that
 * does. Safe to call with zero mp3s present (writes the checked-in EMPTY
 * default), and safe to call after only SOME clips exist.
 */
function generateClipsModule() {
  const availableIds = VOCABULARY.map(({ id }) => id).filter((id) =>
    existsSync(resolve(ASSETS_DIRECTORY, clipFilename(id))),
  );
  const body =
    availableIds.length === 0
      ? '{}'
      : `{\n${availableIds
          .map(
            (id) =>
              `  // eslint-disable-next-line @typescript-eslint/no-require-imports\n` +
              `  '${id}': safeRequire(() => require('${ASSET_IMPORT_PREFIX}${clipFilename(id)}')),`,
          )
          .join('\n')}\n}`;
  const safeRequireBlock =
    availableIds.length === 0
      ? ''
      : `
function safeRequire(load: () => number): number | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}
`;
  const contents = `/**
 * AUTO-GENERATED by apps/mobile/scripts/generate-voice-pack.mjs -- do not
 * hand-edit (regenerate by re-running that script; see docs/voice-pack.md).
 * Metro needs a static, literal \`require(...)\` call per bundled asset, so
 * this module lists every voice clip mp3 that currently exists under
 * apps/mobile/assets/voice/ as an explicit property. EMPTY (no \`require\`
 * calls) until clips have been generated -- the app builds and runs
 * correctly with an empty map, falling back to expo-speech for every cue
 * (MUST DO #3, ADR-0004's offline mandate: no clip here is ever fetched at
 * runtime, only bundled).
 *
 * \`safeRequire\` exists for vitest/vite-node, which has no mp3 asset pipeline:
 * there the require throws at load and the entry resolves to \`undefined\`,
 * reproducing the pre-generation (empty-map) behavior tests were written
 * against. Metro still statically collects the literal require inside the
 * thunk, so device bundling is unaffected.
 */
import type { BrakeUtteranceId } from './voiceCoach';
${safeRequireBlock}
export const VOICE_CLIPS: Partial<Record<BrakeUtteranceId, number>> = ${body};
`;
  writeFileSync(CLIPS_MODULE_PATH, contents, 'utf8');
  return availableIds;
}

function parseArguments(argv) {
  let voiceId = DEFAULT_VOICE_ID;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--voice' && argv[index + 1] !== undefined) {
      voiceId = argv[index + 1];
      index += 1;
    }
  }
  return { voiceId };
}

async function main() {
  const { manifest, existing } = writeManifest();
  process.stdout.write(`Wrote ${MANIFEST_PATH} (${manifest.entries.length} phrases).\n`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    generateClipsModule(); // keep the checked-in file in sync with whatever mp3s already exist on disk (none, on a clean checkout)
    process.stdout.write(
      'ELEVENLABS_API_KEY is not set -- manifest written, but no audio was generated (none was requested).\n' +
        'To synthesize clips, run:\n' +
        '  ELEVENLABS_API_KEY=<your key> node apps/mobile/scripts/generate-voice-pack.mjs\n' +
        'The key is read from the environment only and is never written to this repo.\n',
    );
    process.exitCode = 1;
    return;
  }

  const { voiceId } = parseArguments(process.argv.slice(2));
  let totalCharacters = 0;
  let generatedCount = 0;
  let skippedCount = 0;

  for (const entry of manifest.entries) {
    if (!needsGeneration(entry, existing)) {
      skippedCount += 1;
      continue;
    }
    process.stdout.write(`Generating "${entry.id}" (${entry.phrase.length} chars)...\n`);
    await synthesize(entry, voiceId, apiKey);
    totalCharacters += entry.phrase.length;
    generatedCount += 1;
  }

  const availableIds = generateClipsModule();
  process.stdout.write(
    `Done. Generated ${generatedCount}, skipped ${skippedCount} (unchanged). ` +
      `Bundled clips: ${availableIds.length}/${manifest.entries.length}. ` +
      `Total characters sent to ElevenLabs this run: ${totalCharacters}.\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
