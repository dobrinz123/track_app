TASK: Independent security & privacy review of the track-session app repository. READ-ONLY advisory role — you change nothing; you report findings. Authorization: this is the project's own code, reviewed at the owner's request per the project plan (defensive review of first-party code, no third-party targets).

EXPECTED OUTCOME: A findings report written to .foreman/scratch/security-review-findings.md, severity-ranked (CRITICAL/HIGH/MEDIUM/LOW/INFO), each finding with file:line, exploit/abuse scenario, and a concrete fix recommendation. Empty severity classes stated explicitly.

CONTEXT: The app: offline-first GNSS lap timer (Expo/RN + pure-TS core), iOS primary, community-derived OSM circuit data, local SQLite, no accounts, no server. Review at current HEAD. Read: docs/architecture/contracts.md, docs/decisions/*.md for intent; then the code.

MUST DO — review at minimum:
1. Imported-data handling: packages/core/src/profile/loader.ts (size guard, migration, zod validation) — can a malicious circuit-profile JSON cause DoS (pathological polygon sizes, NaN/Infinity smuggling through zod, prototype pollution via JSON, quadratic validation), incorrect timing, or crash? Check migrateProfile on hostile version fields.
2. Telemetry bounds: unbounded array growth anywhere samples accumulate (matcher, calibration, recorder paths, controller if present, fixtures excluded); SQLite write amplification; JSON.stringify of huge telemetry.
3. Privacy: what precise-location data is persisted, for how long, deletion path (deleteUserData completeness — verify against every table incl. the v2 settings migration if present); anything logged via console.* that includes coordinates; diagnostics exports content; no analytics/network exfiltration paths (grep fetch/XMLHttpRequest/WebSocket/axios; expo modules that phone home).
4. Permissions posture: app.json — least privilege (no background location, no always keys), usage-string honesty; Android permissions minimal.
5. Injection surfaces: SQL parameterization in persistence-sql (every query — string concatenation anywhere?); path handling in the mobile SQLite adapter.
6. Supply chain: dependency review of package.json files (anything unexpected, typosquat-looking, or unnecessary; devDep leakage into runtime imports).
7. Unsafe deserialization: CheckpointCodec and any JSON.parse of stored data — crash-safety on corrupted stores (should return null, never throw into app code).
8. Denial-of-accuracy: can hostile GNSS spoofing (mocked locations) silently corrupt PBs? (mocked-flag rejection exists on Android only — assess iOS story and whether PB provenance records enough to audit).

MUST NOT: modify ANY file except writing your single findings report; run no destructive commands; spawn subagents; git commit.

OUTPUT FORMAT: First line exactly one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. Then a one-paragraph executive summary (counts by severity), then the path to the findings file.

WRITE SET: .foreman/scratch/security-review-findings.md ONLY.
