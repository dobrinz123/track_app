# TRACE content engine — clipuri faceless, autonome

Produce clipuri verticale (TikTok / Reels / Shorts) care promovează TRACE: idee → script → voce în engleză →
grafică animată în stilul aplicației → subtitrări cuvânt-cu-cuvânt → MP4 + descriere cu # gata de copiat.
Fără fețe, fără footage de stock, fără GPU, fără cheie API.

## Pornire rapidă

```
pip install -r requirements.txt       # ffmpeg trebuie să fie în PATH
Studio.bat                            # sau: python server.py  ->  http://127.0.0.1:8765
```

În **TRACE Studio**:
- **Generează clip nou** — gol = următoarea idee din listă (cercetează idei noi dacă lista e goală);
  cu text = clip pe subiectul scris de tine (menționează „MotorPark" sau „Transilvania" ca să apară harta).
- Fiecare clip: player, tab-uri TikTok / Instagram / YouTube, **Copiază descrierea** (text + #hashtag-uri),
  Aprobă / Marchează postat / Respinge / Descarcă MP4.

- **Voci** (tab-ul al doilea): mostre pe același text; bifezi ☑ una sau mai multe voci → **Folosește vocile bifate**.
  Cu mai multe, clipurile le folosesc pe rând (cea folosită cel mai demult). Fiecare clip arată 🎙 vocea lui.

- **Postări** (`/posts`): postări cu imagini (carusel 5–8 slide-uri sau imagine unică, 1080×1350) cu ecranele reale ale
  aplicației; prezentare slide cu slide (săgeți / tastatură / miniaturi), descrieri pentru Instagram, Facebook, LinkedIn, X,
  PDF pentru caruselele LinkedIn. Prima dată generează **seria de prezentare** (5 postări despre diferențiator), apoi ideile
  de coaching. Randare: HTML → PNG cu Chrome/Edge headless (`engine/post_render.py`), fără dependențe noi.

Linie de comandă: `python run.py daily | research | produce --count N | status | approve ID | publish | demo`,
plus `rerender [ID...]` (refă vocea clipurilor existente, fără cost LLM) și `rerender ID --keep-voice`.

**Subiectele** vând diferențiatorul: coaching **live** (banda de viraj + callout-uri), **la boxe** (Pit view, „unde pierzi
cel mai mult") și **după sesiune** (raportul pe viraj). Fiecare clip arată unul dintre aceste ecrane; un pas Haiku de
fact-check respinge afirmațiile pe care `brand/facts.yaml` nu le susține.

**Muzică**: 8 piese Kevin MacLeod (CC BY 4.0) din pool-ul YOUTUBE_FARM; mp3-urile nu sunt în git (79 MB) — le copiezi
din `D:\CODE\YOUTUBE_FARM\assets\music\_pool\` după numele din `assets/music/credits.json`. Creditul piesei (și al vocii,
când e CC BY) se adaugă automat în descrierea fiecărui clip.

Autonom zilnic: `powershell -ExecutionPolicy Bypass -File schedule_daily.ps1` (09:00; `-At 18:30`; `-Remove`).
Rularea zilnică completează lista de idei, produce `daily.videos_per_run` clipuri și le pune la **De revizuit**.

## Cum funcționează

| Etapă | Fișier | Ce face |
|---|---|---|
| Adevărul despre produs | `brand/facts.yaml` | singurele afirmații permise + ce nu avem voie să spunem; actualizează `launch_status`/`cta` la lansare |
| Cercetare | `engine/research.py` | Haiku, **un apel → 8 idei**, echilibrate pe piloni; surse web opționale |
| Script | `engine/script.py` | un apel per clip, JSON structurat, scene: hook / point / track / timer / cta |
| Validator | `engine/guard.py` | reguli deterministe: fără „oficial", fără cifre de precizie, fără drum public, fără „descarcă acum" înainte de lansare, fără testimoniale inventate; structură obligatorie |
| Voce | `engine/tts.py`, `engine/voices.py` | edge-tts, Kokoro, Piper, Chatterbox (local, `voice-lab/`); rotație între voci; timpi pe cuvânt (WordBoundary sau faster-whisper aliniat pe script) |
| Grafică | `engine/visuals.py` | Pillow: ecranele aplicației (coaching live, Pit view, raport pe viraj, timer), harta reală a circuitului (OSM, atribuită), logo |
| Randare | `engine/render.py` | cadre direct în ffmpeg (fără PNG-uri pe disc), subtitrări ASS arse, muzică opțională din `assets/music/` |
| Publicare | `engine/publish.py` | pachet per clip; YouTube prin API oficial (opțional); TikTok/IG = export pentru upload manual |

**Nimic nu se publică singur.** `publish.auto_approve: false` și `publish.youtube.enabled: false` sunt valorile implicite.

## Economia de tokeni (din cercetarea făcută cu agenți Haiku)

Măsurat: un clip costă ~**0,004 $** (script), un lot de 8 idei ~**0,025 $**; plafon zilnic 0,50 $ (`llm.daily_budget_usd`).

Folosite, pentru că se potrivesc unui pipeline mic:
1. **Backend `claude -p` redus la minim** — director gol, fără unelte, fără setări, fără MCP, prompt de sistem propriu:
   ~1,3k tokeni de input fix pe apel, în loc de contextul complet Claude Code. Fără cheie API în program.
2. **Gândire extinsă oprită** (`MAX_THINKING_TOKENS=0`) — măsurat: tokenii de ieșire scad la jumătate pe task-uri JSON scurte.
3. **Ieșire structurată (JSON Schema)** — fără parsare de text liber și fără reîncercări de tip „repară JSON-ul".
4. **Loturi** — un apel produce 8 idei; costul fix al promptului se plătește o dată.
5. **Cache pe disc după hash** (model + prompt + schemă) — un prompt identic nu se plătește de două ori (14 zile).
6. **Dedup local** cu trigrame (Jaccard) — ideile repetate se elimină fără niciun token.
7. **Validator determinist înaintea oricărui reapel** — reparația trimite doar lista de încălcări, nu o recenzie completă.
8. **trafilatura + filtru pe cuvinte cheie** pentru surse web — pagina devine câteva propoziții relevante, plafonate la 1.200 de caractere.

Evaluate și lăsate deoparte: LLMLingua-2 (model torch greu; prompturile noastre sunt deja mici), GPTCache/cache semantic
(cache-ul exact pe hash acoperă cazul), prompt caching pe Haiku 4.5 (minimul cacheabil e 4.096 de tokeni, peste promptul nostru —
backend-ul `anthropic-api` îl marchează totuși, pentru când brief-ul crește), Message Batches API (-50%, dar cere cheie API;
merită dacă treci pe `anthropic-api` și produci zeci de clipuri pe noapte).

Repo-uri studiate: MoneyPrinterTurbo, ShortGPT, AI-Youtube-Shorts-Generator, youtube-shorts-pipeline (MIT) — am preluat
tiparul pe etape (TTS → timpi pe cuvânt → subtitrări ASS → ffmpeg), nu codul monolitic. Remotion evitat (licență comercială).

## Publicare

- **YouTube Shorts**: API-ul oficial Data v3. Setează `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`,
  apoi `publish.youtube.enabled: true`. Implicit se încarcă `private`.
- **TikTok / Instagram**: API-urile lor de postare cer aplicație auditată / cont Business. Până atunci, din Studio:
  Descarcă MP4 + Copiază descrierea. Uploaderele prin automatizare de browser încalcă ToS-ul și riscă blocarea contului.

## Teste

`python -m pytest -q tests` — validator, dedup, subtitrări, descrieri, geometria circuitelor.
