# Voice pack (WP-C6)

How the premium coaching voice pack is generated, why the spoken vocabulary is deliberately tiny,
and how it stays inside ADR-0004's offline mandate.

## What gets spoken (beginner-first vocabulary)

The app's target users are beginners: a long descriptive sentence is unprocessable at speed. The
coaching voice is Gran Turismo-style -- **exactly three fixed, corner- and unit-independent
imperative callouts**, mapped from a `BRAKE` cue's severity (`voiceUtteranceIdForCue` in
`apps/mobile/src/session/voiceCoach.ts`):

| Severity                                                                      | Utterance id | Spoken            |
| ------------------------------------------------------------------------------ | ------------ | ------------------ |
| 6 (hairpin)                                                                    | `brake-hard` | "Brake hard."      |
| 5 (hard)                                                                       | `brake`      | "Brake."           |
| 1-4 (medium / easy / kink -- e.g. TMR's T3/T7-style fast kinks, small speed drop) | `lift`       | "Lift."            |

`CORNER_AHEAD` cues **never speak** -- the visual coaching strip (corner number, severity, advisory
speed, live countdown) is unchanged and is the only surface for that cue. The units setting
(km/h vs. mph) no longer affects voice at all, since nothing numeric is spoken; it still governs
the visual strip and corners list exactly as before.

`phraseForCue` (the original, longer descriptive-sentence phrasing) still exists in
`voiceCoach.ts` as a pure, independently-tested utility -- e.g. for a future visual/accessibility
transcript -- but it is **not** what gets spoken any more.

## Why pre-generated, why ElevenLabs

ADR-0004 requires the app to run a timed session with **zero network calls**. A cloud
text-to-speech API therefore cannot run at session time -- so the three clips are generated
**once, offline from the app**, by a script the user (or foreman) runs by hand with their own
ElevenLabs account, and the resulting mp3s are bundled into the app like any other static asset.
The app itself never talks to ElevenLabs, or to any network, at runtime; on-device `expo-speech`
remains a fully-offline fallback for whenever a clip is missing or fails to play.

## How to run the generator

```
ELEVENLABS_API_KEY=<your key> node apps/mobile/scripts/generate-voice-pack.mjs
```

(equivalently, from `apps/mobile/`: `ELEVENLABS_API_KEY=<your key> npm run generate:voice-pack`)

The key is read **only** from the `ELEVENLABS_API_KEY` environment variable -- never from a file in
this repo, and the script never logs it. Running the script with no key set still writes/refreshes
`apps/mobile/assets/voice/manifest.json` (the phrase list + a hash per phrase) and exits non-zero
with instructions; it never calls ElevenLabs in that case.

Optional flag: `--voice <voiceId>` overrides the default ElevenLabs voice (a neutral, professional
premade English voice) with any voice id from your ElevenLabs account.

What the script does, each run:

1. Writes `apps/mobile/assets/voice/manifest.json` -- the three fixed phrases, each with a content
   hash.
2. If `ELEVENLABS_API_KEY` is set: for every phrase whose mp3 is missing on disk, or whose hash
   changed since the manifest that was on disk before this run, calls the ElevenLabs
   text-to-speech API (model `eleven_turbo_v2_5`, output format `mp3_44100_64`) and writes
   `apps/mobile/assets/voice/{id}.mp3`. Already-generated, unchanged phrases are skipped --
   **idempotent**, safe to re-run at any time.
3. Regenerates `apps/mobile/src/session/voiceClips.gen.ts`, the static `require(...)` map Metro
   needs to bundle whichever clips currently exist on disk (Metro cannot resolve a dynamic
   `require(variable)`). Checked into the repo **empty** (`{}`) until clips have been generated --
   the app builds and runs correctly with an empty map, and every cue transparently falls back to
   `expo-speech`.
4. Prints the total ElevenLabs character count consumed by that run.

## Cost estimate

The vocabulary is three short phrases: "Brake hard." (11 chars), "Brake." (6 chars), "Lift."
(5 chars) -- **22 characters total** for a full from-scratch generation. This is a trivial
fraction of any ElevenLabs plan's monthly character quota (including the free tier); a full
regeneration essentially never meaningfully affects usage.

## Regeneration rules

Re-run the same command at any time -- it is safe and idempotent:

- A phrase that hasn't changed and whose mp3 already exists is **skipped** (not re-billed).
- A phrase whose text changed (i.e. `VOCABULARY` in `generate-voice-pack.mjs` was edited) is
  regenerated automatically, since its hash no longer matches the manifest on disk.
- Deleting an mp3 by hand and re-running regenerates just that one clip.
- `voiceClips.gen.ts` is always regenerated to match whatever mp3s exist on disk after the run --
  never hand-edit it.

If `VOCABULARY` in `generate-voice-pack.mjs` is ever changed, keep `BRAKE_UTTERANCES` in
`apps/mobile/src/session/voiceCoach.ts` in sync by hand -- both are intentionally tiny, hand-
maintained constants (there is nothing to derive them from any more, since the vocabulary is no
longer per-corner or per-unit).

## License / account note

Generated audio is produced under the ElevenLabs account whose API key is used to run the script
-- review that account's plan terms for usage of the generated audio. This repository never stores
or transmits an ElevenLabs API key; each user who wants to (re)generate the pack supplies their own
key via the environment variable at generation time only.

## API endpoint note

As authored, the script calls `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
?output_format=mp3_44100_64` with an `xi-api-key` header and a JSON body of `{ text, model_id }`
(see `synthesize()` in `generate-voice-pack.mjs`). If a run fails, the error includes the response
body to help diagnose it; re-check
[ElevenLabs' text-to-speech API reference](https://elevenlabs.io/docs/api-reference/text-to-speech)
before editing that function, in case the path or parameters have since changed.
