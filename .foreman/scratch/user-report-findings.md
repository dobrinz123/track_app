# Constatările userului la citirea paginii "Analiza tururilor TRACE" (2026-08-31) — de rezolvat TOATE la finalul citirii
F1 (secțiunea 3, tur curat/anomal) — REGULILE DE ANOMALIE SUNT PREA AGRESIVE PENTRU CIRCUIT:
  - ABS-ul se activează normal la frânări tari pe circuit → oscilațiile gen ABS NU anulează turul;
  - |longG| > 1,2 g e o frânare normală de circuit (multe frânări sunt "de urgență" ca intensitate); unele mașini trec de 1,5 g;
    userul a făcut 1,3 g în viraj cu un GR86 → pragul de g NU anulează turul;
  - derapajul controlat ("rotație") e pilotaj normal → viteza de girație "incompatibilă" NU anulează turul.
  REGULA CERUTĂ DE USER: un tur e anulabil DOAR dacă (a) e incomplet, (b) ieși în decor (off-track), (c) GPS slab / lipsă informații.
  Implicație de design: pragurile de g/yaw/ABS pot rămâne cel mult ca ETICHETE informative pe tur (nu excludere din referință/envelope) —
  de decis la implementare; envelope-ul de siguranță V2 poate folosi separat doar tururi fără off-track.
F2 (secțiunea 6 raport / P5b UI) — RAPORTUL TREBUIE SĂ FIE INTERACTIV, NU TEXT MULT:
  - lumea nu citește paragrafe; propozițiile lungi gen exemplul T3 sunt OK doar ca RAPORT FINAL extras (export .md/JSON)
    la sfârșitul trackday-ului;
  - în aplicație: viraje pe care le atingi → detalii vizuale (cifre, badge-uri, bare/sparkline), scris minim;
  - ÎN TIMPUL trackday-ului userul vrea evoluție "live": algoritmul să ofere HINTURI ȘI SFATURI între stinturi
    (rapid, imediat după fiecare ieșire), nu doar la final.
  Notă LEAD de rezolvat la implementare: contractul de siguranță spune sugestii doar post-sesiune și opt-in — "live între
  stinturi" = post-sesiune rapid (compatibil); sfaturi în timpul condusului rămân excluse; de clarificat cu userul dacă
  vrea să activăm sugestiile (V2) acum, cu limitele existente (10 m / +3 km/h / 1 schimbare per viraj, doar în anvelopa
  demonstrată).
F3 (precizare la F2, decizia userului pe flow-ul live) — ÎN TIMPUL CONDUSULUI: FĂRĂ SFATURI, dar app-ul POATE ACTUALIZA
  brake point-urile / lift point-urile (cue-urile de coaching de pe dashboard/voce). ÎN PIT: sfaturi, INTERACTIVE —
  pilotul vede ce a greșit în tururile trecute și unde a pierdut secunde, ca să intre pe circuit știind pe ce se
  concentrează.
  Notă LEAD pentru rezolvare: actualizarea cue-urilor ÎN MERS e o revizuire a contractului de siguranță (azi: schimbări
  doar post-sesiune). Propunerea de reconciliere, de validat cu userul la final: actualizările în mers rămân STRICT în
  anvelopa demonstrată pe tururi curate din ACEEAȘI ieșire (niciodată mai agresive decât ce a făcut deja pilotul),
  cu limitele 10 m / +3 km/h / 1 schimbare per viraj per stint; orice sugestie dincolo de demonstrat = doar în pit,
  interactiv, opt-in.
