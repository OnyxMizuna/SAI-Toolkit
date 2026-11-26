# S.AI Toolkit — Manual Test Checklist

Run through this before cutting a new build, and after any change that touches
a feature. Sections 1–4 match the Settings modal's own tabs (Layout → Style →
Features → Data); sections 5–11 cover things that live outside the modal.
Steps marked **iOS** need an iPhone/iPad (Safari); section 12 lists them all
in one place for a phone-only pass.

**Keeping this current:** every time a feature is added, changed, or removed,
update this file in the same change — add a step, edit one, or delete one.
Don't let it drift from what the extension actually does.

## 0. Setup

- [ ] Reload the extension in `chrome://extensions` (and the Firefox
      equivalent if you're testing `manifest.json`, the Firefox/MV2 build, too)
- [ ] Hard-refresh the SpicyChat tab
- [ ] Use a test chat that has real content to look at: at least one AI
      message with dialogue ("..."), narration (*...*), and a couple of
      back-and-forth exchanges with the user
- [ ] For anything visual, check **both** SpicyChat's Light and Dark mode
      (sun/moon icon, top right)
- [ ] For anything involving Sidebar Layout, check with the left nav **both**
      expanded and collapsed
- [ ] At the very start of a pass, with a normal desktop window width: confirm
      there's **no page-level horizontal scrollbar** at all, with Sidebar
      Layout both on and off (a stray right-side margin causing one — desktop
      only, both Sidebar Layout states — was a real bug once, caused by a
      mobile-only fix that wasn't actually scoped to mobile — search
      `content.js` for "Character info bar full-width background fix")

## 1. Layout tab

- [ ] **Sidebar Layout** — enable, open Generation Settings, confirm it pins
      to the right as a sidebar instead of a floating centered modal
  - [ ] Open Memories too — confirm the split view (Generation Settings on
        top ~40%, Memories on the bottom ~60%)
  - [ ] Confirm the chat's scrollbar sits flush against the sidebar panel
        with no gap (this exact gap was a real bug once)
  - [ ] **Compact Generation Settings** sub-toggle — descriptions disappear
  - [ ] **Minimum page width** — change it, confirm the layout adapts; clear
        the field or type garbage, confirm it falls back to 1000px
  - [ ] With Sidebar Layout **off**, at normal desktop width, confirm the page
        still doesn't scroll horizontally (see the Setup-section note above)
  - [ ] Shrink the window below ~999px wide — confirm the character info bar's
        background still extends edge-to-edge behind the (now-collapsed) left
        nav, same as before this was scoped to mobile-only
  - [ ] With Sidebar Layout enabled on a chat page, click through to a bot's
        edit page (`/chatbot/edit/*`) via a SpicyChat link (not a manual URL
        paste, so it's SPA navigation) — confirm the page looks normal and
        "Attach Lorebook" shows its Cancel/Attach buttons; then click back to
        the chat page and confirm Sidebar Layout is still active there (this
        was a real bug once — the sidebar CSS only got re-checked against the
        URL on full page load, not on SPA navigation — see
        `initSidebarLayoutPageWatcher` in `content.js`)
  - [ ] Sidebar Layout only applies on chat and Story Mode pages (`/chat/*`,
        `/chats/*`, `/story/*`, and localized `/{lang}/...` versions). With it enabled, create a **new** bot
        (before its first save), click "Attach Lorebook" — confirm it opens as
        a centered dialog with Cancel/Attach buttons, not a right-side panel
        (real bug once — the old denylist missed the new-bot page). Also spot
        check `/chatbot/*`, `/lorebook/*`, `/group/*`, `/voice/*` look normal
- [ ] **Rounded Profile Images** — avatars become circular
- [ ] **Selection Checkboxes on Right Side** — start a multi-select, confirm
      checkboxes flip to the right
- [ ] **Square Message Box Edges** — corners go from rounded to square

## 2. Style tab

### 2.1 Message Colors

- [ ] The tab shows only: **Message Colors**, **Background Image**, and
      **Memory Limit Indicator**. No Classic Style, Custom Style, font,
      Creator Link, or Max Width controls anywhere
- [ ] **Custom Message Colors** checkbox off (the default on a fresh
      install): the color fields are hidden and there is **zero** visual
      difference from native SpicyChat in both Light and Dark mode
- [ ] Tick it: the fields appear (Bot Message BG, User Message BG, Button
      Hover — each with a ☀ Light and 🌙 Dark field) and any **empty** field
      is filled with its default (Dark: `rgba(100, 100, 100, 0.1)`,
      `rgba(0, 100, 255, 0.1)`, `#292929`; Light: `#ededed`, `#335566`,
      `#fcfcfc`). Fields that already hold a value are **not** overwritten
- [ ] Save & Refresh with it ticked — the colors apply to the chat
- [ ] Untick it, Save & Refresh — the chat returns to SpicyChat's own colors;
      tick it again and the previous values are still in the fields
- [ ] While ticked, clear a single field and Save & Refresh — that one color
      falls back to SpicyChat's own; the others still apply
- [ ] A Dark-only value does **not** leak into Light mode, and vice versa
- [ ] Color swatch next to each field updates live while typing; accepts
      hex, rgb()/rgba() and named colors

### 2.2 Background Image

- [ ] Upload applies after Save & Refresh; the status line says "An image is
      set."
- [ ] The square bin button (right of the file picker) removes it after
      Save & Refresh; status says "No image set."; the chosen file's name
      has room to show

### 2.3 Memory Limit Indicator

- [ ] Toggle Show Memory Dot; change Dot Color

### 2.4 Retired Custom Style (upgrading from 1.3.0 or earlier)

- [ ] **Migration, Custom Style was on** — after updating, **Custom Message
      Colors** is ticked, the fields hold the old Message BG / Button Hover
      values (built-in ones included), and the bubbles look the same as before
- [ ] **Migration, Custom Style was off** — the checkbox is unticked and the
      chat is unchanged; ticking it reveals the old values already filled in
- [ ] The background image carries over in both cases
- [ ] The migration runs once: change or blank the migrated fields, Save &
      Refresh, reload — your edits stay
- [ ] **Your old Custom Style** section appears at the bottom of the Style tab
      only when old Custom Style data exists (it was enabled, or its values
      differ from defaults)
- [ ] **Export Custom Style URL to SpicyChat** shows a link field + "Open in
      SpicyChat ↗"; the link is copied to the clipboard where allowed
- [ ] Opening the link lands on SpicyChat's Customize preview: "Trying
      'Toolkit Custom Style'" with your bubble/text/dialogue/narration/
      highlight colors, in each theme you had customized. **Save** adds it to
      SpicyChat's saved styles
- [ ] Translucent colors (e.g. the old default `rgba(...)` bubbles) come
      through as their blended solid equivalent, not bright opaque colors
- [ ] The note under the link lists what SpicyChat styles can't carry
      (separate text colors for your own messages, fonts, highlight text
      color) when those were customized
- [ ] A Custom Style left at defaults → "matches SpicyChat's defaults —
      nothing to export" (no broken link)
- [ ] **Clear Custom Style data** → confirm dialog; after confirming, the
      section disappears and stays gone after reload. Message Colors,
      Background Image and Memory Indicator are untouched
- [ ] Once cleared, **nothing** brings the section back: not a Drive sync
      (Style checked), not restoring a Drive backup, not importing an All
      Data file — including ones made before 1.3.1 (see 4.3)

## 3. Features tab

- [ ] **Hide "For You" Characters**
  - [ ] Enable it on page 1 of the home grid, then SPA-navigate away (into a
        chat) and back to page 1 **without reloading** — confirm the "For You"
        tiles are still hidden. This was driven by a `history.pushState` hook
        that never fired (SpicyChat's router reassigns `pushState`); it now
        polls the URL — see `startHideForYou` in `content.js`
- [ ] **Page Jump Modal**
- [ ] **Show Generation Stats** (+ sub: full model details, compact stats)
  - [ ] On a long chat, reload and confirm **every** message shows its model/
        settings block exactly once (real bug once — SpicyChat nested the header
        menu button, so `insertBefore` threw `NotFoundError` and no stats
        rendered at all; check DevTools console for that error)
  - [ ] Regenerate a bot message a few times, then flip between versions with
        `<` `>` while a new response is still loading: each version shows one
        stats block, none duplicated, none missing
  - [ ] **Automatic recovery (all browsers)** — on page load and every time the
        tab returns to the foreground, the console logs "Background health:
        alive (…)". On Orion after switching apps, either it logs
        "alive (reconnect)" and stats keep saving with no alert, or the Orion
        alert appears within a few seconds of returning — before any message
        is generated
  - [ ] **Background page frozen mid-chat (iOS/Orion)** — the case that used
        to lose a whole chat: with the extension working, generate a message,
        switch to another app for a minute, come back and keep chatting. Every
        new message shows its stats; within ~8 s of the first one that can't
        be saved, the Orion alert appears. Force-quit and reopen Orion,
        reload the chat: **all** of those messages still have their stats
  - [ ] While healthy, `pendingStatsRecords` is empty or absent after each
        message (records are written there first and removed once the
        database confirms)
  - [ ] **Background page down (iOS/Orion)** — switch to another app and back
        so Orion unloads the background page, then generate a few messages.
        Each new message still shows its stats block, and the console logs
        "Held (background unavailable) stats…". **Orion on iOS only (test
        with both the Firefox build and the Chrome build installed in
        Orion):** an
        alert appears **once per page load** saying Orion shut down the
        background page, that it's a bug in the Orion app, and to force-quit
        Orion and reopen it. No alert in any other browser. Force-quit and
        reopen Orion (or toggle the extension off/on) and reload: the same messages still show their stats, the console
        logs "Delivered N held stats record(s)", and `pendingStatsRecords`
        is gone from storage. An Export All or Drive sync right after
        includes those messages
- [ ] **Show Timestamps** (+ sub: date-first order, 24-hour time)
  - [ ] **Switch directly from one chat to another** via an in-app link (SPA
        navigation, no reload) and confirm stats/timestamps still appear on the
        second chat's messages **and** on newly generated ones. The message
        observer's reattach-after-navigation was previously stuck on the old
        chat's detached container (same inert-`pushState` root cause), silently
        killing stats until a full reload
- [ ] **Show Message IDs**
- [ ] **Highlight Model Changes** — actually switch models mid-chat, confirm
      the yellow border appears
  - [ ] **Auto-Regenerate on Mismatch** / **on Short Response** / **Max
        Attempts** — confirm regen actually fires per the settings
  - [ ] Change the model via SpicyChat's own preset picker — confirm this
        does **not** falsely trigger an auto-regen (suppression logic)
- [ ] **Chat Name in Title** — browser tab title updates
  - [ ] On a chat with a label, tab reads `{Character} ({label})`, not
        SpicyChat's native `Chat with {Character} on SpicyChat`
  - [ ] On a brand-new chat (no messages yet), tab reads just `{Character}`
- [ ] **NSFW Image Toggle** — button appears, stays in sync with SpicyChat's
      own Image Settings modal
- [ ] **Message Recovery** (off by default) — enable it, force a failed send,
      confirm a Recover button appears and restores the text

("Hide Creator Name" is hidden from the UI — SpicyChat no longer shows a
per-message creator name in group chats, which is what it was built to
hide. Code is still intact; nothing to test here unless it's un-hidden.)

## 4. Data tab

### 4.1 Drive Sync — connection and sign-in

- [ ] Connect — status line updates; when healthy it shows the Google account
      email
- [ ] Disconnect — fully clears (buttons revert, no stale "connected" state)
- [ ] Dead sign-in detection: revoke the toolkit's access at
      myaccount.google.com → Security → Third-party connections, then open
      the Data tab — status turns red ("Google sign-in expired"), the
      **Reconnect Google** button appears, and the backup list stays hidden
      (no surprise sign-in sheet)
- [ ] Reconnect Google — shows Google's account chooser, then "Reconnected
      as …"; Sync Now and Create Backup work afterwards **without** clearing
      browser cookies (**iOS**: this used to need a cookie wipe)

- [ ] **iOS (Orion)** background page unloaded: open a chat, switch to another
      app and back, open the Data tab and tap Sync Now. Either it recovers by
      itself within ~5 s, or the status says Orion has shut down the
      background page, that it's a bug in the Orion app, and to force-quit
      and reopen Orion — never a bare "Sync failed — please try again."
      After force-quitting and reopening Orion, Sync Now works. (Other
      browsers get the generic "turn the extension off and on again" text)

### 4.2 Drive Sync — syncing

- [ ] Toggle Stats / Settings / Style independently, Sync Now — confirm only
      the checked scopes actually change
- [ ] Auto-sync on/off + interval
- [ ] Layout toggles "Selection Checkboxes on Right Side" and "Square Message
      Box Edges" carry over via "Settings" sync
- [ ] Fresh install on a second device, then sync with **Style** checked
      (before pressing Save & Refresh there) — it **receives** the other
      device's Message Colors / Background Image instead of wiping them

### 4.3 Backups and import/export

- [ ] Drive: Create Backup, Restore Backup, Delete Backup, Open in Drive
- [ ] Create Backup shows live status ("Reading stats database…" →
      "Uploading N MB… Ns") and finishes with "Backup created." (**iOS**:
      test with a large ~20 MB stats set; it must not sit on "Creating…"
      forever)
- [ ] Restore Backup — button shows "Downloading… Ns" → "Parsing N MB…" →
      "Applying…", then the page reloads with restored settings and merged
      stats (**iOS**: test with a ~20 MB backup; no endless "Restoring…")
- [ ] **All Data Export/Import** round-trips settings, profiles and stats
- [ ] New exports and new Drive backups contain `styleOverrides` and do
      **not** contain `enableCustomStyle` / `customStyleValues` (open the
      JSON and check)
- [ ] Importing/restoring a **pre-1.3.1** backup that has `customStyleValues`:
      the old Custom Style data is quietly ignored — the "Your old Custom
      Style" section does **not** appear because of it. Only the surviving
      settings (bubble BGs, button hover, background image) are filled in
      from it, with Custom Message Colors ticked only if Custom Style was on
      in that backup
- [ ] **Generation Profiles** — Export, Delete (with confirmation dialog)
- [ ] **Clear All Data** — confirm the warning modal, confirm it actually
      wipes everything

### 4.4 Footer

- [ ] **What's New / View Changelog** button opens the release-history modal
      (see section 7)
- [ ] Version number shown at the bottom matches the actual installed
      extension version (not a hardcoded string)
- [ ] Mari's photo and caption are **hidden** by default, and appear at the
      very bottom of the Data tab (below the debug filters) only while Debug
      Mode is on (see section 11). When visible, check that the image loads
      in both Chrome and Firefox, since it's loaded from `images/mari.jpg`
      via `web_accessible_resources`

## 5. Generation Settings integration

- [ ] Open Generation Settings with Sidebar Layout off — still centered/modal
      as before
- [ ] Save a Generation Profile, switch chats, load it back — model +
      sliders apply
- [ ] Delete a profile — removed from the dropdown

## 6. Toolbar popup

- [ ] Click the extension icon — quick toggles mirror the in-page settings
      (toggle one in the popup, refresh the page, confirm it applied)
- [ ] "Open SpicyChat" button works when not currently on a SpicyChat tab
- [ ] "What's New" button: with a SpicyChat tab open, focuses that tab and
      opens the changelog history modal there
- [ ] "What's New" button: with **no** SpicyChat tab open, opens a new tab and
      the modal appears once that tab finishes loading

## 7. Update notifications / changelog

Release notes live in `changelog.json` — edit that file on every release, not
`content.js`. Add an entry there (`version`, `date`, `features[]`) before or
right after bumping `manifest.json`'s version.

- [ ] Bump the version in `manifest.json` (and `manifest.chrome.json`) and add
      a matching entry to `changelog.json`. Reload the unpacked extension
      **with a SpicyChat tab already open** — that tab should show the update
      modal with the correct notes, with no manual page refresh
- [ ] The update modal's "View Changelog" button opens the release-history
      view (replacing the toast) and also marks the version as seen — reload
      the tab afterward and confirm the toast does **not** come back
- [ ] Dismiss it via "Got it!", reload the tab — it should **not** reappear
- [ ] Both the update modal and the history modal have a **×** button
      (top-right) that closes them (**iOS**: the modal fills the screen, so
      there's no backdrop to tap; the footer button must also be visible
      above Safari's bottom toolbar)
- [ ] Repeat with no SpicyChat tab open at update time; open one afterward —
      modal appears once with correct notes
- [ ] Bump the version twice in a row (simulating two quick releases) while a
      tab stays open — confirm only one modal ends up shown/left visible
      (the latest version), not two stacked on top of each other
- [ ] Temporarily delete a version's entry from `changelog.json` and trigger
      its notification — confirm an honest "not published yet" fallback
      appears instead of wrong/stale bullets, and no console errors
- [ ] `grep -n CHANGELOG content.js` comes up empty (no hardcoded release
      notes left in the file)

## 8. Chat export

- [ ] Export as JSON — downloads, contains the real conversation (full
      message count, not just one page), and bot/user name + avatar are
      populated
- [ ] Export as HTML — downloads, contains the real conversation, and bot/user
      name + avatar are populated
- [ ] **Long conversation (800+ messages) exports in full, not cut off around
      1MB.** The messages endpoint silently caps a single response body at ~1MB
      (~625 messages), so the export pages backward through history with
      `?limit=300&last_id=<oldest id so far>` — the same cursor the site's "Load
      Previous Chapters" button uses — until it reaches the first message
      ([page-context.js](page-context.js), the `SAI_EXPORT_CHAT_REQUEST` handler).
      Verify the exported message count matches the whole active thread (first
      message present) and the file is well over 1MB. Note: the count can be
      lower than the on-screen `#N` / `num_messages`, which also counts
      regenerated alternates the endpoint doesn't return.
- [ ] HTML export uses native SpicyChat colors for the current light/dark mode,
      with the Style tab's Bot/User Message BG for that mode when Custom Message
      Colors is ticked and a value is set

## 9. Story Mode (`/story/...` URLs)

- [ ] **Auto Story Mode toggle** appears in the Story Mode header immediately to
      the left of the Generation Settings (sparkles) button
- [ ] Enabling it repeatedly clicks "Continue Story" on its own; the icon
      reflects the on/off state; disabling it stops further clicks
- [ ] It stops itself safely if "Continue Story" disappears or navigation leaves
      Story Mode (no runaway clicking, no console errors)
- [ ] **Message number (`#N`)** shows in the Generation Statistics block on the
      same line as the timestamp (`MM/DD/YYYY @ HH:MM:SS AM | #N`)
- [ ] On a fresh load of a long story (>50 messages), the newest message's `#N`
      equals the conversation's true total — it does **not** reset to `#50`
      (numbering is calibrated against the API's `num_messages`; the GET
      /messages window is only the last 50)
- [ ] During a live Auto Story Mode run, each new message increments `#N` by
      exactly 1 and the newest number stays equal to `num_messages` — it does
      **not** drift ahead over a long run (each number is anchored to its
      predecessor via `prev_id`, so duplicate insert events and regenerations
      don't inflate the count)
- [ ] Refresh mid-run — the recalibrated `#N` matches what was shown live (no
      jump up or down)
- [ ] **Export/download button** appears in the Story Mode header (same download
      icon as Chat Mode), to the left of the Auto Story toggle
- [ ] Clicking it opens the JSON/HTML menu; both exports download the full story
      conversation (all messages, not just the loaded window) — the messages API
      is the same endpoint for chat and story, so the fetch is mode-agnostic

## 10. Cross-browser

- [ ] Repeat the checks that matter most (Style tab colors, Custom Style
      export, Sidebar Layout, Drive backup/restore) on both the Firefox build
      (`manifest.json`, MV2) and the Chrome build (`manifest.chrome.json`,
      MV3) — they're maintained separately now, so a fix on one side isn't
      guaranteed on the other

## 11. Debug Mode

- [ ] Version-text easter egg (Shift+click, or 4 quick taps/clicks on the
      version number in the Data tab) toggles it on and off; the version
      text turns green while on
- [ ] **iOS**: 4 fast taps toggle it every time (no page zoom, no
      text-selection callout)
- [ ] "Generation Profiles (Legacy)" row, "Debug Log Filters" section and
      Mari's tribute appear/disappear along with it

### 11.1 Background page experiment (Debug Mode only)

Under Debug Log Filters there is a **Background page (experimental)** block.
It exists to learn what works on Orion for iOS; nothing in it is on by default.

- [ ] **Check background** on a healthy browser: `backgroundAnswersPing: true`,
      `heldStatsWaiting: 0`, and `bridge: "off…"` while the box is unticked
- [ ] Tick **Use extension-page fallback (bridge)**, then **Check background**:
      `bridge.ok: true`, with `database.opened: true` and
      `backgroundBefore.alive: true`. If it says "bridge page did not load",
      the browser or page blocked the hidden frame — note which browser
- [ ] **iOS (Orion), background dead** (switch apps and back): press **Check
      background** and record the output — whether the ping answers, whether
      the bridge loads, and whether the database opens
- [ ] **Try revive** while dead: record `before`, `after` and `details.via`
      (`reconnect` = the fresh-port approach worked; `bridge` = the extension
      page revived it; `null` = neither did)
- [ ] With the box ticked and the background dead, generate a message: the
      console logs "Bridge fallback for message … stored", and after a
      force-quit and reload the message still has its stats
- [ ] **Restart extension** (needs the box ticked) asks for confirmation, then
      restarts the extension; refresh the page afterwards and check the
      background answers again
- [ ] Untick the box or turn Debug Mode off: the bridge refuses requests
      ("not authorised") and no hidden frame is used
- [ ] `bridgeToken` and `experimentalBridge` are **not** in Drive backups

## 12. iOS pass (iPhone/iPad Safari)

The **iOS**-marked steps above, gathered for a phone-only run:

- [ ] Changelog modals close via **×** and fit above Safari's toolbar (7)
- [ ] 4 taps on the version number toggle Debug Mode reliably (11)
- [ ] Reconnect Google works without clearing cookies (4.1)
- [ ] Create Backup and Restore Backup finish with a large stats set and show
      progress (4.3)
- [ ] Sync Now completes with a large stats set (4.2)
- [ ] Orion: after switching apps, Drive actions recover or explain that the
      extension needs toggling off/on (4.1)
- [ ] Orion: switching apps mid-chat no longer loses that chat's stats (3)
- [ ] Orion: run the background page experiment and record the results (11.1)
- [ ] Orion: stats for messages generated while the background page was
      unloaded are kept and delivered later, and the one-time alert explains
      the Orion bug and the force-quit fix (3)

## 13. Proposed compatibility and reliability regression pass

- [ ] Story with entire history loaded: first message is #1, last matches API total; long window retains absolute numbering; alternatives share one number and one combined index; repeat reload and Auto Story Mode.
- [ ] Two unrelated 2/2 and 3/3 groups: alternate each, rapidly alternate during generation, use mouse and keyboard, reload, navigate chats. Stats must correspond to the visible message identity. If identity cannot be established, no guessed version stats should appear.
- [ ] Public Rulebook issue #3: new chat without first prompt, public Rulebook, send prompt, verify attachment. Test Firefox/Edge with Toolkit disabled, enabled/default, Sidebar Layout only, then other settings individually. Compare native request payloads locally; do not log credentials. No speculative API fix included.
- [ ] Export 116k+ messages (JSON and HTML separately), verify IDs/count/ordering against an independent export and expected conversation; test duplicate pages, empty terminal page, timestamp formats, 429 with Retry-After, network interruption, cancellation, concurrent attempts, and no silent partial downloads. Compare duration to the 6m25s QoL reference; this is a benchmark, not a promised runtime.
- [ ] Toolkit capability attribute appears without QoL, reports actual installed version and independent feature flags, updates after settings changes/import/restore and theme changes, contains no sensitive values. Test both extension initialization orders and older/absent Toolkit.
- [ ] Test both extensions' overlapping UI features independently and together, including recovery/auto-retry and native Rulebook/Lorebook attachment. Confirm no duplicate sends, no broken streaming, no stale CSS, and retained QoL-only features.
- [ ] Preserve v1.3.2 Orion background holding/reconnect, Drive and bridge tests above. Firefox alternate manifest must have identical resources to main Firefox manifest.
