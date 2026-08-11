# Comanda PCB-ului TRACE OBD Dongle la JLCPCB — pas cu pas (România, livrare rapidă)

Fișierele de producție (deja generate, DRC curat la toate severitățile):
`hardware/kicad/trace-dongle/production/` → **gerbers.zip**, **bom.csv**, **cpl.csv**

## Pasul 1 — Cont și upload
1. Intră pe **jlcpcb.com** → creează cont (email normal).
2. Click **"Order now"** → **"Add gerber file"** → urcă `gerbers.zip`.
3. Așteaptă preview-ul: trebuie să vadă placa de **68 × 30 mm, 2 straturi**. Verifică
   vizual conturul și găurile în viewerul lor.

## Pasul 2 — Opțiunile PCB (lasă default ce nu e menționat)
| Opțiune | Valoare |
|---|---|
| Base Material | FR-4 |
| Layers | 2 |
| Dimensions | 68 x 30 mm (auto-detectat) |
| PCB Qty | 5 (minimul; costul e aproape identic) |
| PCB Thickness | 1.6 mm |
| PCB Color | Green (cel mai rapid; alte culori pot adăuga 1-2 zile) |
| Surface Finish | HASL (with lead) — sau LeadFree, +~1$ |
| Outer Copper Weight | 1 oz |
| Via Covering | Tented |
| Mark on PCB | "Order Number (Specify Position)" — gratuit, îl pune discret |

## Pasul 3 — Asamblarea SMT (partea importantă)
1. Activează **"PCB Assembly"** (toggle în dreapta).
2. **Assembly Side: Top Side** (toate SMD-urile sunt sus).
3. **PCBA Qty: 2** (asamblezi 2 din 5 plăci — cel mai ieftin; 5 dacă vrei rezerve).
4. Tooling holes: **"Added by JLCPCB"**.
5. Next → urcă **bom.csv** la "BOM File" și **cpl.csv** la "CPL/Pick&Place File".
6. Pe ecranul de potrivire a pieselor: toate cele 29 de rânduri asamblate au cod
   LCSC verificat și în stoc la data generării. Verifică lista:
   - Piesele **"Basic"** nu au taxă; cele **"Extended"** adaugă ~3$/tip taxă de
     încărcare (avem câteva — normal, total estimat 10-20$).
   - Dacă vreo piesă apare **out of stock** între timp: click "Search" pe rândul
     ei și alege echivalentul EXACT ca valoare/pachet (ex. alt 22.1kΩ 1% 0603).
     NU înlocui U1/U2/U3/D1/D2/D3/F1/L1 cu altceva fără să mă întrebi.
7. Pe previzualizarea plasării (poziții/rotații componente): compară cu
   `render-top.png` din repo — trebuie să arate identic. Rotațiile diodelor și
   ale circuitelor integrate sunt deja corecte în CPL.

## Pasul 4 — Plata și livrarea în România (rapid)
1. **Shipping: DHL Express** (3-5 zile lucrătoare până în România) — recomandat.
   FedEx e comparabil. Evită "Global Standard Direct" dacă vrei viteză.
2. **TVA/vamă**: sub ~150€ total, JLCPCB colectează TVA-ul la checkout (IOSS) —
   coletul trece prin vamă fără taxe suplimentare și fără drumuri la poștă.
   Estimarea comenzii ăsteia (5 PCB + 2 asamblate + DHL): **~60-90€** → sub prag.
3. Plată cu cardul. Salvează invoice-ul.

**Timp total estimat: 6-10 zile** (2-4 zile fabricație+asamblare, 3-5 zile DHL).

## Pasul 5 — Ce mai comanzi separat (oriunde, ex. LCSC/optimusdigital/emag)
- **Cablu pigtail OBD-II mascul cu fire libere** (~15-25 lei) — se lipesc 5 fire
  la padurile J1: 12V (pin 16), GND (pin 4), GND (pin 5), CAN-H (pin 6),
  CAN-L (pin 14). Ordinea e serigrafiată pe placă.
- **Header 2.54mm 1×6** (J2, programare) — orice header ieftin; se lipește manual.
- **Adaptor USB-UART 3.3V** (CP2102 sau CH340, ~15 lei) — pentru flash-ul
  firmware-ului prin J2.
- **4 șuruburi M2 autofiletante** ~5mm — pentru carcasă.
- Opțional: filament pentru carcasă (PETG recomandat — mașina se încălzește).

## Pasul 6 — La sosire: NU direct în mașină
Ordinea obligatorie (lista completă în `.foreman/ledger.md` / raportul GO):
1. Inspecție vizuală + verificare scurt între 12V_RAW–GND și 3V3–GND (multimetru).
2. Alimentare de la sursă de laborator/limitată în curent la 12V: verifică 3,3V
   pe rail (test point: pinul 3V3 al J2).
3. Flash firmware: `pio run -t upload` cu USB-UART pe J2, ținând SW1 (BOOT) la
   power-on. Apoi caută rețeaua WiFi **TRACE-OBD** (parola: tracetrace).
4. Conectează aplicația: Settings → Vehicle telemetry ON → host 192.168.4.1,
   port 35000 → Telemetry monitor → CONNECTED.
5. Abia apoi, prima mașină — ideal pornind cu contactul pus dar motorul oprit.

Orice nelămurire la vreun pas — întreabă-mă cu un screenshot.
