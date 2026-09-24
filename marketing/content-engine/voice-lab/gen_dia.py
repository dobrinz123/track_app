import time, torch, re
from transformers import AutoProcessor, DiaForConditionalGeneration
ckpt = "nari-labs/Dia-1.6B-0626"
proc = AutoProcessor.from_pretrained(ckpt)
model = DiaForConditionalGeneration.from_pretrained(ckpt, torch_dtype=torch.bfloat16).to("cuda")
text = open('sample_text.txt', encoding='utf-8').read()
# Dia is best at 5-20 s per pass; two halves at a sentence boundary.
sents = re.split(r'(?<=[.!?])\s+', text); half = len(sents) // 2
parts = [' '.join(sents[:half]), ' '.join(sents[half:])]
for seed in (1, 2, 3):
    t = time.time(); outs = []
    for p in parts:
        torch.manual_seed(seed)
        inputs = proc(text=[f"[S1] {p}"], padding=True, return_tensors="pt").to("cuda")
        out = model.generate(**inputs, max_new_tokens=2600, guidance_scale=3.0, temperature=1.2, top_p=0.9, top_k=45)
        outs.append(proc.batch_decode(out)[0])
    for i, o in enumerate(outs):
        proc.save_audio([o], f"samples/_dia_s{seed}_p{i}.wav")
    print('dia seed', seed, f'{time.time()-t:.1f}s', flush=True)
