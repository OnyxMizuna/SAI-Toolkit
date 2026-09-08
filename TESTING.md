# S.AI Toolkit — Manual Test Checklist

Run through this before cutting a new build, and after any change that touches
a feature. It's organized to match the Settings modal's own tabs (Layout →
Style → Features → Data), plus a few things that live outside the modal.

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
      mobile-only fix that wasn't actually scoped to mobile —
      [content.js:1659](content.js#L1659))

## 1. Layout tab

- [ ] **Sidebar Layout** — enable, open Generation Settings, confirm it pins
      to the right as a sidebar instead of a floating centered modal
  - [ ] Open Memories too — confirm the split view (Generation Settings on
        top ~40%, Memories on the bottom ~60%)
  - [ ] Confirm the chat's scrollbar sits flush against the sidebar panel
        with no gap (this exact gap was a real bug once — [content.js:2061](content.js#L2061))
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
        URL on full page load, not on SPA navigation —
        [content.js:5066](content.js#L5066))
- [ ] **Classic Chat Layout** — messages center into a single column
- [ ] **Small Profile Images** — avatars shrink
- [ ] **Rounded Profile Images** — avatars become circular
- [ ] **Selection Checkboxes on Right Side** — start a multi-select, confirm
      checkboxes flip to the right; confirm it now also carries over via
      Drive "Settings" sync (key-name mismatch fixed — verify it stays fixed)
- [ ] **Square Message Box Edges** — corners go from rounded to square;
      confirm it also carries over via Drive "Settings" sync

## 2. Style tab

- [ ] **Classic Style** — enable, colors change; confirm it and Custom Style
      can't both be on at once
- [ ] **Custom Style**
  - [ ] Enable with everything left at defaults — confirm **zero** visual
        difference from native SpicyChat, in **both** Light and Dark mode,
        for **both** the AI's messages and your own (this is the main thing
        to watch for regressing)
  - [ ] Flip the Light/Dark "Editing colors for" switch — the color fields
        swap to that theme's values
  - [ ] Flip the Bot/User "Colors for" switch — Message BG, Body Text,
        Dialogue, and Narration all swap to that role's values (only one
        Message BG row is visible at a time); Highlight and Button Hover
        stay put — those aren't split by role
  - [ ] Edit a color on only one theme/role combination, then check the
        other three — confirm they're unaffected
  - [ ] Send a message yourself using dialogue/narration/asterisks — confirm
        YOUR OWN message text/quotes/italics pick up the "You" role's
        colors, and the AI's pick up the "Bot" role's colors, independently
  - [ ] Font Size / Font Family / weight/style/decoration selects — preview
        box updates live (these stay shared across both roles and themes)
  - [ ] Preview box's backdrop matches the actual configured Message BG for
        whichever role is selected — check "You" specifically in Light mode,
        since the user's bubble is always dark-navy regardless of theme, so
        a flat light-page guess would make light text look broken there
  - [ ] Background image upload applies; Clear removes it
  - [ ] Reset to Defaults — only resets the **currently-viewed** theme (both
        roles within it), not the other theme
  - [ ] Export Custom Style, then Import it back — identical result
  - [ ] If you have Custom Style colors saved from before the Bot/User
        split existed, confirm they migrated into "Bot" with no visual
        change, and "You" got safe new defaults (white body/dialogue,
        light-cyan narration) instead of inheriting a color that was never
        meant for your own always-dark bubble
- [ ] **Message Container Max Width** — set a value, chat column resizes;
      clear it, reverts to 800px
- [ ] **Memory Limit Indicator** — toggle Show Memory Dot; change Dot Color

## 3. Features tab

- [ ] **Hide "For You" Characters**
  - [ ] Enable it on page 1 of the home grid, then SPA-navigate away (into a
        chat) and back to page 1 **without reloading** — confirm the "For You"
        tiles are still hidden. This was driven by a `history.pushState` hook
        that never fired (SpicyChat's router reassigns `pushState`); it now
        polls the URL — [content.js:5476](content.js#L5476)
- [ ] **Page Jump Modal**
- [ ] **Show Generation Stats** (+ sub: full model details, compact stats)
- [ ] **Show Timestamps** (+ sub: date-first order, 24-hour time)
  - [ ] **Switch directly from one chat to another** via an in-app link (SPA
        navigation, no reload) and confirm stats/timestamps still appear on the
        second chat's messages **and** on newly generated ones. The message
        observer's reattach-after-navigation was previously stuck on the old
        chat's detached container (same inert-`pushState` root cause), silently
        killing stats until a full reload — [content.js:15785](content.js#L15785)
- [ ] **Show Message IDs**
- [ ] **Highlight Model Changes** — actually switch models mid-chat, confirm
      the yellow border appears
  - [ ] **Auto-Regenerate on Mismatch** / **on Short Response** / **Max
        Attempts** — confirm regen actually fires per the settings
  - [ ] Change the model via SpicyChat's own preset picker — confirm this
        does **not** falsely trigger an auto-regen (suppression logic)
- [ ] **Chat Name in Title** — browser tab title updates
- [ ] **NSFW Image Toggle** — button appears, stays in sync with SpicyChat's
      own Image Settings modal
- [ ] **Live Text Formatting (WYSIWYG)** — see dedicated section below
- [ ] **Message Recovery** (off by default) — enable it, force a failed send,
      confirm a Recover button appears and restores the text

("Hide Creator Name" is hidden from the UI — SpicyChat no longer shows a
per-message creator name in group chats, which is what it was built to
hide. Code is still intact; nothing to test here unless it's un-hidden.)

## 4. Data tab

- [ ] **Generation Profiles** — Export, Delete (with confirmation dialog)
- [ ] **Drive Sync**
  - [ ] Connect — status line updates
  - [ ] Toggle Stats / Settings / Style independently, Sync Now — confirm
        only the checked scopes actually change
  - [ ] Auto-sync on/off + interval
  - [ ] Create Backup, Restore Backup, Delete Backup, Open in Drive
  - [ ] Disconnect — fully clears (buttons revert, no stale "connected"
        state)
- [ ] **Custom Style Export/Import** (separate from All Data)
- [ ] **All Data Export/Import**
- [ ] **Clear All Data** — confirm the warning modal, confirm it actually
      wipes everything
- [ ] **What's New / View Changelog** button opens the release-history modal
      (see section 7b)
- [ ] Version number shown at the bottom matches the actual installed
      extension version (not a hardcoded string)

## 5. WYSIWYG composer — dedicated stress test

This has broken in subtle, hard-to-notice ways more than once. Test all of:

- [ ] Type dialogue "...", narration *...*, bold **...**, bold-narration
      ***...***, and highlight `` `...` `` — each renders live as you type
- [ ] With Custom Style on, the colors you see WHILE TYPING match the "You"
      role's colors (not "Bot") — send the message and confirm it renders
      with the same colors it previewed with in the composer
- [ ] Leave a quote or asterisk unclosed — the rest of the text still styles
      reasonably instead of breaking
- [ ] **Start a brand-new chat while already in an existing chat (no page
      reload)** — confirm the new chat's composer still allows arrow-key
      cursor movement and still highlights syntax (this exact bug was fixed
      once already — top regression risk)
- [ ] Switch between chats a few times in a row — re-check arrow keys and
      highlighting after each switch
- [ ] Edit an existing message — arrow keys still work and don't accidentally
      switch between regeneration siblings
- [ ] Resize the browser window (or drag the sidebar resize handle), then
      open a **new** chat afterward — WYSIWYG still works
- [ ] Paste text into the composer — reformats correctly
- [ ] Paste or edit multi-paragraph text (multiple blank lines between
      paragraphs) — no extra blank lines get added
- [ ] Type a standalone `---` line — renders as a full-width horizontal
      separator; sending the message preserves the literal `---` in the text
- [ ] On iOS/mobile if available: backspace in an empty composer doesn't
      crash the page
- [ ] With Grammarly (or a similar grammar-checking extension) installed and
      enabled, type an incorrect sentence, select it, and accept a suggested
      correction a few times in a row — the correction replaces the original
      text; it should never end up duplicated (correction glued in front of
      the original) even after several repeats
- [ ] With Grammarly enabled, trigger a small in-place suggestion (e.g. a
      missing comma, or lowercase "i" that should be capitalized) — accepting
      it should actually change the text, not silently do nothing. Try it
      right after typing (composer still "warm") as well as after pausing a
      few seconds first
- [ ] With Grammarly enabled, click away from the composer to interact with a
      suggestion popup, then click back into the composer to keep typing —
      whatever the popup did to the text should still be there, not reverted
      back to what it was before
- [ ] On Android (or any mobile layout where the composer's bottom-right
      button can show a voice/mic icon instead of send): with text typed,
      press Enter/Return on the on-screen keyboard — it should send the
      message, not toggle voice input

## 6. Generation Settings integration

- [ ] Open Generation Settings with Sidebar Layout off — still centered/modal
      as before
- [ ] Save a Generation Profile, switch chats, load it back — model +
      sliders apply
- [ ] Delete a profile — removed from the dropdown

## 7. Toolbar popup

- [ ] Click the extension icon — quick toggles mirror the in-page settings
      (toggle one in the popup, refresh the page, confirm it applied)
- [ ] "Open SpicyChat" button works when not currently on a SpicyChat tab
- [ ] "What's New" button: with a SpicyChat tab open, focuses that tab and
      opens the changelog history modal there
- [ ] "What's New" button: with **no** SpicyChat tab open, opens a new tab and
      the modal appears once that tab finishes loading

## 7b. Update notifications / changelog

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
- [ ] HTML export follows the active Settings modal style at export time:
  - [ ] Neither Classic Style nor Custom Style on — matches native SpicyChat
        colors for the current light/dark mode
  - [ ] Classic Style on — matches its fixed dark palette regardless of the
        live light/dark mode
  - [ ] Custom Style on — matches the configured bot/user colors, fonts, and
        highlight/quote/narration styling for the current light/dark mode
  - [ ] Quoted dialogue ("...") is colored per the Custom Style quote color

## 9. Cross-browser

- [ ] Repeat the checks that matter most (WYSIWYG, Custom Style, Sidebar
      Layout) on both the Firefox build (`manifest.json`, MV2) and the Chrome
      build (`manifest.chrome.json`, MV3) — they're maintained separately
      now, so a fix on one side isn't guaranteed on the other

## 10. Debug Mode (only if you touched it)

- [ ] Version-text easter egg (shift-click or 4 quick taps) toggles it on
- [ ] "Generation Profiles (Legacy)" row and "Debug Log Filters" section
      appear/disappear along with it
