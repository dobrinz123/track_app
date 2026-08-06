/** Deterministic 32-bit linear-congruential generator. */
export class SeededPrng {
  private state: number;
  private spareGaussian: number | undefined;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new RangeError('seed must be finite');
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(1_664_525, this.state) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  gaussian(): number {
    if (this.spareGaussian !== undefined) {
      const value = this.spareGaussian;
      this.spareGaussian = undefined;
      return value;
    }

    const radius = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, this.next())));
    const angle = Math.PI * 2 * this.next();
    this.spareGaussian = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
}
