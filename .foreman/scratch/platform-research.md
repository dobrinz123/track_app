# GNSS Lap-Timing Platform Constraints: Expo SDK 57 Research

**Research Date:** 2026-08-06  
**Expo SDK Version:** 57 (stable, June 2026 release; React Native 0.86, React 19.2)  
**Achievable GNSS Rate:** ~1 Hz foreground (see expo-location accuracy/interval specifics below)  
**Monotonic Time:** Use `performance.now()` (microsecond precision, not wall-clock subject to skew)

---

## 1. expo-location Foreground: watchPositionAsync

**Accuracy Levels & Update Rates**

expo-location exposes `Accuracy` enum for Android/iOS/Web:
- `Accuracy.Lowest` (1): ±3 km
- `Accuracy.Low` (2): ±1 km  
- `Accuracy.Balanced` (3): ±100 m
- `Accuracy.High` (4): ±10 m
- `Accuracy.Highest`: Highest precision + supplementary sensor data (navigation optimized)

**watchPositionAsync Configuration**

`watchPositionAsync(options, callback)` accepts:
- `accuracy`: Accuracy enum value (required)
- `timeInterval`: Minimum milliseconds between updates (Android only)
- `distanceInterval`: Minimum meters displacement to trigger update (default depends on accuracy)

**Foreground-Only Constraint:** watchPositionAsync emits updates only while app is in foreground. No background delivery. For track sessions requiring foreground operation, this is acceptable; brief backgrounding requires startLocationUpdatesAsync + TaskManager.

**Sources:**
- [Location - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/location/) (accessed 2026-08-06)

---

## 2. expo-location Background: startLocationUpdatesAsync + TaskManager

**Background Location Setup**

To receive location updates when app backgrounded:
1. Request both `requestForegroundPermissionsAsync()` and `requestBackgroundPermissionsAsync()`
2. Define a TaskManager task: `TaskManager.defineTask(taskName, ({ data, error }) => { ... })`
3. Call `Location.startLocationUpdatesAsync(taskName, options)` with accuracy & interval settings
4. Call `Location.stopLocationUpdatesAsync(taskName)` to cleanup

**Limitation on Expo Go:** TaskManager background location is unsupported on Android with Expo Go; requires development build (EAS Build).

**Deferred Updates (Battery Optimization)**
- `deferredUpdatesDistance`: Distance in meters before delivering batch
- `deferredUpdatesInterval`: Time in ms to defer delivery
- `deferredTimeout`: Max time before forcing delivery

**Sources:**
- [TaskManager - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/task-manager/) (accessed 2026-08-06)
- [Location - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/location/) (accessed 2026-08-06)

---

## 3. Android Platform Specifics

**Required Manifest Permissions**

For foreground location:
- `ACCESS_FINE_LOCATION` (precise, GPS-capable)
- `ACCESS_COARSE_LOCATION` (cell/WiFi triangulation)

For background location (Android 10+):
- `ACCESS_BACKGROUND_LOCATION` (runtime permission; Google Play policy restricted)

**Foreground Service Type**

Android 14+ (API 34+) requires foreground services declare a type. For location:
- Add `FOREGROUND_SERVICE_TYPE_LOCATION` to manifest
- Call `startForeground(id, notification)` before accessing location in background
- Permissions must be granted before calling `startForeground()`

**Doze & Battery Optimization**

Doze (low-power mode) throttles background location:
- Location computed ~every 10 minutes
- ~6 updates batched and delivered hourly
- Geofencing responsiveness degrades from ~10s to ~2 min (10x battery improvement on some devices)
- Wi-Fi static AP detection suppresses location computation

**Google Play Background Location Policy (April 2026 Update)**

- Background location use restricted to core app functionality and user-initiated features
- Prohibited for analytics/advertising only
- Enforcement begins late October 2026 for apps targeting Android 17+
- Foreground location access ("location button") now recommended minimum scope

**Mock Location Detection**

`Location.isMockLocation()` (preferred) or deprecated `Location.isFromMockProvider()` detect spoofed positions. Essential for lap-timing validation.

**Sources:**
- [Request location permissions - Android Developers](https://developer.android.com/develop/sensors-and-location/location/permissions) (accessed 2026-08-06)
- [Foreground service types - Android Developers](https://developer.android.com/develop/background-work/services/fgs/service-types) (accessed 2026-08-06)
- [About background location and battery life - Android Developers](https://developer.android.com/develop/sensors-and-location/location/battery) (accessed 2026-08-06)
- [Understanding location in the background - Play Console Help](https://support.google.com/googleplay/android-developer/answer/9799150?hl=en) (accessed 2026-08-06)
- [Location - Android API Reference](https://developer.android.com/reference/android/location/Location) (accessed 2026-08-06)

---

## 4. iOS Platform Specifics

**Required Info.plist Keys**

Declare intent for location access:
- **`NSLocationWhenInUseUsageDescription`** (String): Reason for foreground-only access (required)
- **`NSLocationAlwaysAndWhenInUseUsageDescription`** (String): Reason for foreground + background access
- **`UIBackgroundModes` (Array):** Add `"location"` to enable background updates

**Accuracy Authorization**

iOS 14+ allows users to grant reduced accuracy (±1900 m) vs. full precision:
- Set `NSLocationDefaultAccuracyReduced` to `YES` in Info.plist if app can tolerate reduced accuracy
- Reduced accuracy updates recomputed ~4 times/hour
- Runtime: check `CLLocationManager.accuracyAuthorization` (`.fullAccuracy` vs. `.reducedAccuracy`)
- Temporary full accuracy request possible via `CLLocationManager.requestTemporaryFullAccuracyAuthorization(withPurposeKey:)`

**Known Issues (iOS 26.x)**
LocationButton functionality broken in iOS 26.0–26.2.1; authorization status remains `.notDetermined` with `.denied` error. Affects apps relying on the location button UI element for permission grants.

**Sources:**
- [NSLocationWhenInUseUsageDescription - Apple Developer](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationwheninuseusagedescription) (accessed 2026-08-06)
- [NSLocationAlwaysAndWhenInUseUsageDescription - Apple Developer](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationalwaysandwheninuseusagedescription) (accessed 2026-08-06)
- [NSLocationDefaultAccuracyReduced - Apple Developer](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationdefaultaccuracyreduced) (accessed 2026-08-06)
- [CLAccuracyAuthorization - Apple Developer](https://developer.apple.com/documentation/corelocation/claccuracyauthorization) (accessed 2026-08-06)

---

## 5. Timestamps & Monotonic Time

**expo-location Timestamp Field**

The `timestamp` property in Location objects is **wall-clock milliseconds since Unix epoch (ms since 1970-01-01T00:00:00Z)**, subject to system clock adjustments. Suitable for correlation but not for precise duration measurement across discontinuous events.

**Monotonic Time in React Native / Hermes**

`performance.now()` (Web API polyfill available in React Native) returns:
- **Microsecond precision** (up to 5 µs reported accuracy, fallback to 1 ms)
- **Monotonically increasing:** guaranteed non-decreasing, immune to clock skew/NTP adjustments
- Relative to `Performance.timeOrigin` (stable anchor per process)
- **Preferred over `Date.now()`** for lap timing, interval measurement, and monotonic sequence validation

**Pitfall:** Wall-clock timestamps can go backward on NTP correction or user adjustment. Use `performance.now()` for durations; use `expo-location.timestamp` only for UTC correlation/logging.

**Sources:**
- [High precision timing - Web APIs - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/High_precision_timing) (accessed 2026-08-06)
- [Performance: now() method - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) (accessed 2026-08-06)
- [Location - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/location/) (accessed 2026-08-06)

---

## 6. expo-sqlite: Foreground Data Persistence

**API Overview**

- `SQLite.openDatabaseAsync(dbName)`: Async DB handle
- Query methods: `runAsync()`, `getFirstAsync()`, `getAllAsync()`, `getEachAsync()`
- Prepared statements (recommended for user input): `prepareAsync()` + `executeAsync()` → prevents SQL injection
- React hook: `SQLiteProvider` wraps app, `useSQLiteContext()` accesses DB

**WAL Mode for Performance**

Enable Write-Ahead Logging:
```sql
PRAGMA journal_mode = WAL;
```
WAL improves performance for frequent small writes (e.g., GPS samples logged every 100–500 ms). Default journal mode is slower for transactional workloads.

**Batch Operations**

`execAsync(multiStatementSQL)` executes multiple statements in one call, more efficient than repeated `runAsync()`. Suitable for periodically flushing accumulated location buffers.

**Suitability for Lap-Timing**
expo-sqlite + WAL handles rapid small inserts well. Typical lap-session workload (1 Hz GNSS × 60 min = 3,600 rows) is well within capacity. No special pooling or async queue needed.

**Sources:**
- [SQLite - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/) (accessed 2026-08-06)

---

## 7. Screen Keep-Awake: expo-keep-awake

**API**

Prevents device sleep during foreground operation:
- `activateKeepAwake(tag?)`: Prevents sleep indefinitely (or until `deactivateKeepAwake(tag)` called)
- `deactivateKeepAwake(tag)`: Re-enables sleep
- **Tag system:** Multiple tags can be active; all must be deactivated for sleep to resume

**React Hook Alternative**
`useKeepAwake()` declarative hook: while component mounted, screen stays awake.

**Limitations**

Web support is limited. Background sleep prevention not guaranteed when app backgrounded.

**Sources:**
- [KeepAwake - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/keep-awake/) (accessed 2026-08-06)

---

## 8. Sensor Rates: Accelerometer & Gyroscope

**expo-sensors API**

Accelerometer & Gyroscope expose `setUpdateInterval(intervalMs)` to control sampling frequency.

**Android 12+ Frequency Limit**

System hard-caps sensor updates at **200 Hz** per sensor. Requesting higher rate requires:
- Add `HIGH_SAMPLING_RATE_SENSORS` permission to AndroidManifest.xml

**Typical Rates for Lap-Timing**

- Standard device motion: 50–100 Hz default
- High-performance requests: 200 Hz (Android 12+ limit; older devices may exceed)

For G-force or cornering analysis during track sessions, 50–100 Hz is sufficient. 200 Hz cap on Android 12+ noted; iOS generally supports higher, but practical limit is device-dependent.

**Sources:**
- [Sensors - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/sensors/) (accessed 2026-08-06)
- [Accelerometer - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/accelerometer/) (accessed 2026-08-06)
- [Gyroscope - Expo Documentation](https://docs.expo.dev/versions/latest/sdk/gyroscope/) (accessed 2026-08-06)

---

## 9. Battery & Thermal Implications (30–60 min sessions)

**Battery Drain from Continuous GPS**

Foreground high-accuracy GPS + screen-on is highly battery-intensive:
- Typical drain: **5% per hour** (varies by device, chip, GNSS chipset)
- Example: 60-minute session = ~5% battery for GPS alone + screen/app overhead
- Background location (Doze active): throttled to 6 updates/hour, ~10x better efficiency

**Thermal Stress**

Continuous GPS + screen-on causes thermal loading:
- Devices may thermal-throttle, reduce display brightness, lag
- Sustained high temperatures reported in developer forums (iOS 26.x, Android 13+)
- Thermal design of device is critical; phones with smaller heatspreads reach ~45–50°C quickly

**Guidance**

For 60-minute foreground lap-timing sessions:
- Recommend `Accuracy.High` (±10 m), not `Accuracy.Highest` (consumes more power)
- Use balanced power or implement adaptive accuracy if thermal warning triggered
- Screen-off would save substantial power but defeats lap-timing use case
- Expect 5–10% battery depletion per 60-minute session in typical conditions

**Sources:**
- [About background location and battery life - Android Developers](https://developer.android.com/develop/sensors-and-location/location/battery) (accessed 2026-08-06)
- [Optimize location use for battery life - Android Developers](https://developer.android.com/develop/sensors-and-location/location/battery/optimize) (accessed 2026-08-06)
- [Optimize for Doze and App Standby - Android Developers](https://developer.android.com/training/monitoring-device-state/doze-standby) (accessed 2026-08-06)

---

## 10. Process Death & State Restoration

**Android Activity Recreation**

When system kills app process (low memory, resource pressure):
- Activity destroyed; user is not immediately notified
- `savedInstanceState` (Bundle) can preserve UI state if data written before `onStop()`
- On recreation, `onCreate()` receives savedInstanceState; check null before reading
- **ViewModel alone does NOT survive process death.** Must use ViewModel + `SavedStateHandle` for persistent UI state across process death

**Practical Impact on Lap-Timing**

If app killed mid-session (unlikely but possible on low-RAM devices):
- In-memory location buffer is lost
- SQLite DB on disk persists; can resume writing on restart
- Recommendation: Periodically flush location samples to SQLite (every 30–60 s) to avoid data loss

**React Native: AppState API**

Monitor app lifecycle state changes:
```javascript
import { AppState } from 'react-native';

AppState.addEventListener('change', (state) => {
  if (state === 'active') { /* Foreground */ }
  if (state === 'background') { /* Backgrounded */ }
  if (state === 'inactive') { /* iOS: multitasking/notification */ }
});
```

**AppState States**
- **`active`**: App in foreground, user interacting
- **`background`**: App backgrounded or home screen
- **`inactive`** (iOS only): Transitional state (multitasking view, Notification Center, incoming call)

Use AppState to pause/resume location streaming, pause screen keep-awake, or flush SQLite on background transition.

**Sources:**
- [The activity lifecycle - Android Developers](https://developer.android.com/guide/components/activities/activity-lifecycle) (accessed 2026-08-06)
- [Save UI states - Android Developers](https://developer.android.com/topic/libraries/architecture/saving-states) (accessed 2026-08-06)
- [AppState - React Native](https://reactnative.dev/docs/appstate) (accessed 2026-08-06)

---

## Summary & Constraints for Lap-Timing App

| Constraint | Finding |
|-----------|---------|
| **GNSS Rate (Foreground)** | ~1 Hz achievable with `Accuracy.High` + `distanceInterval=0`, `timeInterval=1000` (Android) |
| **Background GNSS** | Requires startLocationUpdatesAsync + TaskManager; Doze throttles to 6 updates/hour |
| **Timestamps** | Use `performance.now()` (monotonic microsecond precision) for intervals; `expo-location.timestamp` (ms) for UTC correlation only |
| **SQLite Persistence** | WAL mode recommended; handles 3,600+ rows/hour efficiently; periodic flush to disk recommended (q30–60s) to survive process death |
| **Screen Keep-Awake** | Use `activateKeepAwake()` during session; disable on background transition |
| **Battery (60 min)** | Expect 5–10% drain from GPS + screen-on; high-accuracy foreground unavoidable for lap-timing |
| **Thermal Risk** | Sustained GPS + screen may reach 45–50°C; no thermal throttling API exposed; recommend `Accuracy.High` not `Accuracy.Highest` |
| **State Recovery** | Use AppState listener to detect backgrounding; flush SQLite on background; ViewModel + SavedStateHandle for Android process-death recovery |
| **Android Permissions** | ACCESS_FINE_LOCATION (foreground), ACCESS_BACKGROUND_LOCATION (if needed), FOREGROUND_SERVICE_TYPE_LOCATION (Android 14+) |
| **iOS Config** | NSLocationWhenInUseUsageDescription, NSLocationAlwaysAndWhenInUseUsageDescription, UIBackgroundModes: location |
| **Mock Location** | Use `Location.isMockLocation()` on Android to validate lap authenticity |
| **Play Store Policy** | Background location use restricted (enforcement Oct 2026 for Android 17+ apps); lap-timing is eligible core feature if prominently disclosed |

---

**End of Research**
