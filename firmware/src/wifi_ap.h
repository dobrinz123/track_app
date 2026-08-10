#ifndef TRACE_WIFI_AP_H
#define TRACE_WIFI_AP_H

#include <WiFiServer.h>

// SoftAP "TRACE-OBD-XXXX" (random 4-hex-digit suffix derived from the chip's
// MAC so multiple dongles don't collide on air), WPA2 password "tracetrace"
// (EXPECTED OUTCOME 2a -- CHANGE THIS before shipping past the bench; see
// firmware/README.md), static IP 192.168.4.1 (ESP-IDF SoftAP default,
// matches docs/architecture/contracts.md's assumed adapter host).
void wifi_ap_begin();

// TCP server bound to port 35000, single client (contracts.md: local socket
// only, one adapter <-> one phone).
WiFiServer &wifi_ap_tcp_server();

#endif // TRACE_WIFI_AP_H
