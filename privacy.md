# Privacy Policy for S.AI Toolkit Extension

**Effective Date:** November 5, 2025  
**Version:** 1.1  

Thank you for using the **S.AI Toolkit Extension**. Your privacy is important to us.  
This Privacy Policy explains how we collect, use, and protect your data when you use our browser extension.

---

## 1. Data Collection

The S.AI Toolkit Extension collects and processes limited metadata necessary to provide its functionality.  
No personal information or message content is collected.

### 1.1 Data Observed Automatically

**Local API Observation:**  
The extension observes certain API responses within your browser (such as `GET /messages` and `POST /chat`) to extract metadata for visualization and debugging purposes. This includes:

- `conversation_id`  
- `message_id`  
- `inference_model`  
- `inference_settings`  
- `createdAt` timestamps  
- roles (bot/user) and related message metadata  

This observation occurs **only within your local browser environment**.  
The extension does **not** transmit, log, or send any data externally.

### 1.2 Data Stored Locally

The extension stores limited information locally using the browser’s `storage.local` API:

- **User Preferences:** Layout, theme, and interface customization settings.  
- **Generation Statistics:** Metadata about message generation (e.g., model type, token count, temperature, top_p, top_k, timestamps) for debugging and display purposes.  

All stored data remains **local to your device**.

---

## 2. Data Usage

Collected data is used solely for the following purposes:

- **Display Generation Statistics:** To provide insights into message generation parameters and performance.  
- **Customization:** To enable and manage user-selected interface features.  
- **Debugging:** To assist users in exporting, importing, or reviewing local statistics for troubleshooting.

---

## 3. Data Sharing

The S.AI Toolkit Extension **does not share any data** with third parties.  
All data remains on your device and is processed entirely within your browser.  
There is **no data transmission, collection, or exfiltration** to any external servers or services.

---

## 4. Data Security

We take reasonable measures to protect your local data:

- **Local Storage Only:** All information is stored using the browser’s `storage.local` API.  
- **No External Transmission:** The extension does not communicate with any remote servers.  
- **Limited Scope:** Only metadata necessary for display and debugging is processed.

---

## 5. Data Storage and Unlimited Storage Permission

The **S.AI Toolkit Extension** uses the browser’s `storage.local` API to save user preferences, configuration profiles, and generation statistics locally on your device.  
Over time, this data (such as conversation metadata, model settings, and generation records) may grow beyond Chrome’s default 5 MB limit.

To prevent data loss and ensure smooth functionality, the extension requests the **`unlimitedStorage`** permission.  
This permission allows the extension to store more than 5 MB of data **locally only** — it **does not** enable access to additional system resources or external data, nor does it transmit any information outside your browser.

Key points:
- All information remains **fully local** on your device.  
- No personal or identifiable data is collected.  
- No data is shared, synced, or sent to any external servers.  
- You can clear all stored data at any time via the extension’s settings or by uninstalling it.

This permission is requested solely to ensure the extension continues to operate reliably as your locally stored statistics and preferences grow over time.

---

## 6. User Control

You have full control over your data at all times:

- **Clear Data:** You can remove all stored data by uninstalling the extension or by using the built-in “Clear All Data” option.  
- **Export/Import Data:** You may export or import generation statistics for backup or debugging.  
- **Local Management:** You may modify or reset preferences through your browser settings.

---

## 7. Permissions

The S.AI Toolkit Extension requires the following browser permissions:

- **storage** – to save user preferences and local statistics.  
- **unlimitedStorage** – to allow storage of data beyond the default 5 MB limit, all locally.  
- **scripting** – to modify elements on supported pages and display metrics.  
- **webRequest / webRequestBlocking (if applicable)** – to observe API responses locally within the browser for statistical display.  

These permissions are used **only within your browser** and **do not enable any external data collection**.

---

## 8. Changes to This Privacy Policy

We may update this Privacy Policy periodically.  
Updates will be posted on this page with a revised effective date.  
Continued use of the extension after updates indicates acceptance of the revised terms.

---

## 9. Contact Us

If you have any questions about this Privacy Policy or your data, please contact us at:  
📧 **Email:** [support@sai-toolkit.com](mailto:support@sai-toolkit.com)

---

## 10. Compliance and Data Protection

The S.AI Toolkit Extension complies with applicable privacy and data protection laws, including:

- **General Data Protection Regulation (GDPR)**  
- **California Consumer Privacy Act (CCPA)**  

Because no personal or identifiable data is collected, no data subject access, correction, or deletion requests are required.

---

## 11. Additional Notes

- **No Personal Identifiable Information (PII):** The extension does not collect, store, or transmit any personal data.  
- **Browser Context Only:** All processing occurs within the browser, under user-granted permissions.  
- **Transparency:** The extension’s source code and behavior are transparent to the user at all times.

---

✅ **Summary:**  
This policy clearly communicates that all processing is local, no data is shared or transmitted externally, and users have complete control.  
It meets Chrome Web Store **User Data Privacy Policy** and **Manifest V3** standards for transparency and limited data use.