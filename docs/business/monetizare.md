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
3. **Două generații de ofertă:** **V1** (la lansare) = aplicația + **pachetul Pro anual cu adaptor OBD
   BLE, 79,99 €**; **V2** (mai târziu) = pachetul cu **pod**, 149 €. Bugetul e strâns, deci V1 folosește un
   adaptor gata făcut, deja certificat CE de producător, cumpărat în loturi mici. V2 vine abia când
   veniturile din V1 pot finanța certificarea și lotul de pod-uri.
4. **Prima sesiune pe circuit e gratuită integral.** Omul vede raportul pe viraj _al lui_, pe turele _lui_,
   apoi dă de paywall. E cel mai puternic argument de vânzare pe care îl ai.
5. **Ordinea:** întâi V1 (free + Pro + pachetul cu adaptor OBD), abia apoi V2 cu pod, după validarea
   pe teren, certificarea CE și după ce V1 acoperă lotul. Pod-ul nu se vinde înainte ca aplicația
   să fi cronometrat tururi reale.

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

| Funcție                                             |             Free              |                               Pro                                |
| --------------------------------------------------- | :---------------------------: | :--------------------------------------------------------------: |
| Cronometraj GPS, sectoare S1/S2/S3, cel mai bun tur |              ✅               |                                ✅                                |
| Delta live față de cel mai bun tur                  |              ✅               |                                ✅                                |
| Funcționare offline, date doar pe telefon           |              ✅               |                                ✅                                |
| Circuitele incluse (TMR, MotorPark)                 |              ✅               |                                ✅                                |
| Circuite învățate (un tur → circuit propriu)        |               1               |                            nelimitat                             |
| Istoric sesiuni și timpi                            |            complet            |                             complet                              |
| **Prima sesiune pe circuit: tot Pro deblocat**      |              ✅               |                                —                                 |
| Pit view: „unde pierzi cel mai mult”                |        doar virajul #1        |            top 3 + puncte de frânare/lift tur cu tur             |
| Raport după sesiune, pe viraj                       | sumar (timp pierdut pe viraj) | complet: frânare, lift, v min, ieșire, G, cel mai bun demonstrat |
| Banda de coaching live înainte de viraj             |               —               |                                ✅                                |
| Callout-uri vocale („Brake hard / Brake / Lift”)    |               —               |                                ✅                                |
| Sugestii între sesiuni (după 2 tururi curate)       |               —               |                                ✅                                |
| Canale OBD în analiză (frână, pedală, turație)      |       se înregistrează        |                       analizate în raport                        |
| Comparare între sesiuni / zile diferite             |               —               |                                ✅                                |
| Export raport (PDF/imagine, RO/EN)                  |         cu watermark          |                              curat                               |
| **Cu GNSS Pod conectat:** 20–25 Hz + IMU din pod    |              ✅               |                                ✅                                |

Ultimul rând e intenționat în free: funcțiile care depind de hardware se deblochează la împerechere, nu prin
abonament. Asta face pod-ul vandabil și singur (inclusiv celor care folosesc RaceChrono, fiindcă pod-ul
vorbește protocolul RaceBox — `docs/hardware/gnss-device-design.md` faza C) și e și regula Apple pentru
funcții dependente de hardware (App Store Review Guidelines 3.1.4 — **de reverificat la data lansării**).

---

## 3. Lista de abonamente — V1 (lansare) și V2 (cu pod)

| Generație                        | Ce vinzi                                               | Disponibil        | Ce plătești la start                                             |
| -------------------------------- | ------------------------------------------------------ | ----------------- | ---------------------------------------------------------------- |
| **V1 — aplicație + adaptor OBD** | Free, Pro lunar/anual, **Pro anual + adaptor OBD BLE** | **de la lansare** | conturi de magazin, avocat, un lot mic de adaptoare (~500–850 €) |
| **V2 — cu pod**                  | pod + Pro, pod singur, pod + adaptor                   | **mai târziu**    | certificare CE + lot de pod-uri (~9–17 mii €)                    |

**De ce așa:** bugetul e strâns. Adaptorul OBD e un produs gata făcut, cu marcaj CE de la producător: n-ai
certificare de plătit, iar un lot de 20–30 de bucăți costă câteva sute de euro. Pod-ul blochează mii de
euro înainte de prima vânzare. Deci V1 plătește pentru V2, nu invers.

### 3.1 V1 — Abonamentele (disponibile de la lansare)

| Plan                                               | Preț (TVA inclus)  | Echivalent lunar | Net pentru tine\* |
| -------------------------------------------------- | ------------------ | ---------------- | ----------------- |
| **Free**                                           | 0 €                | —                | —                 |
| **Pro lunar**                                      | 9,99 € (~50 lei)   | 9,99 €           | ~7,02 €/lună      |
| **Pro anual**                                      | 59,99 € (~300 lei) | 5,00 €           | ~42,14 €/an       |
| Fondator (primii 200, anual, preț blocat pe viață) | 39,99 €            | 3,33 €           | ~28,09 €/an       |

\* Net = preț ÷ 1,21 (TVA RO 21%) × 0,85 (comision App Store / Google Play 15% prin Small Business Program /
abonamente Google). Aproximativ; comisionul se aplică pe prețul fără TVA.

Ce include: tot tabelul din §2 (Free vs Pro), cu GPS-ul telefonului. Cine are deja un adaptor compatibil
îl folosește pe al lui.

**De ce 9,99 € lunar și nu 7,99 €:** un utilizator sezonier plătește lunar doar ~7 luni pe an. La 7,99 € ar
plăti 55,93 € — aproape cât anualul, deci n-ar avea niciun motiv să aleagă anualul. La 9,99 € plătește
69,93 € pentru 7 luni, iar anualul de 59,99 € devine alegerea evidentă. Lunarul e pentru cel care vrea să
încerce o singură zi de circuit — și e în regulă să plătească mai mult pentru flexibilitate.

**Alternativă de luat în calcul:** „Pas de sezon” (6 luni, fără reînnoire automată, 44,99 €). Reduce
frica de „abonament care mă taxează iarna”. Dezavantaj: pierzi reînnoirea automată. Recomand să pornești
fără el și să-l adaugi doar dacă datele arată abandon mare la paywall pe motiv de „nu vreau abonament”.

### 3.2 V1 — Pachetul Pro anual + adaptor OBD (produsul principal la lansare)

| Ofertă                          | Preț (TVA inclus)                  | Ce primește clientul                                | Mesaj                                    |
| ------------------------------- | ---------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| **Pro anual + adaptor OBD BLE** | **79,99 €** (~400 lei)             | adaptor BLE ELM327 + card cu cod pentru 12 luni Pro | „Adaptorul la doar 20 € peste abonament” |
| Reînnoire Pro în anul 2         | 59,99 €/an (automat, prin magazin) | —                                                   | adaptorul rămâne al lui                  |

Separat, clientul ar plăti 59,99 € + ~25–32 € pe un adaptor BLE de firmă (Vgate iCar Pro BLE sau
Veepeak OBDCheck BLE, 26–34 $ în `gnss-device-design.md` §8.3), deci ~85–92 €.

**De ce merită pachetul, deși lasă cam cât un abonament simplu (§4.2):**

- Adaptorul aduce frâna și pedala în analiză, deci raportul pe viraj e vizibil mai bun decât cu telefonul
  singur. Cine vede raportul complet reînnoiește mai ușor.
- E un motiv concret să plătești anual, nu lunar.
- Cutia poate sta pe raftul de la recepția circuitului și la organizatorii de track day. O aplicație nu
  poate sta acolo.
- Adaptorul rămâne compatibil cu V2: pod-ul a fost proiectat să citească exact un adaptor BLE ELM327
  (`hardware/gnss-pod/DESIGN.md`, iKiKin V03H4). Clientul din V1 cumpără doar pod-ul când apare V2.

**Condiție tehnică, înainte de primul adaptor vândut:** aplicația de azi citește OBD **doar prin WiFi/TCP**
(`apps/mobile/src/session/tcpObdTransport.ts`; nu există nicio bibliotecă BLE în `apps/mobile/package.json`).
Un adaptor BLE nu merge încă. Două drumuri:

1. **Adaugi transportul BLE în aplicație (recomandat).** O bibliotecă BLE compatibilă cu Expo, peste
   `elm327Session` din `@circuit/core`, care există deja. E muncă de câteva săptămâni, dar e aceeași muncă
   de care V2 are oricum nevoie: pod-ul vorbește tot BLE. Plus: telefonul păstrează internetul.
2. **Vinzi un adaptor WiFi ELM327**, care merge azi fără cod nou. Dezavantaje: telefonul pierde internetul
   cât e conectat (aplicația merge offline, deci pe circuit e acceptabil), iar clonele WiFi ieftine au
   calitate foarte variabilă. Bun doar ca soluție de avarie.

**Cum îl vinzi fără bani blocați:**

- **Lot mic:** 20–30 de bucăți de la un distribuitor din UE (~500–850 € la ~18–28 €/buc, **estimare de
  confirmat cu oferta distribuitorului**). Din UE ești doar distribuitor, nu importator, deci conformitatea
  CE rămâne a producătorului. Tot ai obligația de înregistrare DEEE ca vânzător de echipamente electrice.
- **Testezi fiecare model pe cel puțin 3–4 mașini diferite** înainte să-l pui în cutie. Adaptorul trebuie
  să funcționeze cu PID-urile standard pe care le citește aplicația (pedala: 0x49/0x5A). Frâna depinde de
  marca mașinii (`docs/architecture/analysis-engine.md` §1): spune clar în pagina produsului ce primește
  clientul pe mașina lui.
- **Magazin propriu** (Stripe) și eMAG Marketplace. Adaptorul e un bun fizic, deci nu trece prin App Store;
  anul de Pro vine ca **cod de ofertă** pe un card din cutie (mecanismul de mai jos, §3.3).
- Drept de retur de 14 zile pentru vânzarea online și garanție legală de 2 ani: păstrează 1–2 adaptoare de
  schimb din fiecare lot.

**Buget minim ca să pornești V1:** Apple Developer 99 $/an, Google Play 25 $ o dată, avocat pentru
politică și termeni ~1.000–2.500 €, primul lot de adaptoare ~500–850 €. Abonamentele trec prin
StoreKit / Google Play Billing, fără server.

### 3.3 V2 — Cu pod (mai târziu, indisponibil la lansare)

În aplicație și pe site apare ca **„În curând”**, cu formular de listă de așteptare (doar e-mail, fără
avans, deci fără cost și fără obligații legale de rambursare). Prețurile de mai jos sunt ținta de atunci:

| Ofertă                                 | Preț (TVA inclus)    | Ce primește clientul               | Mesaj                                                       |
| -------------------------------------- | -------------------- | ---------------------------------- | ----------------------------------------------------------- |
| **Pod singur**                         | 189 € (~945 lei)     | pod + suport magnetic + cablu      | sub RaceBox Mini S (199–266 $), peste Dragy DRG70-C (159 $) |
| **Pod + 1 an Pro** (recomandat)        | **149 €** (~745 lei) | pod + cod pentru 12 luni Pro       | „Economisești 100 €” (vs 248,99 €)                          |
| Reînnoire Pro pentru posesorii de pod  | 49,99 €/an           | loialitate                         | păstrează abonatul în anul 2                                |
| Pod + Adaptor OBD BLE (pachet complet) | 179 € + 1 an Pro     | pod + adaptor BLE cumpărat en-gros | „tot ce-ți trebuie, într-o cutie”                           |

Clienții V1 cumpără „Pod + 1 an Pro” la 149 € și nu pierd nimic: adaptorul lor merge cu pod-ul, iar anul de
Pro din cutie se adaugă la abonamentul existent. Nu recomand un preț separat, mai mic, pentru pod-ul lor:
cu rezerva de +30% din §4.1, un pod vândut sub ~140 € aproape nu mai lasă nimic.

**Cum livrezi anul de Pro din cutie fără să ocolești magazinele:** coduri de ofertă generate din App Store
Connect (Offer Codes pentru abonamente) și coduri promoționale Google Play, tipărite pe un card în cutie.
Clientul le răscumpără în aplicație, abonamentul trece prin Apple/Google, iar la final de an se reînnoiește
automat la prețul normal. **Verifică limitele trimestriale de coduri și regulile curente înainte de primul lot.**

**Când se deschide V2:** când sunt îndeplinite toate trei:

1. pod-ul a trecut validarea pe teren și certificarea CE;
2. lista de așteptare are ~100 de e-mailuri;
3. venitul net din V1 acoperă lotul de 100 (~5.500–9.000 €) fără împrumut.

---

## 4. Economia pe unitate

### 4.1 Costul pod-ului (din repo)

| Variantă                              | Cost                 | Sursă                                        |
| ------------------------------------- | -------------------- | -------------------------------------------- |
| Prototip, unitatea 1 (SAM-M10Q)       | ~95–130 $ livrat     | `gnss-device-design.md` §8.1                 |
| **Comanda de prototip rev A, reală**  | **270 $ tot inclus** | plătit, 2026-09 (vamă, transport, asamblare) |
| Lot de 100, MAX-M10S                  | **~32 $/buc** BOM    | §8.2                                         |
| Lot de 100, SAM-M10Q (fără riscul RF) | **~59 $/buc** BOM    | §8.2                                         |

Peste BOM mai adaug (**estimări**, nu cotații): ambalaj + suport + cablu ~5 $, transport din China + vamă
~4 $, rebuturi 5%, rezervă de garanție 5% (garanția legală în UE e de 2 ani). Cost aterizat estimat:
**~42 € (MAX-M10S) până la ~69 € (SAM-M10Q)** pe bucată.

**Ce spune costul real al prototipului.** Estimarea din `DESIGN-REV-A.md` §9 era ~132–157 $ **fără TVA**
(5 PCB + 2 asamblate). Comanda reală a costat **270 $ cu tot cu vamă, transport și asamblare**, adică
+72% până la +105% față de estimare. TVA-ul de 21% explică doar ~30 $ din diferență; restul vine din
taxele de curierat/vămuire, taxele de piese Extended și transport. Dacă e comanda din `ORDERING-RO.md`
(2 plăci asamblate), un pod de prototip a ieșit **~135 $ bucata**, de ~2–4 ori peste costul țintă la volum.

Ce înseamnă pentru plan:

- **Costul de prototip nu e costul de producție.** Taxele fixe (setup PCBA, piese Extended ~28 $, curier)
  se împart la 2 plăci acum și la 100 la un lot. Ele nu se repetă per bucată.
- **Dar estimările din repo au ieșit prea optimiste.** Pentru lotul de 100, pune o rezervă de **+30%**
  peste costul aterizat: **~55 € (MAX-M10S) până la ~90 € (SAM-M10Q)** pe bucată, până ai o cotație reală.
- **Pe firmă plătitoare de TVA**, TVA-ul de import se recuperează, deci la un lot comandat pe SRL costul
  efectiv scade față de ce ai plătit ca persoană fizică.
- **Cere cotație JLCPCB pentru 100 de bucăți înainte de orice precomandă**, cu transport DDP (taxe
  incluse), ca să nu mai apară surprize la vamă.

### 4.2 Contribuția pe vânzare

| Vânzare                              | Încasat fără TVA | − plată (~2%) − livrare (~5 €) | − cost pod                    | **Contribuție**        |
| ------------------------------------ | ---------------- | ------------------------------ | ----------------------------- | ---------------------- |
| Pod singur, 189 €                    | 156,20 €         | −7,70 €                        | −42…−69 €                     | **~80–107 €**          |
| Pod + 1 an Pro, 149 €                | 123,14 €         | −7,70 €                        | −42…−69 €                     | **~46–73 €** în anul 1 |
| … + reînnoire an 2 (49,99 €)         | 41,31 €          | −15% magazin                   | —                             | **+~35 €**             |
| **V1: Pro anual + adaptor, 79,99 €** | 66,11 €          | −6,60 €                        | −18…−28 € (adaptor, estimare) | **~32–42 €** în anul 1 |
| Pro anual, doar aplicația            | —                | —                              | —                             | **~42 €/an**           |
| Pro lunar, 7 luni de sezon           | —                | —                              | —                             | **~49 €/an**           |
| _Cu rezerva de +30%:_ pod singur     | 156,20 €         | −7,70 €                        | −55…−90 €                     | **~59–94 €**           |
| _Cu rezerva de +30%:_ pod + 1 an Pro | 123,14 €         | −7,70 €                        | −55…−90 €                     | **~25–60 €** în anul 1 |

Cu rezerva de +30% și varianta SAM-M10Q, pachetul la 149 € lasă doar ~25 € în anul 1. Dacă cotația
pentru 100 de bucăți confirmă costuri apropiate de cele ale prototipului, fie treci pe MAX-M10S (după
validarea RF), fie urci pachetul la **169 €** și pod-ul singur la **199 €**, tot sub RaceBox Mini S.

Concluzia importantă: **pachetul lasă mai puțin în anul 1 decât pod-ul singur, dar aduce un abonat.** Dacă
jumătate din cumpărătorii de pachet reînnoiesc, pachetul depășește pod-ul singur până la finalul anului 2.
Și un abonat activ e cel care recomandă aplicația în paddock.

### 4.3 Costuri fixe (estimări de ordin de mărime, de confirmat)

| Cost                                                          | Sumă                                | Când                                |
| ------------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| **Prototip rev A (deja cheltuit)**                            | **270 $**                           | plătit                              |
| Apple Developer Program                                       | 99 $/an                             | înainte de TestFlight               |
| Google Play Console                                           | 25 $ o dată                         | înainte de primul build Android     |
| Avocat: politică de confidențialitate + termeni (RO/EN)       | ~1.000–2.500 €                      | Etapa C din planul de lansare       |
| **Certificare CE/RED + EMC pentru pod** (laborator acreditat) | **~3.000–8.000 €**                  | înainte de orice vânzare a pod-ului |
| Înregistrare DEEE și baterii (Regulamentul UE 2023/1542)      | câteva sute €/an                    | înainte de vânzare                  |
| Primul lot de 100 pod-uri                                     | ~5.500–9.000 € (cu rezerva de +30%) | după certificare                    |
| Contabilitate SRL                                             | ~100 €/lună                         | continuu                            |

Certificarea e costul care decide dacă pod-ul merită: la o contribuție medie de ~60 € pe pachet, doar
certificarea cere **~50–130 de pachete vândute** ca să fie acoperită. Cu rezerva de +30% (contribuție
medie ~42 €), pragul urcă la **~70–190 de pachete**. Modulul ESP32 are certificare
proprie, dar produsul final tot are nevoie de declarație CE sub RED. Rev A e doar pe USB, fără baterie;
produsul de vânzare va avea baterie, deci intră și obligațiile pentru baterii.

---

## 5. Scenarii pentru primul an (ipoteze, nu prognoză)

Presupuneri: 70% din plătitori aleg anualul, lunarii plătesc în medie 6 luni. **Primul an e doar
V1** (aplicația + pachetul cu adaptor OBD). Pachetul cu adaptor lasă cam cât un abonament anual simplu
(§4.2), deci cifrele de mai jos nu se schimbă mult în funcție de câți îl aleg. Rândurile pentru pod arată ce
ar aduce V2 când se deschide
(contribuție medie ~60 € pe pachet), nu venit din primul an.

|                             | Prudent      | Mediu         | Optimist      |
| --------------------------- | ------------ | ------------- | ------------- |
| Instalări (RO + UE)         | 1.500        | 5.000         | 15.000        |
| Conversie free → Pro        | 4%           | 6%            | 8%            |
| Abonați plătitori           | 60           | 300           | 1.200         |
| **Net an 1, V1**            | **~2.500 €** | **~12.600 €** | **~50.400 €** |
| Finanțează V2?              | nu           | la limită     | da            |
| _Ulterior, V2:_ pachete pod | 30           | 120           | 400           |
| _Ulterior, V2:_ contribuție | ~1.800 €     | ~7.200 €      | ~24.000 €     |

Citirea onestă: **în scenariul prudent, V1 nu adună destul ca să finanțeze pod-ul în primul an.**
Asta e în regulă: V1 e profitabil singur, iar V2 se deschide abia când își permite
(condițiile din §3.3).
Ratele de conversie sunt ipoteze pentru aplicații de nișă pentru pasionați; măsoară-le pe TestFlight și în
primele luni, apoi refă tabelul.

---

## 6. Comparație cu ce există

| Produs                            | Model                  | Preț orientativ   | Ce face TRACE diferit                                                            |
| --------------------------------- | ---------------------- | ----------------- | -------------------------------------------------------------------------------- |
| RaceChrono Pro / Harry's LapTimer | aplicație, plată unică | ~10–30 €          | ei dau grafice; TRACE spune _ce_ să schimbi, pe viraj, în limba ta               |
| RaceBox Mini / Mini S             | hardware + aplicație   | 199–266 $         | pod-ul TRACE vorbește același protocol, costă mai puțin, vine cu coaching        |
| Dragy DRG70-C (+ Dragy OBD)       | hardware + aplicație   | 159 $ (+49–119 $) | Dragy e orientat pe accelerări; TRACE pe circuit și pe începători                |
| Garmin Catalyst                   | hardware cu coaching   | ~1.000 €+         | TRACE oferă coaching pe viraj la o fracțiune din preț                            |
| Instructor pe circuit             | serviciu               | ~50–150 €/sesiune | TRACE nu înlocuiește instructorul (nu pretinde asta), dar e acolo la fiecare tur |

Prețurile pentru RaceChrono, Harry's, Garmin și instructori sunt orientative și **nu sunt verificate în
repo**; RaceBox și Dragy sunt din `gnss-device-design.md` §8.3. Verifică-le înainte de materiale publice.
Regulile din `brand/facts.yaml` se aplică și aici: fără cifre de precizie, fără „oficial”, fără „AI”.

---

## 7. Plan de lansare comercială

**Faza 1 — V1, la lansarea în magazine** (după Etapele A–E din planul de lansare)

- Free + Pro lunar/anual, fără hardware. Oferta Fondator (39,99 €/an blocat) pentru primii 200.
- Prima sesiune pe circuit deblocată complet. Paywall-ul apare în raportul _lor_, cu virajele 2–N estompate.
- Pachetul Pro anual + adaptor OBD BLE la 79,99 €, pe magazinul propriu și pe eMAG, **după** ce aplicația
  are transport BLE (§3.2) și adaptorul a fost testat pe mai multe mașini.
- Tehnic: StoreKit 2 / Google Play Billing (de ex. prin RevenueCat), un singur flag `isPro` în setări,
  verificat local — nu e nevoie de backend pentru abonamente.

**Faza 2 — lista de așteptare pentru pod** (în paralel cu faza 1, cost zero)

- Pe landing-ul existent (`marketing/landing/`) și în aplicație: V2 (pod-ul) marcat „În curând”, cu
  formular doar pentru e-mail. Fără avans, deci fără bani de returnat și fără obligații de livrare.
- Pragul: **~100 de e-mailuri** și venit din V1 care acoperă lotul (§3.3).
- Certificarea CE se plătește tot din veniturile din V1, nu înainte.

**Faza 3 — V2 cu pod, după validare pe teren și CE**

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

| Risc                                       | De ce contează                              | Ce faci                                                                                   |
| ------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sezonalitate                               | abonații lunari pleacă în noiembrie         | anualul e opțiunea implicită în paywall; lunarul la 9,99 €                                |
| Nișă mică în RO                            | sute, nu zeci de mii de piloți activi       | EN de la lansare, circuite învățate = orice circuit din UE                                |
| Aplicația n-a cronometrat încă un tur real | nu poți vinde ce n-a fost verificat         | monetizare doar după validarea de la MotorPark/TMR                                        |
| Adaptorul OBD nu merge pe toate mașinile   | retururi, recenzii proaste                  | listă de mașini testate; pagină clară „ce primești pe mașina ta”; 1–2 adaptoare de schimb |
| Aplicația nu are încă BLE                  | pachetul V1 nu se poate vinde fără el       | transportul BLE înainte de primul adaptor vândut; e aceeași muncă de care are nevoie V2   |
| Pod-ul: CE, garanție, retururi, suport     | costuri fixe mari pentru un volum mic       | lista de așteptare cu prag; pornești cu MAX-M10S doar după bring-up RF                    |
| Regulile magazinelor se schimbă            | coduri în cutie, deblocări hardware         | reverifică ghidurile Apple/Google la fiecare lot                                          |
| Coaching-ul oprit pe geometrie neoficială  | valoarea Pro scade pe circuitele nevalidate | parteneriate cu circuitele (faza 4); arată clar pe ce circuite e coaching live complet    |

---

## 9. Ce se măsoară din prima zi

- Instalări → prima sesiune pe circuit → a doua sesiune (activare reală).
- Vizualizări de paywall → încercări → plătitori, separat pentru lunar și anual.
- Reînnoire anuală (primul semnal apare abia după 12 luni — de aceea Fondatorul contează).
- Rezervări de pod față de pragul de 100.

Fără backend, aceste cifre vin din rapoartele App Store Connect / Play Console și din furnizorul de
abonamente. Dacă adaugi analitică în aplicație, trebuie trecută în politica de confidențialitate și în
etichetele App Store (`docs/legal/`).
