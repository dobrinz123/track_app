# Handoff pentru agenții locali — monetizare, adaptor OBD, extindere pe circuite

Scris 2026-09-25 de sesiunea din cloud. Pentru sesiunea lead locală și workerii ei.

**Citește întâi:** `docs/HANDOFF.md` (regulile de lucru, mai ales regula 1: review încrucișat înainte de
orice build), apoi documentele de afaceri din același director:

- `docs/business/monetizare.md` — free vs Pro, prețuri, V1 (adaptor OBD) și V2 (pod), economia pe unitate.
- `docs/business/expansiune-piete-circuite.md` — țări, ordinea valurilor, circuite candidate, validarea
  de la distanță.

Toată munca e pe branch-ul `claude/epic-goldberg-eay7at` (PR
[dobrinz123/track_app#4](https://github.com/dobrinz123/track_app/pull/4)). **Nimic nu a fost construit sau
instalat pe telefon.**

---

## 1. Ce a făcut sesiunea din cloud

### 1.1 Documente (fără cod)

| Fișier                                       | Ce conține                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/business/monetizare.md`                | modelul freemium, prețurile, V1 = Pro anual + adaptor OBD BLE (79,99 €), V2 = pod, costul real al prototipului (270 $), scenarii                            |
| `docs/business/expansiune-piete-circuite.md` | valurile: Europa Centrală → UK/Benelux/DE → SUA; criterii de alegere; validarea de la distanță; treapta „validată de comunitate” (decizie a proprietarului) |
| acest fișier                                 | sarcinile pentru agenții locali                                                                                                                             |

### 1.2 Cod: validarea geometriei din tururile testerilor (commit `2fc2498`)

Totul în `packages/core`, pur TypeScript, fără React Native. **Nu a trecut încă prin review-ul încrucișat
(Codex) cerut de HANDOFF regula 1** — asta e sarcina L0.

| Fișier                                              | Ce face                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/geometryValidation/assessGeometryDeviation.ts` | proiectează urmele GPS ale testerilor pe linia circuitului; raport general și pe viraj: abaterea laterală (mediană cu semn, mediană absolută, p95), fracțiunea de puncte în afara benzii de pistă, numărul de piloți; verdict `community-verified-candidate` / `insufficient-evidence` / `geometry-mismatch` cu motive |
| `src/geometryValidation/validationExportCodec.ts`   | formatul fișierului trimis de tester (versiune 1, validat cu zod, strict: nu acceptă câmpuri în plus, ca un nume; plafon de 20 MB)                                                                                                                                                                                     |
| `scripts/assess-geometry.ts`                        | CLI: `npm run assess:geometry -- --profile <circuit.json> [--on-track-lateral-m <m>] <export.json>...` → raport JSON; refuză exporturile pentru alt circuit sau altă versiune de layout                                                                                                                                |
| `test/geometryValidation/*.test.ts`                 | 11 teste: potrivire, dovezi insuficiente, viraj deplasat, precizie slabă, puncte din paddock, intrare goală, configurație invalidă, codec                                                                                                                                                                              |

Verificat în cloud: `npm run typecheck` (0), `npm run lint` (0 erori; cele 6 avertismente sunt deja pe
`main`), `npm test` (core: 117 fișiere, 1849 de teste; mobile: 147 fișiere, 1627 de teste; toate verzi,
inclusiv cele 11 noi), CLI rulat pe exporturi sintetice ale TMR, cu cazurile de eroare.

**Pragurile implicite sunt provizorii** (`DEFAULT_GEOMETRY_VALIDATION_CONFIG`: precizie ≤ 10 m, minim 3
piloți, 20 de ture curate, 10 puncte pe viraj, max 5% puncte în afara benzii, max 10% pe viraj). Se
calibrează pe circuitele din Valul 1, unde avem și adevărul de teren.

**O limită de știut:** linia ideală folosește lățimea pistei, deci abaterea față de linia de centru e
normală. De aceea verdictul se uită la fracțiunea de puncte **în afara benzii de pistă**
(`onTrackLateralM`, implicit `corridorWidthM` din profil), nu la abaterea medie.

---

## 2. Sarcinile pentru agenții locali

Ordinea recomandată: L0 → L1 → L2 → L3 → L5 → L6. L4 și L7 așteaptă decizii sau conturi.

Pentru fiecare: porțile complete (`npm run typecheck && npm test && npm run lint` +
`cd apps/mobile && npx expo export --platform ios`), review încrucișat înainte de build, verificare
vizuală în preview-ul web pentru orice ecran nou, și regula „nimic din memorie” pentru fapte externe.

### L0 — Review încrucișat al commit-ului din cloud

- **Ce:** review Codex pe `2fc2498` (modulul `geometryValidation`, CLI-ul, `package.json`).
- **De ce:** HANDOFF regula 1. Sesiunea din cloud n-a avut Codex.
- **Atenție la:** proiecția punctelor pe linie la virajele care trec peste start/sosire
  (`isInsideCorner` cu `entry > exit`), eșantioane fără `accuracyM` (sunt respinse intenționat), CLI-ul
  rulat prin `vite-node` (dependență tranzitivă a `vitest`, nu declarată direct — decide dacă o declari).
- **Gata când:** findings rezolvate sau motivate, porțile verzi.

### L1 — Transport OBD prin Bluetooth (BLE) în aplicație — blocant pentru V1

- **De ce:** pachetul V1 (Pro anual + adaptor OBD BLE) nu se poate vinde fără el. Aplicația citește azi
  OBD **doar prin WiFi/TCP** (`apps/mobile/src/session/tcpObdTransport.ts`); nu există nicio bibliotecă
  BLE în `apps/mobile/package.json`. Aceeași muncă e necesară pentru pod (V2), care vorbește tot BLE.
- **Ce:**
  1. Alege o bibliotecă BLE compatibilă cu **Expo SDK 57** și cu build-ul de dev-client (verifică la
     sursă: config plugin, New Architecture, iOS + Android). Documentează alegerea într-un ADR.
  2. Un `BleObdTransport` lângă `tcpObdTransport`, peste `elm327Session` din `@circuit/core` (transportul
     trebuie să respecte același contract ca cel TCP). ELM327 BLE = UART peste GATT; UUID-urile
     serviciului și caracteristicilor **se verifică pe adaptorul real** (iKiKin V03H4, Vgate iCar Pro BLE,
     Veepeak OBDCheck BLE), nu din memorie.
  3. Setări: tipul adaptorului (WiFi / BLE), scanare și împerechere, ultimul adaptor reținut.
  4. Texte de permisiune BLE (iOS `NSBluetoothAlwaysUsageDescription`, Android) în stilul celor existente
     (`docs/legal/permission-strings.md`), plus politica de confidențialitate și etichetele App Store.
  5. Transport simulat pentru teste, ca `simulatedTransport` din core.
- **Gata când:** pe telefon, cu un adaptor BLE real, pedala (PID 0x49/0x5A) și turația ajung în
  `telemetry_samples` pe durata unei sesiuni; deconectarea și reconectarea nu blochează sesiunea.

### L2 — Exportul de sesiune pentru validarea circuitului

- **De ce:** fără el, testerii din alte țări nu pot trimite tururile (`expansiune-piete-circuite.md` §4.2).
  Formatul și analiza există deja în core (§1.2).
- **Ce:**
  1. Un identificator pseudonim de tester (aleator, generat local, păstrat în setări). **Nu nume, nu
     e-mail, nu VIN.** `deleteAllStoredUserData()` trebuie să-l șteargă (vezi `deviceDataWipe.ts`).
  2. Din ecranul sesiunii: „Trimite pentru validarea circuitului” → ecran de acord explicit (ce se
     trimite: urma GPS a sesiunii, circuitul, numărul de ture curate; ce nu) → `encodeValidationExport`
     → foaia de partajare a sistemului (e-mail, fișiere).
  3. `cleanLapCount` din verdictele de tur existente (`lapVerdict`), eșantioanele din sesiunea salvată.
  4. Actualizează `docs/privacy.md`, `docs/legal/privacy-policy.*.md` și etichetele App Store.
- **Gata când:** un export făcut pe telefon trece prin `npm run assess:geometry` fără erori pe profilul
  circuitului respectiv.

### L3 — Butonul „Cere-ți circuitul”

- **De ce:** semnalul de cerere fără server (`expansiune-piete-circuite.md` §2).
- **Ce:** în lista de circuite, un buton care deschide un formular web extern (nume circuit, țară,
  e-mail, „vreau să fiu tester”). **Proprietarul alege serviciul de formulare și URL-ul** — nu inventa
  unul. Menționează formularul în politica de confidențialitate.
- **Gata când:** butonul deschide URL-ul configurat, pe iOS și Android; textul e în RO și EN.

### L4 — Abonamente și paywall (așteaptă conturile de magazin)

- **De ce:** fără ele nu există venit (`monetizare.md` §2, §3.1, §7 faza 1).
- **Blocat pe:** contul Apple Developer, Google Play Console, produsele create în magazine.
- **Ce:**
  1. O bibliotecă de achiziții compatibilă cu Expo SDK 57 (verifică la sursă; RevenueCat e o variantă,
     nu o decizie luată). ADR.
  2. Un singur flag de drept `isPro`, verificat local; fără backend.
  3. Împărțirea free / Pro exact după tabelul din `monetizare.md` §2, inclusiv **prima sesiune pe
     circuit deblocată complet** și virajele 2–N estompate în raport pentru free.
  4. Restaurarea achizițiilor; răscumpărarea codurilor de ofertă (anul de Pro din cutia V1).
  5. Funcțiile legate de hardware (pod) rămân gratuite la împerechere (`monetizare.md` §2, ultimul rând).
- **Gata când:** în sandbox-ul Apple și în testarea Google, cumpărarea, anularea, restaurarea și codul de
  ofertă schimbă corect `isPro`, iar ecranele respectă tabelul.

### L5 — Distanțe în unități imperiale

- **De ce:** SUA și UK (`expansiune-piete-circuite.md` §6). Viteza are deja km/h / mph
  (`apps/mobile/src/ui/format.ts`, `SpeedUnits`).
- **Ce:** unde aplicația arată metri (numărătoarea până la viraj pe banda de coaching, raportul, Pit view)
  și în textele vocale: picioare/yarzi când e aleasă setarea imperială. O singură setare de unități, nu
  două.
- **Gata când:** cu setarea imperială, niciun ecran și niciun mesaj vocal nu mai afișează metri.

### L6 — Valul 1: circuite din Europa Centrală

- **De ce:** metoda de validare de la distanță se calibrează pe circuite unde poți merge și cu mașina.
- **Ce, pentru fiecare circuit** (începe cu Hungaroring, apoi Pannonia-Ring, Balaton Park, Slovakia Ring,
  Brno, Red Bull Ring, Serres):
  1. Verificare live în Overpass: way-uri `highway=raceway`, configurația folosită la track day-uri,
     lungimea publicată, sensul. Arhivează JSON-ul brut în `data/osm/`. (Din cloud Overpass nu a fost
     accesibil.)
  2. Generator determinist după modelul `generate-motorpark-profile.ts`, profil `community-derived`,
     porți `app-defined`, atribuire ODbL, teste de regresie (playbook §2).
  3. **Înainte de vizită**, notează ce prezice geometria (lungime, viraje, poziția porților).
  4. După ce proprietarul conduce acolo: export (L2) → `npm run assess:geometry` → compară cu predicția.
     Rezultatele merg într-un tabel de calibrare pentru pragurile din §1.2.
- **Gata când:** fiecare circuit are profilul în catalog și, după vizită, un raport de abatere arhivat.

### L7 — Treapta „validată de comunitate” (așteaptă decizia proprietarului)

- **De ce:** fără ea, coaching-ul live nu pornește în SUA (`expansiune-piete-circuite.md` §4.3).
- **Blocat pe:** decizia proprietarului și pragurile calibrate în L6.
- **Ce (după decizie):** o valoare nouă pentru `geometryStatus` (schema profilului + migrare), dovada
  atașată profilului (raportul de la `assessGeometryDeviation`), poarta de coaching live extinsă cu
  marcaj vizibil „validat de comunitate” în RO și EN. Nu slăbi poarta pentru `'community-derived'`.

---

## 3. Ce face proprietarul (nu agenții)

| Ce                                                                        | Pentru      | Document                            |
| ------------------------------------------------------------------------- | ----------- | ----------------------------------- |
| Conturi Apple Developer și Google Play                                    | L4, lansare | `public-release-plan.md` §1.1       |
| Avocat: politică, termeni (plus SUA mai târziu)                           | lansare     | `monetizare.md` §4.3                |
| Ofertă de la un distribuitor UE pentru adaptoare BLE (20–30 buc)          | V1          | `monetizare.md` §3.2                |
| Alegerea serviciului de formulare pentru „Cere-ți circuitul”              | L3          | `expansiune-piete-circuite.md` §2   |
| Decizia pentru treapta „validată de comunitate”                           | L7          | `expansiune-piete-circuite.md` §4.3 |
| Contact cu circuitele din Valul 1 (hartă oficială, linia de cronometrare) | L6          | `expansiune-piete-circuite.md` §4.4 |
| Ofertă JLCPCB pentru 100 de pod-uri, cu livrare DDP                       | V2          | `monetizare.md` §4.1                |

---

## 4. CI pe PR-ul #4

Două verificări sunt roșii și **pe `main`**, nu din cauza acestui branch: politica de licențe (9 pachete
în afara politicii, `public-release-plan.md` §2.3) și osv-scanner (avize din dependențe, §4.3). Nu au
fost reparate aici. Typecheck, lint, teste și gitleaks sunt verzi.
