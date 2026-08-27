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
  PersonalBest: undefined;
  Settings: undefined;
  Telemetry: undefined;
  DevReplay: undefined;
  DidProbe: undefined;
  DidSweep: undefined;
};
