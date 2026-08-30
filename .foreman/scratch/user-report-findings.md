# Constatările userului la citirea paginii "Analiza tururilor TRACE" (2026-08-31) — de rezolvat TOATE la finalul citirii
F1 (secțiunea 3, tur curat/anomal) — REGULILE DE ANOMALIE SUNT PREA AGRESIVE PENTRU CIRCUIT:
  - ABS-ul se activează normal la frânări tari pe circuit → oscilațiile gen ABS NU anulează turul;
  - |longG| > 1,2 g e o frânare normală de circuit (multe frânări sunt "de urgență" ca intensitate); unele mașini trec de 1,5 g;
    userul a făcut 1,3 g în viraj cu un GR86 → pragul de g NU anulează turul;
  - derapajul controlat ("rotație") e pilotaj normal → viteza de girație "incompatibilă" NU anulează turul.
  REGULA CERUTĂ DE USER: un tur e anulabil DOAR dacă (a) e incomplet, (b) ieși în decor (off-track), (c) GPS slab / lipsă informații.
  Implicație de design: pragurile de g/yaw/ABS pot rămâne cel mult ca ETICHETE informative pe tur (nu excludere din referință/envelope) —
  de decis la implementare; envelope-ul de siguranță V2 poate folosi separat doar tururi fără off-track.
