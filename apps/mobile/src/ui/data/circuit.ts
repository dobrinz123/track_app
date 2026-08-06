/**
 * Static circuit metadata for the UI layer's single supported circuit.
 * Sourced from docs/research/transilvania-motor-ring.md and
 * docs/decisions/ADR-0002-circuit-geometry-source.md. This is display-only
 * copy — geometry itself (centerline, gates) lives in `@circuit/core`
 * profiles built by a separate work package and is never fabricated here.
 */
export const TRANSILVANIA_MOTOR_RING = {
  circuitId: 'transilvania-motor-ring',
  displayName: 'Transilvania Motor Ring',
  locality: 'Cerghid, Ungheni',
  county: 'Mureș County',
  country: 'Romania',
  layoutId: 'main',
  lengthKm: 3.708,
  direction: 'clockwise' as const,
  openedYear: 2018,
  /** ADR-0002: geometry is community-derived from OSM; sectors are app-defined — never presented as official. */
  geometryStatus: 'community-derived' as const,
  sectorStatus: 'app-defined' as const,
  geometryProvenance:
    'Centerline derived from OpenStreetMap way 488429454 (community-mapped, not an official homologation file). Start/finish and the 3 sector boundaries are app-defined, not published by the circuit — see ADR-0002.',
  osmAttribution: '© OpenStreetMap contributors (ODbL)',
} as const;

export const ADVISORY_NOTICE = 'Recreational timing aid — not an official timing system.';
