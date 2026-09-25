# TRACE — analiză de monetizare: abonament, GNSS Pod, free vs plătit

Scris 2026-09-25. Bazat pe starea repo-ului la `17bb218`: aplicația (Expo, iOS-first), motorul de analiză
determinist pe viraj (`docs/architecture/analysis-engine.md`), planul de lansare
(`docs/architecture/public-release-plan.md`), GNSS Pod rev A (`hardware/gnss-pod/DESIGN-REV-A.md`) și
costurile din `docs/hardware/gnss-device-design.md` §8.

**Ce e fapt și ce e ipoteză.** Costurile hardware și prețurile concurenților vin din documentele din repo
(verificate acolo la datele indicate). Prețurile TRACE, ratele de conversie și volumele sunt **propuneri și
ipoteze**, marcate ca atare. Nimic de aici nu s-a validat cu clienți reali.

---

## 0. Recomandarea, pe scurt

1. **Freemium, cu abonament anual ca produs principal.** Cronometrajul e gratuit; coaching-ul (cele trei
   momente: live, la boxe, după sesiune) e plătit. Diferențiatorul se vinde, nu cronometrul.
2. **Prețuri propuse:** Pro **9,99 €/lună** sau **59,99 €/an** (−50% față de lunar). Lunarul există ca
   ancoră; anualul e ce vrei să vinzi, pentru că sezonul de track day e ~aprilie–octombrie.
3. **Pod-ul se vinde în pachet cu un an de Pro: 149 €** (față de 189 € pod-ul singur + 59,99 € anul de Pro
   = 248,99 €). Clientul „economisește 100 €”, tu încasezi hardware-ul cu marjă și câștigi un abonat.
4. **Prima sesiune pe circuit e gratuită integral.** Omul vede raportul pe viraj *al lui*, pe turele *lui*,
   apoi dă de paywall. E cel mai puternic argument de vânzare pe care îl ai.
5. **Ordinea:** întâi aplicația (free + Pro), abia apoi pod-ul, după validarea pe teren și certificarea CE.
   Pod-ul nu se vinde înainte ca aplicația să fi cronometrat tururi reale.

---

## 1. Ce vinzi de fapt

Din `marketing/content-engine/brand/facts.yaml` și codul din `packages/core/src/coaching/`:

- **Produsul:** un antrenor de circuit pentru începători, pe telefon. Te ghidează **în timp ce conduci**
  (banda de viraj + callout-uri vocale scurte), **la boxe** (Pit view: cele 3 viraje unde pierzi cel mai
  mult) și **după sesiune** (raport pe viraj: punct de frânare, lift, viteză minimă, ieșire, forțe G).
- **Totul local, offline, fără AI care ghicește.** Te compară doar cu tine. Asta e și argument de vânzare
  (confidențialitate, merge fără semnal pe circuit), și avantaj de cost: **costul marginal al unui abonat
  e practic zero** — nu există server, nici LLM plătit per utilizator.
- **Hardware opțional:**
  - **Adaptor OBD** (BLE ELM327 de ~26–34 $, sau MHD/ENET pe BMW): adaugă frână și pedală → analiză mai fină.
  - **TRACE GNSS Pod** (în lucru, rev A): GNSS 20–25 Hz + IMU, față de ~1 Hz din telefon
    (`docs/known-limitations.md`: precizie ~±0,3 s cu telefonul). Pod-ul transformă „estimat” în „măsurat”.

**Cine plătește:** începătorul de track day care a dat deja 150–400 € pe o zi de circuit (taxă, anvelope,
benzină, drum). Un abonament de 60 €/an e sub costul unui singur set de plăcuțe de frână. Argumentul nu e
„aplicație scumpă”, ci „cea mai ieftină parte a hobby-ului tău care te face mai rapid”.

---

## 2. Free vs Pro — ce intră unde

Regula: **free trebuie să fie util singur** (altfel nu se instalează și nu se recomandă), dar **Pro trebuie
să fie motivul pentru care ai instalat aplicația**. Tăiem analiza, nu datele: turele tale rămân ale tale,
indiferent dacă plătești.

| Funcție | Free | Pro |
|---|:---:|:---:|
| Cronometraj GPS, sectoare S1/S2/S3, cel mai bun tur | ✅ | ✅ |
| Delta live față de cel mai bun tur | ✅ | ✅ |
| Funcționare offline, date doar pe telefon | ✅ | ✅ |
| Circuitele incluse (TMR, MotorPark) | ✅ | ✅ |
| Circuite învățate (un tur → circuit propriu) | 1 | nelimitat |
| Istoric sesiuni și timpi | complet | complet |
| **Prima sesiune pe circuit: tot Pro deblocat** | ✅ | — |
| Pit view: „unde pierzi cel mai mult” | doar virajul #1 | top 3 + puncte de frânare/lift tur cu tur |
| Raport după sesiune, pe viraj | sumar (timp pierdut pe viraj) | complet: frânare, lift, v min, ieșire, G, cel mai bun demonstrat |
| Banda de coaching live înainte de viraj | — | ✅ |
| Callout-uri vocale („Brake hard / Brake / Lift”) | — | ✅ |
| Sugestii între sesiuni (după 2 tururi curate) | — | ✅ |
| Canale OBD în analiză (frână, pedală, turație) | se înregistrează | analizate în raport |
| Comparare între sesiuni / zile diferite | — | ✅ |
| Export raport (PDF/imagine, RO/EN) | cu watermark | curat |
| **Cu GNSS Pod conectat:** 20–25 Hz + IMU din pod | ✅ | ✅ |

Ultimul rând e intenționat în free: funcțiile care depind de hardware se deblochează la împerechere, nu prin
abonament. Asta face pod-ul vandabil și singur (inclusiv celor care folosesc RaceChrono, fiindcă pod-ul
vorbește protocolul RaceBox — `docs/hardware/gnss-device-design.md` faza C) și e și regula Apple pentru
funcții dependente de hardware (App Store Review Guidelines 3.1.4 — **de reverificat la data lansării**).

---

## 3. Prețuri propuse

### 3.1 Abonamentul (aplicația singură)

| Plan | Preț (TVA inclus) | Echivalent lunar | Net pentru tine* |
|---|---|---|---|
| **Pro lunar** | 9,99 € (~50 lei) | 9,99 € | ~7,02 €/lună |
| **Pro anual** | 59,99 € (~300 lei) | 5,00 € | ~42,14 €/an |
| Fondator (primii 200, anual, preț blocat pe viață) | 39,99 € | 3,33 € | ~28,09 €/an |

\* Net = preț ÷ 1,21 (TVA RO 21%) × 0,85 (comision App Store / Google Play 15% prin Small Business Program /
abonamente Google). Aproximativ; comisionul se aplică pe prețul fără TVA.

**De ce 9,99 € lunar și nu 7,99 €:** un utilizator sezonier plătește lunar doar ~7 luni pe an. La 7,99 € ar
plăti 55,93 € — aproape cât anualul, deci n-ar avea niciun motiv să aleagă anualul. La 9,99 € plătește
69,93 € pentru 7 luni, iar anualul de 59,99 € devine alegerea evidentă. Lunarul e pentru cel care vrea să
încerce o singură zi de circuit — și e în regulă să plătească mai mult pentru flexibilitate.

**Alternativă de luat în calcul:** „Pas de sezon” (6 luni, fără reînnoire automată, 44,99 €). Reduce
frica de „abonament care mă taxează iarna”. Dezavantaj: pierzi reînnoirea automată. Recomand să pornești
fără el și să-l adaugi doar dacă datele arată abandon mare la paywall pe motiv de „nu vreau abonament”.

### 3.2 GNSS Pod și pachetele

| Ofertă | Preț (TVA inclus) | Ce primește clientul | Mesaj |
|---|---|---|---|
| **Pod singur** | 189 € (~945 lei) | pod + suport magnetic + cablu | sub RaceBox Mini S (199–266 $), peste Dragy DRG70-C (159 $) |
| **Pod + 1 an Pro** (recomandat) | **149 €** (~745 lei) | pod + cod pentru 12 luni Pro | „Economisești 100 €” (vs 248,99 €) |
| Reînnoire Pro pentru posesorii de pod | 49,99 €/an | loialitate | păstrează abonatul în anul 2 |
| Pod + Adaptor OBD BLE (pachet complet) | 179 € + 1 an Pro | pod + adaptor BLE cumpărat en-gros | „tot ce-ți trebuie, într-o cutie” |

**Cum livrezi anul de Pro din cutie fără să ocolești magazinele:** coduri de ofertă generate din App Store
Connect (Offer Codes pentru abonamente) și coduri promoționale Google Play, tipărite pe un card în cutie.
Clientul le răscumpără în aplicație, abonamentul trece prin Apple/Google, iar la final de an se reînnoiește
automat la prețul normal. **Verifică limitele trimestriale de coduri și regulile curente înainte de primul lot.**

---

## 4. Economia pe unitate

### 4.1 Costul pod-ului (din repo)

| Variantă | Cost | Sursă |
|---|---|---|
| Prototip, unitatea 1 (SAM-M10Q) | ~95–130 $ livrat | `gnss-device-design.md` §8.1 |
| Lot de 100, MAX-M10S | **~32 $/buc** BOM | §8.2 |
| Lot de 100, SAM-M10Q (fără riscul RF) | **~59 $/buc** BOM | §8.2 |

Peste BOM mai adaug (**estimări**, nu cotații): ambalaj + suport + cablu ~5 $, transport din China + vamă
~4 $, rebuturi 5%, rezervă de garanție 5% (garanția legală în UE e de 2 ani). Cost aterizat estimat:
**~42 € (MAX-M10S) până la ~69 € (SAM-M10Q)** pe bucată.

### 4.2 Contribuția pe vânzare

| Vânzare | Încasat fără TVA | − plată (~2%) − livrare (~5 €) | − cost pod | **Contribuție** |
|---|---|---|---|---|
| Pod singur, 189 € | 156,20 € | −7,70 € | −42…−69 € | **~80–107 €** |
| Pod + 1 an Pro, 149 € | 123,14 € | −7,70 € | −42…−69 € | **~46–73 €** în anul 1 |
| … + reînnoire an 2 (49,99 €) | 41,31 € | −15% magazin | — | **+~35 €** |
| Pro anual, doar aplicația | — | — | — | **~42 €/an** |
| Pro lunar, 7 luni de sezon | — | — | — | **~49 €/an** |

Concluzia importantă: **pachetul lasă mai puțin în anul 1 decât pod-ul singur, dar aduce un abonat.** Dacă
jumătate din cumpărătorii de pachet reînnoiesc, pachetul depășește pod-ul singur până la finalul anului 2.
Și un abonat activ e cel care recomandă aplicația în paddock.

### 4.3 Costuri fixe (estimări de ordin de mărime, de confirmat)

| Cost | Sumă | Când |
|---|---|---|
| Apple Developer Program | 99 $/an | înainte de TestFlight |
| Google Play Console | 25 $ o dată | înainte de primul build Android |
| Avocat: politică de confidențialitate + termeni (RO/EN) | ~1.000–2.500 € | Etapa C din planul de lansare |
| **Certificare CE/RED + EMC pentru pod** (laborator acreditat) | **~3.000–8.000 €** | înainte de orice vânzare a pod-ului |
| Înregistrare DEEE și baterii (Regulamentul UE 2023/1542) | câteva sute €/an | înainte de vânzare |
| Primul lot de 100 pod-uri | ~4.500–7.000 € | după certificare |
| Contabilitate SRL | ~100 €/lună | continuu |

Certificarea e costul care decide dacă pod-ul merită: la o contribuție medie de ~60 € pe pachet, doar
certificarea cere **~50–130 de pachete vândute** ca să fie acoperită. Modulul ESP32 are certificare
proprie, dar produsul final tot are nevoie de declarație CE sub RED. Rev A e doar pe USB, fără baterie;
produsul de vânzare va avea baterie, deci intră și obligațiile pentru baterii.

---

## 5. Scenarii pentru primul an (ipoteze, nu prognoză)

Presupuneri: 70% din plătitori aleg anualul, lunarii plătesc în medie 6 luni, pod-ul pornește în a doua
jumătate a sezonului, contribuție medie ~60 € pe pachet.

| | Prudent | Mediu | Optimist |
|---|---|---|---|
| Instalări (RO + UE) | 1.500 | 5.000 | 15.000 |
| Conversie free → Pro | 4% | 6% | 8% |
| Abonați plătitori | 60 | 300 | 1.200 |
| Net abonamente | ~2.500 € | ~12.600 € | ~50.400 € |
| Pachete pod vândute | 30 | 120 | 400 |
| Contribuție pod | ~1.800 € | ~7.200 € | ~24.000 € |
| **Total contribuție** | **~4.300 €** | **~19.800 €** | **~74.400 €** |
| Acoperă certificarea + lotul? | nu | la limită | da |

Citirea onestă: **în scenariul prudent, pod-ul nu-și acoperă costurile fixe în primul an.** De aceea
aplicația trebuie lansată prima și pod-ul fabricat doar când lista de așteptare îl justifică (vezi §7).
Ratele de conversie sunt ipoteze pentru aplicații de nișă pentru pasionați; măsoară-le pe TestFlight și în
primele luni, apoi refă tabelul.

---

## 6. Comparație cu ce există

| Produs | Model | Preț orientativ | Ce face TRACE diferit |
|---|---|---|---|
| RaceChrono Pro / Harry's LapTimer | aplicație, plată unică | ~10–30 € | ei dau grafice; TRACE spune *ce* să schimbi, pe viraj, în limba ta |
| RaceBox Mini / Mini S | hardware + aplicație | 199–266 $ | pod-ul TRACE vorbește același protocol, costă mai puțin, vine cu coaching |
| Dragy DRG70-C (+ Dragy OBD) | hardware + aplicație | 159 $ (+49–119 $) | Dragy e orientat pe accelerări; TRACE pe circuit și pe începători |
| Garmin Catalyst | hardware cu coaching | ~1.000 €+ | TRACE oferă coaching pe viraj la o fracțiune din preț |
| Instructor pe circuit | serviciu | ~50–150 €/sesiune | TRACE nu înlocuiește instructorul (nu pretinde asta), dar e acolo la fiecare tur |

Prețurile pentru RaceChrono, Harry's, Garmin și instructori sunt orientative și **nu sunt verificate în
repo**; RaceBox și Dragy sunt din `gnss-device-design.md` §8.3. Verifică-le înainte de materiale publice.
Regulile din `brand/facts.yaml` se aplică și aici: fără cifre de precizie, fără „oficial”, fără „AI”.

---

## 7. Plan de lansare comercială

**Faza 1 — aplicația, la lansarea în magazine** (după Etapele A–E din planul de lansare)
- Free + Pro lunar/anual. Oferta Fondator (39,99 €/an blocat) pentru primii 200.
- Prima sesiune pe circuit deblocată complet. Paywall-ul apare în raportul *lor*, cu virajele 2–N estompate.
- Tehnic: StoreKit 2 / Google Play Billing (de ex. prin RevenueCat), un singur flag `isPro` în setări,
  verificat local — nu e nevoie de backend pentru abonamente.

**Faza 2 — lista de așteptare pentru pod** (în paralel cu faza 1)
- Pagină pe landing-ul existent (`marketing/landing/`): „Rezervă pod-ul — 20 € avans, returnabil”.
- Pragul de fabricație: **~100 de rezervări** acoperă lotul; sub prag, returnezi avansurile.
- Avansurile nu finanțează certificarea — pe aceea o plătești tu sau o amâni până la prag.

**Faza 3 — pod-ul, după validare pe teren și CE**
- Pachetul Pod + 1 an Pro la 149 €; pod singur 189 €.
- Canale: magazin propriu (Stripe), eMAG Marketplace, recepția circuitelor (TMR, MotorPark) cu comision.

**Faza 4 — B2B (după ce ai 50+ abonați activi)**
- **Școli de pilotaj / organizatori de track day:** licență de instructor + flotă de 10 pod-uri la preț de
  volum; închiriere pod la circuit, ~15 €/zi.
- **Circuite:** geometrie validată împreună cu circuitul → trece la `'official'`, ceea ce deblochează
  coaching-ul live complet pe acel circuit (`public-release-plan.md` §3). Circuitul primește co-marketing,
  tu primești validarea pe teren gratis și un punct de vânzare.

---

## 8. Riscuri

| Risc | De ce contează | Ce faci |
|---|---|---|
| Sezonalitate | abonații lunari pleacă în noiembrie | anualul e opțiunea implicită în paywall; lunarul la 9,99 € |
| Nișă mică în RO | sute, nu zeci de mii de piloți activi | EN de la lansare, circuite învățate = orice circuit din UE |
| Aplicația n-a cronometrat încă un tur real | nu poți vinde ce n-a fost verificat | monetizare doar după validarea de la MotorPark/TMR |
| Pod-ul: CE, garanție, retururi, suport | costuri fixe mari pentru un volum mic | lista de așteptare cu prag; pornești cu MAX-M10S doar după bring-up RF |
| Regulile magazinelor se schimbă | coduri în cutie, deblocări hardware | reverifică ghidurile Apple/Google la fiecare lot |
| Coaching-ul oprit pe geometrie neoficială | valoarea Pro scade pe circuitele nevalidate | parteneriate cu circuitele (faza 4); arată clar pe ce circuite e coaching live complet |

---

## 9. Ce se măsoară din prima zi

- Instalări → prima sesiune pe circuit → a doua sesiune (activare reală).
- Vizualizări de paywall → încercări → plătitori, separat pentru lunar și anual.
- Reînnoire anuală (primul semnal apare abia după 12 luni — de aceea Fondatorul contează).
- Rezervări de pod față de pragul de 100.

Fără backend, aceste cifre vin din rapoartele App Store Connect / Play Console și din furnizorul de
abonamente. Dacă adaugi analitică în aplicație, trebuie trecută în politica de confidențialitate și în
etichetele App Store (`docs/legal/`).
