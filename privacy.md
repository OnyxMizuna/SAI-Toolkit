# Privacy Policy for S.AI Toolkit Extension

**Effective Date:** June 13, 2026
**Version:** 1.6

Thank you for using the **S.AI Toolkit Extension**. Your privacy is important to us.
This Privacy Policy explains how we collect, use, and protect your data when you use our browser extension.

---

## 1. Data Collection

The S.AI Toolkit Extension collects and processes limited metadata necessary to provide its functionality.
By default, no personal information or message content is collected. Two opt-in features send or locally persist additional data: **Message Recovery** (section 1.3) captures the text of a failed outgoing message and stores it locally only; **Drive Sync** (section 1.5) uploads generation statistics to your own Google Drive account when you initiate a sync.

### 1.1 Data Observed Automatically

**Local API Observation:**
The extension observes certain API responses within your browser (such as `GET /messages`, `GET /characters`, and `POST /chat`) to extract metadata for visualization, debugging, and export features. This includes:

- `conversation_id`
- `character_id`
- `message_id`
- `inference_model`
- `inference_settings` (e.g., temperature, top_p, top_k, max_new_tokens)
- `createdAt` timestamps
- roles (bot/user) and related message metadata
- NSFW mode state (if toggled by the user)
- Exported chat data (when user initiates export)

This observation occurs **only within your local browser environment**.
The extension does **not** transmit, log, or send any data externally, except as described in section 1.5 (Drive Sync, opt-in).

### 1.2 Data Stored Locally

The extension stores limited information locally using the browser's `storage.local` API and a local **IndexedDB** database:

- **User Preferences:** Layout, theme, interface customization, and feature toggles (e.g., sidebar, classic theme, NSFW mode, Message Recovery, Hide Creator Name, etc.)
- **Generation Statistics:** Metadata about message generation (e.g., model type, token count, temperature, top_p, top_k, timestamps) for debugging and display purposes. These records are kept in a local **IndexedDB** database (`sai_toolkit_stats`) on your device.
- **Custom Style Values:** User-defined color, font, and background preferences for the chat interface, including any uploaded background image (stored as a local data URL).
- **Exported Data:** When you use the export feature, chat data is prepared for download but is never sent externally.
- **NSFW Mode State:** If you toggle NSFW image mode, your preference is stored locally.
- **Failed Message Queue (only if Message Recovery is enabled):** Locally saved copies of messages whose send to SpicyChat failed — see section 1.3.
- **Drive Sync State (only if Drive Sync has been used):** Google OAuth tokens — a short-lived **access token** (with expiry timestamp) and a long-lived **refresh token** used to renew it without prompting you to sign in again — the Drive file ID of the sync file, the optional auto-sync preference and interval, and the timestamp of the last successful sync — see section 1.5.

All stored data remains **local to your device**, except when Drive Sync is explicitly triggered by the user (section 1.5).

### 1.3 Message Recovery (Opt-In Feature)

**What it is.** SpicyChat's chat backend occasionally fails — Cloudflare 502 errors, CORS preflight failures, network drops, request timeouts. When this happens the message the user just typed is silently destroyed: the input box is cleared the instant the request is issued, and the only on-screen affordance is a generic "Oops! Something went wrong" banner. Long, carefully-written messages disappear with no way to recover them.

The optional **Message Recovery** feature exists solely to address this. When enabled, the extension captures the text of an outgoing chat message at the moment of send, holds it in memory until the request's outcome is known, and persists it locally **only if the send fails** — so the user can click a "Recover message" button to restore what they typed.

**How to enable / disable.** The feature is found in the **Features** tab of the S.AI Settings modal under the label **"Message Recovery"**. The default is **OFF**. When OFF, message text is never read into the extension's code under any circumstance. When ON, the user is on notice that message text may be captured.

**What is captured, and when.**

- The text of the outgoing user message (`message` field in the `POST /chat` or `POST /story` request body).
- The associated `conversation_id`, `character_id`, the request URL, and a millisecond timestamp.
- The failure reason (e.g., `xhr-status-502`, `fetch-throw`).

Capture happens **only at send time**. If the request succeeds, the in-memory snapshot is discarded immediately and nothing is written to storage. If it fails, the snapshot is written to `chrome.storage.local` under the key `failedMessages`.

**What is *not* captured.**

- Bot/AI response content (we never read or store the assistant's replies).
- Successfully-sent messages (only failed sends are persisted).
- Any messages while the toggle is OFF.
- Credentials, tokens, account information, payment details, or any other personal data.

**Storage limits and eviction.**

- The `failedMessages` queue is capped at **50 entries**. When full, the oldest entry is dropped to make room for a new one.
- Recovering a message via the "Recover message" button removes that entry from the queue.
- Disabling the toggle stops new captures immediately. Existing captured entries remain in storage so previously-failed messages can still be recovered; the user can clear them at any time using **Clear All Data** in the settings modal.

**Transmission.** Captured messages are stored on the user's device only. The extension does not transmit, sync, log, upload, or otherwise send this data anywhere — including to any of the extension author's services. The browser's `storage.local` API is the only sink.

**Source-level transparency.** The interception, capture, persistence, and recovery code is documented inline in `xhr-intercept.js` (network-level capture and disclosure header) and `content.js` (storage and UI). Reviewers can verify the behavior end-to-end.

### 1.4 Custom Background Image (Opt-In)

The **Custom Style** feature includes an optional background image upload. If the user uploads an image, it is converted to a data URL entirely within the browser and stored in `chrome.storage.local` under the `customStyleValues` key. The image data never leaves the device and is not transmitted anywhere. Users can remove it at any time by clicking **Clear** next to the background image field or by using **Reset to Defaults** or **Clear All Data** in the settings modal.

### 1.5 Drive Sync (Opt-In Feature)

**What it is.** The optional **Drive Sync** feature allows generation statistics (`messageGenerationStats`) to be synchronised across multiple devices via a file stored in the user's own Google Drive. Sync is user-initiated by clicking **Sync Now** in the popup or the Settings modal. An optional **Auto-sync** setting (off by default) can additionally run the same sync on a user-chosen interval; it syncs the same data to the same place and can be turned off at any time.

**How to enable / disable.** Manual sync requires no separate toggle — it runs only when the user clicks **Sync Now**. Automatic sync is controlled by the **Auto-sync** checkbox (off by default) and an interval selector in the Settings modal's Data tab. The user can disconnect at any time using the **Disconnect** button there, which clears all locally cached Drive credentials (including the refresh token) and stops any future syncs — manual and automatic — until the user re-authenticates.

**What is sent, and when.**

- `messageGenerationStats` — generation metadata only (model name, token count, temperature, top_p, top_k, message UUID, character UUID). No message text, no bot reply content, no personal identifiers. (Conversation IDs are no longer part of the stored or synced statistics.)
- Data is sent to **the user's own Google Drive account** as a single file named `sai-toolkit-sync.json`, accessible only to this extension under the `drive.file` OAuth scope.

**OAuth and authentication.**

- The extension authenticates with Google using the OAuth 2.0 **Authorization Code flow with PKCE** — via the browser's `identity` API where available, or a Google sign-in tab on browsers where that API is unavailable (e.g. iOS).
- The scope requested is `https://www.googleapis.com/auth/drive.file` — a non-sensitive scope that grants access only to files created by this specific extension, not to any other files in the user's Drive.
- The flow returns a short-lived **access token** and a long-lived **refresh token**, both cached locally (in `chrome.storage.local`) with the access token's expiry timestamp. The refresh token lets the extension mint new access tokens silently, so you are not prompted to sign in again roughly every hour. These tokens are used solely for Drive API calls.
- **Token broker.** Google's token exchange requires a confidential `client_secret`, which must never ship inside a browser extension. The extension therefore performs the code-for-token exchange (at first sign-in) and the silent token refresh (thereafter) through a small, **stateless Cloudflare Worker operated by the extension author** (a "token broker"). The browser sends the broker **only OAuth artifacts** — the one-time authorization code plus PKCE verifier, or the refresh token — and the broker adds the client secret, relays the request to Google, and returns the tokens. **The broker never receives any generation statistics, message text, or other user content, keeps no logs, and stores nothing.** It is the only extension-author-operated endpoint the extension contacts, and only for OAuth token exchange.
- If the refresh token is revoked or expires, the extension prompts for re-authentication on the next sync attempt.

**What is *not* transmitted.**

- Message text or bot reply content.
- Credentials, passwords, session cookies, or SpicyChat account information.
- Generation statistics or any user content to the extension author's servers. The author-operated token broker (above) handles **only** OAuth token exchange — never statistics or message data. The statistics themselves travel only between the browser and the user's own Google Drive (`www.googleapis.com`).

**Merge behaviour.** When syncing, the extension performs a deep merge of local and remote stats, retaining the richer data set from each source. No data is overwritten without comparison; entries present only on one side are preserved.

**Revocation.** Users can revoke the extension's Drive access at any time from their [Google Account security settings](https://myaccount.google.com/permissions) or by clicking **Disconnect** in the extension, which removes the locally cached token and file reference.

---

## 2. Data Usage

Collected data is used solely for the following purposes:

- **Display Generation Statistics:** To provide insights into message generation parameters and performance.
- **Customization:** To enable and manage user-selected interface features, including colors, fonts, layout preferences, and visibility toggles (such as Hide Creator Name).
- **Debugging:** To assist users in exporting, importing, or reviewing local statistics for troubleshooting.
- **Chat Export:** To allow users to export their chat history for backup or personal use.
- **NSFW Mode:** To allow users to toggle and persist NSFW image mode locally.
- **Message Recovery (opt-in):** To restore the user's typed chat message after a failed send to SpicyChat's API. The captured text is read into memory at send time, persisted to local storage only on failure, and returned to the user's input field on demand. It is never used for any other purpose, never aggregated, and never transmitted.
- **Drive Sync (opt-in):** To synchronise generation statistics across the user's devices via the user's own Google Drive account, only when explicitly triggered by the user.

---

## 3. Data Sharing

The S.AI Toolkit Extension does not share any data with third parties under normal operation.
All data remains on your device and is processed entirely within your browser.

**Exception — Drive Sync (opt-in):** When a sync runs — either when the user clicks **Sync Now** or, if Auto-sync is enabled, on the user's chosen interval — `messageGenerationStats` is uploaded to the user's own Google Drive account via Google's Drive API. This data is stored in a file visible only to this extension (`drive.file` scope). It is not shared with the extension author or any other party. The user can revoke this access at any time (see section 1.5).

There is no background data collection and no analytics pipeline. The only extension-author-operated endpoint the extension contacts is a **stateless OAuth token broker** used solely to complete Google sign-in and token refresh for Drive Sync (see section 1.5); it processes only OAuth tokens — never generation statistics, message text, or other user content — and retains nothing. No generation statistics or user content are ever sent to the extension author.

---

## 4. Data Security

We take reasonable measures to protect your local data:

- **Local Storage Only:** All information is stored using the browser's `storage.local` API.
- **No External Transmission:** The extension communicates with remote servers only in connection with Drive Sync — with Google's OAuth and Drive APIs, and with the extension author's stateless OAuth **token broker** (used only to complete Google token exchange/refresh; see section 1.5). It contacts no other remote servers.
- **Limited Scope:** Only metadata necessary for display and debugging is processed.
- **OAuth Token Security:** Google access and refresh tokens are cached locally and used only to obtain and use Drive API access. They are sent only to Google and to the OAuth token broker (which adds the client secret, relays to Google, and stores nothing). The refresh token is cleared on **Disconnect** and is excluded from any exported or backed-up data; access tokens are never otherwise logged or transmitted, and expired or revoked tokens are cleared automatically.

---

## 5. Data Storage and Unlimited Storage Permission

The **S.AI Toolkit Extension** stores user preferences, configuration profiles, and generation statistics locally on your device, using the browser's `storage.local` API and a local **IndexedDB** database (the latter holds the generation-statistics records).
Over time, this data (such as message metadata, model settings, generation records, and any uploaded background image) may grow beyond Chrome's default 5 MB limit.

To prevent data loss and ensure smooth functionality, the extension requests the **`unlimitedStorage`** permission.
This permission allows the extension to store more than 5 MB of data **locally only** (across `storage.local` and IndexedDB) — it **does not** enable access to additional system resources or external data, nor does it transmit any information outside your browser.

Key points:

- All information remains **fully local** on your device.
- No personal or identifiable data is collected.
- No data is shared, synced, or sent to any external servers — except generation statistics sent to the user's own Google Drive when Drive Sync is explicitly triggered.
- You can clear all stored data at any time via the extension's settings or by uninstalling it.

This permission is requested solely to ensure the extension continues to operate reliably as your locally stored statistics and preferences grow over time.

---

## 6. User Control

You have full control over your data at all times:

- **Clear Data:** You can remove all stored data by uninstalling the extension or by using the built-in "Clear All Data" option.
- **Export/Import Data:** You may export or import all settings (including generation statistics and custom style values) for backup or to transfer to another device.
- **Reset Styles:** The "Reset to Defaults" button in the Custom Style panel clears any uploaded background image and all custom color/font choices without requiring a full data wipe.
- **Local Management:** You may modify or reset preferences through your browser settings.
- **Disconnect from Google Drive:** Clicking **Disconnect** in the Settings modal's Data tab clears the locally cached OAuth token, token expiry, Drive file reference, and last-sync timestamp. No further syncs will occur until the user re-authenticates. Drive access can also be revoked at any time from [Google Account Permissions](https://myaccount.google.com/permissions).

---

## 7. Permissions

The S.AI Toolkit Extension requires the following browser permissions:

- **storage** – to save user preferences and local statistics.
- **unlimitedStorage** – to allow storage of data beyond the default 5 MB limit (in `storage.local` and IndexedDB), all locally.
- **identity** – to authenticate with Google OAuth 2.0 for Drive Sync.
- **alarms** – to schedule the optional Auto-sync at the user's chosen interval (only when the user enables Auto-sync).
- **tabs** – to send sync progress/status messages to open SpicyChat tabs and, on browsers where the background page cannot perform large network transfers (e.g. iOS), to delegate Drive uploads/downloads through a SpicyChat tab.
- **Host access** (`*://spicychat.ai/*`, `https://www.googleapis.com/*`, `https://oauth2.googleapis.com/*`) – to read SpicyChat API responses locally (for statistics/export) by observing the page's own network calls, and to communicate with Google's Drive and OAuth endpoints for Drive Sync.

These permissions are used **only within your browser** and **do not enable any external data collection**. The extension does not use the `webRequest` or `scripting` permissions; API observation is performed by a script the extension injects into the page that wraps the page's own `fetch`/`XHR` calls locally.

---

## 8. Changes to This Privacy Policy

We may update this Privacy Policy periodically.
Updates will be posted on this page with a revised effective date.
Continued use of the extension after updates indicates acceptance of the revised terms.

| Version | Date | Summary of changes |
| --- | --- | --- |
| 1.6 | 2026-06-13 | Drive Sync OAuth moved to Authorization Code + PKCE with a refresh token and a stateless author-operated token broker (§1.5, §3, §4); generation statistics now stored in a local IndexedDB database (§1.2, §5); disclosed the opt-in Auto-sync (§1.5); corrected the Permissions list — added `alarms`/`tabs` and host access, removed `scripting`/`webRequest` (§7); conversation IDs are no longer part of the stored or synced statistics (§1.5). |
| 1.5 | 2026-06-08 | Added Drive Sync (§1.5); updated data sharing, security, permissions, and user control sections. |
| 1.4 | 2026-06-03 | Added Custom Background Image (§1.4); updated storage, customization, and user control sections. |
| 1.3 | 2026-05-05 | Added Message Recovery (§1.3) with capture scope, storage limits, eviction, and transmission policy. |

---

## 9. Contact Us

If you have any questions about this Privacy Policy or your data, please contact us through:
**GitHub:** [https://github.com/OnyxMizuna/SAI-Toolkit/issues](https://github.com/OnyxMizuna/SAI-Toolkit/issues)

---

## 10. Compliance and Data Protection

The S.AI Toolkit Extension complies with applicable privacy and data protection laws, including:

- **General Data Protection Regulation (GDPR)**
- **California Consumer Privacy Act (CCPA)**

Because no personal or identifiable data is collected, no data subject access, correction, or deletion requests are required. Drive Sync transmits only non-personal generation metadata to the user's own Google account; the only extension-author-operated component is a stateless OAuth token broker that handles Google token exchange/refresh and retains nothing. No user data is held by the extension author.

---

## 11. Additional Notes

- **No Personal Identifiable Information (PII):** The extension does not collect, store, or transmit personal account data, credentials, or payment information. The opt-in Message Recovery feature locally stores the user's own typed chat message text — and only on send failure, see section 1.3 — but does not transmit it anywhere. Drive Sync transmits only generation metadata (model, token count, temperature settings) and only to the user's own Google Drive account.
- **Browser Context Only:** All processing occurs within the browser, under user-granted permissions.
- **Transparency:** The extension's source code and behavior are transparent to the user at all times.

---

**Summary:**
This policy clearly communicates that all processing is local by default, no data is shared or transmitted externally without user action, and users have complete control. Message Recovery is opt-in, off by default, never transmits, and exists to prevent loss of user-typed text when SpicyChat's chat API fails. Drive Sync is opt-in (manual, or an optional Auto-sync that is off by default), transmitting only generation metadata (no message text) to the user's own Google Drive account using a non-sensitive OAuth scope (`drive.file`); sign-in uses Authorization Code + PKCE, with token exchange relayed through a stateless author-operated broker that sees only OAuth tokens and stores nothing. Custom Style values (including any uploaded background image) are stored locally as user preferences and are never transmitted. All other features operate entirely on locally available page data and store only preference flags.
It meets Chrome Web Store **User Data Privacy Policy** and **Manifest V3** standards for transparency and limited data use.
