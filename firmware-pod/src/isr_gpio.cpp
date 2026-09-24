#include "isr_gpio.h"

#include <driver/gpio.h>
#include <esp_intr_alloc.h>

#include "console_io.h"

static bool s_service_ok = false;

bool isr_gpio_attach_rising(int pin, isr_gpio_handler_t handler, void *arg) {
  if (!s_service_ok) {
    esp_err_t e = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
    if (e != ESP_OK) {
      /* ESP_ERR_INVALID_STATE would mean someone installed it without our
       * flags (e.g. an attachInterrupt): refuse rather than mix. */
      con_printf("[isr] gpio_install_isr_service(IRAM) failed: %d\n", (int)e);
      return false;
    }
    s_service_ok = true;
  }
  gpio_config_t c = {};
  c.pin_bit_mask = 1ULL << pin;
  c.mode = GPIO_MODE_INPUT;
  c.pull_up_en = GPIO_PULLUP_DISABLE;
  c.pull_down_en = GPIO_PULLDOWN_DISABLE;
  c.intr_type = GPIO_INTR_POSEDGE;
  if (gpio_config(&c) != ESP_OK) return false;
  return gpio_isr_handler_add((gpio_num_t)pin, handler, arg) == ESP_OK;
}
