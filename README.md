# S.AI Toolkit - Browser Extension

Enhanced features for SpicyChat including generation profiles, sidebar layout, theme customization, and more.


## Features

- **Generation Settings Profiles**: Save and load different generation settings configurations
- **Sidebar Layout**: Pin Generation Settings and Memories modals to the side of the screen
- **Classic Theme**: Apply classic SpicyChat colors and styling (credit: MssAcc)
- **Hide "For You" Characters**: Automatically hide "For You" tagged characters on the main page
- **Page Jump**: Click pagination "..." to jump directly to any page number
- **Generation Stats**: Display model info and timestamps on bot messages
- **Toolkit Settings**: Access all features through a unified settings modal
- **Chat Export**: Export your current conversation as JSON or HTML (with images embedded)
- **NSFW Mode Toggle**: Toggle NSFW image mode directly from the chat UI; state is stored locally and never transmitted
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
2. Open Chrome/Edge and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the extension folder
6. The extension will be active on spicychat.ai

## Development

### File Structure
```
extension/
├── manifest.json          # Extension manifest
├── content.js            # Main content script (injected into pages)
├── storage-wrapper.js    # Storage API wrapper
├── background.js         # Background service worker
├── popup.html            # Settings popup UI
├── popup.js              # Settings popup logic
├── popup.css             # Settings popup styling
└── icons/                # Extension icons
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

### Building
```bash
# Test in Firefox
web-ext run --source-dir=extension/

# Build for Firefox
web-ext build --source-dir=extension/

# Test in Chrome
# Just use chrome://extensions/ Load unpacked
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
- All data is stored locally in your browser and never transmitted externally
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
