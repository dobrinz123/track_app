/**
 * Savitzky-Golay filtering: a least-squares polynomial fit over a sliding
 * window.
 *
 * Why not a moving average: on a telemetry trace the braking spike and the
 * apex minimum ARE the signal. A box filter flattens exactly those features,
 * which is what the coaching engine reads. A local polynomial fit preserves
 * peak height and width while still rejecting sample noise, and -- because the
 * fit is analytic -- it differentiates the trace without the amplification a
 * naive finite difference produces on noisy input.
 *
 * Implemented natively rather than taken as a dependency: the published
 * npm packages for this are dormant (latest release 2021) and the algorithm is
 * a closed-form textbook derivation, so an owned ~200 lines costs less than a
 * stale dependency in the shipped bundle.
 */

/**
 * How samples closer to an edge than `halfWindow` are handled.
 *
 * - `'interpolate'` (default) keeps the window inside the data and evaluates
 *   the fitted polynomial off-centre. No invented samples, and derivatives
 *   stay meaningful at the edges.
 * - `'nearest'` slides a centred window and clamps out-of-range reads to the
 *   first/last sample. Cheaper, but it flattens genuine edge slopes -- do not
 *   use it with `derivative > 0` unless the edges are known to be flat.
 */
export type SavitzkyGolayEdgeMode = 'interpolate' | 'nearest';

export interface SavitzkyGolayOptions {
  /** Samples per window. Must be odd and >= 3 so the window has a centre. */
  windowLength: number;
  /** Degree of the fitted polynomial. Must be < windowLength. */
  polyOrder: number;
  /** Derivative to return: 0 smooths, 1 is the first derivative. Default 0. */
  derivative?: number;
  /** Spacing between samples in x units; scales derivatives. Default 1. */
  spacing?: number;
  /** Edge handling. Default `'interpolate'`. */
  edgeMode?: SavitzkyGolayEdgeMode;
}

interface ResolvedOptions {
  windowLength: number;
  halfWindow: number;
  polyOrder: number;
  derivative: number;
  spacing: number;
  edgeMode: SavitzkyGolayEdgeMode;
}

function rowAt(matrix: number[][], index: number): number[] {
  const row = matrix[index];
  if (row === undefined) throw new RangeError(`matrix is missing row ${index}`);
  return row;
}

function cellAt(row: readonly number[], index: number): number {
  const value = row[index];
  if (value === undefined) throw new RangeError(`row is missing column ${index}`);
  return value;
}

function resolveOptions(options: SavitzkyGolayOptions): ResolvedOptions {
  const { windowLength, polyOrder } = options;
  const derivative = options.derivative ?? 0;
  const spacing = options.spacing ?? 1;
  const edgeMode = options.edgeMode ?? 'interpolate';

  if (!Number.isInteger(windowLength) || windowLength < 3) {
    throw new RangeError('windowLength must be an integer of at least 3');
  }
  if (windowLength % 2 === 0) {
    throw new RangeError('windowLength must be odd so the window has a centre sample');
  }
  if (!Number.isInteger(polyOrder) || polyOrder < 0) {
    throw new RangeError('polyOrder must be a non-negative integer');
  }
  if (polyOrder >= windowLength) {
    throw new RangeError('polyOrder must be smaller than windowLength');
  }
  if (!Number.isInteger(derivative) || derivative < 0) {
    throw new RangeError('derivative must be a non-negative integer');
  }
  if (derivative > polyOrder) {
    throw new RangeError('derivative must not exceed polyOrder');
  }
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new RangeError('spacing must be a positive finite number');
  }

  return {
    windowLength,
    halfWindow: (windowLength - 1) / 2,
    polyOrder,
    derivative,
    spacing,
    edgeMode,
  };
}

/** Gauss-Jordan inverse with partial pivoting, for the small normal matrix. */
function invert(matrix: number[][]): number[][] {
  const size = matrix.length;
  const work: number[][] = [];
  for (let index = 0; index < size; index += 1) {
    const source = rowAt(matrix, index);
    if (source.length !== size) throw new RangeError('matrix must be square');
    const identity = new Array<number>(size).fill(0);
    identity[index] = 1;
    work.push([...source, ...identity]);
  }

  for (let column = 0; column < size; column += 1) {
    let pivotIndex = column;
    let pivotMagnitude = Math.abs(cellAt(rowAt(work, column), column));
    for (let candidate = column + 1; candidate < size; candidate += 1) {
      const magnitude = Math.abs(cellAt(rowAt(work, candidate), column));
      if (magnitude > pivotMagnitude) {
        pivotIndex = candidate;
        pivotMagnitude = magnitude;
      }
    }
    if (!(pivotMagnitude > 0)) {
      throw new RangeError('normal equations are singular; check windowLength and polyOrder');
    }
    if (pivotIndex !== column) {
      const swap = rowAt(work, column);
      work[column] = rowAt(work, pivotIndex);
      work[pivotIndex] = swap;
    }

    const pivotRow = rowAt(work, column);
    const pivot = cellAt(pivotRow, column);
    for (let index = 0; index < size * 2; index += 1) {
      pivotRow[index] = cellAt(pivotRow, index) / pivot;
    }

    for (let target = 0; target < size; target += 1) {
      if (target === column) continue;
      const targetRow = rowAt(work, target);
      const factor = cellAt(targetRow, column);
      if (factor === 0) continue;
      for (let index = 0; index < size * 2; index += 1) {
        targetRow[index] = cellAt(targetRow, index) - factor * cellAt(pivotRow, index);
      }
    }
  }

  return work.map((row) => row.slice(size));
}

/**
 * `(A^T A)^-1 A^T` for the Vandermonde matrix `A` of the centred window, where
 * `A[j][k] = (j - halfWindow)^k`. Row `k` of the result maps window samples to
 * the k-th coefficient of the fitted polynomial.
 */
function fitOperator(resolved: ResolvedOptions): number[][] {
  const { halfWindow, polyOrder, windowLength } = resolved;

  const design: number[][] = [];
  for (let sample = 0; sample < windowLength; sample += 1) {
    const position = sample - halfWindow;
    const row: number[] = [];
    for (let power = 0; power <= polyOrder; power += 1) {
      row.push(power === 0 ? 1 : position ** power);
    }
    design.push(row);
  }

  const normal: number[][] = [];
  for (let left = 0; left <= polyOrder; left += 1) {
    const row: number[] = [];
    for (let right = 0; right <= polyOrder; right += 1) {
      let sum = 0;
      for (let sample = 0; sample < windowLength; sample += 1) {
        const designRow = rowAt(design, sample);
        sum += cellAt(designRow, left) * cellAt(designRow, right);
      }
      row.push(sum);
    }
    normal.push(row);
  }

  const normalInverse = invert(normal);
  const operator: number[][] = [];
  for (let coefficient = 0; coefficient <= polyOrder; coefficient += 1) {
    const inverseRow = rowAt(normalInverse, coefficient);
    const row: number[] = [];
    for (let sample = 0; sample < windowLength; sample += 1) {
      const designRow = rowAt(design, sample);
      let sum = 0;
      for (let power = 0; power <= polyOrder; power += 1) {
        sum += cellAt(inverseRow, power) * cellAt(designRow, power);
      }
      row.push(sum);
    }
    operator.push(row);
  }
  return operator;
}

/**
 * Convolution weights that evaluate the requested derivative of the fitted
 * polynomial at `offset` sample positions from the window centre. `offset` 0
 * is the centred case used for interior samples; the edge modes evaluate the
 * same fit off-centre.
 */
function weightsAt(resolved: ResolvedOptions, operator: number[][], offset: number): number[] {
  const { polyOrder, derivative, spacing, windowLength } = resolved;
  const scale = 1 / spacing ** derivative;
  const weights = new Array<number>(windowLength).fill(0);

  for (let power = derivative; power <= polyOrder; power += 1) {
    // d^derivative/dz^derivative of z^power, evaluated at `offset`.
    let fallingFactorial = 1;
    for (let step = 0; step < derivative; step += 1) fallingFactorial *= power - step;
    const remainingPower = power - derivative;
    const positionTerm = remainingPower === 0 ? 1 : offset ** remainingPower;
    const contribution = fallingFactorial * positionTerm * scale;
    if (contribution === 0) continue;

    const operatorRow = rowAt(operator, power);
    for (let sample = 0; sample < windowLength; sample += 1) {
      weights[sample] = cellAt(weights, sample) + contribution * cellAt(operatorRow, sample);
    }
  }
  return weights;
}

function sampleAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`values is missing index ${index}`);
  return value;
}

function convolve(values: readonly number[], start: number, weights: readonly number[]): number {
  let sum = 0;
  for (let offset = 0; offset < weights.length; offset += 1) {
    sum += cellAt(weights, offset) * sampleAt(values, start + offset);
  }
  return sum;
}

function convolveClamped(
  values: readonly number[],
  centre: number,
  halfWindow: number,
  weights: readonly number[],
): number {
  const lastIndex = values.length - 1;
  let sum = 0;
  for (let offset = 0; offset < weights.length; offset += 1) {
    const requested = centre - halfWindow + offset;
    const clamped = requested < 0 ? 0 : requested > lastIndex ? lastIndex : requested;
    sum += cellAt(weights, offset) * sampleAt(values, clamped);
  }
  return sum;
}

/**
 * Convolution weights for one window. Exposed so callers filtering many
 * equally-shaped series can hoist the (small) matrix solve out of their loop,
 * and so the coefficients can be asserted directly in tests.
 *
 * `offset` is measured in samples from the window centre; it is 0 for the
 * interior case.
 */
export function savitzkyGolayCoefficients(
  options: SavitzkyGolayOptions,
  offset = 0,
): number[] {
  if (!Number.isFinite(offset)) throw new RangeError('offset must be a finite number');
  const resolved = resolveOptions(options);
  return weightsAt(resolved, fitOperator(resolved), offset);
}

/**
 * Filters `values`, returning a series of the same length. With
 * `derivative: 0` this smooths; with `derivative: 1` it returns d(value)/dx in
 * units of `1 / spacing`.
 *
 * Throws rather than truncating when the series is shorter than one window --
 * a silently shortened telemetry trace is worse than a rejected one.
 */
export function savitzkyGolay(
  values: readonly number[],
  options: SavitzkyGolayOptions,
): number[] {
  const resolved = resolveOptions(options);
  const { windowLength, halfWindow } = resolved;

  if (values.length < windowLength) {
    throw new RangeError(
      `values must contain at least windowLength (${windowLength}) samples, received ${values.length}`,
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new RangeError(`values[${index}] must be a finite number`);
    }
  }

  const operator = fitOperator(resolved);
  const centreWeights = weightsAt(resolved, operator, 0);
  const lastInteriorIndex = values.length - halfWindow - 1;
  const output = new Array<number>(values.length).fill(0);

  for (let index = 0; index < values.length; index += 1) {
    if (index >= halfWindow && index <= lastInteriorIndex) {
      output[index] = convolve(values, index - halfWindow, centreWeights);
      continue;
    }
    if (resolved.edgeMode === 'nearest') {
      output[index] = convolveClamped(values, index, halfWindow, centreWeights);
      continue;
    }
    // 'interpolate': pin the window to the nearest edge and evaluate the same
    // fit at this sample's true position within it.
    const windowStart = index < halfWindow ? 0 : values.length - windowLength;
    const offset = index - (windowStart + halfWindow);
    output[index] = convolve(values, windowStart, weightsAt(resolved, operator, offset));
  }

  return output;
}
