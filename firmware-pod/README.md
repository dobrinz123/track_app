# TRACE GNSS Pod firmware (rev A)

This is the ESP32-S3 firmware for the TRACE GNSS Pod rev A board. The binding
design is `hardware/gnss-pod/DESIGN-REV-A.md`; the goals are in
`hardware/gnss-pod/DESIGN.md`. The pod does four things:

- runs the u-blox SAM-M10Q GNSS at 10, 20 or 25 Hz;
- disciplines its microsecond clock to the GNSS PPS;
- reads the LSM6DSV16X IMU at 480 Hz with hardware timestamps;
- streams all of it to the TRACE app over BLE.

The app implements the wire protocol in **`PROTOCOL.md`**.

> **Status: nothing here has run on hardware yet.** The boards are ordered
> (JLCPCB). The code compiles cleanly, and every parser, encoder and timebase
> module is unit-tested on the host. Every electrical and register fact is
> sourced (§9). Bring-up (§6) is the first real test. See the limitations in §11.

## 1. Layout

The layout follows `../firmware` (the OBD dongle): the logic lives in plain C
modules that `env:native` unit-tests on the PC, and thin `.cpp` files wire them
to the ESP32.

```
firmware-pod/
  platformio.ini            env:pod (ESP32-S3), env:native (host tests)
  boards/trace_pod_reva.json board definition: ESP32-S3-MINI-1-N8, 8 MB QIO flash, no PSRAM, USB-CDC on boot
  PROTOCOL.md               BLE wire protocol v1 (the contract for the app)
  src/
    ubx.{h,c}               framework-free: UBX checksum, robust frame parser, VALSET/VALGET/CFG-RST builders, NAV-PVT/NAV-SAT decoders
    ubx_hp_otp.{h,c}        framework-free: the u-blox high-performance OTP byte strings (IM Table 3) + verification
    gnss_config.{h,c}       framework-free: which VALSETs the pod sends, rate-mode policy (20/25 Hz gated on OTP)
    timebase.{h,c}          framework-free: PPS discipline, PPS<->UTC association, pod<->Unix mapping, civil time
    clockmap.{h,c}          framework-free: IMU timestamp counter -> pod microseconds (noisy-pair fit, wrap handling)
    imu_fifo.{h,c}          framework-free: LSM6DSV16X FIFO tag decoder (time slots, timestamp anchoring) + decimator
    lsm6dsv16x_regs.h       register map subset, every value with its DS13510/AN5763 reference
    pod_protocol.{h,c}      framework-free: BLE frame encoder AND decoder, CRC-16/CCITT-FALSE
    cn0_stats.{h,c}         framework-free: DESIGN-REV-A §10A test 4 statistics (median C/N0 of the 8 strongest SVs)
    console_parse.{h,c}     framework-free: USB console command parser
    console_line.{h,c}      framework-free: console line assembler (a line runs exactly as typed or is rejected whole)
    bridge_filter.{h,c}     framework-free: `gnss bridge` host->GNSS filter that blocks every OTP-writing UBX frame
    gnss_tx_guard.{h,c}     framework-free: wire-level guard, no byte may complete B5 62 06 41 on the GNSS UART
    power_policy.{h,c}      framework-free: low-battery cutoff (inert on rev A), charging never allowed on rev A
    board_pins.h            every GPIO, with the DESIGN-REV-A rule it follows
    pod_state.h             shared runtime state, firmware version
    main.cpp                ESP32: setup()/loop()
    gnss.{h,cpp}            ESP32: UART1, autobaud, RAM-layer config, OTP procedure, u-center bridge
    pps.{h,cpp}             ESP32: GPIO21 rising-edge ISR timestamped with esp_timer
    imu.{h,cpp}             ESP32: I2C, LSM6DSV16X setup, FIFO read on INT1 (+ 20 ms poll fallback)
    ble_link.{h,cpp}        ESP32: NimBLE peripheral, GATT service, notifications, control queue
    wifi_test.{h,cpp}       ESP32: the only code that turns WiFi on (§10A tests 4 and 2)
    power.{h,cpp}           ESP32: CHG_EN held low, PGOOD_N, VBAT ADC
    leds.{h,cpp}            ESP32: LED patterns, BOOT button (read after boot only)
    console.{h,cpp}         ESP32: USB-CDC console
    con.{h,cpp}             ESP32: non-blocking console output (drop + count, never stall the loop)
    isr_gpio.{h,cpp}        ESP32: IRAM-safe GPIO interrupts (PPS, IMU INT1) via the ESP-IDF driver
    obd_central.h           PHASE 2 boundary (not implemented, §10)
  test/                     Unity tests run by `pio test -e native`
```

## 2. Toolchain

PlatformIO Core, installed per user (no admin, nothing system-wide):

```sh
uv tool install platformio          # or: python -m pip install --user platformio
pio --version                       # 6.1+; this tree was built with 6.2.0
```

On Windows, prefix commands with `PYTHONIOENCODING=utf-8` if PlatformIO fails
with a `UnicodeEncodeError` while printing (a cp1252 console issue, not a build
problem). Host tests need a C compiler on PATH (gcc/MinGW-w64 on Windows).

Platform `espressif32` (Arduino core 2.0.17 / ESP-IDF 4.4) and NimBLE-Arduino
1.4.3 (pinned in `platformio.ini`) are fetched on the first build.

```sh
cd firmware-pod
pio test -e native      # host unit tests (no hardware)
pio run  -e pod         # cross-compile the firmware
```

Results on 2026-09-24:

- `pio test -e native`: **97 test cases: 97 succeeded** (after the Codex POD-FW REV1 fix wave and the wire-guard wave).
- `pio run -e pod`: SUCCESS with 0 warnings (-Wall -Wextra). RAM 20.0 % (65,520 B), flash 28.2 % (941,237 B of the 3.3 MB app slot).

### Board definition (checked)

`boards/trace_pod_reva.json` is Espressif's `esp32-s3-devkitm-1` definition,
which uses the same ESP32-S3-MINI-1-N8 module. It sets:

- **8 MB flash**, `flash_mode qio` at 80 MHz, `memory_type qio_qspi` (Arduino's quad-flash SDK build);
- `default_8MB.csv` partitions (two 3.2 MB OTA app slots);
- **no PSRAM**: `BOARD_HAS_PSRAM` is not defined, so the core never initialises PSRAM (the -N8 has none);
- native USB as **USB-Serial/JTAG** (`ARDUINO_USB_MODE=1`), with the console on it from boot (`ARDUINO_USB_CDC_ON_BOOT=1`).

The built image header says 8 MB / 80 MHz. PlatformIO writes the image header
in DIO mode on purpose, so any ROM can read it; the second-stage bootloader
(built with `CONFIG_ESPTOOLPY_FLASHMODE_QIO`) then switches to quad I/O.

## 3. Flashing (native USB)

J1 is the only port. No USB-UART adapter is needed. **SW3 must be ON**:
with it off, the 3.3 V domain is unpowered even on USB (DESIGN-REV-A §10.10).

**First flash, or whenever auto-reset fails (manual download mode):**

1. Plug in USB-C and set SW3 to ON.
2. Hold **SW1 BOOT** (GPIO0 strap), press and release **SW2 RESET**, then release BOOT.
   The S3 ROM is now in download mode and enumerates as "USB JTAG/serial debug unit"
   (VID 0x303A, PID 0x1001).
3. Run `pio run -e pod -t upload --upload-port COMx` (Linux/macOS: `/dev/ttyACM0` or `/dev/cu.usbmodem*`).
4. Press **SW2 RESET** to start the new firmware.

**Later flashes:** the firmware keeps the USB-Serial/JTAG controller active, so
esptool can usually reset the chip into download mode by itself. Just run the
upload. If it fails, use the manual procedure above.

This is the equivalent esptool command (what PlatformIO runs):

```sh
python -m esptool --chip esp32s3 --port COMx --baud 921600 --before default_reset --after hard_reset \
  write_flash -z --flash_mode dio --flash_freq 80m --flash_size 8MB \
  0x0     .pio/build/pod/bootloader.bin \
  0x8000  .pio/build/pod/partitions.bin \
  0xe000  ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin \
  0x10000 .pio/build/pod/firmware.bin
```

Serial monitor: `pio device monitor -e pod` (USB CDC ignores the baud rate).
The ROM boot log also appears on U0TXD (TP13) at 115200 baud, as a fallback.

## 4. Console (USB CDC)

Type `help` for the full list. All commands:

| Command | What it does |
|---|---|
| `status` | Everything at once: power (PGOOD, CHG_EN, VBAT), GNSS, PPS/timebase, IMU, BLE, WiFi. |
| `gnss rate <10\|20\|25>` | Sets the nav rate. 10 Hz = GPS+Galileo (+SBAS+QZSS), no OTP needed. 20 Hz = GPS+Galileo and 25 Hz = GPS (+SBAS+QZSS) are **refused unless the high-performance OTP reads back SET**. Constellations and rate go to the receiver in one all-or-nothing VALSET and are read back. On a mismatch the previous mode is restored and re-verified; `status` shows `verified` / `UNVERIFIED`. Refused (BUSY) while `wifi tx-test` runs. |
| `gnss raw on\|off` | Prints every received UBX frame (class, id, length and the first 32 payload bytes). |
| `gnss sat` | Shows the last UBX-NAV-SAT: constellation, SV, C/N0, elevation, used. |
| `gnss reset` | Holds RESET_N (GPIO40, open-drain) low for 10 ms, then reconfigures. **Clears BBR**, so expect a cold start. |
| `gnss bridge` | USB ↔ GNSS UART bridge at 460800 for u-center. Press **BOOT** to leave; the receiver is then reconfigured. Do not change the receiver baud from u-center. **The host→GNSS direction is filtered** (`bridge_filter.h`): UBX frames that could write OTP (class 0x06 id 0x41; VALSET to a layer other than RAM/BBR/Flash; any frame carrying `B5 62 06 41` in its payload) are dropped with a console warning. A `0xB5` byte only passes as the start of a complete, checksum-valid, allowed frame. NMEA passes; frames with more than 1016 payload bytes are dropped. Behind that filter, **every byte to the GNSS UART** (bridge and firmware alike) passes the wire-level guard (`gnss_tx_guard.h`). The guard refuses any byte that would complete `B5 62 06 41` on the wire, even when the pieces come from different frames, for example a checksum ending in 0xB5 followed by `62 06 41`. GNSS→USB bytes that do not fit the USB buffer are dropped and counted. |
| `gnss otp-status` | Sends the IM §2.1.5 step-5 verification poll and reports SET / NOT SET / UNKNOWN. |
| `gnss otp-highperf` | **Preflight** for the irreversible OTP write: MON-VER, current state, the exact 60 bytes and their source. It refuses if the state is already SET or is UNKNOWN. |
| `gnss otp-highperf CONFIRM` | **Writes the OTP.** Only works within 60 s of a successful preflight, once; `CONFIRM` is case-sensitive. The authorisation is cleared on expiry, on `gnss reset`, on any receiver re-init and on bridge entry. It then runs the rest of IM §2.1.5: two ACK-ACKs, UBX-CFG-RST hardware reset, re-init, verification. |
| `imu dump [n]` | IMU status, then n decoded samples in g and deg/s, with pod timestamps. |
| `pps` | Timebase state, edge count, rejects, rate (ppb), current UTC. |
| `ble info` | Address, connection, MTU, PHY, streams, sequence, drops. |
| `wifi tx-test <s> [max]` | §10A test 4: s seconds with WiFi off, then s seconds of continuous TX at 13 dBm, then a C/N0 verdict. With `max`: 20 dBm (the load for §10A test 2). WiFi is turned off again afterwards. |
| `reset` | Restarts the MCU. |

WiFi is otherwise **never** started. The product does not use the MHD adapter
(DESIGN.md §3, owner decision 2026-09-24).

**Line rules.** A line runs exactly as typed or not at all:

- It is limited to 120 printable ASCII characters (TAB allowed); backspace/DEL edit it visibly.
- A longer line, or one with any control or non-ASCII byte, is **rejected
  whole** up to its terminator, with an error message.
- So `gnss otp-highperf CONFIRM` followed by 102 spaces and `CANCEL` does
  nothing.

**Output never blocks.** Console output is written only if it fits the USB TX
buffer (4 KB). Otherwise the message is dropped and counted, and `status` shows
the drops. Reason: with a zero TX timeout, the installed `HWCDC::write` could
spin forever on a host that is connected but not reading (details in `console_io.h`).

### High-performance OTP: rules

- The OTP write is **irreversible**. It uses 18 of the receiver's 69 OTP bytes.
- It exists only as the two-step console command above.
- It is never automatic and cannot be reached over BLE.
- The firmware refuses to write when the verification poll already reports
  SET, so OTP space is never spent twice.
- It also refuses when the state is UNKNOWN, so it never writes blind.
- SET / NOT SET is decided only from a complete, structurally valid VALGET
  reply that matches the poll: version 1, layer 4, position 0, each of the 4
  polled keys exactly once, nothing else, correct sizes. It is captured only
  while that poll is outstanding. All keys are evaluated before deciding:
  - **SET** only if every key equals the IM step-5 value;
  - **NOT SET** only if every key differs (the virgin state);
  - any mix, and anything malformed, is **UNKNOWN**, and the write is refused.
  A mix would mean a partially programmed module or unexpected values; check
  it with u-center before deciding anything.
- `gnss bridge` cannot be used to bypass this. The bridge drops OTP-writing
  frames (above), and the wire guard refuses any byte that would complete
  `B5 62 06 41` on the UART, however it is assembled.
- Exactly one code path may put `B5 62 06 41` on the wire:
  `otp_raw_write_confirmed()`. It is `static` in `gnss.cpp` and called only
  from `gnss_otp_confirm()`. Every other UART write goes through the guarded
  `uart_tx()`. Check:

  ```sh
  grep -rn "otp_raw_write_confirmed" src/   # gnss.cpp only: 1 doc comment, 1 static definition, 1 call inside gnss_otp_confirm()
  grep -rn "GnssSerial.write(" src/         # exactly 2: in uart_tx() and in otp_raw_write_confirmed()
  grep -rln "Serial1\|GnssSerial" src/     # gnss.cpp only
  ```

  The native test `test_tx_guard/test_raw_writer_and_uart_writes_are_confined`
  runs the same checks, so the build is red if another caller appears.
- The bytes are quoted verbatim from u-blox SAM-M10Q Integration manual
  UBX-22020019 R02, §2.1.5, Table 3. The tests check their UBX checksums.

## 5. LEDs and button

| LED | Pattern | Meaning |
|---|---|---|
| LED1 yellow (GPIO12) | off | no UBX traffic from the receiver |
| | 1 Hz blink | receiver alive, no 3-D fix |
| | 4 Hz blink | fix, but the PPS timebase is not locked |
| | on | PPS timebase locked |
| LED2 red (GPIO13) | 8 Hz blink | fault: GNSS or IMU did not initialise |
| | 2 Hz blink | WiFi TX test running |
| | on | phone connected |
| | short blip every 2 s | advertising |
| LED3 red | hardware (BQ24073 CHG) | never lit on rev A, which has no cell |

- **SW1 BOOT (GPIO0).** This is a strap pin. Holding it through reset selects
  download mode, which is its intended use. The firmware only reads it as an
  input after boot. A press prints a status line, or leaves `gnss bridge`.
- **SW2 RESET (EN).** Hardware reset.
- **SW3.** Power (LDO enable).

## 6. Bring-up procedure (maps to DESIGN-REV-A §10A)

Run everything on **both** boards and keep the numbers in the bring-up log.
Do step 0 first.

**0. Smoke test (before any §10A test)**

1. Visual inspection. Set SW3 OFF and plug in USB: LED3 must stay dark, since
   there is no cell. Set SW3 ON.
2. Flash (§3). `status` must show:
   - `CHG_EN low` and `USB present`;
   - `gnss: ok` with a receiver software string (MON-VER);
   - `imu: ok` (WHO_AM_I 0x70 at 0x6A);
   - `ble: advertising`.
3. Outdoors, open sky. Watch LED1 go from 1 Hz to 4 Hz to on. Then check:
   - `pps` reports `locked`, the rate is within ±50,000 ppb, and `rejected` stays at 0;
   - `gnss sat` shows C/N0 values.
4. Pod lying flat and still: `imu dump 20` should read about +1 g on the axis
   pointing up and about 0 deg/s.
5. With nRF Connect or the app, connect to `TRACE-Pod-XXXX` and subscribe to
   DATA. Write `01 80 01 00 02 00 01 07 0A 36` (SET_STREAMS 7) to CONTROL.
   GNSS, IMU and STATUS frames should arrive. `ble info` shows the MTU, PHY 2M
   (if the phone accepts it) and 0 drops.

**§10A test 1: USB enumeration and flashing**

- Setup: a 1 m USB-C cable through a USB 2.0 hub, plus one direct laptop port.
- Enumeration: it must show up as USB-Serial/JTAG on first plug-in.
- Flashing: 10 of 10 full flash + verify cycles per board. esptool verifies the
  MD5 after each write; also run `verify_flash`. PowerShell example:
  ```powershell
  1..10 | % { pio run -e pod -t upload --upload-port COMx; if ($LASTEXITCODE) { "FAIL $_" } }
  ```
- Serial stability: 10-minute log with no disconnects. Run `gnss raw on` for a
  continuous ~10 lines/s stream and log it with `pio device monitor -e pod | Tee-Object log.txt`.

**§10A test 2: 3V3 during WiFi TX bursts**

- Scope on U1.3 and U2.17. Run `wifi tx-test 60 max`: 60 s with WiFi off, then
  60 s of continuous 802.11b TX (1 Mbit/s, 1000-byte frames, 20 dBm) with BLE
  advertising and GNSS running.
- Measure during the TX phase with infinite persistence: minimum ≥ 3.0 V, and
  no brown-out reset (a reset shows as a new boot banner on the console).
- Case (b), a cell at 3.5 V on J2, is out of scope on rev A (J2 not fitted). The
  low-battery cutoff code exists but is inert (`POWER_HAS_CELL 0`).

**§10A test 3: charge temperature trips.** **Not supported by this firmware, by
design.** DESIGN-REV-A §6 (binding) keeps GPIO37 (CHG_EN) LOW at all times on
rev A, and this firmware has no command that can drive it high (a
`static_assert` in `power.cpp` guards this). Test 3 needs CE enabled. How that
happens on the bench (a separate, explicitly named bench build, or driving
CHG_CE by hand with the MCU unpowered) is an owner decision. It is left open
(§11).

**§10A test 4: GNSS C/N0 with WiFi TX on vs off**

1. Mount the pod on the windscreen outdoors, open sky, and let it warm up
   10 minutes.
2. Run `wifi tx-test 600`: 10 min TX off, then 10 min continuous TX at the
   13 dBm cap (BLE is capped at +9 dBm the whole time, §10.3).
3. The firmware prints, per phase:
   - the median over epochs of the per-epoch median C/N0 of the 8 strongest
     satellites;
   - the median number of used SVs;
   - the NAV-SAT and NAV-PVT epoch counts and valid-fix count;
   - the TX frame count.

   The verdict is **PASS** only if all of these hold:
   - every WiFi setup call succeeded, with channel and TX power read back;
   - at least 30 successful frames/s on average, and no second without a frame;
   - in both phases, NAV-SAT and NAV-PVT arrived for ≥ 90 % of the seconds;
   - ≥ 90 % of the NAV-SAT epochs had ≥ 8 satellites;
   - ≥ 99 % of the PVT epochs had a valid 3-D fix;
   - C/N0 dropped ≤ 2.0 dB and the used-SV median did not drop.

   The result is INCONCLUSIVE if the TX-off baseline itself misses the
   availability bars. GNSS rate changes are refused while the test runs.
4. For an independent cross-check, log the same run in u-center through
   `gnss bridge` (then start the TX test on the second board, or after leaving
   the bridge).

**High-performance OTP (after the tests above pass, owner's decision, one
board first)**

1. `gnss otp-status` should read NOT SET on a new module.
2. `gnss otp-highperf` (read the preflight), then `gnss otp-highperf CONFIRM`.
3. `gnss otp-status` should now read SET. Then run `gnss rate 20` and
   `gnss rate 25`, and check with `gnss raw on` that NAV-PVT arrives at 20/25 Hz.

## 7. Design notes

- **GNSS configuration.**
  - Everything goes to the receiver's **RAM layer only** (VALSET layers = 0x01).
  - The receiver is autobauded (460800, 9600, 115200, 38400, 921600), moved to
    460800, and configured every boot and after every reset.
  - Configuration: UBX only (NMEA off), automotive dynamic model (IM Table 4:
    ≤ 100 m/s horizontal), NAV-PVT every epoch, NAV-SAT at about 1 Hz.
  - Signals: GPS+Galileo+SBAS+QZSS, with BeiDou and GLONASS off; this is what
    allows 10 Hz on the default clock (DS Table 1). The 25 Hz mode drops Galileo.
- **PPS.**
  - Time pulse: 1 PPS on the GPS grid, rising edge at the top of the second,
    length 0 while unlocked and 100 ms once locked. Every edge the pod sees is
    therefore a GNSS-locked second.
  - GPIO21 is input-only with no pulls (SAFEBOOT_N shares the net).
  - The ISR stamps each edge with `esp_timer_get_time()`.
  - The ISR is registered IRAM-safe: `gpio_install_isr_service(ESP_INTR_FLAG_IRAM)`
    and `gpio_isr_handler_add`, with the handler in IRAM. Arduino's
    `attachInterrupt` is not used anywhere, because this core is built without
    `CONFIG_ARDUINO_ISR_IRAM` and dispatches from flash. The link map shows the
    PPS and IMU handlers at 0x403755xx (IRAM). Rationale in `isr_gpio.h`.
  - `timebase.c` does the rest:
    - rejects edges that are not an integer number of seconds apart (±300 µs + 200 ppm);
    - estimates the pod clock rate (EMA);
    - pairs each edge with its UTC second from a fully-resolved NAV-PVT;
    - tracks lock, holdover and re-lock.
- **IMU.**
  - Configuration: ±16 g, ±2000 dps, accelerometer and gyroscope at 480 Hz in
    high-performance mode, FIFO in continuous mode, one hardware-timestamp word
    every 8 time slots.
  - The watermark is 64 words, about 63 ms, about 30 % of the 219-word FIFO.
    The FIFO-threshold and overrun interrupts go to INT1 (INT2 is not connected).
  - Sample times come from the timestamp counter at 96 ticks per slot, which is
    exact. `clockmap.c` maps them to pod time, using register reads of
    TIMESTAMP0..3 bracketed by `esp_timer`.
  - Why ±16 g / ±2000 dps: in-car dynamics are under 2 g and under 200 deg/s,
    but kerb strikes and mount shock would clip at ±4 g. The resolution is still
    0.5 mg and 0.07 deg/s, below the sensor noise.
- **BLE.**
  - NimBLE peripheral, TX power capped at +9 dBm (DESIGN-REV-A §10.3
    mitigation 1). It requests MTU 247 and 2M PHY.
  - One frame per notification. Every generated frame takes a sequence number,
    so drops show as gaps.
  - Control writes are queued from the NimBLE task to the main loop.
  - Each control is tagged with the connection generation. A disconnect clears
    the queue; stale controls are dropped unexecuted.
  - One control runs per loop pass. A full queue is answered BUSY.
  - All pod state is owned by the loop task. INFO reads return a snapshot
    published under a spinlock every 100 ms.
- **Charger (binding).**
  - `power_early_init()` drives GPIO37 LOW as the first action in `setup()` and
    re-asserts it every second. No code path can set it high.
  - PGOOD_N (GPIO2) is read as "USB present".
  - The §10.5 low-battery cutoff (3.5 V sleep, 3.6 V no-WiFi, only on battery)
    is implemented and unit-tested but compiled inert (`POWER_HAS_CELL 0`).

## 8. Tests (`pio test -e native`)

| Suite | Covers |
|---|---|
| `test_ubx` | Fletcher checksum against frames printed by u-blox. Parser: whole frames, byte-by-byte fragmentation, NMEA/noise skipping, corrupted checksum then recovery, a good frame hidden inside a corrupt length span, oversize length, bad sync. NAV-PVT decode of a 100-byte vector with every field asserted. NAV-SAT decode. VALSET layout and value-range refusal. VALGET builder reproducing the IM poll byte for byte. Strict VALGET validation (layer, version, position, truncation, missing, extra, duplicate). CFG-RST. |
| `test_hp_otp` | The IM Table 3 frames (valid UBX, class 0x06/0x41, head and tail quoted) and the ACK/poll/reply frames. Strict classifier: the Codex counter-example payload; wrong layer, version or position; every truncation; trailing byte; extra key; duplicate key; one or all values differing; reordered keys. All 16 equal/different combinations of the 4 keys: SET only if all are equal, NOT SET only if all differ, UNKNOWN otherwise. The one-shot 60 s authorisation, including expiry across the `millis()` wrap. |
| `test_gnss_config` | Rate policy (20/25 only with OTP SET); rate/signal/base VALSETs decoded back; RAM-only layer on every frame; the mode as ONE VALSET (constellations + rate); strict readback (the Codex 25 Hz + Galileo mismatch, every single corrupted value, truncation, wrong layer). |
| `test_timebase` | Civil→Unix against Python-computed dates; lock and mapping within 2 µs at 20 ppm drift; 0.9 s latency plus missed pulses; a PVT older than the latest edge; glitch rejection; holdover and re-lock; IMU clock map convergence under ±100 µs noise; the FREQ_FINE formula; 32-bit wrap. |
| `test_imu_fifo` | Tag bit fields; timestamp interpolation over slots; timestamp word before or after data; dropping before the first timestamp; slots split across bursts; incomplete slots; empty and unknown tags; resync after overrun; decimator rounding and time averaging. |
| `test_pod_protocol` | CRC check value; GNSS golden byte offsets; round trips for GNSS, IMU, STATUS and CONTROL/RESULT; the PROTOCOL.md example frames byte for byte; every single-bit corruption detected; sequence-gap arithmetic; MTU sizing. |
| `test_misc` | Top-8 median C/N0; the full test-4 verdict (TX never ran, setup failure, too few frames, stalls, outages during TX, < 8 SVs, missing epochs, bad baseline → INCONCLUSIVE, 3 dB drop); console parsing (including the exact `CONFIRM`); power policy inert on rev A and correct with a cell. |
| `test_bridge_filter` | The exact Table-3 OTP bytes pushed in every chunk size 1..60: nothing forwarded. OTP between allowed traffic; VALSET to an undocumented layer; OTP embedded in an allowed payload; OTP hidden in a corrupt candidate; splice attempt; stray 0xB5; allowed UBX and NMEA pass byte-exact. |
| `test_tx_guard` | The blind-verifier splices, all rejected at the wire:
  - an allowed valid frame with CK_B = 0xB5 followed by `62 06 41 …`;
  - CK_A = 0xB5 with CK_B = 0x62;
  - a payload tail `B5`, and a frame ending `B5 62 06 41` inside its own checksum;
  - a firmware frame ending in 0xB5 followed by host bytes at bridge entry.

  Plus two fuzzers asserting the wire never contains `B5 62 06 41`: 400 rounds of random chunking of mixed allowed, OTP, crafted-checksum and garbage input, with interleaved firmware writes and bridge re-entries; and the guard alone on arbitrary bytes. Also the source-confinement check of the raw OTP writer. A mutation run with the guard disabled fails all 7 wire tests. |
| `test_console_line` | CRLF handling; `CONFIRM` + 102 spaces + `CANCEL` rejected whole; ESC and non-ASCII bytes reject the line; visible backspace editing; exact-maximum length accepted. |

About the NAV-PVT vector: the u-blox documents contain **no captured NAV-PVT
frame**. The vector was generated independently of this code (Python
`struct.pack` at the documented offsets, checksum computed separately). It
checks the decoder against the documented layout, not against a real receiver.

## 9. Sources of every protocol constant

| Constant(s) | Source (downloaded and checked 2026-09-24) |
|---|---|
| UBX framing, sync 0xB5 0x62, U2 LE length, 8-bit Fletcher checksum | u-blox M10 SPG 5.10 Interface description **UBX-21035062 R03**, §3.2, §3.4 |
| ACK-ACK 05 01, ACK-NAK 05 00 | UBX-21035062 §3.9.1/3.9.2 |
| CFG-RST 06 04 (navBbrMask, resetMode 0x00 = HW watchdog reset) | §3.10.2 |
| CFG-VALGET 06 8B (layers 0/1/2/7), CFG-VALSET 06 8A (layer bits RAM/BBR/Flash, v0 layout, ≤ 64 keys) | §3.10.4, §3.10.5 |
| MON-VER 0A 04 | §3.14.9 |
| NAV-PVT 01 07 (92 bytes, all offsets and scales) | §3.15.11 |
| NAV-SAT 01 35 (8 + 12·n, cno, flags bits) | §3.15.13 |
| gnssId values (0 GPS, 1 SBAS, 2 GAL, 3 BDS, 5 QZSS, 6 GLO) | §1.5.2 Table 1 |
| Key-ID size bits 30..28 | §4.2 |
| CFG-RATE-*, CFG-UART1-BAUDRATE, CFG-UART1IN/OUTPROT-*, CFG-MSGOUT-UBX_NAV_PVT/SAT_UART1, CFG-NAVSPG-DYNMODEL (AUTOMOT = 4), CFG-SIGNAL-*, CFG-TP-* and their enums | §4.9.11, 4.9.12, 4.9.17, 4.9.21, 4.9.25, 4.9.27–29 (Tables 23, 37, 46–49) |
| High-performance OTP string, expected ACK, verification poll and reply, procedure | SAM-M10Q Integration manual **UBX-22020019 R02**, §2.1.5 Table 3 + steps 1–6; OTP budget §2.3 |
| Nav-rate maxima (10/20 Hz GPS+GAL, 18/25 Hz single GNSS), UART range, default 9600 | SAM-M10Q Data sheet **UBX-22013293 R05**, Tables 1, 2, 16, 18 |
| Dynamic model limits, "restart after signal change, wait 0.5 s", time-pulse behaviour, UTC 12.5 min note | UBX-22020019 §2.1.2, Table 4, §3.6.2, §3.8.2 |
| LSM6DSV16X addresses 0x07–0x7E, bit fields, WHO_AM_I 0x70, ODR/BDR codes, FS codes, sensitivities 0.488 mg / 70 mdps, FIFO tags, timestamp 21.75 µs and the FREQ_FINE formula, IF_CFG defaults, 1.5 KB FIFO | ST **DS13510 Rev 4**, Table 3, Table 24, §6.12, §9.3–§9.87 |
| FIFO timestamp word layout (X_L..Y_H = TIMESTAMP[31:0]), time-slot/TAG_CNT semantics, timestamp decimation | ST **AN5763 Rev 2**, §6.4, §9.2, Tables 78, 86, 89 |
| I2C address 0x6A, every GPIO, CHG_EN rule, PPS rule, RESET_N rule | `hardware/gnss-pod/DESIGN-REV-A.md` §4, §6 |
| WiFi TX power units (0.25 dBm, 52 = 13 dBm, 80 = 20 dBm), `esp_wifi_80211_tx` frame types | ESP-IDF 4.4 `esp_wifi.h` as bundled with arduino-esp32 2.0.17 |
| CRC-16/CCITT-FALSE check value 0x29B1 | standard catalogue value, cross-checked with an independent Python implementation |

URLs are in the header comments of `ubx.h`, `ubx_hp_otp.h` and
`lsm6dsv16x_regs.h`.

## 10. TODO: phase 2, BLE central to an ELM327 OBD adapter

This is not in this release. The boundary is in `src/obd_central.h` (nothing
includes it yet). The plan:

- Enable the NimBLE central role. `platformio.ini` currently has
  `CONFIG_BT_NIMBLE_ROLE_CENTRAL_DISABLED` and `MAX_CONNECTIONS=1`; it needs 2
  connections.
- Scan for the adapter's UART-like service. FFE0/FFE1 is common on clones;
  **verify on the actual iKiKin V03H4** (DESIGN.md §6).
- Run an ELM327 session as a non-blocking state machine.
- Stamp every sample with request and response pod times, and optionally pulse
  GNSS EXTINT (GPIO41) as a receiver time mark.
- Add an OBD frame type to PROTOCOL.md under the versioning rules.
- Keep the dongle's read-only guard policy (`../firmware/src/read_only_guard.c`).
- Measure the real PID/s before designing anything around a number
  (DESIGN.md §6).

## 11. Limitations (honest list)

1. **Nothing has run on hardware.** Every timing figure (PPS lock, IMU FIFO
   margins, BLE throughput, 2M PHY acceptance) is a design value.
2. **High-performance OTP.** Message 0x06 0x41, keys 0x40A4xxxx and VALGET
   layer 4 appear only in the integration manual, not in the public interface
   description. The firmware uses them exactly as printed there. Whether the
   verification reply of a *not-set* module is a NAK or a reply with other
   values is not documented. The classifier treats a NAK or missing keys as
   UNKNOWN and then refuses to write. If a new module reports UNKNOWN, check
   with u-center (`gnss bridge`) before deciding anything.
3. **PPS ↔ UTC pairing** assumes the NAV-PVT output latency is under 1 s
   (normally tens of ms). A leap-second instant (sec = 60) is not specially
   handled.
4. **IMU time offset.**
   - The IMU-counter → pod-time map uses I2C register reads bracketed by
     `esp_timer`. The absolute bias (on the order of ±100 µs) is unmeasured.
   - The 480 Hz → 120 Hz box-car decimation is a crude anti-alias filter.
   - Axes are raw sensor axes; there is no orientation solving in the pod.
5. **GNSS frames before PPS lock** are stamped at receive time (latency not
   compensated). Flag bit 6 tells the app which kind a frame is.
6. **Blocking waits.**
   - A GNSS reconfiguration blocks the main loop: up to ~5 s for a rate change
     with rollback, longer for reset or OTP. PPS, the IMU FIFO, LEDs and the
     WiFi-test deadlines keep being serviced during it. Console, BOOT and
     further BLE controls wait for it.
   - `gnss reset` and bridge exit re-run the full init.
   - Console and bridge output are **dropped** (and counted), never waited for,
     when the USB host does not drain them.
7. **No BLE security.** There is no pairing or bonding, and one phone at a time.
8. **§10A test 3 is not supported** (CHG_EN is held low by design; see §6).
   How to run it is an open owner decision.
9. **Battery paths.** The low-battery cutoff and the VBAT reading are compiled
   but inert. The ADC is uncalibrated beyond the IDF eFuse calibration used by
   `analogReadMilliVolts`.
10. **Unhandled receiver faults.** The UART runs at 460800; the ESP32 baud
    error there was not characterised. There is no automatic recovery from a
    receiver in safeboot mode (TP12 procedure, DESIGN-REV-A §4).
11. **No OTA, no logging to flash** (that is rev B's NAND), and no power
    management (modem sleep).
