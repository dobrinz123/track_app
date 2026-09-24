#ifndef TRACE_POD_LSM6DSV16X_REGS_H
#define TRACE_POD_LSM6DSV16X_REGS_H

/*
 * LSM6DSV16X register map subset used by the pod.
 *
 * Sources (checked 2026-09-24, nothing from memory):
 *  [DS]  ST DS13510 Rev 4 (May 2023), LCSC copy
 *        https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/2309061516_STMicroelectronics-LSM6DSV16XTR_C5267406.pdf
 *        Table 24 "Registers address map" (p.52-55) and §9 register descriptions.
 *  [AN]  ST AN5763 Rev 2 (Feb 2023), SparkFun mirror of the ST document
 *        https://cdn.sparkfun.com/assets/0/a/c/c/9/an5763-lsm6dsv16x-6axis-imu-with-embedded-sensor-fusion-ai-qvar-for-highend-applications-stmicroelectronics.pdf
 *        §6.4 timestamp, §9.x FIFO, Table 89 (timestamp word layout in FIFO).
 *
 * Board: SDO/SA0 tied to GND -> 7-bit address 1101010b = 0x6A
 *        (DESIGN-REV-A §4 netlist "U3.1 (SDO/SA0) -> GND (I2C address 1101010b = 0x6A)").
 */

#define LSM6DSV16X_I2C_ADDR 0x6A

/* [DS] Table 24 addresses */
#define LSM_REG_IF_CFG 0x03            /* H_LACTIVE[4]=0 active high, PP_OD[3]=0 push-pull; NOT reset by SW_RESET (§9.3) */
#define LSM_REG_FIFO_CTRL1 0x07        /* WTM[7:0]; 1 LSB = one 7-byte FIFO word (§9.5) */
#define LSM_REG_FIFO_CTRL2 0x08        /* (§9.6) */
#define LSM_REG_FIFO_CTRL3 0x09        /* BDR_GY[7:4] BDR_XL[3:0] (§9.7) */
#define LSM_REG_FIFO_CTRL4 0x0A        /* DEC_TS_BATCH[7:6] ODR_T_BATCH[5:4] G_EIS[3] FIFO_MODE[2:0] (§9.8) */
#define LSM_REG_INT1_CTRL 0x0D         /* (§9.11) */
#define LSM_REG_WHO_AM_I 0x0F          /* fixed 0x70 (§9.13) */
#define LSM_REG_CTRL1 0x10             /* OP_MODE_XL[6:4] ODR_XL[3:0] (§9.14) */
#define LSM_REG_CTRL2 0x11             /* OP_MODE_G[6:4] ODR_G[3:0] (§9.15) */
#define LSM_REG_CTRL3 0x12             /* BOOT[7] BDU[6] IF_INC[2] SW_RESET[0], default 0x44 (§9.16) */
#define LSM_REG_CTRL6 0x15             /* LPF1_G_BW[6:4] FS_G[3:0] (§9.19) */
#define LSM_REG_CTRL8 0x17             /* HP_LPF2_XL_BW[7:5] XL_DualC_EN[3] FS_XL[1:0] (§9.21) */
#define LSM_REG_FIFO_STATUS1 0x1B      /* DIFF_FIFO[7:0] (§9.25) */
#define LSM_REG_FIFO_STATUS2 0x1C      /* WTM_IA[7] OVR_IA[6] FULL_IA[5] CNT_BDR_IA[4] OVR_LATCHED[3] DIFF_FIFO_8[0] (§9.26) */
#define LSM_REG_TIMESTAMP0 0x40        /* TIMESTAMP0..3 = 0x40..0x43, LSB first (§9.43) */
#define LSM_REG_INTERNAL_FREQ_FINE 0x4F /* signed, 0.13 % steps (§9.52) */
#define LSM_REG_FUNCTIONS_ENABLE 0x50  /* INTERRUPTS_ENABLE[7] TIMESTAMP_EN[6] (§9.53) */
#define LSM_REG_FIFO_DATA_OUT_TAG 0x78 /* tag, then X_L..Z_H at 0x79..0x7E (§9.84-9.87) */

#define LSM_WHO_AM_I_VALUE 0x70

/* CTRL3 bits (§9.16) */
#define LSM_CTRL3_BOOT 0x80
#define LSM_CTRL3_BDU 0x40
#define LSM_CTRL3_IF_INC 0x04
#define LSM_CTRL3_SW_RESET 0x01

/* ODR / BDR codes (§9.14 Table 52, §9.15 Table 55, §9.7 Table 38):
 * 0b1000 = 480 Hz (high-performance mode). */
#define LSM_ODR_480HZ 0x08
#define LSM_BDR_480HZ 0x08
/* OP_MODE 000 = high-performance (Tables 51, 54) */
#define LSM_OP_MODE_HP 0x00

/* Full scales. FS_XL (§9.21): 11 = ±16 g.  FS_G (§9.19): 0100 = ±2000 dps. */
#define LSM_FS_XL_16G 0x03
#define LSM_FS_G_2000DPS 0x04
/* Sensitivities, [DS] Table 3 "Mechanical characteristics" (typ.):
 * LA_So FS ±16 g = 0.488 mg/LSB; G_So FS ±2000 dps = 70 mdps/LSB. */
#define LSM_ACC_G_PER_LSB_16G 0.000488f
#define LSM_GYR_DPS_PER_LSB_2000 0.070f

/* FIFO_CTRL4 fields (§9.8 Table 40) */
#define LSM_FIFO_MODE_CONTINUOUS 0x06 /* 110: continuous, overwrite oldest */
#define LSM_DEC_TS_BATCH_1 (0x01 << 6)
#define LSM_DEC_TS_BATCH_8 (0x02 << 6)
#define LSM_DEC_TS_BATCH_32 (0x03 << 6)

/* INT1_CTRL bits (§9.11 Table 45): bit6 CNT_BDR, bit5 FIFO_FULL,
 * bit4 FIFO_OVR, bit3 FIFO_TH, bit1 DRDY_G, bit0 DRDY_XL. */
#define LSM_INT1_FIFO_OVR 0x10
#define LSM_INT1_FIFO_TH 0x08

/* FUNCTIONS_ENABLE (§9.53 Table 147) */
#define LSM_FUNC_TIMESTAMP_EN 0x40

/* FIFO_STATUS2 bits (§9.26 Table 78) */
#define LSM_FIFO_ST2_WTM_IA 0x80
#define LSM_FIFO_ST2_OVR_IA 0x40
#define LSM_FIFO_ST2_FULL_IA 0x20
#define LSM_FIFO_ST2_OVR_LATCHED 0x08
#define LSM_FIFO_ST2_DIFF8 0x01

/* FIFO word = TAG + 6 data bytes (§9.5 "1 LSB = TAG (1 byte) + 1 sensor
 * (6 bytes)"). TAG_SENSOR[7:3], TAG_CNT[2:1] (§9.84 Table 216). */
#define LSM_FIFO_WORD_LEN 7
/* Tag values (§9.84 Table 218 / [AN] Table 86) */
#define LSM_TAG_EMPTY 0x00
#define LSM_TAG_GYRO_NC 0x01
#define LSM_TAG_ACC_NC 0x02
#define LSM_TAG_TEMPERATURE 0x03
#define LSM_TAG_TIMESTAMP 0x04 /* X_L..Y_H = TIMESTAMP[31:0], [AN] Table 89 */
#define LSM_TAG_CFG_CHANGE 0x05

/* FIFO capacity: "1.5 KB of data in FIFO" ([DS] §6.12 FIFO, p.44)
 * -> 1536 / 7 = 219 words when compression is off (it is). */
#define LSM_FIFO_CAPACITY_WORDS 219

/* Timestamp ticks per FIFO time slot at BDR 480 Hz: the timestamp counter
 * and the ODR are derived from the same internal clock; nominal tick rate
 * 46080 Hz ([DS] §9.52 formula), so 46080 / 480 = 96 ticks per slot exactly,
 * independent of FREQ_FINE. */
#define LSM_TICKS_PER_SLOT_480HZ 96.0

#endif /* TRACE_POD_LSM6DSV16X_REGS_H */
