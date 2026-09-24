import re, time, sys, torch, soundfile as sf
text = open('sample_text.txt', encoding='utf-8').read()
# Chatterbox is tuned for short utterances: feed it 2-3 sentence chunks and join them.
sents = re.split(r'(?<=[.!?])\s+', text)
chunks, cur = [], ''
for s in sents:
    if len((cur + ' ' + s).split()) > 28 and cur:
        chunks.append(cur); cur = s
    else:
        cur = (cur + ' ' + s).strip()
chunks.append(cur)

def run(name, model, **kw):
    t = time.time(); parts = []
    for c in chunks:
        wav = model.generate(c, **kw)
        parts += [wav.cpu(), torch.zeros(1, int(model.sr * 0.15))]
    out = torch.cat(parts, dim=1)
    sf.write(f'samples/{name}.wav', out.squeeze(0).numpy(), model.sr)
    print(name, f'{out.shape[1]/model.sr:.1f}s audio in {time.time()-t:.1f}s', flush=True)

torch.manual_seed(7)
which = sys.argv[1]
if which == 'base':
    from chatterbox.tts import ChatterboxTTS
    m = ChatterboxTTS.from_pretrained(device='cuda')
    run('chatterbox_default', m)
    run('chatterbox_calm', m, exaggeration=0.35, cfg_weight=0.4)
else:
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    m = ChatterboxTurboTTS.from_pretrained(device='cuda')
    run('chatterbox_turbo', m)
