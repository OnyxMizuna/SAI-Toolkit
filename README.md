# S.AI Toolkit - Browser Extension

Enhanced features for SpicyChat including generation profiles, sidebar layout, theme customization, and more.


## Features

- **Generation Settings Profiles**: Save and load different generation settings configurations
- **Sidebar Layout**: Pin Generation Settings and Memories modals to the side of the screen
- **Appearance Overrides**: Optional Light/Dark message backgrounds, button hover colors, custom chat backgrounds and layout details. Native SpicyChat Chat Appearance handles retired Classic Style and formatting options.
- **Hide "For You" Characters**: Automatically hide "For You" tagged characters on the main page
- **Page Jump**: Click pagination "..." to jump directly to any page number
- **Generation Stats**: Display model info and timestamps on bot messages
- **Toolkit Settings**: Access all features through a unified settings modal
- **Chat Export**: Export your current conversation as JSON or HTML (with images embedded). Paginated history export shows progress and supports cancellation; failed or stalled pagination is reported rather than silently saving partial history.
- **NSFW Mode Toggle**: Toggle NSFW image mode directly from the chat UI; state is stored locally and never transmitted
- **Message Recovery** *(opt-in, off by default)*: When SpicyChat's chat backend fails (502, CORS, network drop, timeout) the message you typed is normally lost — the input clears the moment you press Send and only an "Oops!" banner remains. With this enabled, the extension captures the outgoing text at send time, persists it locally **only if the send fails**, and shows a "Recover message" button next to SpicyChat's "Resubmit" button so you can restore your message into the input field. Captured text never leaves your browser. Toggle in the Features tab of the S.AI Settings modal.
- **Import/Export Statistics**: Backup or restore your generation statistics and settings with one click


### Performance

The extension is optimized for minimal performance impact:
- **Smart Caching**: 5-second cache with 70% reduction in storage I/O
- **Finalized Stats Tracking**: 95% reduction in storage reads for existing messages
- **Debounced Observers**: Mutation observers with 150ms debounce prevent redundant processing
- **Early Exit Patterns**: Skip irrelevant DOM mutations immediately
- **Single-Pass Algorithms**: Combined relevance and action checks in one loop

## Installation

### Firefox
1. Download the extension folder
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" → "Load Temporary Add-on"
4. Select the `manifest.json` file from the extension folder
5. The extension will be active on spicychat.ai

### Chrome/Edge
1. Download the extension folder
2. In a separate working copy, copy `manifest.chrome.json` over `manifest.json` (MV3). Then open Chrome/Edge and navigate to `chrome://extensions/` or `edge://extensions/`.
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the extension folder
6. The extension will be active on spicychat.ai

## Development

extension/

### File Structure
```
extension/
├── manifest.json           # Firefox MV2 manifest
├── manifest.firefox.json   # Matching alternate Firefox MV2 manifest
├── manifest.chrome.json    # Chrome/Edge MV3 manifest
├── background.js           # Background service worker
├── content.js              # Main content script (injected into pages)
├── storage-wrapper.js      # Storage API wrapper (cross-browser)
├── xhr-intercept.js        # Injected script for network interception (page context)
├── page-context.js         # Injected script for debug/utility functions (page context)
├── popup.html              # Settings popup UI
├── popup.css               # Settings popup styling
├── rules.json              # Feature rules and toggles
├── privacy.md              # Privacy policy (local only)
├── README.md               # This documentation
├── icons/                  # Extension icons
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── ... (other support files)
```

### Building
```bash
# Test in Firefox
web-ext run --source-dir=extension/

# Build for Firefox
web-ext build --source-dir=extension/

# Test in Chrome/Edge (in a separate copy)
# Copy manifest.chrome.json to manifest.json, then Load unpacked
```

## Migration from Userscript

This extension is converted from the Tampermonkey userscript. Key differences:

- Uses `browser.storage.local` instead of `GM_getValue`/`GM_setValue`
- Unlimited storage capacity (no 10MB limit)
- Native browser integration
- Proper extension popup for settings
- Better performance and security


## Storage & Privacy

The extension uses `browser.storage.local` with unlimited storage permission, allowing you to:
- Store unlimited generation profiles
- Cache character and conversation data
- Export and import chat history and statistics (all local, never sent externally)
- Store large amounts of settings and preferences
- Persist NSFW mode and other feature toggles locally

**Privacy:**
- Settings and statistics are stored locally by default. Optional Google Drive synchronization and backups transmit selected data to the user's Google Drive account.
- No personal or message content is collected or sent to any server
- See `privacy.md` for full details


## Permissions

- `storage`: Store settings, profiles, statistics, and export data
- `unlimitedStorage`: Remove storage limits for profiles and data
- `*://spicychat.ai/*`: Access and enhance SpicyChat pages
- `scripting` (if required): Modify page UI and inject features
- `webRequest` / `webRequestBlocking` (if required): Observe API responses for local statistics and export features


## License

Same as the original userscript project. See LICENSE for details.


## Credits

- Original userscript: OnyxMizuna
- Classic theme CSS: MssAcc (Discord)

## Optional extension interoperability

Toolkit publishes `data-sai-toolkit-capabilities` on the document root (JSON, `schemaVersion: 1`, `version`, `features` booleans). Listen for `sai-toolkit-capabilities-changed` and reread the attribute. The fields express configured feature ownership, not a guarantee of rendering on every route. Profiles are effective when saved profiles exist or the legacy force-enable flag is set. Color-specific flags reflect the active native Light/Dark theme; no stored colors, images, profiles, messages or credentials are exposed. Missing or unknown schema means unknown capability. This interface is informational, not a trust or security boundary, and Toolkit does not depend on QoL.
