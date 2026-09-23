# RFQ — custom BLE OBD-II adapter (ODM), based on iKiKin V03H4

Owner-facing note (not for the supplier): our targets below are OUR acceptance
criteria, to be measured on samples — not facts about the supplier's product.
Context: `DESIGN.md` §6 (entry vs competitive OBD tier, dragy OBD II "200 Hz").

---

Hello,

We are developing a motorsport data-logging app (lap timing + vehicle
telemetry) and are interested in your V03H4 BT4.0 OBD-II adapter as the base
for a custom (ODM / private-label) product. Before ordering we need to
understand the hardware and whether you can deliver a custom firmware.

## Part 1 — Questions about the current V03H4

1. Which chips are inside? Please give exact part numbers for: the main MCU,
   the Bluetooth chip/module, and the CAN transceiver. A photo of both sides
   of the PCB would help.
2. Does the MCU have a hardware CAN controller, or is CAN done in software?
3. Is the firmware developed by your own team? Can you modify it, or is it
   bought from a third party?
4. Bluetooth: exact version, BLE only or dual-mode, GATT service and
   characteristic UUIDs used for data, maximum MTU, is 2M PHY supported?
5. Listing mentions "SDK": what does the SDK contain? Please send it and the
   protocol documentation.
6. Supported OBD protocols (ISO 15765-4 CAN 11/29-bit 250/500 kbit/s,
   ISO 9141-2, KWP2000, J1850)?
7. Measured speed today: how many OBD mode-01 PID responses per second on a
   500 kbit/s CAN car? Do you support multi-PID requests (several PIDs in one
   request)?
8. Standby current when the car is off, and does it sleep automatically?
9. Certifications you already hold (CE-RED, FCC, RoHS, REACH) — copies please.
10. MOQ, unit price at 100 / 500 / 1000 pcs, sample price, lead time.

## Part 2 — What we need in the custom version

**Hardware**
- MCU with a hardware CAN controller; proper CAN transceiver with ESD
  protection on CAN-H/CAN-L.
- BLE 5.x with 2M PHY and MTU ≥ 185 bytes; works with iPhone (BLE, no MFi
  needed) and Android.
- Standby current ≤ 1 mA with automatic sleep when the engine is off, wake on
  CAN activity or voltage rise, so the car battery is never drained.
- Input protection for automotive transients (load dump, reverse polarity).
- Custom logo / housing colour (private label).

**Firmware — "fast mode" in addition to standard ELM327**
- Keep full ELM327 v1.5 compatibility (so generic apps still work).
- A second, binary "fast mode" (no ELM327 ASCII text), documented by you:
  - direct CAN request/response: we send CAN ID + data, you return
    CAN ID + data + a timestamp;
  - a polling list: we upload a list of requests (OBD mode 01 PIDs and UDS
    service 0x22 DIDs, with ISO-TP multi-frame), the adapter polls them in a
    loop by itself and streams the answers;
  - every response carries a microsecond timestamp from the adapter's clock;
  - optional passive listen-only mode with configurable CAN ID filters
    (receive broadcast frames without transmitting).
- **Read-only safety:** in fast mode the adapter must only transmit
  diagnostic READ requests (OBD modes 01/09, UDS 0x22 and 0x3E TesterPresent).
  All write, clear-DTC, routine-control, programming and flash services must be
  blocked in firmware. This is a hard requirement.
- Firmware update over BLE (OTA), so we can receive fixes without returning
  units.

**Performance targets (we will test samples against these)**
- Fast mode on a 500 kbit/s CAN car: ≥ 100 responses per second in total
  across the polling list (target 200).
- Latency from CAN response to BLE notification ≤ 10 ms.
- Stable connection for a 30-minute session with no drops.

**Deliverables**
- Full protocol documentation for fast mode (commands, packet format, UUIDs).
- 3–5 engineering samples with the custom firmware for our testing.
- Confirmation of who owns the custom firmware, and whether you can provide
  the source code or an escrow copy.
- Test report for the performance targets above on at least one CAN car.

Please tell us which points you can do, which you cannot, and the cost
(one-time engineering / NRE fee and unit price).

Thank you.
