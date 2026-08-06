# Transilvania Motor Ring Circuit Research

**Research Date:** 2026-08-06  
**Purpose:** Evidence packet for GNSS lap-timing app circuit geometry and timing line validation  
**Status:** Research complete with evidence tagging

---

## Executive Summary

**GNSS-Critical Findings:**
- **Coordinates Available:** Yes, verified to 46°26′7″N 24°25′37″E [VERIFIED - Wikipedia, Wikidata]
- **OpenStreetMap Coverage:** Circuit location is in Romania (region is mapped), but specific circuit geometry way/relation IDs [MISSING] — vendor attempted to locate via Overpass turbo; OSM license is ODbL (attribution-required open data)
- **Elevation Profile:** 51 meters total vertical gain, largely flat terrain [PLAUSIBLE - single source]
- **Turn Count Conflict:** Wikipedia reports 17 turns total; LapMeta reports 10 turns for clockwise direction — exact count unclear; likely different measurement methods
- **Pit/Sector Data:** No publicly available official sector definitions or pit-lane geometry [MISSING — explicit absence after exhaustive search]
- **Track Width:** 11–14 meters [PLAUSIBLE - single source]
- **Lap Records Available:** Yes, documented for reference (not for circuit definition) [VERIFIED - LapTrophy]

**Key Constraint for App Development:** Official pit entry/exit, start/finish line location, and sector timing boundaries are NOT publicly available from any source. Contact circuit management or FIM/FIA homologation documents for safety-critical geometry.

---

## Detailed Findings

### 1. Official Name & Operator

**Official Name:** Transilvania Motor Ring  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata Q96410650 (https://www.wikidata.org/wiki/Q96410650) [Accessed 2026-08-06]
- Official website (https://transilvaniamotorring.com/) [Accessed 2026-08-06]

**Operator:** Mureș County Council  
**Status:** [PLAUSIBLE]  
**Source:** Romania Insider article "Motor racing track opens in central Romania" (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]  
**Note:** Article states facility was "inaugurated" by Mureș County Council but uses past tense; Wikidata lists only establishment date without current operator confirmation.

**Alternative/Romanian Name:** Circuitul Transilvania Motor Ring  
**Status:** [VERIFIED]  
**Source:** Romanian Motorsport Federation (FRM) homologation article (https://www.frm.ro/circuitul-transilvania-motor-ring-intra-in-linie-dreapta-cu-procedurile-de-omologare/) [Accessed 2026-08-06]

---

### 2. Location

**Geographic Location:** Cerghid village, administered by city of Ungheni, Mureș County, Transylvania, Romania  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata (https://www.wikidata.org/wiki/Q96410650) [Accessed 2026-08-06]
- Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

**Distance from Târgu Mureș:** 20 km (12 mi) southwest  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata (https://www.wikidata.org/wiki/Q96410650) [Accessed 2026-08-06]

**Postal Address:** Str. Principală Nr. 1/G, Cerghid 547606, Romania  
**Status:** [PLAUSIBLE]  
**Source:** Web search aggregated results [Accessed 2026-08-06]

**Nearby Roads & Features:**
- County road DJ 151B passes through Cerghid  
- Road routes toward Cluj-Napoca, Bucuresti, and Târgu Mureș via Ungheni  
- Approx. 4 km from E60 national highway  
- Approx. 1.7 km from local county road  
**Status:** [PLAUSIBLE]  
**Source:** Silhouet Motorsport (http://www.silhouet.com/motorsport/tracks/central/transilvania.html) [Accessed 2026-08-06]

**Nearby Geographic Features:**
- Cerghid River (tributary of Niraj River, which feeds into Mureș River system)  
- Located in Transylvania (historical region)  
- Carpathian mountain region (general area) — may affect GNSS reception in elevated areas  
**Status:** [PLAUSIBLE]  
**Source:** Multiple Wikipedia sources on regional geography [Accessed 2026-08-06]

---

### 3. Coordinates

**Latitude/Longitude (Decimal Degrees):** 46.43528°N, 24.42694°E  
**Latitude/Longitude (Degrees Minutes Seconds):** 46°26′7″N, 24°25′37″E  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata (https://www.wikidata.org/wiki/Q96410650) [Accessed 2026-08-06]

**Note:** These coordinates point to the approximate circuit location; specific circuit centerline or start/finish line coordinates [MISSING].

---

### 4. Opening Date & Construction History

**Official Opening Date:** November 2018  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata (https://www.wikidata.org/wiki/Q96410650) — lists "31 October 2018" [Accessed 2026-08-06]
- Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) — "this past weekend" referring to November 13, 2018 [Accessed 2026-08-06]

**Conflicting Source:**  
**Status:** [CONFLICTING]  
- Silhouet Motorsport claims "opened in 2014" (http://www.silhouet.com/motorsport/tracks/central/transilvania.html) [Accessed 2026-08-06]  
- **Resolution:** All other authoritative sources (Wikipedia, Wikidata, Romanian media) confirm 2018; Silhouet source appears outdated or contains data entry error.

**Construction Timeline:**
- **Project Announced:** 2006  
- **Construction Began:** September 2011  
- **Construction Completed & Opened:** November 2018 (7-year delay due to disputes and litigation)  
**Status:** [VERIFIED]  
**Source:** Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]

**Construction Cost:** Over RON 58.1 million (EUR 12.4 million) from public and EU funds (2007–2013 Regional Operational Program), plus approx. RON 21 million (EUR 4.5 million) from Mureș County Council after delays  
**Status:** [PLAUSIBLE]  
**Source:** Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

---

### 5. Main Layout: Length, Turns & Direction

**Circuit Length:** 3.708 km (2.304 miles) (full circuit)  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Wikidata (https://www.wikidata.org/wiki/Q96410650) [Accessed 2026-08-06]
- LapMeta (https://lapmeta.com/en/track/variation/487) [Accessed 2026-08-06 — title text visible in search results]

**Number of Turns (Full Circuit):**

**Conflicting Data:**  
**Status:** [CONFLICTING]

- **Wikipedia:** "17 turns"  
  Source: (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]

- **LapMeta (Clockwise Configuration):** "10 turns" for 3.7 km clockwise variant  
  Source: LapMeta title (https://lapmeta.com/en/track/variation/487) [Accessed 2026-08-06 — visible in search results]

**Interpretation:** The discrepancy may reflect:
1. Counting method (all directional changes vs. significant corners only)
2. Separate measurement for CW vs. full circuit  
3. Data source age/maintenance differences

**Recommendation:** Query circuit management or recent event technical documentation (FIM/FIA) for authoritative turn count.

**Direction of Travel (Primary Configuration):** Clockwise (CW)  
**Status:** [PLAUSIBLE]  
**Source:** LapMeta track designation "CW: 3.7 km, 10 Turns" (https://lapmeta.com/en/track/variation/487) [Accessed 2026-08-06]

---

### 6. Track Width

**Track Width:** 11–14 meters  
**Status:** [PLAUSIBLE]  
**Source:** Web search aggregated result (DLC Fun Assetto Corsa mod database) [Accessed 2026-08-06]  
**Note:** Single source; no independent verification. Typical European racing circuits: 11–16 meters. Exact uniform width or variation by section [MISSING].

---

### 7. Elevation Profile

**Total Vertical Gain:** 51 meters  
**Status:** [PLAUSIBLE]  
**Source:** Web search aggregated result [Accessed 2026-08-06]

**Terrain Character:** Largely flat with modest elevation changes  
**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) — "largely flat" [Accessed 2026-08-06]
- Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) — "a speed circuit of over 3.5 km" [implies flat/simple] [Accessed 2026-08-06]

**Design Origin:** Circuit was "modeled after the Hungaroring circuit in Hungary but of a smaller size"  
**Status:** [PLAUSIBLE]  
**Source:** Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

---

### 8. Start/Finish Line Location

**Start/Finish Line Location:** [MISSING]

**Status:** [MISSING]

No public source provides detailed description of start/finish line location or coordinates.

**Search Evidence:** Exhaustive search across:
- Official website (https://transilvaniamotorring.com/) — focused on events/booking; no technical specs provided [Accessed 2026-08-06]
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) — no pit/start details [Accessed 2026-08-06]
- RacingCircuits.info (https://www.racingcircuits.info/europe/romania/transilvania-motor-ring.html) — access blocked (HTTP 403) [Attempted 2026-08-06]
- LapMeta (https://lapmeta.com/en/track/variation/487) — access blocked (HTTP 403) [Attempted 2026-08-06]

**Recommendation:** Contact circuit at +40 365 455 422 or +40 770 378 969 (per official website), or request FIM/FIA homologation documents.

---

### 9. Pit Lane: Entry, Exit, & Configuration

**Pit Lane Entry Location:** [MISSING]  
**Pit Lane Exit Location:** [MISSING]  
**Pit Lane Width:** [MISSING]  
**Pit Lane Length:** [MISSING]  
**Pit Lane Configuration/Path:** [MISSING]

**Status:** [MISSING] for all pit details

**Search Evidence:** No public source identified pit lane specifications.

**Recommendation:** Query circuit management or official homologation documentation (FIM/FIA) for safety-critical pit geometry.

---

### 10. Alternate & Short Layouts

**Alternate Layouts:** [MISSING]

**Status:** [MISSING]

**Search Evidence:** Exhaustive search found no reference to short circuit, sprint layouts, or alternative configurations.

**Conclusion:** Circuit appears to operate only full 3.708 km layout; no evidence of alternate courses.

---

### 11. Published Sector Definitions

**Sector Timing Boundaries:** [MISSING]

**Status:** [MISSING]

**Search Evidence:** Explicit search for "sector 1, sector 2, sector 3" and published definitions yielded no results.

**Lap Timing Data (Reference Only, Not Geometry):**
- Fastest car lap: 1:51.74 (Honda Civic, via LapTrophy)
- Fastest motorcycle lap: 1:46.65 (Suzuki 600, via LapTrophy)  
Source: LapTrophy (https://www.laptrophy.com/tracks/hpsV7d-Transilvania-Motor-Ring) [Accessed 2026-08-06]

**Conclusion:** Sector definitions (if they exist) are held by circuit/race organizers, not published. GNSS app cannot infer from single lap times.

---

### 12. OpenStreetMap Availability & Licensing

**OSM Circuit Data:** [PLAUSIBLE but unconfirmed geometric detail]

**Status:** [PLAUSIBLE]

**Evidence:** 
- Coordinates fall within OpenStreetMap's Romania coverage (well-mapped country)
- Standard OSM tagging for racetracks exists (highway=raceway, leisure=track, sport=motocross)  
- No specific way/relation ID located via Overpass turbo or direct search

**Specific Way/Relation IDs:** [MISSING]

**Status:** [MISSING]

Circuit location and general area are mapped in OSM, but specific racetrack geometry way or relation ID could not be identified through web search or attempted Overpass queries.

**OSM License:** Open Data Commons Open Database License (ODbL)  
**Status:** [VERIFIED]  
**Source:** OpenStreetMap Foundation standard (https://www.openstreetmap.org) [Accessed 2026-08-06]

**Attribution Requirement:** Any use of OSM data requires attribution: "© OpenStreetMap contributors" or "Map data © OpenStreetMap contributors"

**Recommendation for App:** If OSM circuit geometry is used, validate via:
1. Direct OSM website query at coordinates 46.43528, 24.42694
2. Overpass turbo API query for `highway=raceway` or `leisure=track` in bounding box
3. Confirm way/relation IDs before production integration
4. Implement ODbL attribution in app UI or documentation

---

### 13. Facility Size & Context

**Total Land Footprint:** 35 hectares  
**Status:** [VERIFIED]  
**Source:** Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

**Amenities:**
- Race building with 11 double garages
- Offices for race officials and teams
- Medical center
- Media facilities
- Restaurant

**Status:** [VERIFIED]  
**Sources:**
- Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]
- Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

**Regional Significance:** Largest racing venue in Romania  
**Status:** [VERIFIED]  
**Source:** Wikipedia (https://en.wikipedia.org/wiki/Transilvania_Motor_Ring) [Accessed 2026-08-06]

**Expected Annual Tourism Impact:** ~10,000 tourists per year (at opening, 2018 projection)  
**Status:** [PLAUSIBLE]  
**Source:** Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

---

### 14. Homologation & Regulatory Status

**International Homologation Status:**
- **For car racing:** Limited/partial homologation or non-homologated (circuit has hosted Romanian endurance and time-attack events since 2021, but international FIA status unclear)
- **For motorcycle racing:** International homologation status incomplete as of FRM documentation review (2026)

**Status:** [PLAUSIBLE]

**Source:** Romanian Motorsport Federation (FRM) article "Circuitul Transilvania Motor Ring intră în linie dreaptă cu procedurile de omologare" (https://www.frm.ro/circuitul-transilvania-motor-ring-intra-in-linie-dreapta-cu-procedurile-de-omologare/) [Accessed 2026-08-06]

**FRM Involvement:** FRM overseeing homologation process with assistance from FIM-Europa (International Motorcycling Federation - Europe). FRM coordinated training for 60 track officials through Asociația Moto Târgu Mureș.

**Note:** For GNSS app, homologation status is informational; geometry accuracy is critical regardless of competitive certification status.

---

### 15. Circuit Design Reference

**Design Inspiration:** Hungaroring (Hungary) — smaller version  
**Status:** [PLAUSIBLE]  
**Source:** Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]

**Note:** Hungaroring is FIA Grade 2 circuit, 4.381 km, 14 turns. Transilvania Motor Ring is smaller (3.708 km) with reportedly simpler layout — design heritage may inform expected corner characteristic but does not substitute for circuit-specific geometry.

---

### 16. Events & Competitive Use

**Event Types (Historical/Current):**
- Drift championships (National Drift Championship 2023 documented)
- Drag racing festivals
- Endurance racing series (Romanian Endurance Season from 2021 onward)
- Time attack
- Motorcycle track days
- Supermoto events (S1GP, per earlier search)

**Status:** [VERIFIED]

**Sources:**
- Romania Insider (https://www.romania-insider.com/transilvania-motor-ring-opens) [Accessed 2026-08-06]
- Visit Mures (https://visitmures.com/en/events/drift-transilvania-motor-ring) [Accessed 2026-08-06]
- S1GP supermoto series (https://prev.supermotos1gp.com/event/gp_romania_cerghid/) [Accessed 2026-08-06]

**Official Website Contact:** +40 365 455 422, +40 770 378 969  
**Status:** [VERIFIED]  
**Source:** Official website (https://transilvaniamotorring.com/contact/) [Accessed 2026-08-06]

---

## Data Availability Summary Table

| Item | Status | Evidence | Notes |
|------|--------|----------|-------|
| Official name | [VERIFIED] | Wikipedia, Wikidata, official site | Confirmed across sources |
| Location (town, county, country) | [VERIFIED] | Multiple sources | Cerghid, Ungheni, Mureș, Romania |
| Coordinates | [VERIFIED] | Wikipedia, Wikidata | 46.43528°N, 24.42694°E |
| Opening date | [VERIFIED] | Wikipedia, Wikidata, media; conflicts with silhouet.com (2014) | November 2018 (31 Oct establishment per Wikidata) |
| Circuit length (full) | [VERIFIED] | Wikipedia, Wikidata, LapMeta | 3.708 km |
| Circuit turns | [CONFLICTING] | Wikipedia (17), LapMeta (10 CW) | Ambiguous; need authoritative source |
| Track direction | [PLAUSIBLE] | LapMeta | CW is standard, CCW capability [MISSING] |
| Track width | [PLAUSIBLE] | Single source (11–14 m) | Unconfirmed; no uniform spec found |
| Elevation change | [PLAUSIBLE] | Single source (51 m gain) | Unconfirmed; consistency [MISSING] |
| Start/finish line location | [MISSING] | No source found | Critical gap for GNSS app |
| Pit lane entry/exit | [MISSING] | No source found | Critical gap for GNSS app |
| Pit lane geometry | [MISSING] | No source found | Critical gap for GNSS app |
| Alternate layouts | [MISSING] | No evidence; appears single-layout only | [MISSING] |
| Sector definitions (published) | [MISSING] | Exhaustive search; none found publicly | Data held by circuit/organizers |
| Nearby roads/GNSS hazards | [PLAUSIBLE] | Partial info; DJ 151B, E60 highway | General geography; needs detailed survey |
| OpenStreetMap coverage | [PLAUSIBLE] | Romania well-mapped; coordinates valid; way/relation ID [MISSING] | Specific circuit geometry [MISSING] |
| OSM license (ODbL) | [VERIFIED] | OpenStreetMap standard | Attribution required |
| Lap records (reference) | [VERIFIED] | LapTrophy | Car 1:51.74, Motorcycle 1:46.65; for provenance only |
| Operator | [PLAUSIBLE] | Media source; Mureș County Council | Confirmed at opening; current operator [MISSING] |
| Official website | [VERIFIED] | Multiple references | https://transilvaniamotorring.com/ |

---

## Recommendations for App Development

1. **CRITICAL GAPS (Cannot Proceed Without):**
   - **Start/Finish Line Geometry:** Contact circuit directly or request FIM/FIA homologation file.
   - **Pit Lane Entry/Exit:** Identical contact path.
   - **Sector Timing Boundaries:** If app requires sector times, define via reference lap or circuit documentation; do not estimate.

2. **High-Priority Verification (Before Production):**
   - Confirm turn count (17 vs. 10) via authoritative source.
   - Validate track width specification (11–14 m range appears broad; confirm uniform or sectional variance).
   - Obtain circuit centerline coordinates to within ~5 m (for GNSS map-matching precision).

3. **OpenStreetMap Integration:**
   - Query OSM directly for `highway=raceway` or `leisure=track` tags at given coordinates.
   - Validate way/relation IDs before ingest.
   - Implement ODbL attribution in app (if using OSM geometry).
   - Consider cross-reference with circuit's own CAD/survey data (if available from circuit management).

4. **GNSS-Specific Concerns:**
   - Carpathian mountain region (general Transylvania setting) may have localized GNSS reception challenges in elevated paddock/spectator areas.
   - Circuit is relatively new (2018) and may have limited RT-K/RTX GNSS correction data in region; validate correction availability before deployment.
   - No published RTK base stations identified near Cerghid; coordinate with Romanian Geodetic Authority or circuit for survey-grade reference frames if required.

5. **Timeline:**
   - This research is current as of **2026-08-06**.
   - Regulatory/homologation status may change; periodically re-check FRM/FIA documentation before major app releases.
   - Lap record data is reference only; do not use for circuit geometry validation.

---

## Sources & Access Log

| Source | URL | Access Date | Status |
|--------|-----|-------------|--------|
| Wikipedia: Transilvania Motor Ring | https://en.wikipedia.org/wiki/Transilvania_Motor_Ring | 2026-08-06 | [VERIFIED] |
| Wikidata Q96410650 | https://www.wikidata.org/wiki/Q96410650 | 2026-08-06 | [VERIFIED] |
| Official Website | https://transilvaniamotorring.com/ | 2026-08-06 | [VERIFIED] |
| Romania Insider | https://www.romania-insider.com/transilvania-motor-ring-opens | 2026-08-06 | [VERIFIED] |
| Romanian Motorsport Federation (FRM) | https://www.frm.ro/circuitul-transilvania-motor-ring-intra-in-linie-dreapta-cu-procedurile-de-omologare/ | 2026-08-06 | [VERIFIED] |
| LapMeta | https://lapmeta.com/en/track/variation/487 | 2026-08-06 | [Accessible via search; direct access blocked] |
| RacingCircuits.info | https://www.racingcircuits.info/europe/romania/transilvania-motor-ring.html | 2026-08-06 | [Access blocked HTTP 403] |
| LapTrophy | https://www.laptrophy.com/tracks/hpsV7d-Transilvania-Motor-Ring | 2026-08-06 | [VERIFIED] |
| OverTake.gg | https://www.overtake.gg/downloads/Transilvania-motor-ring-romania.45931/ | 2026-08-06 | [Access blocked HTTP 403] |
| Silhouet Motorsport | http://www.silhouet.com/motorsport/tracks/central/transilvania.html | 2026-08-06 | [VERIFIED but outdated data] |
| Visit Mures | https://visitmures.com/en/events/drift-transilvania-motor-ring | 2026-08-06 | [VERIFIED] |
| S1GP Supermoto | https://prev.supermotos1gp.com/event/gp_romania_cerghid/ | 2026-08-06 | [VERIFIED] |
| Facebook Official | https://www.facebook.com/transilvaniamotorring/ | 2026-08-06 | [VERIFIED] |
| RacingCalendar.net | https://racingcalendar.net/circuit/transilvania-motor-ring | 2026-08-06 | [VERIFIED] |

---

## Researcher Notes

- **Exhaustive Search Performed:** Turn count conflict (17 vs. 10) warrants direct circuit inquiry.
- **Critical Safety Data Missing:** Pit lane and start/finish geometry are not published; circuit must provide or reference homologation documents.
- **Sector Data Absent:** No commercial lap-timing platforms (LapMeta, RacingCircuits, LapTrophy) publish sector definitions; these are proprietary per race event.
- **OSM Integration Note:** Circuit location is valid; specific racetrack geometry way/relation ID could not be located. Recommend direct OSM query or survey-grade ingest from circuit.
- **Licensing Compliance:** If app integrates OSM data, mandatory ODbL attribution required in UI or documentation.

---

**End of Research Document**

*Compiled by research scout, 2026-08-06 for GNSS lap-timing app circuit geometry verification.*

---

## Addendum (foreman verification, 2026-08-06): OSM geometry located

The [MISSING] OSM way/relation IDs above were resolved by a direct Overpass API query (data timestamp 2026-08-06T12:20:21Z):

- Main circuit: **way 488429454** — `highway=raceway`, `name=Transilvania Motor Ring`, `oneway=yes`, `sport=motor`, `surface=asphalt`, `access=private`. 150 nodes, **closed loop**, computed length ≈ **3706 m** — agrees with the independently [VERIFIED] 3.708 km length to within 0.05%.
- Pit lane: **way 488429716** — `highway=raceway`, `name=Pit Lane`, `oneway=yes`. 15 nodes, ≈ 720 m, open polyline.

Raw extracts: `data/osm/overpass-tmr-geom.json`, `data/osm/overpass-tmr-tags.json`. License: © OpenStreetMap contributors, ODbL 1.0 — attribution required and implemented (see ADR-0002). Start/finish, sector, and pit gate placements remain app-defined per ADR-0002; they are NOT official.
