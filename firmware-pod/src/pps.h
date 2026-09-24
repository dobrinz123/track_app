#ifndef TRACE_POD_PPS_H
#define TRACE_POD_PPS_H

#include <stdint.h>

/* PPS capture on GPIO21 (input only). The ISR timestamps each rising edge
 * with esp_timer_get_time(); pps_service() feeds them to the timebase. */
void pps_init();
/* Drain captured edges into g_pod.tb. Call before processing GNSS bytes. */
void pps_service();
uint32_t pps_isr_count();
uint32_t pps_overflow_count();

#endif
