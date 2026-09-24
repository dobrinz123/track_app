#ifndef TRACE_POD_CTRL_SCHED_H
#define TRACE_POD_CTRL_SCHED_H

/*
 * Fair service of the two BLE control queues (review PODFW-REV2 M2;
 * framework-free, header-only).
 *
 * The loop takes ONE item per pass. With strict priority for the overflow
 * (BUSY-answer) queue, a peer that keeps the overflow queue full would
 * starve every accepted control. Round-robin instead: when both queues have
 * work, alternate; an accepted control therefore runs at least every second
 * pass.
 */

#include <stdbool.h>
#include <stdint.h>

typedef enum { CS_NONE = 0, CS_CONTROL = 1, CS_OVERFLOW = 2 } cs_pick_t;

/* *turn: 0 = the control queue goes first next time, 1 = the overflow
 * queue. Updated so the other queue goes first after an item is picked. */
static inline cs_pick_t ctrl_sched_next(bool has_control, bool has_overflow, uint8_t *turn) {
  cs_pick_t p;
  if (has_control && has_overflow)
    p = (*turn == 0) ? CS_CONTROL : CS_OVERFLOW;
  else if (has_control)
    p = CS_CONTROL;
  else if (has_overflow)
    p = CS_OVERFLOW;
  else
    return CS_NONE;
  *turn = (p == CS_CONTROL) ? 1 : 0;
  return p;
}

#endif /* TRACE_POD_CTRL_SCHED_H */
