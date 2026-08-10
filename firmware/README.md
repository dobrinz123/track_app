# TRACE OBD dongle firmware (rev-A prototype)

ESP32-C3 firmware for the TRACE OBD telemetry dongle (`hardware/DESIGN.md`,
binding). Speaks a minimal ELM327-compatible subset over WiFi so the shipped
TRACE app connects **unmodified** -- it is the server side of exactly the
client in `packages/core/src/telemetry/elm327Session.ts` /
`apps/mobile/src/session/tcpObdTransport.ts`.

Scope note (CONSTRAINTS): this is small, readable rev-A prototype firmware,
not a product. No OTA, no BLE, no web UI.

## Framework

Arduino (`framework = arduino` in `platformio.ini`). `WiFi.h`/`WiFiServer`
implement the SoftAP + TCP server in a handful of calls, and arduino-esp32's
bundled `driver/twai.h` is the same underlying ESP-IDF TWAI driver a pure
`espidf` project would use -- including `TWAI_MODE_LISTEN_ONLY` for the
`SNIFF_ONLY` future-passive build -- so listen-only support is exactly as
clean as it would be under `espidf`, without `espidf`'s Kconfig/component
boilerplate for firmware this size.

All protocol logic (`elm_line_parser`, `elm_server_core`, `pid_codec`,
`read_only_guard`) is plain, framework-free C, so `env:native` compiles and
unit-tests it directly on the host -- no ESP32 hardware or QEMU needed to
run the test suite.

## Layout

```
firmware/
  platformio.ini
  src/
    pid_codec.{h,c}          framework-free: mode-01 PID table + response formatting
    elm_line_parser.{h,c}    framework-free: incoming-byte -> command-line framer
    elm_server_core.{h,c}    framework-free: ELM dispatch (echo, AT commands, '>' prompt)
    read_only_guard.{h,c}    framework-free: THE single CAN-transmit chokepoint
    can_obd.{h,cpp}          ESP32: TWAI driver, 0x7DF request / 0x7E8-0x7EF response
    wifi_ap.{h,cpp}          ESP32: SoftAP + TCP server (port 35000)
    elm_server.{h,cpp}       ESP32: WiFiClient <-> elm_server_core wiring
    status_led.{h,cpp}       ESP32: IO8 blink pattern state machine
    main.cpp                 ESP32: setup()/loop(), single-client accept policy
  test/
    test_pid_codec/          PID formatting vectors (env:native)
    test_elm_line_parser/    framing / echo / prompt (env:native)
    test_elm_server_core/    dispatch table (env:native)
    test_read_only_guard/    whitelist/blacklist table (env:native)
```

## Building

```sh
pio run -e esp32c3          # cross-compile firmware
pio run -e esp32c3-sniff    # cross-compile the SNIFF_ONLY (listen-only) build
pio test -e native          # host unit tests, no hardware required
```

## Flashing

Per `hardware/DESIGN.md` J2 (1x6 2.54mm header: 3V3, GND, TX, RX,
IO9/BOOT, EN) and SW1 (BOOT strap on IO9):

1. Connect a 3.3V USB-UART adapter to J2 (3V3, GND, TX->RX, RX->TX; do not
   connect 3V3 if the dongle is already bus-powered).
2. Hold SW1 (BOOT) down, power/reset the board, then release SW1 -- this
   puts the ESP32-C3 into its UART download mode.
3. `pio run -e esp32c3 -t upload --upload-port <COMx or /dev/ttyUSBx>`
4. Power-cycle (or reset without holding SW1) to run the flashed firmware
   normally.

## AP credentials

- SSID: `TRACE-OBD-XXXX` (last 4 hex digits of the module's factory MAC, so
  multiple dongles on the bench don't collide)
- Password: `tracetrace` (WPA2-PSK) -- **change this** (`src/wifi_ap.cpp`,
  `kApPasswordDefault`) before using the dongle anywhere it isn't your own
  bench; it ships as a known, documented default.
- Static IP: `192.168.4.1`
- TCP port: `35000`, single client only (a second connection attempt is
  refused, per `hardware/DESIGN.md`'s "one adapter <-> one phone" design)

## Connecting the app

In TRACE: Settings -> adapter host `192.168.4.1`, port `35000`. Join the
`TRACE-OBD-XXXX` WiFi network first (WPA2 password above); the app's
`TcpObdTransport` connects over plain TCP, no pairing/auth beyond WPA2.

## Read-only guard

`src/read_only_guard.c`'s `guard_can_transmit()` is the **only** place in
the firmware allowed to decide whether a CAN frame reaches the vehicle bus
(`src/can_obd.cpp`'s single `twai_transmit()` call site is gated behind it).
Whitelist: mode `01` (show current data) and the two read-only UDS services
the app's custom-PID contract uses, `21`/`22`. Everything else -- explicitly
including `04` (clear DTCs), `08` (actuation), `2F` (IO control), `3E`
(tester present) -- is rejected and logged. See `test/test_read_only_guard/`
for the full table.

## Honest limitations (rev-A)

Same caveats as `hardware/DESIGN.md` section 6: no physical validation yet.
`SNIFF_ONLY` (passive listen-only, S pin held HIGH, never transmits) exists
as a compile-time flag for a future fully-passive build but is not the
default -- normal operation actively polls the ECU per the app's poll plan.
