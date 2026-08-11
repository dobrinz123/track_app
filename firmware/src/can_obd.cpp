#include "can_obd.h"

#include <Arduino.h>
#include <driver/twai.h>

#include "can_response_match.h"
#include "pid_codec.h"
#include "read_only_guard.h"

namespace {

constexpr gpio_num_t kCanTxGpio = GPIO_NUM_4; // hardware/DESIGN.md: IO4 = CAN TX -> U2.TXD
constexpr gpio_num_t kCanRxGpio = GPIO_NUM_5; // IO5 <- U2.RXD
constexpr int kCanSGpio = 6;                  // IO6 -> U2.S (silent-mode pin)
constexpr uint32_t kObdFunctionalId = 0x7DF;  // standard OBD functional request address
constexpr uint32_t kObdResponseIdLow = 0x7E8; // ECU response range, hardware/DESIGN.md architecture
constexpr uint32_t kObdResponseIdHigh = 0x7EF;
constexpr uint32_t kResponseTimeoutMs = 100; // EXPECTED OUTCOME 2c

void guard_log_serial(const char *msg) { Serial.println(msg); }

size_t hex_to_bytes(const char *hex, uint8_t *out, size_t out_cap) {
  size_t len = strlen(hex);
  size_t nbytes = len / 2;
  if (nbytes > out_cap) nbytes = out_cap;
  for (size_t i = 0; i < nbytes; i++) {
    char byte_str[3] = {hex[i * 2], hex[i * 2 + 1], '\0'};
    out[i] = (uint8_t)strtoul(byte_str, nullptr, 16);
  }
  return nbytes;
}

void format_raw_hex(const uint8_t *data, size_t len, char *out, size_t out_cap) {
  size_t pos = 0;
  out[0] = '\0';
  for (size_t i = 0; i < len && pos + 3 < out_cap; i++) {
    int n = snprintf(out + pos, out_cap - pos, i == 0 ? "%02X" : " %02X", data[i]);
    if (n < 0) break;
    pos += (size_t)n;
  }
}

/* THE ONLY call site of twai_transmit() in this firmware (EXPECTED OUTCOME
 * 2d). Every request -- standard PID or custom read -- funnels through
 * here, and guard_can_transmit() (read_only_guard.c) is consulted before
 * anything reaches the wire. */
bool can_tx_chokepoint(uint32_t id, const uint8_t *data, uint8_t dlc) {
  if (!guard_can_transmit(data, dlc)) return false;

#ifdef SNIFF_ONLY
  (void)id;
  return false; // passive mode: never transmits, even if the guard allowed it
#else
  twai_message_t msg = {};
  msg.identifier = id;
  msg.data_length_code = dlc;
  memcpy(msg.data, data, dlc);
  return twai_transmit(&msg, pdMS_TO_TICKS(50)) == ESP_OK;
#endif
}

} // namespace

void can_obd_init() {
  pinMode(kCanSGpio, OUTPUT);
#ifdef SNIFF_ONLY
  digitalWrite(kCanSGpio, HIGH); // silent/standby -- transceiver never drives the bus
#else
  digitalWrite(kCanSGpio, LOW); // normal mode -- required to poll the vehicle
#endif

  guard_set_logger(guard_log_serial);

#ifdef SNIFF_ONLY
  twai_general_config_t g_config =
      TWAI_GENERAL_CONFIG_DEFAULT(kCanTxGpio, kCanRxGpio, TWAI_MODE_LISTEN_ONLY);
#else
  twai_general_config_t g_config =
      TWAI_GENERAL_CONFIG_DEFAULT(kCanTxGpio, kCanRxGpio, TWAI_MODE_NORMAL);
#endif
  twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g_config, &t_config, &f_config) == ESP_OK) {
    twai_start();
  } else {
    Serial.println("can_obd: TWAI driver install failed");
  }
}

ElmCanResult can_obd_query(const char *request_hex, char *response_hex_out, size_t response_cap,
                            void *ctx) {
  (void)ctx;

  uint8_t payload[7] = {0};
  size_t nbytes = hex_to_bytes(request_hex, payload, sizeof payload);
  if (nbytes == 0 || nbytes > 7) return ELM_CAN_NO_DATA;

  uint8_t frame[8] = {0};
  frame[0] = (uint8_t)nbytes; // ISO-TP single-frame length nibble
  memcpy(&frame[1], payload, nbytes);

  if (!can_tx_chokepoint(kObdFunctionalId, frame, sizeof frame)) return ELM_CAN_NO_DATA;

  twai_message_t rx;
  uint32_t deadline = millis() + kResponseTimeoutMs;
  while (millis() < deadline) {
    uint32_t remaining = deadline - millis();
    if (twai_receive(&rx, pdMS_TO_TICKS(remaining < 10 ? remaining : 10)) != ESP_OK) continue;
    if (rx.identifier < kObdResponseIdLow || rx.identifier > kObdResponseIdHigh) continue;
    if (rx.data_length_code < 2) continue;

    uint8_t length = rx.data[0] & 0x0F;
    if (length == 0 || length > rx.data_length_code - 1) continue;

    // hardware/DESIGN.md sec8 item12 (rev A3 NO-GO fix): reject any frame
    // that isn't the actual positive response to THIS request (wrong
    // service, wrong echoed PID/DID, or a negative 0x7F response) instead
    // of accepting the first 0x7E8-0x7EF frame unconditionally -- a
    // busy/multi-ECU bus can otherwise have an unrelated frame mistaken
    // for the answer.
    if (!can_response_matches_request(payload, nbytes, &rx.data[1], length)) continue;
    uint8_t service = rx.data[1];

    // Mode-01 response (service 0x41 = 0x01 | 0x40): format via pid_codec so
    // the wire bytes match the app's decodeMode01Response() vectors
    // byte-for-byte (see firmware/README.md provenance table).
    if (service == 0x41 && length >= 2) {
      uint8_t pid = rx.data[2];
      size_t data_len = (size_t)length - 2;
      if (pid_codec_format_mode01_response(pid, &rx.data[3], data_len, response_hex_out,
                                            response_cap) > 0) {
        return ELM_CAN_OK;
      }
      return ELM_CAN_NO_DATA;
    }

    // Custom read response (e.g. UDS 0x62 = positive response to 0x22):
    // echoed raw, matching the app's decodeCustomResponse() contract
    // (last data byte - 40).
    format_raw_hex(&rx.data[1], length, response_hex_out, response_cap);
    return ELM_CAN_OK;
  }

  return ELM_CAN_NO_DATA;
}

bool can_obd_has_bus_error() {
  twai_status_info_t status;
  if (twai_get_status_info(&status) != ESP_OK) return true;
  return status.state == TWAI_STATE_BUS_OFF || status.state == TWAI_STATE_RECOVERING;
}
