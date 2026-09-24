#ifndef TRACE_POD_CONSOLE_H
#define TRACE_POD_CONSOLE_H

/* USB-CDC console (native USB, USB-Serial/JTAG). Line-based, 115200 is
 * ignored by the USB CDC but used by `pio device monitor`. */
void console_init();
void console_service();
void console_print_status();

#endif
