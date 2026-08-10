#ifndef TRACE_ELM_SERVER_H
#define TRACE_ELM_SERVER_H

#include <WiFiClient.h>

// Resets the ELM protocol state (echo etc.) and the input line framer --
// call once per new client connection.
void elm_server_reset();

// Reads whatever bytes are currently available on `client`, frames them
// into commands (elm_line_parser.c), dispatches each through
// elm_server_core.c (which queries can_obd.cpp for real data), and writes
// the response straight back. Non-blocking: does nothing if no bytes are
// waiting.
void elm_server_service(WiFiClient &client);

#endif // TRACE_ELM_SERVER_H
