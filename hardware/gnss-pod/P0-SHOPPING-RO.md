# P0 — lista de cumpărături pentru prototipul pe breadboard (2026-09-23)

Scop: un "pod" funcțional din plăci de dezvoltare, fără PCB, ca să măsurăm
înainte să proiectăm (vezi `DESIGN.md` §8): rata GPS reală la 20/25 Hz,
forțele G din IMU, cât de repede răspunde V03H4 și MHD, și ce antenă merge
pe parbriz.

Prețurile și stocul de mai jos au fost verificate pe site-uri la data de azi.
Ce e marcat *neverificat* verifică în coș.

## Comanda 1 — DigiKey (livrează în România)

| # | Produs | Cod | Preț | Stoc | De ce |
|---|---|---|---|---|---|
| 1 | SparkFun GNSS Receiver Breakout **MAX-M10S** (Qwiic) | GPS-18037 | 45,95 $ | 150 buc, activ | Cipul exact din design (25 Hz doar GPS / 20 Hz GPS+Galileo). La Botland e epuizat fără dată. |
| 2 | SparkFun GPS/GNSS **Magnetic Mount Antenna 3 m** (SMA) | GPS-14986 | *neverificat* (16,50 $ la SparkFun) | *neverificat* | Antena recomandată de SparkFun pentru placa asta; pe **plafon** = referința „cel mai bun caz” |

Sfat: DigiKey are de obicei livrare gratuită peste un prag; verifică pragul
în coș. Dacă nu-l atingi, poți muta și produsele 3–4 aici (DigiKey le are).

## Comanda 2 — Botland (botland.store, livrare în 24 h)

| # | Produs | Cod | Preț | Stoc | De ce |
|---|---|---|---|---|---|
| 3 | SparkFun 6DoF IMU Breakout **LSM6DSV16X** (Qwiic) | SEN-21325 | 27,90 € | în stoc | IMU-ul candidat: ±16 g, giroscop ±4000 dps, FIFO 4,5 kB |
| 4 | Espressif **ESP32-S3-DevKitC-1-N8R8** | — | 22,00 € | în stoc | Procesorul pod-ului: BLE 5 + WiFi (pentru MHD) |
| 5 | SparkFun **GPS Embedded Antenna** SMA, 27×27 mm, activă 26 dB | GPS-00177 | 22,50 € | sosește în câteva zile | Antenă mică pe **parbriz** = ce va vedea pod-ul real |
| 6 | Qwiic Cable – Breadboard Jumper (4-pin), **2 buc** | PRT-14425 (sau varianta nouă PRT-17912) | *neverificat* | *neverificat* | Leagă GPS-ul și IMU-ul de pinii ESP32 |
| 7 | Breadboard + fire jumper (dacă nu ai) | — | — | — | — |

Subtotal verificat Botland: 72,40 € (3+4+5), plus cablurile.

## Comanda 3 — adaptorul OBD

| # | Produs | Unde | Notă |
|---|---|---|---|
| 8 | **iKiKin V03H4** (ELM327 v1.5, Bluetooth 4.0) — 1–2 buc | Anunțul de pe Alibaba (sau același model pe AliExpress, dacă vrei o bucată mai repede) | Pentru P0 ajunge o bucată; întreabă furnizorul de mostre (vezi `OBD-SUPPLIER-RFQ.md`) |

## Ai deja / de la orice magazin

- Cablu USB potrivit portului de pe ESP32-S3-DevKitC-1 (verifică tipul pe placă) + încărcător auto USB sau power bank.
- Un suport de telefon cu ventuză sau bandă dublu adezivă, ca să ții antena
  mică și IMU-ul **fix** pe parbriz (IMU-ul trebuie să nu se miște față de mașină).
- Adaptorul **MHD** (îl ai) — pentru măsurătoarea P0b.

## De ce două antene

- **Magnetică pe plafon (2):** cel mai bun semnal posibil = referința.
- **Mică pe parbriz (5):** cât pierde un pod real în cabină.
Comparăm aceleași ture cu ambele. Dacă antena mică pierde prea mult, aflăm
acum, nu după ce am comandat PCB-uri.

## Cum se leagă (pentru când sosesc)

- Ambele plăci SparkFun merg **doar la 3,3 V** (nu 5 V) — se alimentează din
  pinul 3V3 al ESP32.
- GPS: **UART** spre ESP32 (pentru 20–25 Hz) + pinul **PPS** spre un GPIO
  (pentru ceasul comun). IMU: **I2C** (Qwiic).
- Schema exactă a pinilor o fac eu împreună cu firmware-ul.

## Total estimativ

~46 $ + antena magnetică (DigiKey) + ~72 € + cabluri (Botland) + V03H4.
Aproximativ **150–180 €** cu tot cu livrarea — de confirmat în coș.

## Surse verificate

- DigiKey GPS-18037: https://www.digikey.com/en/products/detail/sparkfun-electronics/GPS-18037/16719314
- Botland MAX-M10S (epuizat): https://botland.store/gps-modules/22065-gnss-max-m10s-module-qwiic-sparkfun-gps-18037.html
- Botland SEN-21325: https://botland.store/9dof-imu-sensors/23323-sparkfun-6dof-imu-breakout-lsm6dsv16x-qwiic-sparkfun-sen-21325.html
- Botland ESP32-S3-DevKitC-1-N8R8: https://botland.store/esp32-wifi-and-bt-modules/26547-esp32-s3-devkitc-1-n8r8-wifi-bluetooth-development-board-with-esp32-s3-wroom-1-chip.html
- Botland GPS-00177: https://botland.store/gps-antennas/2315-antenna-gps-embedded-with-sma-connector-sparkfun-gps-00177-5903351240505.html
- Botland PRT-14425: https://botland.store/qwiic-wires/10107-qwiic-male-cables-with-female-4-pin-jst-plug-15cm-sparkfun-prt-14425-5904422314972.html
- SparkFun MAX-M10S hookup guide (antene recomandate, pini PPS/UART, 3,3 V): https://learn.sparkfun.com/tutorials/gnss-receiver-breakout---max-m10s-qwiic-hookup-guide/all
