> **DRAFT — NOT YET IN FORCE.**
> This document was prepared for review by a qualified lawyer licensed in Romania and the European
> Union. It is **not legal advice**. Several clauses below — in particular the limitation of
> liability in §11 and the assumption of risk in §6 — have limits under Romanian consumer law and
> under Directive 2011/83/EU, and must be checked before publication.
> Drafted: **23 September 2026**. Document version: **1.0-draft**.
> `[OWNER: …]` marks facts only the app's owner can supply; all are listed in
> `docs/legal/compliance-checklist.md` §8.

# TRACE — Terms of Use

**Last updated:** 23 September 2026
**Effective from:** `[OWNER: date of first public release]`

---

## Read this part, if you read nothing else

TRACE times laps and tells you where you might go faster. That makes it a tool that can get you
hurt if you use it the wrong way. So:

1. **TRACE is for closed circuits only.** Not for public roads. Not for "a quick test on the way
   home". Using it to chase a time on a public road is a misuse of this app, is against the law in
   Romania and everywhere else we know of, and ends whatever permission these terms give you.
2. **You are the driver. Everything that happens to your car and to you is yours.** The app has no
   idea what the track surface is doing, who is in your mirrors, whether a marshal is waving a flag,
   or where the limit of your car and your skill actually is. You do.
3. **TRACE is not an instructor.** It is a measuring instrument with opinions. It does not replace
   a qualified instructor, a licensing course, or the experience you get by building up gradually.
4. **The rules of the venue always win.** Whatever the circuit, the organiser, the marshals or the
   session briefing say, that is what applies — including when it contradicts the app.
5. **Never operate the app while driving.** Set it up in the pits and leave it alone. Reading a
   screen at 180 km/h is how people crash.

If you do not accept this, do not use TRACE. Delete it.

---

## 1. Who these terms are between

These terms form an agreement between you and `[OWNER: full legal name and registered address,
Romania]` ("we", "us"), the provider of the TRACE mobile application for iOS and Android ("TRACE",
"the app").

By downloading, installing or using TRACE you accept these terms. If you are using TRACE on behalf
of an organisation, you confirm you may accept them for it.

## 2. What TRACE is

TRACE is a consumer application that:

- records your position with your phone's satellite receiver while you drive a **session on a
  closed circuit**, and computes lap and sector times from it;
- optionally reads data from your vehicle over an OBD-II adapter, read-only;
- analyses each corner after the session and produces observations and, where the app's own safety
  gates permit it, suggestions;
- stores all of this on your phone, and lets you export it.

TRACE is **recreational and advisory**. It is not an officially certified or homologated timing
system. It does not replace the organiser's timing, and must not be used for competitive scoring,
for scrutineering, for settling a result, or for any safety-critical decision. The app says this on
its own About screen and in every report it exports.

## 3. What you need before you use it

You must:

- hold a valid driving licence, and any additional licence or permit the venue requires;
- be legally entitled to drive the vehicle, and have insurance appropriate to what you are doing —
  **note that most ordinary motor policies exclude track use**; check yours before you go;
- have a vehicle in a condition fit for the activity;
- be at least 18 years old, or use TRACE with the consent and supervision of a parent or guardian if
  your local law and the venue allow younger drivers.

## 4. Circuit use only

TRACE is licensed to you **for use on closed circuits, during organised track sessions, at venues
where the activity is permitted**.

You must not use TRACE:

- on a public road, for timing, for comparing laps, for chasing a personal best, or for any other
  performance purpose;
- in any illegal street race or unsanctioned speed event;
- to encourage anyone else to do either of the above.

Displaying your speed is a normal instrument function; **treating a public road as a timed lap is
not**, and nothing in this app should be read as inviting it. If you use TRACE on a public road,
you do so entirely on your own responsibility and in breach of these terms.

## 5. Do not interact with the app while driving

Start the session before you go out and do not touch the phone again until you have stopped. Voice
cues, where enabled, exist so you do not have to look. Mount the phone securely where it cannot
become a projectile or obstruct your view or controls. If you find yourself looking at the screen
on track, turn the feature off.

The app's suggestion stage deliberately does **not** show advice while you are driving — advice is
shown between stints. Do not defeat that.

## 6. Motorsport is dangerous, and you accept that

Driving a vehicle at speed on a circuit carries an inherent risk of serious injury, death, and
damage to property, to your vehicle and to other people's. That risk exists with or without this
app.

By using TRACE you acknowledge that:

- **you alone decide** how fast to go, when to brake, which line to take, and when to stop;
- a lap time, a delta, a coaching cue or a suggestion from TRACE is **information, not an
  instruction**, and is never a statement that a particular speed or braking point is safe for you,
  for your car, for the conditions, or for the traffic around you;
- conditions the app cannot see — surface, weather, temperature, tyres, brakes, fuel load, other
  drivers, flags, debris, your own fatigue — change what is safe, continuously;
- you will build up gradually and drive within your own limits and your vehicle's;
- you are responsible for compliance with all rules, flags, instructions and briefings at the venue.

**If following what the app says would require you to do something that feels wrong, is outside
your experience, or conflicts with a marshal, an instructor or a flag — do not do it.**

## 7. TRACE is not instruction

TRACE's analysis is produced by a deterministic computer program working from sensor data. It is
not driver tuition, coaching by a qualified instructor, or a substitute for either. We recommend
that anyone new to circuit driving takes instruction from a qualified instructor and treats the app
as a record of what happened, not as a plan for what to do next.

## 8. Accuracy — what the numbers are actually worth

You should know how the app's numbers are made, because it changes how much to trust them:

- **Timing is derived from consumer satellite positioning.** It is subject to sampling rate, signal
  quality, multipath near buildings and grandstands, and the geometry of the crossing. It will not
  match transponder timing, and can differ from it by a margin that matters when you are chasing
  hundredths.
- **Circuit geometry comes from OpenStreetMap**, traced from aerial imagery by volunteers, and has
  **not been surveyed or validated on site** for the circuits shipped with this app. Start/finish
  and sector lines are computed by the app, not supplied by the sanctioning body, and are labelled
  as such everywhere they appear.
- **Circuits you teach the app yourself** are derived from a single lap of your own driving and are
  marked distinctly. They carry no independent survey at all.
- **Vehicle data quality depends on your adapter and your car.** Some values arrive through
  per-vehicle signal bindings that the app discovered experimentally on your car. They may be wrong.
- The app deliberately **withholds coaching suggestions on geometry it cannot vouch for.** If you
  see timing but no suggestions, that gate is working as intended; it is not a fault.

We give no warranty that any time, delta, analysis, suggestion or measurement produced by TRACE is
accurate, complete or fit for any particular purpose.

## 9. Your vehicle and the OBD-II connection

If you use the telemetry feature:

- **The app only reads.** It issues standard read-only OBD-II requests and two read-only diagnostic
  services. It never sends a command that writes to, actuates, reprograms or clears anything in your
  vehicle.
- Connecting **any** device to a vehicle's diagnostic port is nevertheless done at your own risk. It
  may affect your vehicle's warranty, and some manufacturers take a position on aftermarket devices.
  Check before you plug anything in.
- Do not connect, disconnect or configure an adapter while driving.
- If you use a third-party adapter, its quality, firmware and security are its maker's
  responsibility, not ours.
- If you use the project's own prototype dongle, it is a **prototype**: unfabricated at the time of
  writing, unvalidated on a real vehicle, and shipping a documented default Wi-Fi password that must
  be changed. It is not a product and is not covered by these terms as a product.

## 10. Your data and your content

Everything TRACE records stays on your device. What that means for your rights, and how to export
or delete it, is set out in the **Privacy Policy** (`privacy-policy.en.md`), which forms part of
these terms.

You own your session data. When you export and send a file, you are the one publishing it — think
about that before posting a raw trace, which shows exactly where you were and when.

**There is no backup and no recovery.** If you lose the phone, reset it, or delete the app, the data
is gone. Export anything you care about.

## 11. Limits on our liability

Nothing in these terms excludes or limits our liability for death or personal injury caused by our
negligence, for fraud, or for anything else that cannot lawfully be excluded — including any
liability that Romanian consumer-protection law or EU law reserves to you and that a contract term
cannot take away.

Subject to that, and to the extent permitted by law:

- TRACE is provided **"as is"**. We do not warrant that it will be uninterrupted, error-free,
  accurate, or compatible with any particular phone, adapter or vehicle.
- **We are not liable for loss or damage arising from how you drive.** That includes any accident,
  injury, vehicle damage, mechanical failure, penalty, exclusion from an event, or loss of a result,
  whether or not you were acting on something the app displayed.
- We are not liable for lost session data, whatever the cause.
- We are not liable for the acts, omissions or products of third parties, including circuit
  operators, event organisers, adapter manufacturers and the services you export files to.
- Where liability can lawfully be capped, `[OWNER/LAWYER: state the cap. For a free app the usual
  formulation is the greater of the amount you paid for the app in the 12 months before the claim
  and a nominal sum; confirm enforceability under Romanian law.]`

`[LAWYER: Romanian civil law limits how far liability can be excluded in a business-to-consumer
contract, and unfair-terms rules (Law 193/2000, transposing Directive 93/13/EEC) apply to every
clause in this section. Please redraft to what is actually enforceable rather than to what is
conventional in English-language app terms.]`

## 12. Licence to use the app

We grant you a personal, non-exclusive, non-transferable, revocable licence to install and use
TRACE on devices you own or control, for your own non-commercial use, in accordance with these terms
and with the App Store or Google Play terms that apply to your download.

You must not: reverse-engineer, decompile or disassemble the app except where law expressly permits
it; remove or obscure any notice, attribution or disclaimer in the app — including the OpenStreetMap
attribution and the "not an official timing system" statement, which we are obliged to display;
resell, rent or sublicense the app; or use it to build a competing product from its outputs.

`[OWNER: state whether the app will be free or paid, and whether there will be in-app purchases or
subscriptions. If paid, this section needs consumer-law content on price, delivery, and the 14-day
right of withdrawal under Directive 2011/83/EU, including the standard clause about waiving it for
immediately supplied digital content.]`

## 13. Third-party components and attribution

TRACE includes open-source software, whose licences and required notices are shown in the app and
listed in `docs/legal/oss-notices.md`.

Circuit geometry is derived from **OpenStreetMap** data, © OpenStreetMap contributors, available
under the **Open Database License (ODbL) 1.0**. That attribution is displayed in the app and must
not be removed.

## 14. Changes to the app and to these terms

We may change, suspend or discontinue any part of TRACE. We may update these terms; when we do, we
will change the version and date at the top, publish the previous version, and — for changes that
materially affect your rights — tell you in the app before they take effect. Continuing to use TRACE
after that means you accept the new terms; if you do not, stop using the app.

## 15. Ending this agreement

You may end it at any time by deleting the app. We may end it if you breach these terms, in
particular §4 (circuit use only). On termination the licence in §12 ends; the data on your phone is
unaffected until you delete it.

## 16. Law and jurisdiction

These terms are governed by Romanian law. `[LAWYER: if the app is distributed to consumers elsewhere
in the EU, Regulation (EU) 593/2008 (Rome I) Article 6 means the consumer keeps the protection of the
mandatory rules of their own country of residence — the choice of Romanian law cannot remove that,
and the clause should say so.]`

If you are a consumer in the EU, you may also use the European Commission's online dispute
resolution platform, and you may bring proceedings in the courts of your own country of residence.

## 17. Contact

`[OWNER: name]`
`[OWNER: postal address]`
`[OWNER: support email]`
`[OWNER: support URL]`

---

*Romanian version: `terms.ro.md`. In case of divergence, `[OWNER/LAWYER: state which version
governs].`*
