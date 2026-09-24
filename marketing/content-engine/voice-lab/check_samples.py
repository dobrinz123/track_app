"""Transcribe every sample with faster-whisper and score it against the source text (word error rate)."""
import json, re, subprocess, sys
from pathlib import Path
from faster_whisper import WhisperModel

ref = open('sample_text.txt', encoding='utf-8').read()
norm = lambda s: re.sub(r"[^a-z0-9' ]", ' ', s.lower().replace('-', ' ')).split()

def wer(r, h):
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / len(r)

def dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True).stdout)

model = WhisperModel('small.en', device='cpu', compute_type='int8')
results = json.loads(Path('checks.json').read_text()) if Path('checks.json').exists() else {}
for p in sorted(Path('samples').glob('*.*')):
    if p.name in results and '--all' not in sys.argv:
        continue
    segs, _ = model.transcribe(str(p), language='en')
    hyp = ' '.join(s.text for s in segs)
    results[p.name] = {'wer': round(wer(norm(ref), norm(hyp)), 3), 'seconds': round(dur(p), 1), 'transcript': hyp.strip()}
    print(f"{p.name:40} WER {results[p.name]['wer']:.3f}  {results[p.name]['seconds']}s", flush=True)
Path('checks.json').write_text(json.dumps(results, indent=1), encoding='utf-8')
