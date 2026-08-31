export type RootStackParamList = {
  CircuitSelection: undefined;
  CircuitDetail: { circuitId: string };
  Preflight: undefined;
  CalibrationInstructions: undefined;
  ActiveCalibration: undefined;
  CalibrationResult: undefined;
  ActiveDashboard: undefined;
  SessionResults: undefined;
  SessionHistory: undefined;
  LapDetail: { sessionId: string; lapNumber: number };
  /** Ticket P5b B1: the post-session corner analysis of ONE stored session. */
  Analysis: { sessionId: string };
  /**
   * Ticket P5c-B D3 (contracts.md R2-3b): the between-stint pit view of the
   * session currently running. Takes no parameters — it always reads the ACTIVE
   * session, and says so when there is none.
   */
  PitView: undefined;
  PersonalBest: undefined;
  Settings: undefined;
  Telemetry: undefined;
  DevReplay: undefined;
  DidProbe: undefined;
  /**
   * Ticket P4p G3 (binding, field test 9): the DID sweep can now be opened
   * WITH a range to sweep -- the Signal Finder's "Scan 0x29 58F3–6FFF" button
   * hands over the target's own unswept discovery range instead of leaving the
   * driver to type it in. All fields optional: the screen is still opened
   * bare from Settings and then behaves exactly as it always did.
   */
  DidSweep: { fromDid?: number; toDid?: number; ecu?: number } | undefined;
  SignalFinder: undefined;
};
