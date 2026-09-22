# Plan de lansare publică — App Store și Google Play

Scris 2026-09-22, după maparea completă a codebase-ului. Starea de pornire: build 12 livrat, 3366 de teste
verzi, aplicația instalată prin sideload pe un singur telefon, niciun magazin, nicio semnătură.

Documentul e ordonat pe **ce blochează** lansarea, nu pe ce e plăcut de avut. Fiecare element spune de ce
contează și ce se întâmplă dacă îl sari.

---

## 0. Realitatea de azi, în trei propoziții

Aplicația funcționează și e testată bine pentru ce face, dar **n-a cronometrat niciodată un tur pe un circuit
real** — asta se schimbă luni. Nu există semnătură, nici cont de dezvoltator, nici build de Android vreodată.
Iar cea mai mare parte a muncii rămase până la magazin **nu e cod**: e juridic, e conformitate și e decizie de
produs.

---

## 1. Blocante absolute — fără astea nu se poate publica

### 1.1 Conturi, semnătură, canale de distribuție

| Ce | De ce | Efort |
|---|---|---|
| Apple Developer Program, 99 $/an | Fără el nu există nici TestFlight, nici App Store | 1–3 zile (verificare identitate) |
| Google Play Console, 25 $ o dată | Idem pentru Play | 1–2 zile |
| Certificat de semnare + provisioning iOS | Build-urile de azi sunt **nesemnate**; workflow-ul nu are secrete | 1 zi |
| Keystore Android + semnare | Cheia se pierde → **nu mai poți actualiza aplicația niciodată**. Păstreaz-o cu backup separat | 0.5 zile |
| Build Android, vreodată | `android.package` e declarat, dar nu s-a construit niciodată un apk/aab. Nu știm ce se rupe | **necunoscut — 1–5 zile** |

### 1.2 Identitatea aplicației — o decizie ireversibilă

Bundle id-ul e **`app.circuittimer.tmr`**. Conține `tmr`, de la Transilvania Motor Ring — de pe vremea când
aplicația avea un singur circuit. Azi are două plus circuite învățate, iar obiectivul e „orice circuit".

**Odată publicat, un bundle id nu se mai poate schimba.** Rămâne în URL-ul din magazin, în chitanțe, în
achizițiile din aplicație. E ultimul moment în care se poate alege altul, și decizia îți aparține:

- **Îl păstrezi** — zero muncă, dar aplicația poartă pe veci numele primului circuit.
- **Îl schimbi acum** (de ex. `app.trace.laptimer`) — datele existente de pe telefonul tău se pierd la
  reinstalare, dar nu ai încă utilizatori.

### 1.3 Versionare

`CFBundleShortVersionString: 1.0.0`, `CFBundleVersion: 1`. Nu există nicio automatizare care să incrementeze
build number-ul. Apple **refuză** un build cu un număr deja folosit. Trebuie automatizat înainte de a doua
încărcare, altfel se blochează fiecare livrare.

---

## 2. Juridic și conformitate — partea care durează cel mai mult

Nu e cod. **Nimic din secțiunea asta nu se rezolvă într-o seară**, și fără ea Apple respinge la review.

### 2.1 Ce colectezi de fapt

Trasee GPS precise, VIN, date OBD (frână, accelerație, turație), marcaje temporale. **În UE, poziția și VIN-ul
sunt date cu caracter personal** — ghidul EDPB despre vehicule conectate e explicit. Faptul că totul stă local
pe telefon ajută enorm, dar nu te scoate din GDPR.

### 2.2 Blocante

| Element | Stare | Notă |
|---|---|---|
| Politică de confidențialitate RO+EN, revizuită de avocat | **lipsește** | Obligatorie pentru ambele magazine. Trebuie să acopere GPS, VIN, OBD, retenție, drepturi, export/ștergere |
| Termeni și condiții cu disclaimer de motorsport | **lipsește** | „Doar pe circuit, nu pe drum public", limitare de răspundere. Verificabilitatea în România o confirmă un avocat, nu eu |
| Etichete de confidențialitate App Store | **lipsesc** | Se completează în App Store Connect; trebuie să se potrivească exact cu politica |
| Formular Data Safety în Play Console | **lipsește** | Echivalentul Android |
| Ecran de notices open-source | **lipsește** | Obligație de licență pentru dependențele livrate |
| Atribuire ODbL pentru OpenStreetMap | **există** | Deja pusă în About/CircuitDetail |
| Răspuns la întrebarea de criptare (`ITSAppUsesNonExemptEncryption`) | **absent din plist** | Apple o cere la fiecare încărcare; declar-o în config, nu manual |

### 2.3 Restanța de licențe

Nouă pachete în afara politicii, **niciunul AGPL sau GPL** — riscul copyleft pe care poarta îl caută nu există.
Clasele: `MIT AND OFL-1.1` (trei pachete de fonturi), `CC-BY-4.0` (`caniuse-lite`, date), `MPL-2.0`
(`lightningcss`, copyleft la nivel de fișier), `CC-BY-3.0` (trei pachete SPDX — ironic, dependențe ale
verificatorului însuși).

Niciunul nu blochează o lansare comercială. Toate **cer atribuire**, ceea ce ecranul de notices rezolvă
oricum. Acțiunea reală: extinde politica cu motivul scris lângă fiecare clasă admisă, și generează notices-urile
din același inventar.

Separat: cele trei pachete proprii sunt marcate `UNLICENSED`. E convenția normală pentru pachete private, dar
**repo-ul e public** — merită o decizie conștientă, nu una implicită.

### 2.4 Textele de permisiuni

Cele pentru locație și rețea locală sunt scrise de voi, precise, explică scopul. Cea pentru senzori e valoarea
implicită a Expo: **„Allow TRACE to access your device motion"**. Apple respinge frecvent formulările generice.
Rescrie-o: de ce are nevoie aplicația de giroscop și accelerometru, în aceiași termeni ca celelalte două.

---

## 3. Decizia de produs care decide dacă merită publicată

**Poarta de onestitate ține coaching-ul stins pe ambele circuite.** `geometryValidated` acceptă doar
`geometryStatus: 'official'`, iar TMR și MotorPark sunt amândouă `community-derived`, trasate din imagini
aeriene. Deci un utilizator care descarcă azi aplicația primește cronometraj și analiză, **dar niciodată un
sfat de pilotaj** — funcția construită în Faza 5, oprită de propria ei poartă de siguranță.

Poarta e corectă și n-o slăbesc. Dar înseamnă că trebuie ales un drum:

1. **Validează geometria pe teren** — conduci, compari traseul real cu trasarea OSM, corectezi, promovezi la
   `'official'`. Luni e primul pas. Se scalează prost: fiecare circuit nou cere o vizită.
2. **Lansează fără coaching**, ca instrument de cronometraj și telemetrie. Onest, livrabil acum, dar renunți la
   diferențiatorul principal.
3. **O a treia stare între ele** — geometrie validată de utilizator, cu sfaturi marcate ca atare. Muncă de
   proiectat, dar singura care se scalează la „orice circuit".

**Asta e decizia ta, nu una tehnică.** Recomand varianta 3 pe termen mediu și varianta 2 pentru prima lansare.

---

## 4. Tehnic — ce trebuie reparat înainte de public

### 4.1 Lipsuri găsite la mapare (în lucru sau de programat)

| Element | Impact | Stare |
|---|---|---|
| Un rând corupt ascunde tot istoricul | Utilizatorul își pierde accesul la toate datele | **în reparație** |
| Poarta de geometrie eșuează deschis în `core` | Sfaturi pe geometrie nevalidată dacă un apelant uită parametrul | **în reparație** |
| `markInvalid` în afara contractului | O implementare alternativă n-ar invalida niciodată | **în reparație** |
| Circuitele învățate nu se pot șterge | Funcția există, niciun ecran n-o cheamă | **de programat** |
| `resetTestLoop` fără apelanți | O fază de învățare eșuată poate arăta starea veche | **de programat** |
| Diagnosticele de timing n-au consumator | Dacă un tur dispare, nu se poate afla de ce de pe dispozitiv | **de programat** |
| `rawSessionShare.ts` mort | Cod neatins de nimeni | **de șters** |

### 4.2 Reziduuri acceptate, de reevaluat înainte de public

Patru defecte cunoscute din lanțul de review, toate cerând o eroare plus o secvență anume. Acceptabile pentru un
build de colectare pe un singur telefon; **înainte de mii de utilizatori trebuie recântărite**, fiindcă ce se
întâmplă o dată la mie devine zilnic la scară.

### 4.3 Restanța de securitate

29 de avize (1 critică, dev-only; 10 high). Majoritatea vin prin lanțul Expo/metro. Înainte de lansare: trecere
la zi a dependențelor, apoi reevaluare. Cele două job-uri roșii din CI devin verzi odată cu asta.

### 4.4 Golul de testare

Nu există infrastructură de teste de randare pentru React Native, iar suprafețele noi de UI sunt verificate doar
prin typecheck, bundling și citire. Pentru un singur utilizator care poate face zece minute de verificare acasă,
e acceptabil. **Pentru public nu e.** Un ecran care crapă pe un model de telefon pe care nu-l ai înseamnă
recenzii de o stea și zero diagnostic.

---

## 5. Ordinea pe care o recomand

**Etapa A — după MotorPark (1–2 săptămâni).** Analizezi datele de luni. Corectezi regulile de tur invalid pe baza
verdictelor tale. Repari lipsurile din 4.1. Decizi bundle id-ul. Ăsta e momentul, nu mai târziu.

**Etapa B — fundația de magazin (2–3 săptămâni, mare parte în așteptare).** Conturile, semnătura, primul build
Android. Începi juridicul **imediat** — e cel mai lung element și nu depinde de cod. Automatizezi versionarea.

**Etapa C — conformitate și adevăr (2–4 săptămâni).** Politica și termenii revizuiți de avocat. Etichetele de
confidențialitate. Ecranul de notices. Textul de permisiune pentru senzori. Restanțele de licențe și avize.

**Etapa D — pregătire pentru scară (durată deschisă).** Infrastructură de teste de randare. Reevaluarea
reziduurilor. Raportare de erori din teren — azi n-ai nicio vizibilitate asupra unui telefon străin.

**Etapa E — TestFlight, apoi lansare.** Grup restrâns întâi, pe telefoane diferite de al tău.

Realist, cu tine lucrând în paralel cu un avocat: **6–10 săptămâni până la o primă lansare publică onestă.**
Blocantul nu e codul.

---

## 6. Ce aș face în primul rând, dacă ar fi să aleg trei lucruri

1. **Pornește juridicul mâine.** Nu depinde de niciun commit și e cel mai lung.
2. **Decide bundle id-ul înainte de orice încărcare în magazin.** E ireversibil.
3. **Construiește o dată pentru Android.** E singura necunoscută mare rămasă; orice altceva din documentul ăsta
   e estimabil, aia nu.
