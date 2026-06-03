# Privacy Policy for S.AI Toolkit Extension


**Effective Date:** June 3, 2026  
**Version:** 1.4  

Thank you for using the **S.AI Toolkit Extension**. Your privacy is important to us.  
This Privacy Policy explains how we collect, use, and protect your data when you use our browser extension.

---

## 1. Data Collection

The S.AI Toolkit Extension collects and processes limited metadata necessary to provide its functionality.  
By default, no personal information or message content is collected. One opt-in feature — **Message Recovery** — captures the text of an outgoing chat message at send time and stores it locally only if the send fails; this is described in detail in section 1.3.


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
The extension does **not** transmit, log, or send any data externally.


### 1.2 Data Stored Locally

The extension stores limited information locally using the browser's `storage.local` API:

- **User Preferences:** Layout, theme, interface customization, and feature toggles (e.g., sidebar, classic theme, NSFW mode, Message Recovery, Hide Creator Name, etc.)
- **Generation Statistics:** Metadata about message generation (e.g., model type, token count, temperature, top_p, top_k, timestamps) for debugging and display purposes.
- **Custom Style Values:** User-defined color, font, and background preferences for the chat interface, including any uploaded background image (stored as a local data URL).
- **Exported Data:** When you use the export feature, chat data is prepared for download but is never sent externally.
- **NSFW Mode State:** If you toggle NSFW image mode, your preference is stored locally.
- **Failed Message Queue (only if Message Recovery is enabled):** Locally saved copies of messages whose send to SpicyChat failed — see section 1.3.

All stored data remains **local to your device**.


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

---

## 2. Data Usage

Collected data is used solely for the following purposes:

- **Display Generation Statistics:** To provide insights into message generation parameters and performance.  
- **Customization:** To enable and manage user-selected interface features, including colors, fonts, layout preferences, and visibility toggles (such as Hide Creator Name).  
- **Debugging:** To assist users in exporting, importing, or reviewing local statistics for troubleshooting.
- **Chat Export:** To allow users to export their chat history for backup or personal use.
- **NSFW Mode:** To allow users to toggle and persist NSFW image mode locally.
- **Message Recovery (opt-in):** To restore the user's typed chat message after a failed send to SpicyChat's API. The captured text is read into memory at send time, persisted to local storage only on failure, and returned to the user's input field on demand. It is never used for any other purpose, never aggregated, and never transmitted.

---

## 3. Data Sharing

The S.AI Toolkit Extension **does not share any data** with third parties.  
All data remains on your device and is processed entirely within your browser.  
There is **no data transmission, collection, or exfiltration** to any external servers or services.

---

## 4. Data Security

We take reasonable measures to protect your local data:

- **Local Storage Only:** All information is stored using the browser's `storage.local` API.  
- **No External Transmission:** The extension does not communicate with any remote servers.  
- **Limited Scope:** Only metadata necessary for display and debugging is processed.

---


## 5. Data Storage and Unlimited Storage Permission

The **S.AI Toolkit Extension** uses the browser's `storage.local` API to save user preferences, configuration profiles, and generation statistics locally on your device.  
Over time, this data (such as conversation metadata, model settings, generation records, and any uploaded background image) may grow beyond Chrome's default 5 MB limit.

To prevent data loss and ensure smooth functionality, the extension requests the **`unlimitedStorage`** permission.  
This permission allows the extension to store more than 5 MB of data **locally only** — it **does not** enable access to additional system resources or external data, nor does it transmit any information outside your browser.

Key points:
- All information remains **fully local** on your device.
- No personal or identifiable data is collected.
- No data is shared, synced, or sent to any external servers.
- You can clear all stored data at any time via the extension's settings or by uninstalling it.

This permission is requested solely to ensure the extension continues to operate reliably as your locally stored statistics and preferences grow over time.

---

## 6. User Control

You have full control over your data at all times:

- **Clear Data:** You can remove all stored data by uninstalling the extension or by using the built-in "Clear All Data" option.
- **Export/Import Data:** You may export or import all settings (including generation statistics and custom style values) for backup or to transfer to another device.
- **Reset Styles:** The "Reset to Defaults" button in the Custom Style panel clears any uploaded background image and all custom color/font choices without requiring a full data wipe.
- **Local Management:** You may modify or reset preferences through your browser settings.

---

## 7. Permissions

The S.AI Toolkit Extension requires the following browser permissions:

- **storage** – to save user preferences and local statistics.
- **unlimitedStorage** – to allow storage of data beyond the default 5 MB limit, all locally.
- **scripting** – to modify elements on supported pages and display metrics.
- **webRequest / webRequestBlocking (if applicable)** – to observe API responses locally within the browser for statistical display and export features.

These permissions are used **only within your browser** and **do not enable any external data collection**.

---

## 8. Changes to This Privacy Policy

We may update this Privacy Policy periodically.  
Updates will be posted on this page with a revised effective date.  
Continued use of the extension after updates indicates acceptance of the revised terms.

| Version | Date | Summary of changes |
|---------|------|--------------------|
| 1.4 | 2026-06-03 | Added section 1.4 (Custom Background Image); updated sections 1.2, 2, 5, and 6 to reflect custom style values storage, background image handling, Hide Creator Name toggle, export/import of all settings, and Reset to Defaults control. |
| 1.3 | 2026-05-05 | Added section 1.3 (Message Recovery opt-in feature) with full detail on capture scope, storage limits, eviction, and transmission policy. |

---

## 9. Contact Us

If you have any questions about this Privacy Policy or your data, please contact us through:  
📧 **GitHub:** [https://github.com/OnyxMizuna/SAI-Toolkit/issues](https://github.com/OnyxMizuna/SAI-Toolkit/issues)

---

## 10. Compliance and Data Protection

The S.AI Toolkit Extension complies with applicable privacy and data protection laws, including:

- **General Data Protection Regulation (GDPR)**  
- **California Consumer Privacy Act (CCPA)**  

Because no personal or identifiable data is collected, no data subject access, correction, or deletion requests are required.

---

## 11. Additional Notes

- **No Personal Identifiable Information (PII):** The extension does not collect, store, or transmit personal account data, credentials, or payment information. The opt-in Message Recovery feature locally stores the user's own typed chat message text — and only on send failure, see section 1.3 — but does not transmit it anywhere.
- **Browser Context Only:** All processing occurs within the browser, under user-granted permissions.  
- **Transparency:** The extension's source code and behavior are transparent to the user at all times.

---

✅ **Summary:**  
This policy clearly communicates that all processing is local, no data is shared or transmitted externally, and users have complete control. The single feature that touches message content (Message Recovery) is opt-in, off by default, never transmits, and exists to prevent loss of user-typed text when SpicyChat's chat API fails. Custom Style values (including any uploaded background image) are stored locally as user preferences and are never transmitted. All other features — including Hide Creator Name, Chat Name in Title, model change highlighting, and auto-regeneration — operate entirely on locally available page data and store only preference flags.  
It meets Chrome Web Store **User Data Privacy Policy** and **Manifest V3** standards for transparency and limited data use.
