#include "elm_server.h"

#include "can_obd.h"
#include "elm_line_parser.h"
#include "elm_server_core.h"

namespace {
ElmLineFramer g_framer;
ElmServerState g_state;
} // namespace

void elm_server_reset() {
  elm_line_framer_reset(&g_framer);
  elm_server_state_init(&g_state);
}

void elm_server_service(WiFiClient &client) {
  while (client.available() > 0) {
    char c = (char)client.read();
    char command[ELM_LINE_MAX];
    if (!elm_line_framer_push(&g_framer, c, command, sizeof command)) continue;

    char response[96];
    size_t n =
        elm_server_handle_command(&g_state, command, can_obd_query, nullptr, response, sizeof response);
    client.write(reinterpret_cast<const uint8_t *>(response), n);
  }
}
