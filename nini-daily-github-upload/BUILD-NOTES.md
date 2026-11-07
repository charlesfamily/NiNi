# Nini Daily — Native App Build Notes

Scaffolded 2026-11-06 on the Linux VM. Goal: turn the Nini Daily web
prototype into a real iOS app whose reminders alert **even when the app is
closed** — the web version can only alert while its page is open.

## What was built

- **Capacitor project** in this folder (`native/`):
  - `appName`: **Nini Daily**
  - `appId`: **app.ninidaily** — placeholder; can be changed any time before
    App Store submission (it becomes permanent once the app record exists).
  - Capacitor **8.6.0** (`@capacitor/core`, `@capacitor/cli`,
    `@capacitor/ios`), `@capacitor/local-notifications` **8.3.1**.
- **Web content** (`www/`): byte-identical copies of the web app from
  `../api/app/` (`index.html`, `styles.css`, `app.js`), plus one new file.
  The originals in `api/app/` were **not** modified.
- **Native notification layer** (`www/native-notify.js`): when the Capacitor
  native bridge is present, it schedules an OS-level local notification for
  each enabled reminder at its next due time:
  - `daily` → fires at the set time, repeats daily
  - `weekly` → fires at the set time on its weekday, repeats weekly
  - `once` → single shot at the next occurrence of the set time
  - Paused reminders are cancelled; deleted reminders are cancelled;
    edits reschedule. Reconciliation runs through one hook: `app.js` calls
    `NiniNotify.syncReminders(rows)` at the end of `loadReminders()`, which
    already runs after every add / edit / pause / delete.
  - On plain web it detects there's no native bridge and does nothing, so
    the in-page behavior of the web app is unchanged.
- **Wiring changes to the copied web files** (only these two):
  - `www/index.html`: one added line, `<script src="native-notify.js">`
    before `app.js`.
  - `www/app.js`: 4 added lines in `loadReminders()` calling the sync.
- **iOS platform** (`ios/`): generated successfully. Capacitor 8 uses Swift
  Package Manager instead of CocoaPods, so the missing `pod` command on
  Linux was **not** a blocker. The Xcode project exists at
  `ios/App/App.xcodeproj`, bundle ID `app.ninidaily`, display name
  "Nini Daily", and the LocalNotifications plugin is wired into
  `Package.swift`.

## Verified on this VM

- `npm install` completed cleanly for all packages (versions above).
- `node --check` passes on `www/app.js` and `www/native-notify.js`.
- `capacitor.config.json` parses as valid JSON with the right
  appId / appName / webDir.
- Copied web files confirmed byte-identical to `api/app/` originals
  (md5) before wiring; `styles.css` still identical after.
- `npx cap add ios` → success; web assets copied into
  `ios/App/App/public/` (including `native-notify.js`).
- `project.pbxproj` carries `PRODUCT_BUNDLE_IDENTIFIER = app.ninidaily`;
  `Info.plist` carries `CFBundleDisplayName = Nini Daily`.
- `npx cap sync ios` finishes cleanly and finds the
  `@capacitor/local-notifications` plugin.

**Not verified here (impossible on this VM):** compiling the app, running
it in a simulator/on a phone, and an actual notification firing. There is
no Xcode on Linux. Those need a Mac (below).

## Known gap to decide before submission

The app still loads its affirmations and reminders from the Express API at
`/v1/*` on the same origin, with the API key from Settings. Inside the
native app there is no "same origin" server, so before this can be a real
store app the data layer needs one of:
1. point the app at a hosted copy of the API (needs hosting + the key
   story cleaned up), or
2. bundle the data into the app (local storage on-device) — simpler and
   more private for a reminders app, and local notifications already work
   fully on-device.
This scaffold deliberately doesn't choose; the notification layer works
either way because it syncs from whatever reminder list the UI loads.

## Remaining steps — need Charles and/or a Mac

1. **Apple Developer enrollment ($99/year)** — Charles personally, at
   developer.apple.com, with his Apple ID, identity, and payment. Nothing
   can be signed or submitted without this.
2. **On a Mac:** install Xcode (App Store) and open `ios/App` (the
   `.xcodeproj`). Run `npm install` and `npx cap sync` in this folder
   first if `node_modules` isn't copied over.
3. **Signing:** in Xcode, select the "Nini Daily" target → Signing &
   Capabilities → check "Automatically manage signing" and pick Charles's
   developer team. Confirm the bundle ID stays `app.ninidaily` (or change
   it now, in both Xcode and `capacitor.config.json`, before step 4 —
   after the App Store record is created it can't change).
4. **App Store Connect name check:** in App Store Connect → My Apps → +,
   start a new app and confirm the name **"Nini Daily"** is available.
   A web search found no exact-match app, but only App Store Connect can
   confirm; do this early, before printing the name anywhere permanent.
5. **Build & test on a real iPhone** (or simulator): add a reminder a
   couple of minutes out, close the app, and confirm the notification
   fires. Also test pause (should cancel) and delete (should cancel).
   First launch will ask for notification permission — that's expected.
6. **Privacy policy:** required for submission. A simple hosted page
   stating what data the app collects (aim: none leaves the device if
   option 2 above is chosen) with a contact email. Must be a live URL
   before submitting.
7. **App Store listing assets:** app icon (1024×1024), screenshots
   (iPhone sizes), description, keywords, support URL, age rating
   questionnaire, category (Lifestyle or Productivity).
8. **Archive & submit:** Xcode → Product → Archive → Distribute App →
   App Store Connect → upload, then complete the listing, pass App
   Review (typically days), and release.

## Handy commands

```bash
cd ~/workspace/goals/finish-the-chatnow-app/native
npm install          # restore dependencies on any new machine
npx cap sync ios     # copy web changes into the iOS project
npx cap open ios     # open in Xcode (Mac only)
```

After editing anything in `www/`, run `npx cap sync ios` before building.

## No-Mac route (Codemagic) — added 2026-11-06

**Why:** Charles has no Mac — only an iPhone and a tablet — so the
Mac-based steps above (Xcode build, local signing, Archive & submit)
can't run locally. Instead, **Codemagic** (a CI service) builds the app
on its cloud Macs: it reads `codemagic.yaml` from the project repo,
installs dependencies, syncs Capacitor, signs the app automatically with
an App Store Connect API key, builds the `.ipa`, and uploads it to
TestFlight / App Store Connect. This section supersedes the Mac-only
parts of the steps above; everything else there (privacy policy, listing
assets, data-layer decision) still applies.

**What was added:** `codemagic.yaml` in this folder — one workflow,
`ios-release`, on a `mac_mini_m2` instance: `npm install` →
`npx cap sync ios` → signing script (`keychain initialize` +
`app-store-connect fetch-signing-files --create` +
`xcode-project use-profiles`) → build number set from Codemagic's
per-build `$BUILD_NUMBER` via `agvtool` → `xcode-project build-ipa`
(using the `.xcodeproj`, since Capacitor 8/SPM has no workspace) →
publish to **TestFlight** (`submit_to_app_store: false` for now; flip it
when submitting for review). The YAML was validated with a parser.

**Placeholders in `codemagic.yaml` (nothing real is stored there):**
- `integrations.app_store_connect: Nini Daily ASC` — must exactly match
  the integration name Charles creates in Codemagic (step c).
- `APP_STORE_CONNECT_KEY_IDENTIFIER`, `APP_STORE_CONNECT_ISSUER_ID`,
  `APP_STORE_CONNECT_PRIVATE_KEY` — placeholder values in the file. The
  real values go into Codemagic's **encrypted** environment variables for
  the app (or the integration itself); once set there, delete the
  placeholder lines. **Never commit the real .p8 key to git.**
- `CERTIFICATE_PRIVATE_KEY` — optional but recommended: one fixed key
  for the signing certificate so builds reuse a single certificate
  instead of creating a new one each run (Apple caps how many you can
  have). Also stored encrypted in Codemagic.

**Ordered steps that remain:**

- **(a) [Charles]** Enroll in the **Apple Developer Program ($99/year)**
  at developer.apple.com — doable from his iPhone/tablet with his Apple
  ID, identity, and payment. Nothing can be signed or submitted before
  this.
- **(b) [Charles, with Muse guiding]** In **App Store Connect**: first
  the **name check** — start a new app and confirm **"Nini Daily"** is
  available (only App Store Connect can confirm) — then create the app
  record with bundle ID `app.ninidaily` (permanent once created, so the
  name check comes first).
- **(c) [Charles, with Muse guiding]** Create an **App Store Connect API
  key** (App Store Connect → Users and Access → Integrations → App Store
  Connect API; App Manager role is enough; download the `.p8` — it's a
  one-time download), then in **Codemagic** (Teams → Integrations → App
  Store Connect) connect it under the name **"Nini Daily ASC"**, and put
  the Key ID / Issuer ID / key into the app's encrypted environment
  variables, replacing the placeholders in `codemagic.yaml`.
- **(d) [Charles + Muse]** Get this project into a **git repo Codemagic
  can read** — the project currently lives **only in this workspace**,
  and Codemagic builds from a repository, so a **GitHub repo is needed**.
  Charles creates/connects his own GitHub account and the Codemagic app
  (his accounts, his sign-ins); Muse prepares the project content and
  the push. In Codemagic, the app must be set to build from
  `codemagic.yaml` (not the visual Workflow Editor). Note: don't push
  `node_modules/` — the build reinstalls it.
- **(e) [Shared]** **First build → TestFlight → real test on Charles's
  iPhone.** Trigger the workflow (a push to `main` does it, or start it
  manually in Codemagic). When the build lands in TestFlight, Charles
  installs it and runs the test that could never be run before: add a
  reminder a couple of minutes out, **close the app**, and confirm the
  notification fires. Also check pause/delete cancel as expected.
  Muse watches build results and fixes pipeline errors.
- **(f) [Shared]** **App Store review submission:** finish the listing
  (icon, screenshots, description, keywords, privacy-policy URL, age
  rating, category), flip `submit_to_app_store` to `true` in
  `codemagic.yaml` (Muse), run one more build, and submit for review
  from App Store Connect (Charles's account, Charles's final click).
  Review typically takes days.

**Still open, unchanged:** the data-layer decision in "Known gap"
above (hosted API vs. on-device data) must be settled before the
TestFlight test in step (e) means anything end-to-end — the notification
layer itself works either way.
