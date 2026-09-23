> **PROIECT — NU ESTE ÎNCĂ ÎN VIGOARE.**
> Acest document a fost pregătit pentru a fi revizuit de un avocat calificat, înscris în barou în
> România și în Uniunea Europeană. **Nu constituie consultanță juridică** și nu trebuie publicat,
> legat din pagina de magazin a aplicației sau invocat de utilizatori înainte de finalizarea acelei
> revizuiri.
> Redactat: **23 septembrie 2026**. Versiunea documentului: **1.0-proiect**.
> Elementele scrise ca `[PROPRIETAR: …]` sunt informații pe care numai proprietarul aplicației le
> poate furniza; toate sunt listate și în `docs/legal/compliance-checklist.md` §8.

# TRACE — Politica de confidențialitate

**Se aplică:** aplicației mobile TRACE pentru iOS și Android (identificator de pachet
`app.circuittimer.tmr`), versiunea 1.0.0 și ulterioare, până la înlocuirea cu o versiune nouă a
acestei politici.

**Ultima actualizare:** 23 septembrie 2026
**Intră în vigoare:** `[PROPRIETAR: data primei lansări publice]`

---

## 1. Pe scurt, într-un paragraf

TRACE este o aplicație de cronometraj și analiză a pilotajului pentru **circuite închise**.
Înregistrează unde se află mașina, cât de repede merge și — dacă conectezi un adaptor OBD-II — ce
raportează senzorii proprii ai mașinii, ca să cronometreze turele și să îți spună ce s-a întâmplat în
fiecare viraj. **Totul rămâne pe telefonul tău.** TRACE nu conține absolut niciun cod de rețea: nu
există cont, nu există server, nu există copie în cloud, nu există analytics, reclame sau raportare
de erori. Singurul mod în care datele pleacă de pe telefon este dacă apeși tu un buton de trimitere
și alegi unde le trimiți. Poți șterge tot din interiorul aplicației.

---

## 2. Cine răspunde pentru datele tale (operatorul)

| | |
|---|---|
| Operator | `[PROPRIETAR: denumirea legală completă — persoană fizică, PFA/ÎI sau SRL]` |
| Sediu / adresă | `[PROPRIETAR: adresa poștală completă din România]` |
| Contact pentru confidențialitate | `[PROPRIETAR: adresă de e-mail, de ex. privacy@…]` |
| Responsabil cu protecția datelor (DPO) | Nu este desemnat. TRACE nu realizează monitorizare la scară largă în numele unui operator; prelucrarea descrisă aici are loc integral pe dispozitivul utilizatorului. `[PROPRIETAR/AVOCAT: confirmați că nu este necesar un DPO conform art. 37 GDPR]` |
| Reprezentant în UE | Nu este necesar — operatorul este stabilit în România, în interiorul UE. |

Regulamentul general privind protecția datelor (Regulamentul (UE) 2016/679, „GDPR") se aplică acestei
aplicații.

**O precizare despre ce înseamnă „operator" aici.** Pentru aproape tot ce înregistrează TRACE, noi nu
primim datele deloc — ele sunt scrise într-o bază de date privată, în spațiul propriu al aplicației
de pe telefonul tău, la care nu avem acces. Ne tratăm totuși ca operator pentru această prelucrare,
pentru că noi decidem ce înregistrează aplicația și de ce. Acolo unde distincția îți schimbă
drepturile în practică, politica o spune explicit (vezi §7).

---

## 3. Ce înregistrează TRACE, de ce și în ce temei legal

Tot ce e în tabelele de mai jos se stochează **exclusiv** într-o bază de date SQLite privată din
interiorul aplicației, pe dispozitivul tău, plus în fișierele pe care aplicația le scrie în propriul
folder de cache atunci când exporți ceva.

### 3.1 Datele de localizare

| | |
|---|---|
| Ce | Latitudine, longitudine, precizie orizontală, viteză, direcție și altitudine, eșantionate continuu cât timp o sesiune este în desfășurare |
| De ce | Asta este, în întregime, produsul. Timpii de tur și de sector se obțin detectând momentul în care poziția ta traversează linia de start/sosire sau de sector; analiza fiecărui viraj se calculează din același traseu |
| Când | Numai cât timp o sesiune este activă (turul de calibrare și turele cronometrate) și numai cât timp aplicația este în prim-plan |
| Unde se stochează | Tabelul `telemetry`, pe tur, plus un „traseu brut" cu tot ce a fost capturat, inclusiv atunci când niciun tur nu a fost detectat |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a) GDPR), exprimat prin acordarea permisiunii de localizare a sistemului de operare și prin pornirea unei sesiuni. Aplicația nu poate porni o sesiune fără el |
| Se trimite undeva | **Nu** |

**Localizarea precisă este obligatorie pentru ca aplicația să funcționeze.** Modul „precizie redusă"
din iOS oferă un cerc de poziție de aproximativ 1,9 km, cu care nu se poate cronometra un tur. TRACE
tratează precizia redusă ca pe un eșec clar la verificarea dinaintea sesiunii și îți arată cum
activezi Locația Precisă, în loc să producă în tăcere timpi greșiți.

**Localizarea în fundal nu este cerută niciodată.** Aplicația nu solicită niciodată permisiunea
„Întotdeauna" pe iOS și nu declară `ACCESS_BACKGROUND_LOCATION` pe Android. Dacă ieși din aplicație,
înregistrarea se oprește.

**În dreptul european, un traseu de poziții este dată cu caracter personal chiar dacă numele tău nu
apare nicăieri în el.** O succesiune de poziții precise cu marcaj de timp spune unde a fost o
persoană, iar *Ghidul 01/2020 privind prelucrarea datelor cu caracter personal în contextul
vehiculelor conectate și al aplicațiilor de mobilitate* al Comitetului European pentru Protecția
Datelor (versiunea 2.0, adoptată la 9 martie 2021) tratează datele de localizare ca necesitând o
grijă deosebită exact din acest motiv. Îți tratăm traseul în consecință.

### 3.2 Datele vehiculului prin portul OBD-II (opțional)

| | |
|---|---|
| Ce | Turația motorului, viteza vehiculului, poziția clapetei de accelerație, poziția pedalei de accelerație, temperatura lichidului de răcire, temperatura aerului admis, sarcina calculată a motorului, temperatura uleiului de motor, temperatura uleiului de transmisie (dacă îți configurezi un PID personalizat pentru ea), starea contactorului de frână și presiunea de frânare |
| De ce | Ca analiza să poată spune *unde* ai frânat și *cât de tare*, și unde ai revenit pe accelerație — ceea ce transformă un timp de tur într-o observație utilizabilă |
| Când | Numai dacă activezi setarea „Telemetrie" **și** conectezi un adaptor. Implicit este dezactivată |
| Unde se stochează | Tabelul `telemetry_samples` (un rând pe eșantion: sesiune, tur, marcaj de timp, canal, valoare) |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a)), exprimat prin activarea setării și conectarea adaptorului |
| Se trimite undeva | **Nu.** Conexiunea se face către un adaptor din rețeaua ta Wi-Fi locală, nu către internet |

**TRACE doar citește de pe magistrala vehiculului.** Aplicația trimite cereri OBD-II standard, de
tip citire (serviciul 01), și cele două servicii de diagnosticare exclusiv de citire 0x21/0x22
folosite pentru valori specifice producătorului. Nu trimite niciodată o comandă care scrie, acționează
sau șterge ceva în mașină.

### 3.3 Seria de identificare a vehiculului (VIN)

| | |
|---|---|
| Ce | VIN-ul de 17 caractere al mașinii tale, citit o singură dată pe rulare a aplicației din calculatorul de motor (identificatorul de date `0xF190` din ISO 14229-1), atunci când este conectat un adaptor de tip BMW ENET |
| De ce | Ca să recunoască în ce mașină te afli și să selecteze automat profilul corect de vehicul, ca să nu trebuiască să îți identifici manual mașina la fiecare sesiune |
| Când | Numai pe calea cu adaptor ENET, numai cu telemetria activată și cel mult o dată pe pornire a aplicației |
| Unde se stochează | Tabelul `settings`, cheia `lastSeenVin` |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a)) |
| Se trimite undeva | **Nu** |

**VIN-ul este dată cu caracter personal.** Identifică un vehicul anume și, prin evidențele de
înmatriculare, un deținător anume — ghidul CEPD privind vehiculele conectate o spune direct. TRACE îl
tratează ca atare:

- **Nu este scris niciodată** într-o analiză exportată, într-un raport de sesiune sau într-un export
  brut de sesiune. Am verificat; nu se află în acele documente.
- Acolo unde aplicația scrie VIN-ul într-un jurnal tehnic, acesta este **mascat** — doar primele trei
  și ultimele două caractere, de exemplu `WBA************12`.
- Este afișat integral pe ecranul Signal Finder, adică exact acolo unde ai avea nevoie să îl citești.

- „Delete all my data" (§7) șterge VIN-ul stocat și, odată cu el, un profil de vehicul pe care
  aplicația l-a ales pe baza VIN-ului. Aplicația încearcă să citească din nou VIN-ul data viitoare
  când este conectat un adaptor de tip BMW ENET care nu e ocupat cu altă operațiune.

### 3.4 Senzorii de mișcare ai dispozitivului

| | |
|---|---|
| Ce | Citirile accelerometrului (convertite în g lateral și longitudinal) și ale giroscopului (convertite în viteză de girație) |
| De ce | Ca să măsoare forțele din viraj și din frânare și ca să distingă un viraj real de zgomotul GPS. Citirile giroscopului se folosesc doar dacă activezi acea setare |
| Când | Cât timp o sesiune este în desfășurare |
| Unde se stochează | Același tabel `telemetry_samples`, pe canalele `latG`, `longG`, `yawRateDps` |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a)) |
| Se trimite undeva | **Nu** |

### 3.5 Cronometraj, ture și propriile tale verdicte

| | |
|---|---|
| Ce | Ora de început a sesiunii, numerele turelor, timpii de tur și de sector, indicatorii de validitate și motivul pentru care un tur a fost marcat invalid, încercările de calibrare, turul tău de referință (recordul personal) și verdictele pe care **tu** le înregistrezi când ești de acord sau nu cu judecata aplicației asupra unui tur |
| De ce | Ca să îți arate istoricul, ca să compare cu cel mai bun tur al tău și — în cazul verdictelor — ca aplicația să poată fi corectată de persoana care chiar a condus |
| Unde se stochează | Tabelele `sessions`, `laps`, `checkpoints`, `reference_laps`, `lap_verdicts`, `calibration_attempts` |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a)) |
| Se trimite undeva | **Nu** |

### 3.6 Setările aplicației și uneltele de diagnosticare

| | |
|---|---|
| Ce | Unitățile de măsură, preferințele de afișare, limba, adresa și portul adaptorului, ce profil de vehicul este activ, legăturile de semnal confirmate pentru vehiculul tău și — dacă folosești uneltele de diagnosticare integrate — înregistrări ale rulărilor de „sweep" OBD, inclusiv răspunsuri hexazecimale brute de la calculatoarele mașinii |
| De ce | Ca să rețină cum ai configurat aplicația și ca aplicația să găsească semnalul corect de frână/accelerație pe mașina ta anume |
| Unde se stochează | Tabelele `settings`, `vehicle_profile_bindings`, `signal_finder_ruled_out`, `did_sweep_*` |
| Temei legal | **Consimțământul** (art. 6 alin. (1) lit. (a)) |
| Se trimite undeva | **Nu** |

> **O atenționare despre uneltele de diagnosticare.** Ecranele Signal Finder și DID Sweep
> înregistrează răspunsuri brute de la calculatoarele mașinii. Dacă baleiezi un interval care include
> identificatorul de date al VIN-ului, hexazecimalul brut din acea înregistrare — și din orice export
> al ei pe care alegi să îl trimiți — poate conține VIN-ul tău. Verifică un export de sweep înainte
> de a-l trimite cuiva.

### 3.7 Diagnosticele GNSS

Aplicația menține în memorie o fereastră glisantă cu ultimele 300 de eșantioane de poziție, pentru a
calcula statistici de calitate a semnalului (intervale între eșantioane, percentile de precizie,
numărul de locații simulate respinse pe Android). **Acestea nu sunt scrise niciodată pe disc și nu
părăsesc niciodată dispozitivul**; există doar pe durata procesului aflat în execuție.

---

## 4. Ce NU face TRACE

- **Niciun cont.** Nu există înregistrare, autentificare, adresă de e-mail sau parolă. Aplicația
  folosește intern un singur identificator local fix, ca să eticheteze rândurile din propria bază de
  date.
- **Niciun server.** În această versiune, TRACE nu conține absolut niciun cod de rețea. Un audit al
  codului sursă a găsit zero utilizări de `fetch`, `XMLHttpRequest`, `axios`, `WebSocket` sau
  actualizări over-the-air oriunde în aplicație sau în pachetul ei de domeniu. Hărțile circuitelor
  sunt compilate în aplicație, nu descărcate.
- **Niciun analytics, nicio reclamă, nicio urmărire.** Nu există SDK de analytics, SDK de publicitate,
  serviciu de raportare a erorilor și nicio bibliotecă terță în aplicație care să colecteze date.
  TRACE nu te urmărește în aplicațiile sau site-urile altor companii, nu folosește identificatori
  publicitari și nu transmite nimic către brokeri de date.
- **Nicio vânzare și nicio partajare de date personale.** Nu există ce vinde; noi nu le primim
  niciodată.
- **Nicio creare de profiluri și nicio decizie automată cu efect juridic.** Analiza de coaching a
  aplicației este o evaluare automată a pilotajului tău, dar produce sfaturi pe care ești liber să le
  ignori. Nu produce efecte juridice sau similar semnificative în sensul art. 22 GDPR.
- **Nu colectăm cu bună știință date ale copiilor.** TRACE este destinată conducătorilor auto cu
  permis care participă la activități pe circuit și nu se adresează copiilor.
  `[PROPRIETAR: confirmați clasificarea de vârstă pe care o veți declara în ambele magazine.]`

---

## 5. Când pleacă datele de pe telefon — și numai atunci

TRACE are butoane de export. Ele sunt singura ieșire, iar tu le apeși.

| Export | Unde se află | Ce conține |
|---|---|---|
| **Trimite raportul** (rezultatele sesiunii, istoricul sesiunilor) | La finalul unei sesiuni și pe fiecare rând din istoric | Raportul de sesiune în JSON, plus un rezumat lizibil de o pagină în Markdown: timpii de tur și de sector, validitatea și motivele ei, proveniența circuitului, starea calibrării |
| **Trimite raportul / Trimite fișierul JSON** (ecranul de analiză) | Ecranul de analiză | Documentul de analiză pe viraje, în română sau engleză, după setarea ta de limbă |
| **Export brut de sesiune** | Istoricul sesiunilor | Tot ce se află pe disc pentru acea sesiune, fără nicio interpretare: traseul GNSS complet al fiecărui tur, traseul nerevendicat al unei sesiuni în care nu s-a detectat niciun tur și fiecare eșantion OBD/de mișcare înregistrat |
| **Export Signal Finder**, **export DID Sweep** | Ecranele de diagnosticare respective | Înregistrarea observației ghidate sau a baleiajului, inclusiv răspunsuri brute de la mașina ta |

Când apeși unul dintre ele, aplicația scrie fișierul în propriul folder de cache (fișierele se
numesc în forma `trace-report-<circuit>-<data>-<sesiune>.json`) și îl predă foii standard de
partajare a sistemului tău de operare. **Din acel moment, unde ajunge fișierul este alegerea ta și
este guvernat de serviciul căruia i-l trimiți** — o aplicație de mesagerie, e-mail, stocare în cloud.
Noi nu primim nimic.

Rapoartele și analizele exportate **nu conțin VIN-ul tău**. Un export brut de sesiune conține traseul
tău complet de poziții, adică date de localizare precisă — tratează-l ca pe o fotografie a locurilor
în care ai fost.

---

## 6. Cât timp se păstrează datele

**Până le ștergi tu.** În această versiune nu există expirare automată, temporizator de retenție sau
curățare în fundal a sesiunilor. O sesiune înregistrată azi va fi pe telefonul tău și peste cinci
ani, dacă nu o ștergi sau dacă nu dezinstalezi aplicația.

Se aplică două limite tehnice, iar niciuna nu este o politică de retenție:

- Se stochează cel mult **200.000 de rânduri de telemetrie vehicul/mișcare per sesiune**;
  înregistrarea acelui canal se oprește pentru sesiunea respectivă odată atins plafonul.
- Magazinul de diagnosticare **DID sweep păstrează ultimele cinci rulări** și le elimină pe cele mai
  vechi.

Pentru că nu se transmite nimic, nu există o copie pe server cu propria ei perioadă de retenție.
Dezinstalarea TRACE elimină odată cu ea baza de date privată, în modul obișnuit în care sistemul tău
de operare elimină datele unei aplicații.

**Dacă ai exportat fișiere**, acele fișiere sunt ale tale și au viața lor: politica aceasta nu ajunge
la ele. Șterge-le de acolo unde le-ai trimis.

---

## 7. Drepturile tale și exact cum le exerciți în această aplicație

Conform art. 15–22 GDPR ai drepturile de mai jos. Pentru că datele tale sunt pe propriul dispozitiv
și noi nu deținem nicio copie, majoritatea se exercită **direct în aplicație** — ceea ce este mai
rapid și mai complet decât să ni le ceri nouă, pentru că noi nu am avea ce să îți trimitem.

### Dreptul de acces (art. 15) — „dați-mi o copie a datelor mele"

**În aplicație:** Istoricul sesiunilor → sesiunea dorită → **Trimite raportul** pentru varianta
lizibilă sau **export brut de sesiune** pentru tot ce este pe disc, neinterpretat. Butoanele **Trimite
raportul / Trimite fișierul JSON** de pe ecranul de analiză îți dau analiza viraj cu viraj. Aceste
exporturi sunt înregistrarea completă, citibilă automat; nu există o copie ascunsă altundeva.

### Dreptul la rectificare (art. 16) — „este greșit, corectați-l"

**În aplicație:** poți înregistra propriul verdict asupra oricărui tur judecat de aplicație, care se
stochează alături de judecata aplicației și este folosit în raportare. Valorile măsurate (o poziție
înregistrată, o presiune de frânare înregistrată) sunt citiri brute de senzor și nu pot fi editate —
a corecta o măsurătoare ar însemna a falsifica înregistrarea a ceea ce au raportat senzorii.

### Dreptul la ștergere (art. 17) — „ștergeți-le"

**În aplicație:** **Settings → DATA → „Delete all my data"**, apoi confirmi. Aceasta elimină
definitiv fiecare sesiune, tur, punct de control, traseu GNSS, eșantion de vehicul și de mișcare,
verdict de tur, încercare de calibrare și turul tău de referință — pentru toate circuitele, nu doar
pentru cel selectat — și verifică efectiv că ștergerea a avut loc înainte de a raporta succes. Este
ireversibilă.

Șterge de asemenea VIN-ul stocat, un profil de vehicul ales de aplicație pe baza VIN-ului,
legăturile de semnal confirmate pentru vehicul, semnalele excluse, înregistrările de baleiaj din
diagnosticare, definițiile de canale de semnal personalizate (fie etichetate dintr-un baleiaj cu „Tag
as channel", fie scrise în Setări), evidența profilului de vehicul folosit în fiecare sesiune, nota
unui Test Loop întrerupt, un traseu pe care Test Loop l-a învățat dar nu l-a putut salva și geometria
circuitelor pe care le-ai învățat aplicației.

Păstrează doar **preferințele** tale: unitățile de măsură, limba, adresa și portul adaptorului,
comutatoarele pentru coaching, voce și sugestii, circuitul selectat și un profil de vehicul ales chiar
de tine. Niciuna dintre ele nu te identifică pe tine sau mașina ta. Dezinstalarea aplicației le
elimină și pe acestea.

Două precizări oneste:

1. Comanda este **refuzată cât timp o sesiune este în desfășurare sau cât timp un Test Loop învață
   ori salvează un traseu**; încheie mai întâi sesiunea sau oprește Test Loop. Această regulă
   există ca ștergerea să nu se poată suprapune peste o înregistrare vie și să lase date în urmă.
2. Dacă o parte a ștergerii eșuează, aplicația spune asta în loc să raporteze succes. În acest caz,
   un circuit învățat pe care îl folosește încă o sesiune rămasă este păstrat, ca sesiunea să poată fi
   analizată în continuare; rulează din nou ștergerea.

### Dreptul la restricționare (art. 18) — „opriți-vă deocamdată"

**În aplicație:** dezactivează telemetria, coaching-ul și sugestiile din Setări; nu porni o sesiune.
Aplicația nu înregistrează nimic cât timp nicio sesiune nu este activă.

### Dreptul la portabilitate (art. 20) — „dați-mi-le într-un format utilizabil"

**În aplicație:** aceleași exporturi ca la dreptul de acces. Sunt JSON — format deschis, documentat,
citibil automat și nelegat de TRACE.

### Dreptul la opoziție (art. 21) și retragerea consimțământului (art. 7 alin. (3))

**Pe dispozitivul tău:** retrage oricând permisiunea de localizare din setările sistemului de operare
sau dezactivează telemetria. Retragerea oprește înregistrările viitoare; nu face retroactiv nelegală
înregistrarea anterioară și nu șterge prin ea însăși ce este deja stocat — pentru asta folosește
comanda de ștergere.

### Dreptul de a nu fi supus unei decizii automate (art. 22)

Nu este incident. Analiza TRACE produce sfaturi, nu decizii cu efecte juridice sau similar
semnificative.

### Dacă preferi să ne întrebi pe noi

Scrie la `[PROPRIETAR: e-mail de contact pentru confidențialitate]`. Te rugăm să înțelegi ce putem și
ce nu putem face: **noi nu avem nicio copie a datelor tale**, deci nu îți putem trimite un export și
nu putem șterge nimic de pe telefonul tău. Ce putem face este să te ajutăm să folosești comenzile de
mai sus, să răspundem la întrebări despre ce înregistrează aplicația și să corectăm această politică
dacă este greșită. Vom răspunde în termen de **o lună** de la cererea ta, așa cum cere art. 12 alin.
(3) GDPR, și îți vom spune dacă avem nevoie de prelungirea permisă de acel articol.

### Dreptul de a depune plângere la autoritatea de supraveghere (art. 77)

Poți depune plângere la autoritatea română de supraveghere:

> **Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP)**
> B-dul G-ral. Gheorghe Magheru 28-30, Sector 1, 010336 București, România
> Telefon: +40 318 059 211
> E-mail: anspdcp@dataprotection.ro
> Web: https://www.dataprotection.ro/

Dacă locuiești în alt stat din UE sau SEE, poți depune plângere la autoritatea națională proprie.

---

## 8. Securitate

- Baza de date se află în **directorul privat (sandbox) al aplicației**, pe care sistemul de operare
  îl protejează de celelalte aplicații.
- Pe un telefon modern, iPhone sau Android, acel spațiu este acoperit de **criptarea completă a
  discului**, activă ori de câte ori dispozitivul este blocat cu un cod. **Pune-ți un cod de
  acces.** Fără el, protecția aceasta nu se aplică.
- **Nu criptăm separat baza de date** cu o cheie proprie a aplicației. Cine are telefonul tău
  deblocat, are sesiunile tale.
- **Nu există transmisie de securizat**: nimic nu este criptat în tranzit pentru că nimic nu este în
  tranzit.
- Conexiunea către adaptorul OBD pe Wi-Fi este o legătură TCP simplă în rețeaua ta locală, fără
  criptare. Transportă doar telemetrie de vehicul și doar pe cei câțiva metri dintre adaptor și
  telefon. Dacă folosești dongle-ul prototip al proiectului, **schimbă-i parola Wi-Fi implicită.**
- Fișierele pe care le exporți rămân în cache-ul aplicației și apoi acolo unde le trimiți.
  Destinația din foaia de partajare nu este sub controlul nostru.

**Nu există backup.** Dacă îți pierzi sau îți resetezi telefonul, sesiunile tale dispar, dacă nu
le-ai exportat singur. Acesta este prețul faptului că aplicația nu deține nimic.

---

## 9. Transferuri internaționale

Niciunul. Nicio dată nu este transferată în afara dispozitivului tău și, prin urmare, niciuna nu este
transferată în afara Spațiului Economic European.

---

## 10. Modificări ale acestei politici — și serverul care încă nu există

Vom păstra un număr de versiune și o dată în antetul documentului și vom publica versiunea anterioară
alături. Dacă o modificare afectează material ce se colectează sau unde ajunge, te vom anunța **în
aplicație, înainte ca modificarea să intre în vigoare**, iar acolo unde modificarea necesită
consimțământul tău îl vom cere, nu îl vom presupune.

**Despre un server viitor.** Există un plan de a adăuga un serviciu de tip backend, pentru ca un
model lingvistic să poată produce o analiză scrisă a pilotajului. **El nu există. Această versiune a
aplicației nu contactează niciun astfel de serviciu, iar niciun cod din această versiune nu este
capabil să contacteze unul.** Dacă și când va fi construit, va apărea ca un **amendament numerotat la
această politică** — o secțiune nouă care descrie exact ce se trimite, cui, în ce temei legal și cât
timp se păstrează — împreună cu un consimțământ separat și explicit în aplicație. Prelucrarea
exclusiv locală descrisă în acest document va rămâne disponibilă și va rămâne opțiunea implicită.
Structurăm politica astfel încât să poți vedea schimbarea ca pe o schimbare, în loc să o găsești
topită într-o rescriere.

---

## 11. Contact

`[PROPRIETAR: nume]`
`[PROPRIETAR: adresă poștală]`
`[PROPRIETAR: e-mail de confidențialitate]`
`[PROPRIETAR: adresă web de suport]`

---

*Versiunea în limba engleză: `privacy-policy.en.md`. În caz de divergență între cele două versiuni
lingvistice, `[PROPRIETAR/AVOCAT: precizați care versiune prevalează — versiunea română este alegerea
mai sigură pentru un operator român și pentru consumatori români].`*
