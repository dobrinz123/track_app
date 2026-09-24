# Voice lab

Listening comparison + the local neural voice engines. Open **Studio → Voci** (`Studio.bat`, then the *Voci* tab).

Each local model lives in its own venv, so their conflicting torch pins never touch the main pipeline
(which stays on system Python and calls `synth.py` as a subprocess). RTX 50xx cards need CUDA 12.8 wheels.

```
# Kokoro (Apache 2.0) — .venv
python -m venv .venv
.venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/python -m pip install kokoro soundfile

# Chatterbox (MIT) — .venv-cb; it pins torch 2.6 (no RTX 50xx support), so install it without deps
python -m venv .venv-cb
.venv-cb/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
.venv-cb/Scripts/python -m pip install --no-deps chatterbox-tts
.venv-cb/Scripts/python -m pip install "numpy<2" librosa==0.11.0 s3tokenizer transformers==5.2.0 diffusers==0.29.0 resemble-perth conformer==0.3.2 safetensors==0.5.3 pyloudnorm omegaconf soundfile
```

Use one in the engine by setting `voices.en` in `config.yaml` (the Studio button does this for you):

```yaml
voices:
  en: { engine: chatterbox, voice: calm }     # or { engine: kokoro, voice: am_michael }
```

Caption timings for local engines come from faster-whisper, aligned back to the script's words.

Files: `samples/` (same text, every voice), `clips/` (the same finished clip per voice), `checks.json`
(Whisper transcript + word error rate per sample — catches voices that skip or invent words),
`gen_*.py` (sample generators), `render_clips.py`, `candidates.py` (what the Voci page lists).
Chatterbox output carries Resemble's inaudible Perth watermark.
