import type { AnalysisUiLanguage } from './analysisStrings';

/**
 * Ticket P6a — the RO/EN chrome for the two experimental signal-processing
 * settings: IMU sensor fusion on the live G channels, and Savitzky-Golay
 * smoothing of the recorded G channels in the post-session analysis.
 *
 * Same two invariants as `trackdayStrings.ts` / `analysisStrings.ts`: RO
 * carries every key EN does (pinned by a test), and `SettingsScreen.tsx` holds
 * no prose of its own for these rows.
 *
 * The copy states what the driver is actually opting into, in their own
 * language: both flags are experimental, both are off by default, and NEITHER
 * can affect lap timing -- the G-force provider never touches the timing
 * engine, and the smoothing runs only over a finished recording. That last
 * point is the one a driver would otherwise have to guess at, so it is said
 * out loud rather than implied.
 */
export interface ImuSettingStrings {
  /** The toggle's own label. */
  title: string;
  /** What it does. */
  help: string;
  /** What it cannot do -- the reassurance that belongs next to an experimental switch. */
  helpBounds: string;
  a11y: string;
}

/** The `imuFusionEnabled` row. */
export const IMU_FUSION_SETTING_STRINGS: Readonly<
  Record<AnalysisUiLanguage, ImuSettingStrings>
> = {
  en: {
    title: 'IMU sensor fusion (experimental)',
    help: 'Estimate gravity by fusing the phone’s gyroscope with its accelerometer instead of a simple low-pass filter. Steadier lateral and longitudinal g while braking and cornering. This changes how those two are measured — recording the yaw rate is the separate switch above.',
    helpBounds:
      'Never used for lap timing. A phone without a usable gyroscope simply records nothing extra. Takes effect at your next session. Off by default.',
    a11y: 'IMU sensor fusion',
  },
  ro: {
    title: 'Fuziune senzori IMU (experimental)',
    help: 'Estimează gravitația combinând giroscopul telefonului cu accelerometrul, în loc de un filtru trece-jos simplu. Accelerații laterale și longitudinale mai stabile la frânare și în viraje. Aceasta schimbă modul în care sunt măsurate cele două — înregistrarea vitezei de girație este comutatorul separat de mai sus.',
    helpBounds:
      'Nu este folosită niciodată pentru cronometrare. Un telefon fără giroscop utilizabil pur și simplu nu înregistrează nimic în plus. Se aplică de la următoarea ta sesiune. Oprit implicit.',
    a11y: 'Fuziune senzori IMU',
  },
};

/**
 * The `imuGyroCaptureEnabled` row (ticket P7R E3).
 *
 * The copy has to make ONE distinction clear to someone standing in a
 * paddock: this row records a new measurement, the fusion row above changes
 * how an existing one is computed. That is the whole reason they are two
 * rows, and it is why this one is on by default while that one is not.
 */
export const IMU_GYRO_CAPTURE_SETTING_STRINGS: Readonly<
  Record<AnalysisUiLanguage, ImuSettingStrings>
> = {
  en: {
    title: 'Record yaw rate (gyroscope)',
    help: 'Record how fast the car is rotating, from the phone’s gyroscope, as its own channel alongside the g-force channels. Used by the post-session analysis to tell a real slide from a corner you simply drove quickly.',
    helpBounds:
      'Never used for lap timing, and it does not change your lateral or longitudinal g — those keep being measured exactly as before. A phone without a usable gyroscope simply records nothing extra. Takes effect at your next session. On by default.',
    a11y: 'Record yaw rate from the gyroscope',
  },
  ro: {
    title: 'Înregistrează viteza de girație (giroscop)',
    help: 'Înregistrează cât de repede se rotește mașina, de la giroscopul telefonului, pe un canal propriu, alături de canalele de accelerație. Este folosită în analiza de după sesiune ca să deosebească o derapare reală de un viraj pe care pur și simplu l-ai luat repede.',
    helpBounds:
      'Nu este folosită niciodată pentru cronometrare și nu îți schimbă accelerațiile laterale sau longitudinale — acelea sunt măsurate exact ca până acum. Un telefon fără giroscop utilizabil pur și simplu nu înregistrează nimic în plus. Se aplică de la următoarea ta sesiune. Pornit implicit.',
    a11y: 'Înregistrează viteza de girație de la giroscop',
  },
};

/** The `analysisSmoothingEnabled` row. */
export const ANALYSIS_SMOOTHING_SETTING_STRINGS: Readonly<
  Record<AnalysisUiLanguage, ImuSettingStrings>
> = {
  en: {
    title: 'Smooth G traces in analysis (experimental)',
    help: 'Filter the recorded lateral and longitudinal g of a finished session before analysing it, using a polynomial fit that keeps the height of a braking spike or an apex minimum instead of flattening it.',
    helpBounds:
      'Applied only after a session ends — never to anything shown while you are driving, and never to your lap times. Off by default.',
    a11y: 'Smooth G traces in analysis',
  },
  ro: {
    title: 'Netezire accelerații în analiză (experimental)',
    help: 'Filtrează accelerațiile laterale și longitudinale înregistrate ale unei sesiuni încheiate înainte de analiză, cu o aproximare polinomială care păstrează amplitudinea vârfului de frânare sau a minimului din apex, în loc să o aplatizeze.',
    helpBounds:
      'Se aplică doar după încheierea sesiunii — niciodată la ce vezi în timp ce conduci și niciodată la timpii tăi de tur. Oprit implicit.',
    a11y: 'Netezire accelerații în analiză',
  },
};
