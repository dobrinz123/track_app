// ELM dispatch: echo settings, '>' prompt emission on every response, ATZ
// banner, unknown-AT passthrough, mode-01/custom data forwarding. Mirrors
// the init sequence and framing contract in
// packages/core/src/telemetry/elm327Session.ts (INIT_COMMANDS, the `>`
// response framer) and docs/architecture/contracts.md's Telemetry addendum.
#include <unity.h>

#include <cstring>

extern "C" {
#include "elm_server_core.h"
}

void setUp() {}
void tearDown() {}

// Stub CAN layer: canned response for one expected request, NO_DATA for
// anything else -- lets each test assert exactly what elm_server_core.c
// asked the CAN layer for.
struct StubCtx {
  const char *expect_request;
  const char *reply_hex;
  int calls;
};

static ElmCanResult stub_can_query(const char *request_hex, char *out, size_t cap, void *raw_ctx) {
  StubCtx *ctx = static_cast<StubCtx *>(raw_ctx);
  ctx->calls++;
  if (strcmp(request_hex, ctx->expect_request) != 0) return ELM_CAN_NO_DATA;
  strncpy(out, ctx->reply_hex, cap - 1);
  out[cap - 1] = '\0';
  return ELM_CAN_OK;
}

static ElmCanResult stub_can_no_data(const char *, char *, size_t, void *ctx) {
  static_cast<StubCtx *>(ctx)->calls++;
  return ELM_CAN_NO_DATA;
}

void test_every_response_ends_with_prompt() {
  ElmServerState state;
  elm_server_state_init(&state);
  char out[128];
  elm_server_handle_command(&state, "ATZ", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_CHAR('>', out[strlen(out) - 1]);

  elm_server_handle_command(&state, "ATE0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_CHAR('>', out[strlen(out) - 1]);

  elm_server_handle_command(&state, "010C", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_CHAR('>', out[strlen(out) - 1]);
}

void test_atz_reset_banner() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false; // isolate the banner text from echo
  char out[128];
  elm_server_handle_command(&state, "ATZ", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("ELM327 v1.5 compatible TRACE\r>", out);
}

void test_echo_on_by_default_prefixes_the_command() {
  ElmServerState state;
  elm_server_state_init(&state);
  char out[128];
  elm_server_handle_command(&state, "ATL0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("ATL0\rOK\r>", out);
}

void test_ate0_disables_echo_for_subsequent_commands() {
  ElmServerState state;
  elm_server_state_init(&state);
  char out[128];
  elm_server_handle_command(&state, "ATE0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("ATE0\rOK\r>", out); // ATE0 itself still echoes (echo was on when sent)

  elm_server_handle_command(&state, "ATS0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("OK\r>", out); // no echo now
}

void test_ate1_re_enables_echo() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  char out[128];
  elm_server_handle_command(&state, "ATE1", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("OK\r>", out); // echo was off when ATE1 itself was sent

  elm_server_handle_command(&state, "ATL0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("ATL0\rOK\r>", out); // echoes now
}

void test_unknown_at_command_is_ok() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  char out[128];
  elm_server_handle_command(&state, "ATSH7E0", nullptr, nullptr, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("OK\r>", out);
}

void test_known_mode01_pid_forwards_and_formats_can_response() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  StubCtx ctx{"010C", "41 0C 1A F8", 0};
  char out[128];
  elm_server_handle_command(&state, "010C", stub_can_query, &ctx, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("41 0C 1A F8\r>", out);
  TEST_ASSERT_EQUAL_INT(1, ctx.calls);
}

void test_unsupported_mode01_pid_never_queries_can_and_returns_no_data() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  StubCtx ctx{"0199", "should not be requested", 0};
  char out[128];
  elm_server_handle_command(&state, "0199", stub_can_query, &ctx, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("NO DATA\r>", out);
  TEST_ASSERT_EQUAL_INT(0, ctx.calls);
}

// Source: packages/core/test/telemetry/elm327Session.test.ts "polls a
// custom PID verbatim..." -- request '221E1C', canned reply
// '62 1E 1C 87' (decodeCustomResponse -> 0x87 - 40 = 95).
void test_custom_hex_request_is_forwarded_and_response_echoed_verbatim() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  StubCtx ctx{"221E1C", "62 1E 1C 87", 0};
  char out[128];
  elm_server_handle_command(&state, "221E1C", stub_can_query, &ctx, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("62 1E 1C 87\r>", out);
  TEST_ASSERT_EQUAL_INT(1, ctx.calls);
}

void test_custom_hex_request_no_data_on_can_failure() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  StubCtx ctx{"221E1C", "unused", 0};
  char out[128];
  elm_server_handle_command(&state, "221E1C", stub_can_no_data, &ctx, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("NO DATA\r>", out);
  TEST_ASSERT_EQUAL_INT(1, ctx.calls);
}

void test_garbage_non_hex_request_is_no_data_without_can_query() {
  ElmServerState state;
  elm_server_state_init(&state);
  state.echo_enabled = false;
  StubCtx ctx{"n/a", "n/a", 0};
  char out[128];
  elm_server_handle_command(&state, "ZZZZ", stub_can_query, &ctx, out, sizeof out);
  TEST_ASSERT_EQUAL_STRING("NO DATA\r>", out);
  TEST_ASSERT_EQUAL_INT(0, ctx.calls);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_every_response_ends_with_prompt);
  RUN_TEST(test_atz_reset_banner);
  RUN_TEST(test_echo_on_by_default_prefixes_the_command);
  RUN_TEST(test_ate0_disables_echo_for_subsequent_commands);
  RUN_TEST(test_ate1_re_enables_echo);
  RUN_TEST(test_unknown_at_command_is_ok);
  RUN_TEST(test_known_mode01_pid_forwards_and_formats_can_response);
  RUN_TEST(test_unsupported_mode01_pid_never_queries_can_and_returns_no_data);
  RUN_TEST(test_custom_hex_request_is_forwarded_and_response_echoed_verbatim);
  RUN_TEST(test_custom_hex_request_no_data_on_can_failure);
  RUN_TEST(test_garbage_non_hex_request_is_no_data_without_can_query);
  return UNITY_END();
}
