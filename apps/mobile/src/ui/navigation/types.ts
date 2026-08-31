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
  DidSweep: undefined;
  SignalFinder: undefined;
};
