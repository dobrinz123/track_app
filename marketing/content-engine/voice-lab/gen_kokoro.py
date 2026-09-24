import time, numpy as np, soundfile as sf
from kokoro import KPipeline
text = open('sample_text.txt', encoding='utf-8').read()
for lang, voices in (('a', ['am_michael', 'am_fenrir', 'am_puck', 'af_heart', 'af_bella']), ('b', ['bm_george', 'bm_fable'])):
    pipe = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M')
    for v in voices:
        t = time.time()
        audio = np.concatenate([np.asarray(a) for _, _, a in pipe(text, voice=v, speed=1.0)])
        sf.write(f'samples/kokoro_{v}.wav', audio, 24000)
        print(v, f'{len(audio)/24000:.1f}s audio in {time.time()-t:.1f}s', flush=True)
