#include "wifi_ap.h"

#include <WiFi.h>

namespace {

constexpr char kApPasswordDefault[] = "tracetrace"; // documented as changeable, see README
constexpr uint16_t kTcpPort = 35000;

WiFiServer g_server(kTcpPort);

// Random suffix from the low 16 bits of the chip's factory MAC, so it's
// stable per-device but distinguishes multiple dongles on the bench.
String ap_ssid_with_suffix() {
  uint64_t mac = ESP.getEfuseMac();
  char suffix[5];
  snprintf(suffix, sizeof suffix, "%04X", (unsigned)(mac & 0xFFFF));
  return String("TRACE-OBD-") + suffix;
}

} // namespace

void wifi_ap_begin() {
  WiFi.mode(WIFI_AP);

  IPAddress local_ip(192, 168, 4, 1);
  IPAddress gateway(192, 168, 4, 1);
  IPAddress subnet(255, 255, 255, 0);
  WiFi.softAPConfig(local_ip, gateway, subnet);

  String ssid = ap_ssid_with_suffix();
  WiFi.softAP(ssid.c_str(), kApPasswordDefault);

  g_server.begin();
}

WiFiServer &wifi_ap_tcp_server() { return g_server; }
