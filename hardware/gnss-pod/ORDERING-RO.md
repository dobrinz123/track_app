# Comanda PCB-ului TRACE GNSS Pod rev A la JLCPCB — pas cu pas

Fișierele de producție (generate, DRC curat, review Codex runda 4 fără HIGH):
`hardware/kicad/gnss-pod/production/` → **gerbers.zip**, **bom.csv**, **cpl.csv**

**Rev A e doar pe USB:** conectorul de baterie J2 **NU se montează** și nu se
leagă nicio baterie (decizia ta din 2026-09-24, vezi `DESIGN-REV-A.md` §2).

## Înainte de comandă — verifică stocul
- **u-blox SAM-M10Q (LCSC C5443880)**: la ultima verificare erau doar **10 bucăți**.
  Pentru 2 plăci asamblate îți trebuie 2. Dacă a scăzut sub 2, NU comanda — spune-mi.
- Toate celelalte 29 de coduri LCSC din bom.csv au fost verificate (identitate +
  pachet) de Codex; stocul se vede oricum la pasul 3.

## Pasul 1 — Cont și upload
1. **jlcpcb.com** → cont → **"Order now"** → **"Add gerber file"** → urcă `gerbers.zip`.
2. Preview-ul trebuie să arate placa de **50 × 66,95 mm, 2 straturi**. Marginea de sus
   se oprește fix la antena ESP32 (antena iese peste margine — e voit).

## Pasul 2 — Opțiunile PCB (restul default)
| Opțiune | Valoare |
|---|---|
| Layers | 2 |
| PCB Qty | 5 |
| PCB Thickness | 1,6 mm |
| Surface Finish | **LeadFree HASL** sau **ENIG** (ENIG e mai bun pentru LGA-urile mici: SAM-M10Q, IMU) |
| Outer Copper Weight | 1 oz |
| Via Covering | Tented |

## Pasul 3 — Asamblarea SMT
1. Activează **"PCB Assembly"**, **Assembly Side: Top Side**, **PCBA Qty: 2**.
2. Urcă **bom.csv** (BOM) și **cpl.csv** (CPL).
3. Pe lista de piese:
   - **J2 (conector baterie)** și **SW3 (întrerupătorul ON/OFF)** nu sunt în CPL — nu se
     asamblează. J2 nu-l cumperi deloc pentru rev A; SW3 (SS-12D00-G3) îl lipești tu.
   - J3, C17, C18 nu se montează (DNP) — e normal.
   - Piesele "Extended" adaugă o taxă de încărcare pe tip (estimat ~28 $ în total).
   - Dacă o piesă e **out of stock**, NU o înlocui singur — spune-mi.
4. **Previzualizarea plasării — verifică-o atent** (aici se văd greșelile de rotație):
   U1 (ESP32, modulul mare), U2 (GPS, pătratul mare), U3 (IMU, cel mic de lângă ESP32),
   U4 (încărcătorul), J1 (USB-C la marginea din stânga). Pinul 1 al fiecărui IC trebuie să
   cadă pe punctul/marcajul de pe serigrafie. Compară cu `render-top.png`.

## Pasul 4 — Plata și livrarea
- **DHL Express** (3–5 zile lucrătoare). Sub ~150 € JLCPCB încasează TVA-ul (IOSS).
- **Estimare (din spec §9): ~132–157 $ înainte de TVA** pentru 5 PCB + 2 asamblate +
  livrare. Prețul real e cel din coș.

## Pasul 5 — Ce lipești tu
- **SW3** (SS-12D00-G3, întrerupător cu 3 pini, pas 2,5 mm) — **trebuie pus pe ON** ca
  placa să pornească și să poată fi programată prin USB.
- Nimic altceva pentru rev A.

## La primire — testele obligatorii (spec §10A)
Înainte să te bazezi pe placă: USB se enumeră și se programează de 10 ori; tensiunea de
3,3 V nu scade sub 3,0 V în timpul transmisiei WiFi; semnalul GPS nu scade cu mai mult de
2 dB cu WiFi pornit. Te ghidez eu pas cu pas când ajung plăcile.
