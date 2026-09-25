# TRACE — plan de extindere pe piețe cu motorsport mare și ce circuite adăugăm

Scris 2026-09-25, continuare la `docs/business/monetizare.md`. Scopul: să știm **în ce țări** mergem după
România, **în ce ordine**, **ce circuite** intră în aplicație și **cum le validăm fără să mergem acolo**.

**Ce e fapt și ce e ipoteză.** Mecanica circuitelor (profil, geometrie OSM, trepte de validare) vine din
repo: `docs/NEXT-CIRCUIT-PLAYBOOK.md`, `docs/adding-a-circuit.md`, `docs/architecture/public-release-plan.md`
§3. **Lista de circuite și organizatorii de mai jos sunt candidați scriși din cunoștințe generale, nu
verificați live** (OpenStreetMap nu a fost accesibil din sesiunea în care s-a scris documentul). Regula
repo-ului rămâne: niciun circuit nu intră în aplicație înainte ca way-ul OSM, configurația și lungimea
să fie verificate la sursă și citate (playbook §0).

---

## 0. Recomandarea, pe scurt

1. **Aplicația merge deja pe orice circuit din lume:** un tur de învățare și circuitul e salvat
   („circuite învățate”). Deci lansarea în SUA sau UK **nu așteaptă** circuitele incluse. Circuitele
   incluse aduc confort, numerotarea virajelor și, după validare, coaching-ul live.
2. **Ordinea:**
   - **Val 1 — Europa Centrală**: circuite la care poți ajunge cu mașina din Transilvania.
   - **Val 2 — UK + Benelux/Germania**: cea mai mare piață de track day din Europa, în engleză.
   - **Val 3 — SUA**: cea mai mare piață HPDE (track day pentru amatori, cu instructori), fără
     deplasare, prin testeri locali.
3. **Valul 1 nu e ocolul, ci metoda.** Adaugi fiecare circuit din Europa Centrală **întâi din
   OpenStreetMap, fără să-l vezi**, apoi îl conduci și măsori cât de mult s-a înșelat geometria de pe
   hartă. Așa afli cât de mult poți avea încredere în OSM în SUA, unde nu poți merge.
4. **În SUA validezi prin oameni, nu prin drum:** program de testeri pe TestFlight (instructori HPDE și
   piloți locali), care îți trimit tururile lor. Plus parteneriate cu organizatorii de HPDE.
5. **O decizie îți aparține** (§4.3): o treaptă nouă de geometrie, „validată de comunitate”, care să
   permită coaching live pe circuite la care n-ai fost niciodată. Fără ea, în SUA coaching-ul live
   rămâne oprit, iar asta e diferențiatorul principal.

---

## 1. De ce SUA, dar nu primul

| Piață                                | Pentru                                                                                                                                                | Contra                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SUA**                              | cea mai mare cultură de HPDE: evenimente pentru începători, cu instructor în mașină, exact publicul TRACE; zeci de circuite; putere de cumpărare mare | nu poți valida la fața locului; concurență puternică (Garmin Catalyst e popular în HPDE); unități imperiale; răspundere juridică mai mare                                      |
| **UK**                               | foarte multe track day-uri pe an, circuite multe și apropiate unele de altele, engleză                                                                | piață matură, concurență locală                                                                                                                                                |
| **Germania / Benelux**               | Spa, Zandvoort, Nürburgring GP, Hockenheim, Bilster Berg; public cu bani                                                                              | germană/olandeză; **Nordschleife în regim Touristenfahrten e drum public cu taxă**: nu-l promova pentru cronometrare (regula din `brand/facts.yaml`: niciodată pe drum public) |
| **Italia**                           | Mugello, Imola, Misano, Vallelunga, cultură auto mare                                                                                                 | limba italiană, piață mai fragmentată                                                                                                                                          |
| **Europa Centrală** (HU, SK, CZ, AT) | **poți ajunge cu mașina și valida**; piață apropiată ca preț de RO                                                                                    | piață mică, ca România                                                                                                                                                         |

Concluzie: SUA e ținta mare, dar **o atacăm cu o metodă de validare de la distanță dovedită înainte în
Europa**, nu direct.

---

## 2. Cum alegem circuitele (criterii)

Fiecare candidat primește un scor pe:

1. **Câte track day-uri pentru amatori are pe an** și dacă organizatorii au grupe de începători.
2. **Calitatea geometriei OSM**: există un way `highway=raceway` complet, cu nume, pentru configurația
   principală? (pasul 1 din playbook)
3. **Numărul de configurații**: multe circuite din SUA au 3–5 variante (full, north, south etc.).
   Fiecare variantă e un profil separat. Începe cu configurația folosită cel mai des la HPDE.
4. **Densitatea**: circuite apropiate unele de altele aduc aceiași utilizatori pe mai multe circuite.
   Un cluster de 6 circuite într-o regiune bate 6 circuite împrăștiate pe tot continentul.
5. **Un tester local disponibil** (§4.2). Fără tester, circuitul rămâne pe treapta „mapped”.

**Semnalul de cerere, fără server:** în aplicație, un buton „Cere-ți circuitul” care deschide un
formular web (nume circuit, țară, e-mail, „vreau să fiu tester”). Cererile îți spun unde e cererea
reală. Formularul trebuie trecut în politica de confidențialitate.

---

## 3. Lista de circuite candidate, pe valuri

Toate sunt **candidați de verificat**: way OSM, configurație, lungime, sens de rulare și dacă circuitul
organizează track day-uri pentru amatori.

### Val 1 — Europa Centrală (poți conduce acolo; 3–6 luni)

| Circuit           | Țară     | De ce                                                                           |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| Hungaroring       | Ungaria  | cel mai aproape de Transilvania dintre circuitele mari; track day-uri frecvente |
| Pannonia-Ring     | Ungaria  | popular la track day-uri, mai ales moto; aproape de Hungaroring                 |
| Balaton Park      | Ungaria  | circuit nou, în aceeași călătorie                                               |
| Slovakia Ring     | Slovacia | track day-uri pentru amatori; pe drumul spre Brno                               |
| Automotodrom Brno | Cehia    | circuit mare, calendar de track day-uri                                         |
| Red Bull Ring     | Austria  | nume cunoscut, bun pentru marketing                                             |
| Serres Circuit    | Grecia   | alternativă spre sud, pentru piloții din Bulgaria și Grecia                     |

O singură călătorie de o săptămână poate acoperi Hungaroring, Pannonia, Balaton Park și Slovakia Ring.

### Val 2 — UK + Benelux/Germania (6–12 luni)

| Circuit                   | Țară     | De ce                                                                                  |
| ------------------------- | -------- | -------------------------------------------------------------------------------------- |
| Brands Hatch (Indy)       | UK       | unul dintre cele mai folosite circuite de track day                                    |
| Donington Park (National) | UK       | calendar mare de track day-uri                                                         |
| Silverstone (National)    | UK       | nume cunoscut, bun pentru marketing                                                    |
| Snetterton (300)          | UK       | multe track day-uri pentru începători                                                  |
| Oulton Park               | UK       | popular, cu mai multe configurații                                                     |
| Cadwell Park              | UK       | popular la track day-uri                                                               |
| Bedford Autodrome         | UK       | folosit de școli de pilotaj, multe configurații                                        |
| Spa-Francorchamps         | Belgia   | track day-urile de aici atrag piloți din toată Europa                                  |
| Zandvoort                 | Olanda   | track day-uri, nume cunoscut                                                           |
| Nürburgring GP-Strecke    | Germania | doar circuitul GP la track day-uri organizate, **nu** Nordschleife la Touristenfahrten |
| Hockenheimring            | Germania | track day-uri, nume cunoscut                                                           |
| Bilster Berg              | Germania | circuit privat, foarte popular la track day-uri                                        |

### Val 3 — SUA (12+ luni), pe clustere

Nu adăuga circuite peste tot odată. Alege **un cluster**, câștigă acolo, apoi treci la următorul.

**Cluster A — California (recomandat primul):** densitate mare de circuite și de organizatori HPDE,
cultură auto mare.

| Circuit                                         | De ce                                                        |
| ----------------------------------------------- | ------------------------------------------------------------ |
| WeatherTech Raceway Laguna Seca                 | cel mai cunoscut nume, bun pentru marketing                  |
| Sonoma Raceway                                  | HPDE frecvent în nordul Californiei                          |
| Thunderhill Raceway                             | foarte folosit de organizatorii HPDE; mai multe configurații |
| Buttonwillow Raceway                            | multe configurații; foarte popular în sudul Californiei      |
| Willow Springs (Big Willow / Streets of Willow) | popular pentru începători                                    |
| Chuckwalla Valley Raceway                       | popular în sudul Californiei                                 |

**Cluster B — circuitele „naționale”** (nume pe care orice pasionat din SUA le știe):
Road Atlanta, Road America, Watkins Glen, Virginia International Raceway, Mid-Ohio, Barber Motorsports
Park, Sebring, Circuit of the Americas.

**Cluster C — Texas și Nord-Est** (după ce ai testeri acolo): MSR Houston, Harris Hill, Eagles Canyon,
Lime Rock, New Jersey Motorsports Park, Summit Point, Pittsburgh International Race Complex.

---

## 4. Cum adaugi și validezi un circuit la care nu poți merge

### 4.1 Treptele de geometrie (din repo)

Motorul are deja trei trepte (`public-release-plan.md` §3, ticketul P17): `surveyed` / `mapped` /
`learned`. Pe scurt:

- **Pe orice geometrie declarată** merg cronometrajul, analiza pe viraj și sugestiile din boxă, fiindcă
  analiza e auto-referențială: toate tururile tale se compară pe aceeași linie.
- **Coaching-ul live** (reperele vocale la viteză) cere `'official'`, fiindcă e singura afirmație pe care
  aplicația o face în timp real, fără să-și arate dovada.

Deci un circuit adăugat doar din OSM e util din prima zi: cronometraj + raport pe viraj + Pit view, cu
numerotarea virajelor marcată ca fiind a noastră.

### 4.2 Pașii pentru fiecare circuit nou

1. **Geometria din OSM**, cu pipeline-ul existent (playbook §2): way-uri arhivate în `data/osm/`,
   profil generat determinist, atribuire ODbL, `geometryStatus: 'community-derived'`.
2. **Verificarea de birou**: lungimea din profil comparată cu lungimea publicată de circuit; numărul de
   viraje comparat cu harta oficială a circuitului; sensul de rulare.
3. **Tester local**: un pilot sau instructor de acolo, pe TestFlight, conduce o zi normală de track day și
   îți trimite sesiunea.
4. **Comparația**: tururile testerului proiectate pe linia din OSM. Cât de departe e urma GPS de
   centrul pistei, pe fiecare viraj? Unde e linia de start/sosire față de cea reală (o poză de la tester)?
5. **Corectura și avansarea**: corectezi geometria (și în OSM, dacă e greșită acolo — contribuie înapoi),
   apoi circuitul trece pe treapta următoare.

**Ce lipsește în aplicație pentru asta** (muncă de programare, de planificat separat):

- **Un export de sesiune pentru validare**: fișier cu urma GPS, trimis voluntar de tester, cu acordul
  lui explicit. Azi nu există: `rawSessionShare.ts` e cod mort (`public-release-plan.md` §4.1). Trebuie
  trecut în politica de confidențialitate.
- **Un instrument intern** (script în repo, nu în aplicație) care primește sesiunile testerilor și
  scoate raportul de abatere pe viraj.

### 4.3 Decizia ta: treapta „validată de comunitate”

Azi coaching-ul live cere `'official'`, adică geometrie dintr-un document oficial. În SUA, fără ea,
coaching-ul live nu pornește nicăieri. Propunere:

- **„Validată de comunitate”** = cel puțin **3 piloți diferiți**, cel puțin **20 de ture curate** în
  total, abatere mediană a urmei GPS față de linie sub un prag de stabilit (în metri), linia de
  start/sosire confirmată cu o poză, numerotarea virajelor luată de pe harta oficială a circuitului (cu
  permisiune).
- Pe treapta asta, coaching-ul live pornește, dar **marcat vizibil** ca validat de comunitate, nu oficial.

E o schimbare a porții de onestitate, deci **o decizie de produs care îți aparține**, nu una tehnică.
Pragurile trebuie calibrate pe Valul 1, unde ai adevărul de teren.

### 4.4 Parteneriate care înlocuiesc drumul

- **Circuitele**: cere harta oficială, poziția buclei de cronometrare și numerotarea oficială a
  virajelor. În schimb le oferi co-marketing. Un circuit care îți dă aceste date poate trece la
  `'official'` fără deplasare (`monetizare.md` §7, faza 4).
- **Organizatorii de HPDE și școlile de pilotaj**: Pro gratuit pentru instructori („coach ambassador”).
  Un instructor care folosește aplicația cu elevii lui e și tester, și canal de vânzare.

---

## 5. Cum ajungi la publicul de acolo

| Canal                            | Europa                                                                                   | SUA                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Organizatori de track day / HPDE | organizatorii de track day din fiecare țară                                              | organizatorii HPDE naționali și regionali, cluburile de marcă (Porsche, BMW)  |
| Comunități online                | grupuri Facebook de track day pe țări, forumuri                                          | Reddit (comunitățile de track day și autocross), grupuri Facebook pe circuite |
| Video scurt                      | content engine-ul existent (`marketing/content-engine/`) produce deja clipuri în engleză | aceleași clipuri, cu harta circuitului local                                  |
| Instructori                      | ambasadori Pro gratuit                                                                   | ambasadori Pro gratuit — cel mai important canal în HPDE                      |
| Circuite                         | recepție, afișe, co-marketing                                                            | idem, începând cu clusterul ales                                              |

Pentru fiecare val, content engine-ul primește circuitele noi în `brand/facts.yaml` (lista de circuite
incluse), ca să le poată menționa fără să inventeze.

---

## 6. Ce trebuie pregătit în aplicație și în afaceri

| Ce                                | Pentru                       | Stare                                                                                                                                             |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engleză completă                  | UK, SUA                      | există (RO/EN)                                                                                                                                    |
| Unități imperiale (mph, ft)       | SUA, UK                      | viteza are deja setarea km/h / mph (`apps/mobile/src/ui/format.ts`); verifică distanțele (numărătoarea în metri până la viraj, raportul) și vocea |
| Buton „Cere-ți circuitul”         | toate                        | de făcut                                                                                                                                          |
| Export de sesiune pentru validare | testerii de la distanță      | de făcut (§4.2)                                                                                                                                   |
| Treapta „validată de comunitate”  | coaching live fără deplasare | decizia ta (§4.3)                                                                                                                                 |
| Prețuri în dolari                 | SUA                          | App Store setează automat pe țară; verifică 9,99 $ / 59,99 $                                                                                      |
| Termeni pentru SUA                | răspundere juridică mai mare | avocat; ia în calcul o asigurare de răspundere civilă înainte de SUA                                                                              |
| Pachetul cu adaptor OBD           | Europa                       | în SUA, trimis din RO e scump: acolo recomandă adaptorul prin afiliere (Amazon) până ai un depozit local                                          |
| Pod-ul (V2) în SUA                | mai târziu                   | pe lângă CE, cere și certificare FCC; nu intră în Valul 3                                                                                         |

---

## 7. Calendarul propus

| Perioadă                      | Ce faci                                                                                     | Rezultat                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Acum → lansare                | Validezi TMR și MotorPark; construiești exportul de validare și butonul „Cere-ți circuitul” | metoda de validare, testată acasă                         |
| Primele 3–6 luni după lansare | **Val 1**: 5–7 circuite din Europa Centrală, adăugate din OSM și apoi conduse               | știi cât de precis e OSM; calibrezi pragurile pentru §4.3 |
| 6–12 luni                     | **Val 2**: UK + Benelux/Germania, cu testeri locali și parteneriate cu circuitele           | prima piață mare, în engleză                              |
| 12+ luni                      | **Val 3**: SUA, clusterul California întâi, cu instructori HPDE ca testeri                  | intrarea pe cea mai mare piață                            |

La fiecare val, **cererile din „Cere-ți circuitul” pot schimba ordinea circuitelor**. Dacă vin 50 de
cereri pentru un circuit din afara listei, acela trece primul.

---

## 8. Riscuri

| Risc                                                          | Ce faci                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Geometria din OSM e greșită și nu afli, fiindcă nu ești acolo | treapta „mapped” nu pornește coaching-ul live; testerii locali prind erorile      |
| Nu găsești testeri într-o regiune                             | circuitul rămâne pe „mapped”, util oricum pentru cronometraj și analiză           |
| Circuite cu multe configurații                                | un profil pe configurație; începi cu cea folosită la HPDE                         |
| Concurență în SUA (Garmin Catalyst, RaceChrono, Harry's)      | preț mult sub Catalyst, coaching în trei momente, fără hardware obligatoriu       |
| Nordschleife în regim de drum public                          | nu apare ca circuit de cronometrare; doar circuitul GP, la evenimente organizate  |
| Răspundere juridică în SUA                                    | termeni revizuiți de avocat, asigurare, mesajele „doar pe circuit” deja existente |
