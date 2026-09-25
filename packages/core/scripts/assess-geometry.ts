import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyzeCorners } from '../src/corners';
import {
  assessGeometryDeviation,
  decodeValidationExport,
  toValidationTrace,
} from '../src/geometryValidation';
import type { ValidationTrace } from '../src/geometryValidation';
import { loadProfileFromJson } from '../src/profile';

interface CliArgs {
  profilePath: string;
  exportPaths: string[];
  onTrackLateralM?: number;
}

const USAGE =
  'usage: npm run assess:geometry -- --profile <circuit.json> [--on-track-lateral-m <m>] <export.json>...';

function parseArgs(argv: readonly string[]): CliArgs {
  const exportPaths: string[] = [];
  let profilePath: string | undefined;
  let onTrackLateralM: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--profile') {
      profilePath = argv[index + 1];
      index += 1;
    } else if (arg === '--on-track-lateral-m') {
      onTrackLateralM = Number(argv[index + 1]);
      index += 1;
      if (!Number.isFinite(onTrackLateralM) || onTrackLateralM <= 0) {
        throw new Error('--on-track-lateral-m must be a positive number');
      }
    } else if (arg !== undefined) {
      exportPaths.push(arg);
    }
  }
  if (profilePath === undefined || exportPaths.length === 0) throw new Error(USAGE);
  return {
    profilePath,
    exportPaths,
    ...(onTrackLateralM === undefined ? {} : { onTrackLateralM }),
  };
}

function loadTraces(
  exportPaths: readonly string[],
  circuitId: string,
  layoutVersion: number,
): ValidationTrace[] {
  return exportPaths.map((path) => {
    const decoded = decodeValidationExport(readFileSync(resolve(path), 'utf8'));
    if (!decoded.ok) throw new Error(`${path}: ${decoded.errors.join('; ')}`);
    if (decoded.value.circuitId !== circuitId || decoded.value.layoutVersion !== layoutVersion) {
      throw new Error(
        `${path}: export is for ${decoded.value.circuitId} v${decoded.value.layoutVersion}, profile is ${circuitId} v${layoutVersion}`,
      );
    }
    return toValidationTrace(decoded.value);
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadProfileFromJson(readFileSync(resolve(args.profilePath), 'utf8'));
  if (!loaded.ok) throw new Error(`${args.profilePath}: ${loaded.errors.join('; ')}`);
  const { profile, runtime } = loaded;
  const traces = loadTraces(args.exportPaths, profile.circuitId, profile.layoutVersion);
  const report = assessGeometryDeviation(runtime, analyzeCorners(runtime), traces, {
    onTrackLateralM: args.onTrackLateralM ?? profile.corridorWidthM,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
