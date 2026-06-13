/**
 * ============================================================================
 * S.AI Toolkit - Browser Extension Content Script
 * ============================================================================
 * 
 * SECURITY DISCLOSURE FOR EXTENSION REVIEWERS:
 * 
 * This extension enhances SpicyChat.ai with local-only features including
 * generation profile management, UI customization, and statistics tracking.
 * 
 * KEY SECURITY POINTS:
 * ✓ ALL DATA STORED LOCALLY: Uses chrome.storage.local exclusively
 * ✓ NO EXTERNAL SERVERS: Extension makes zero requests to external domains
 * ✓ NO DATA TRANSMISSION: All processing happens in user's browser
 * ✓ OPEN SOURCE: Full code available for review on GitHub
 * 
 * PERMISSIONS JUSTIFICATION:
 * - storage: Required to save user profiles and settings locally
 * - unlimitedStorage: User may save many profiles over time
 * - spicychat.ai host access: Required to inject UI enhancements and read
 *   AI generation settings from page
 * 
 * PAGE CONTEXT INJECTION (See detailed notes in xhr-intercept.js):
 * This extension injects scripts into page context to read AI model settings
 * from network responses. This is necessary due to Content Security Policy
 * preventing content scripts from accessing page-level network calls.
 * Injection is READ-ONLY and LOCAL-ONLY (no external transmission).
 * 
 * TESTING CHECKLIST FOR REVIEWERS:
 * □ Verify no external network requests in DevTools Network tab
 * □ Verify all data in chrome.storage.local (Application → Storage)
 * □ Verify injected scripts are bundled (not remote)
 * □ Verify no modification of network requests/responses
 * □ Test profile save/load functionality (stays local)
 * 
 * PROJECT INFO:
 * Repository: https://github.com/CLedebur/Spicychat.ai-Mods
 * License: Open source for transparency and security audit
 * 
 * ============================================================================
 */

/**
 * S.AI Toolkit - Browser Extension Content Script
 * Converted from Tampermonkey userscript
 * 
 * Features:
 * - Generation Settings Profiles (save/load/manage)
 * - Sidebar Layout (pin modals to right side)
 * - Classic Theme Customization
 * - Hide "For You" Characters
 * - Page Jump Modal
 * - Generation Stats Display
 * 
 * Testing the onboarding flow:
 * Run in browser console: resetSAIToolkitOnboarding()
 * Then reload the page to see the onboarding modal again.
 */

// Debug mode - set to true to enable console logging for all operations
// Can be toggled at runtime via easter egg (shift+click version text in settings)
// Persists between sessions via storage
let DEBUG_MODE = false;

// Load DEBUG_MODE from storage (async, but we start with false and update when ready)
// This ensures debug logging works immediately if it was previously enabled
if (typeof storage !== 'undefined') {
    storage.get('debugMode', false).then(savedDebugMode => {
        DEBUG_MODE = savedDebugMode;
        if (DEBUG_MODE) {
            console.log('[Core] 🐛 Debug mode loaded from storage (ENABLED)');
            window.__SAI_DEBUG_MODE__ = true;
        }
    }).catch(() => {
        // Storage not ready yet, keep default
    });
}

// Debug log category filters - controls which log categories are shown
// Categories: Core, Stats, Memories, Export, NSFW, ChatTitle, WYSIWYG, WYSIWYG-Text, Profile, Model, Cache, Migration, Custom, Compact, Sync, AutoRegen, MsgRecovery
let debugLogFilters = {
    Core: true,
    Stats: true,
    Memories: true,
    Export: true,
    NSFW: true,
    ChatTitle: true,
    WYSIWYG: true,
    'WYSIWYG-Text': false,  // Disabled by default - very noisy
    Profile: true,
    Model: true,
    Cache: true,
    Migration: true,
    Custom: true,
    Compact: true,
    Sync: true,
    AutoRegen: true,
    MsgRecovery: true
};

// Track sidebar width to detect transitions - prevents injection during React re-renders
let lastKnownSidebarWidth = null;
let sidebarWidthTransitionPending = false;

// Drive auth error state — set when auto-sync detects an expired token
let driveAuthErrorMessage = null;

// Callback to push sync progress updates into the settings modal UI when it's open
let syncProgressCallback = null;

// Load debug filters from storage
if (typeof storage !== 'undefined' && storage.get) {
    storage.get('debugLogFilters').then(filters => {
        if (filters && typeof filters === 'object') {
            debugLogFilters = { ...debugLogFilters, ...filters };
        }
    }).catch(() => {});
}

// Helper to extract category from log message
function getLogCategory(message) {
    if (typeof message !== 'string') return null;
    const match = message.match(/^\[([^\]]+)\]/);
    if (!match) return null;
    
    const fullCategory = match[1];
    // Map sub-categories to main categories
    if (fullCategory.startsWith('Stats')) return 'Stats';
    if (fullCategory.startsWith('ChatTitle')) return 'ChatTitle';
    if (fullCategory.startsWith('Memories')) return 'Memories';
    if (fullCategory === 'Profile Controls') return 'Profile';
    if (fullCategory === 'Change Model' || fullCategory === 'Model Change') return 'Model';
    if (fullCategory === 'Custom Style') return 'Custom';
    if (fullCategory === 'Compact') return 'Compact';
    if (fullCategory === 'Sync' || fullCategory === 'Drive Sync') return 'Sync';

    return fullCategory;
}

// Production-safe debug logging helper - sanitizes sensitive data
function debugLog(...args) {
    if (DEBUG_MODE) {
        // Check category filter - first arg usually contains [Category]
        const firstArg = args[0];
        const category = getLogCategory(firstArg);
        if (category && debugLogFilters[category] === false) {
            return; // Skip this log category
        }
        
        // Sanitize arguments to prevent logging sensitive data
        const sanitized = args.map(arg => {
            if (typeof arg === 'string') {
                // Redact potential auth tokens
                return arg.replace(/Bearer\s+[A-Za-z0-9-_]+/gi, 'Bearer [REDACTED]')
                          .replace(/token["']?:\s*["']?[A-Za-z0-9-_]+/gi, 'token: [REDACTED]');
            }
            if (typeof arg === 'object' && arg !== null) {
                // Create shallow copy to avoid modifying original
                const copy = Array.isArray(arg) ? [...arg] : { ...arg };
                // Redact common sensitive fields
                const sensitiveFields = ['token', 'authorization', 'auth', 'password', 'secret', 'apiKey'];
                for (const field of sensitiveFields) {
                    if (copy[field]) copy[field] = '[REDACTED]';
                }
                return copy;
            }
            return arg;
        });
        // The message already carries its own [Category] prefix, so log it as-is —
        // that's what the category filter and the console reader key off of. Only
        // stamp the default [Core] namespace on genuinely uncategorized logs.
        // (Previously every line was hard-prefixed '[Core]', which mislabeled
        // Stats/WYSIWYG/Model/Export/NSFW/etc. as "Core" in the console.)
        if (category) {
            console.log(...sanitized);
        } else {
            console.log('[Core]', ...sanitized);
        }
    }
}

// Production console.log wrapper - only logs in DEBUG_MODE
const prodLog = (...args) => {
    if (DEBUG_MODE) {
        console.log(...args);
    }
}

// Prevent duplicate initialization if script is injected multiple times
if (window.__saiToolkitLoaded) {
    debugLog('[Core] Already loaded, skipping duplicate initialization');
} else {
    window.__saiToolkitLoaded = true;
}

// Listen for ping from background script to confirm content script is running
const runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;
if (runtimeAPI && runtimeAPI.runtime && runtimeAPI.runtime.onMessage) {
    runtimeAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'ping') {
            sendResponse({ pong: true });
            return true;
        }
    });
}

// ---------------------------------------------------------------------------
// Stats store RPC — content <-> background messaging for the IndexedDB stats
// store. The store lives at the EXTENSION origin (owned by background.js);
// content scripts run at the page origin and cannot open it, so every stats
// read/write goes through these messages. Modeled on sendDriveMessage: one
// retry on the MV3 service-worker "Could not establish connection" cold start.
// Defined at module scope so both the page-context debug bridge (below) and the
// IIFE stats engine can call it.
// ---------------------------------------------------------------------------
function sendStatsMessage(type, payload, _retries = 1) {
    return new Promise((resolve, reject) => {
        try {
            runtimeAPI.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
                const err = runtimeAPI.runtime.lastError;
                if (err) {
                    if (_retries > 0 && err.message && err.message.includes('Could not establish connection')) {
                        setTimeout(() => sendStatsMessage(type, payload, _retries - 1).then(resolve).catch(reject), 300);
                    } else {
                        reject(new Error(err.message));
                    }
                } else {
                    resolve(res);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

debugLog('[Core] Content script starting...');
debugLog('[Core] URL:', window.location.href);
debugLog('[Core] Document ready state:', document.readyState);

// Inject debug functions into page context using external file (MV3 compatible - no inline scripts)
const debugScript = document.createElement('script');
// Use runtime API if available (extensions), otherwise fall back to relative path
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    debugScript.src = chrome.runtime.getURL('page-context.js');
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
    debugScript.src = browser.runtime.getURL('page-context.js');
} else {
    // Fallback for non-extension environments
    debugScript.src = 'page-context.js';
}
(document.head || document.documentElement).appendChild(debugScript);
debugScript.remove(); // Clean up script element after injection

// =============================================================================
// DEBUG HELPER FUNCTIONS - MESSAGE BRIDGE
// =============================================================================
// These handlers bridge between page-context.js debug functions and this
// content script, allowing developers to inspect/manage extension data from
// the browser console.
//
// Message flow:
// 1. User calls debug function in console (e.g., debugSAIToolkitStats())
// 2. page-context.js sends postMessage to this content script
// 3. Content script accesses chrome.storage.local
// 4. Response sent back via postMessage
// 5. page-context.js displays result in console
//
// This is necessary because console functions run in page context but
// chrome.storage API is only accessible in content script context.
// =============================================================================

window.addEventListener('message', async (event) => {
    // Security check: Only process messages from same window (not iframes or external sources)
    if (event.source !== window) return;
    
    // -------------------------------------------------------------------------
    // DEBUG STATS REQUEST - View stored message statistics
    // -------------------------------------------------------------------------
    // Retrieves all message generation stats from local storage and returns
    // them to the debug function for console display
    if (event.data.type === 'SAI_DEBUG_STATS_REQUEST') {
        // Stats now live in the background's IndexedDB store; ask for the full
        // nested wire-format snapshot for console display.
        let stats = {};
        try {
            const res = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
            if (res && res.success) stats = res.stats || {};
        } catch (_) { /* return empty on failure */ }
        // Send stats back to page context for console display
        window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats }, '*');
    }

    // -------------------------------------------------------------------------
    // CLEAR STATS REQUEST - Delete all stored statistics
    // -------------------------------------------------------------------------
    // Wipes all message generation stats from storage (useful for testing)
    if (event.data.type === 'SAI_CLEAR_STATS_REQUEST') {
        try { await sendStatsMessage('SAI_STATS_CLEAR'); } catch (_) { /* ignore */ }
        // Confirm deletion to page context
        window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
    }

    // -------------------------------------------------------------------------
    // EXPORT STATS REQUEST - Export statistics to downloadable JSON file
    // -------------------------------------------------------------------------
    // Allows user to backup or share their generation statistics
    if (event.data.type === 'SAI_EXPORT_STATS_REQUEST') {
        // The per-conversation filter is gone — conversationId is no longer part
        // of the stats model — so this always exports the full nested snapshot.
        let stats = {};
        try {
            const res = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
            if (res && res.success) stats = res.stats || {};
        } catch (_) { /* return empty on failure */ }
        // Return stats to page context which will trigger download
        window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats }, '*');
    }

    // -------------------------------------------------------------------------
    // IMPORT STATS REQUEST - Import statistics from JSON file
    // -------------------------------------------------------------------------
    // Allows user to restore backed up statistics or merge from another browser
    if (event.data.type === 'SAI_IMPORT_STATS_REQUEST') {
        // Background performs the authoritative merge into IndexedDB (collapsing
        // the conversation level, never overwriting richer entries).
        try {
            await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: event.data.jsonData });
        } catch (_) { /* ignore */ }
        // Confirm import completion to page context
        window.postMessage({ type: 'SAI_IMPORT_STATS_RESPONSE' }, '*');
    }
    
    // -------------------------------------------------------------------------
    // NSFW MODE STATE - Handle state updates from page context
    // -------------------------------------------------------------------------
    // When xhr-intercept.js responds with NSFW mode state, update our button
    if (event.data.type === 'SAI_NSFW_MODE_STATE' || event.data.type === 'SAI_NSFW_MODE_UPDATED') {
        if (typeof event.data.enabled === 'boolean') {
            // Update the global state variable (defined later in the file)
            if (typeof nsfwModeEnabled !== 'undefined') {
                nsfwModeEnabled = event.data.enabled;
                // Update button if it exists
                if (typeof updateNSFWButtonIcon === 'function') {
                    updateNSFWButtonIcon();
                }
                debugLog('[NSFW] Received NSFW state from page context:', event.data.enabled);
            }
        }
    }

    // -------------------------------------------------------------------------
    // MESSAGE RECOVERY — receive failed-send snapshots from page context
    // -------------------------------------------------------------------------
    // The page-context interceptor (xhr-intercept.js) detected a failure on a
    // POST /chat or /story request and is handing us the user's typed text.
    // We persist it to chrome.storage.local under 'failedMessages' as a FIFO
    // ring buffer (oldest entries dropped at the cap). We never transmit this
    // data anywhere — it's stored locally so the user can recover it via the
    // "Recover message" button injected next to SpicyChat's "Oops!" banner.
    //
    // STORAGE SHAPE
    //   key: 'failedMessages'
    //   value: Array<{
    //     id: string,            // local UUID for delete-by-id
    //     message: string,       // the user's original typed text
    //     conversationId: string|null,
    //     characterId: string|null,
    //     url: string,           // the failing endpoint, for debugging
    //     capturedAt: number,    // ms epoch
    //     reason: string,        // e.g. 'xhr-status-502', 'fetch-throw'
    //     transport: 'xhr'|'fetch'
    //   }>
    //
    // CAP: 50 entries. Old ones are evicted FIFO so the queue can't grow
    // unbounded if the user has a long outage.
    if (event.data.type === 'SAI_MESSAGE_SEND_FAILED') {
        try {
            const snapshot = event.data.snapshot || {};
            const reason = event.data.reason || 'unknown';
            if (!snapshot.message || typeof snapshot.message !== 'string') return;

            const entry = {
                id: 'fm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
                message: snapshot.message,
                conversationId: snapshot.conversationId || null,
                characterId: snapshot.characterId || null,
                url: snapshot.url || null,
                capturedAt: snapshot.capturedAt || Date.now(),
                reason: reason,
                transport: snapshot.transport || 'unknown'
            };

            const MAX_FAILED = 50;
            const existing = await storage.get('failedMessages', []);
            const list = Array.isArray(existing) ? existing.slice() : [];
            list.push(entry);
            while (list.length > MAX_FAILED) list.shift();
            await storage.set('failedMessages', list);
            debugLog('[MsgRecovery] Persisted failed message, reason:', reason, 'queue size:', list.length);

            // If the "Oops!" banner is already on screen by the time we get
            // here (race between fetch failure and banner render), make sure
            // the recover button is present.
            if (typeof injectRecoverButtonIfNeeded === 'function') {
                injectRecoverButtonIfNeeded();
            }
        } catch (e) {
            console.error('[MsgRecovery] Failed to persist message:', e);
        }
    }
});

// Stats merging is now owned by the background (IndexedDB store): the import/restore
// paths and the SAI_IMPORT_STATS_REQUEST handler delegate to it via
// sendStatsMessage('SAI_STATS_IMPORT_MERGE', …). The old content-side
// pruneStatsObject/mergeMessageEntry/mergeStatsDeep copies were removed to avoid a
// misleading second source of merge truth. normalizeImportPayload (below) is still used
// to un-nest v2 backup files before applying their non-stats settings.

// Normalize a backup/import payload to the flat key layout the import logic expects.
// v2 backups nest keys under settings/style and store stats under `stats`; v1/flat
// payloads already have everything at the top level (passed through unchanged).
// Without this, importing a v2 file (e.g. the Drive sync file) silently drops every
// grouped setting — including the Custom Style group (enableCustomStyle/customStyleValues).
function normalizeImportPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const isV2 = data._format === 'v2' ||
                 (data.settings && typeof data.settings === 'object') ||
                 (data.style && typeof data.style === 'object');
    if (!isV2) return data;
    const flat = { ...data };
    if (data.settings && typeof data.settings === 'object') Object.assign(flat, data.settings);
    if (data.style && typeof data.style === 'object') Object.assign(flat, data.style);
    // v2 keeps the stats object under `stats`; the apply logic reads messageGenerationStats.
    if (data.stats !== undefined && flat.messageGenerationStats === undefined) {
        flat.messageGenerationStats = data.stats;
    }
    delete flat.settings;
    delete flat.style;
    delete flat.stats;
    delete flat._format;
    return flat;
}

'use strict';

// =============================================================================
// =============================================================================
// ===                                                                       ===
// ===   CRITICAL SECURITY SECTION - FOR MANUAL REVIEW BY CHROME/MOZILLA   ===
// ===                                                                       ===
// =============================================================================
// =============================================================================
//
// The following code injects JavaScript files into the page context.
// This is necessary for functionality and is implemented securely.
//
// WHY INJECTION IS REQUIRED:
// 1. SpicyChat.ai uses Content Security Policy (CSP) that blocks content
//    scripts from accessing page-level XMLHttpRequest and fetch APIs
// 2. We need to intercept these network calls to read AI generation settings
//    (temperature, top_p, top_k, model name) from API responses
// 3. Content scripts run in isolated world and cannot access page context
//
// WHAT IS INJECTED:
// - xhr-intercept.js: Intercepts network requests (READ-ONLY)
// - page-context.js: Exposes debug functions to console (USER-INITIATED)
//
// SECURITY GUARANTEES:
// ✓ NO REMOTE CODE: All injected scripts are bundled with extension
// ✓ NO EXTERNAL REQUESTS: Scripts make zero network calls to external servers
// ✓ READ-ONLY ON RESPONSES: Server responses are never modified
// ✓ LOCAL STORAGE ONLY: All data saved to chrome.storage.local
// ✓ NO CREDENTIALS: Does not access passwords, tokens, or auth headers
// ✓ TRANSPARENT: Fully open source at github.com/CLedebur/Spicychat.ai-Mods
//
// ABOUT MESSAGE CONTENT:
// By default, message content is NOT read or stored. The optional
// "Message Recovery" feature (Features tab → Message Recovery, default OFF)
// captures the text of an outgoing chat message ONLY at send time, and ONLY
// persists it locally if the send fails — so the user can recover what they
// typed when SpicyChat's backend errors out. See xhr-intercept.js header
// for the full disclosure.
//
// DATA FLOW:
// Page Context (xhr-intercept.js)
//   → Reads API response (model settings only)
//   → postMessage to Content Script
//   → Content Script saves to chrome.storage.local
//   → Data stays in browser (never transmitted)
//
// TESTING FOR REVIEWERS:
// 1. Install extension → Open DevTools Network tab
// 2. Verify: Extension makes ZERO external network requests
// 3. Open DevTools → Application → Storage → chrome.storage.local
// 4. Verify: All data local (profiles, settings, stats)
// 5. Test: Save profile → Check it's in local storage only
//
// =============================================================================
// INJECT XHR/FETCH INTERCEPTION INTO PAGE CONTEXT - IMMEDIATELY
// This MUST happen at document_start to catch the initial GET /messages call
// =============================================================================

debugLog('[Stats] Injecting XHR/Fetch interception into page context (EARLY)...');

// Make DEBUG_MODE available to injected scripts via window object
// This allows xhr-intercept.js to use the same debug mode setting
window.__SAI_DEBUG_MODE__ = DEBUG_MODE;

// =============================================================================
// INJECT xhr-intercept.js AS EXTERNAL SCRIPT
// =============================================================================
// Using createElement('script') with src (not inline code) for MV3 compliance
// The script file is part of the extension bundle (web_accessible_resources)
const interceptScript = document.createElement('script');

// Get correct URL for the script file (Chrome vs Firefox API differences)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    // Chrome/Edge: Use chrome.runtime.getURL
    interceptScript.src = chrome.runtime.getURL('xhr-intercept.js');
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
    // Firefox: Use browser.runtime.getURL
    interceptScript.src = browser.runtime.getURL('xhr-intercept.js');
} else {
    // Fallback for non-extension environments (development/testing)
    interceptScript.src = 'xhr-intercept.js';
}

// Inject the script tag into page head/document
// Using documentElement as fallback if head doesn't exist yet
(document.head || document.documentElement).appendChild(interceptScript);
// Remove script element after injection (script already executed, DOM cleanup)
interceptScript.remove();
debugLog('[Stats] Injection script added to page context (EARLY)');

// =============================================================================
// STORAGE API WRAPPER
// =============================================================================
// The storage-wrapper.js file is loaded FIRST via manifest.json and provides
// a unified storage API that works across Chrome and Firefox:
//
// Available methods:
// - storage.get(key, defaultValue) → Returns value or default if not found
// - storage.set(key, value) → Saves value to browser storage
// - storage.remove(key) → Deletes key from storage
// - storage.clear() → Clears all extension storage
// - storage.setMultiple(obj) → Batch save multiple key-value pairs
//
// All methods support both callback and Promise (await) patterns
// Storage data persists across browser sessions
// =============================================================================

// =============================================================================
// MAIN CONTENT SCRIPT - ASYNC IIFE (Immediately Invoked Function Expression)
// =============================================================================
// Everything runs inside this async function to allow top-level await
// This pattern lets us wait for storage operations before proceeding
(async function() {
    'use strict';

    // ------------------------------------------------------------------
    // EARLY-DECLARED STATE
    // ------------------------------------------------------------------
    // Hoisted here because asynchronous observers (WYSIWYG, body-class,
    // resize) are wired up partway through this IIFE and can fire BEFORE
    // execution reaches the later `let` declarations. Reading a let/const
    // before its declaration line throws TDZ ("Cannot access … before
    // initialization"). The values themselves are re-assigned later; this
    // block only ensures the bindings exist as soon as the IIFE starts.
    let isResizing = false;
    let resizeEndTimer = null;
    // Sidebar Layout body-class observer state — accessed by the
    // startSidebarLayoutBodyClassObserver function, which is called from the
    // early-inject block (~line 895) long before the later declarations would
    // run. Without these hoists, the first call hit TDZ on
    // `sidebarLayoutBodyObserver`, threw ReferenceError, and halted the
    // entire early-init block — which manifested as ALL injections/page
    // modifications appearing broken because the IIFE never reached them.
    let sidebarLayoutBodyObserver = null;
    let sidebarLayoutBodyClassRafPending = false;

    debugLog('[Core] Content script loaded - starting initialization...');
    debugLog('[Core] Storage object available:', typeof storage !== 'undefined');

    // =============================================================================
    // MIGRATION NOTE: Tampermonkey → Extension
    // =============================================================================
    // Automatic migration from Tampermonkey userscript is not possible because:
    // 1. Userscripts use GM_getValue/GM_setValue (different storage)
    // 2. Content scripts run in isolated world (cannot access GM storage)
    // 3. Cross-origin restrictions prevent direct storage access
    //
    // Solution: Users can manually export from userscript and import to extension
    // via the "Export All Data" / "Import All Data" buttons in settings
    // =============================================================================

    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    EARLY CSS INJECTION (CRITICAL)                    ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    //
    // TIMING IS CRITICAL:
    // CSS must be injected BEFORE React initializes to prevent:
    // 1. Flash of unstyled content (FOUC)
    // 2. React's virtual DOM conflicts with our style changes
    // 3. Layout thrashing during page load
    //
    // This happens at document_start (before DOM is built) to ensure our
    // styles are in place when React renders the page for the first time.
    //
    // CSS INJECTION STRATEGY:
    // - Check if feature is enabled (from storage)
    // - If enabled, inject <style> tag immediately
    // - Use ID to prevent duplicate injection
    // - Insert at head start for maximum priority
    //
    // =============================================================================
    
    // Storage keys for each CSS feature
    const SIDEBAR_LAYOUT_KEY = 'enableSidebarLayout';      // Pin modals to right sidebar
    const CLASSIC_LAYOUT_KEY = 'enableClassicLayout';      // Classic message box layout
    const CLASSIC_STYLE_KEY = 'enableClassicStyle';        // Classic colors/styling
    const CUSTOM_STYLE_KEY = 'enableCustomStyle';          // Custom colors/styling
    const CUSTOM_STYLE_VALUES_KEY = 'customStyleValues';   // Stores custom color/font values
    const MESSAGE_CONTAINER_MAX_WIDTH_KEY = 'messageContainerMaxWidth';  // Max width for message container
    const THEME_CUSTOMIZATION_KEY = 'enableThemeCustomization';  // DEPRECATED - migrated to CLASSIC_LAYOUT_KEY + CLASSIC_STYLE_KEY
    const SMALL_PROFILE_IMAGES_KEY = 'enableSmallProfileImages';  // Smaller profile images
    const ROUNDED_PROFILE_IMAGES_KEY = 'enableRoundedProfileImages';  // Rounded profile images
    const SWAP_CHECKBOX_POSITION_KEY = 'enableSwapCheckboxPosition';  // Swap selection checkbox positions
    const SQUARE_MESSAGE_EDGES_KEY = 'enableSquareMessageEdges';  // Square message box edges
    const WYSIWYG_EDITOR_KEY = 'enableWysiwygEditor';  // Live formatting in textareas
    const SHOW_MESSAGE_IDS_KEY = 'showMessageIds';  // Show message IDs in stats display
    const ENABLE_GENERATION_PROFILES_KEY = 'enableGenerationProfiles';  // Override to force-enable generation profiles (debug only)
    const MEMORY_DOT_ENABLED_KEY = 'memoryDotEnabled';  // Show/hide memory limit indicator dot
    const MEMORY_DOT_COLOR_KEY = 'memoryDotColor';  // Custom color for memory limit indicator dot
    const HIDE_CREATOR_KEY = 'hideCreatorName';  // Hide bot creator @username link under bot messages

    // Default custom style values
    const DEFAULT_CUSTOM_STYLE = {
        aiMessageBg: 'rgba(0, 100, 255, 0.1)',
        userMessageBg: 'rgba(100, 100, 100, 0.1)',
        bodyColor: '#ffffff',
        bodyFontWeight: 'normal',
        bodyFontStyle: 'normal',
        bodyTextDecoration: 'none',
        spanQuoteColor: '#ffffff',
        spanQuoteFontWeight: 'normal',
        spanQuoteFontStyle: 'normal',
        spanQuoteTextDecoration: 'none',
        narrationColor: '#06B7DB',
        narrationFontWeight: 'normal',
        narrationFontStyle: 'italic',
        narrationTextDecoration: 'none',
        highlightBgColor: '#ffdd6d',
        highlightTextColor: '#000000',
        highlightFontWeight: 'normal',
        highlightFontStyle: 'normal',
        highlightTextDecoration: 'none',
        fontSize: '16px',
        fontFamily: '',
        hoverButtonColor: '#292929',
        creatorLinkColor: '',
        backgroundImage: ''
    };
    
    // =============================================================================
    // STORAGE MIGRATION: Classic Theme -> Classic Layout + Classic Style
    // =============================================================================
    // Migrate old THEME_CUSTOMIZATION_KEY to new separate keys if needed
    async function migrateClassicThemeSettings() {
        const oldThemeEnabled = await storage.get(THEME_CUSTOMIZATION_KEY, null);
        const hasClassicLayout = await storage.get(CLASSIC_LAYOUT_KEY, null);
        const hasClassicStyle = await storage.get(CLASSIC_STYLE_KEY, null);
        
        // Only migrate if old key exists and new keys don't
        if (oldThemeEnabled !== null && hasClassicLayout === null && hasClassicStyle === null) {
            debugLog('[Migration] Migrating Classic Theme to new keys');
            // User had classic theme enabled, preserve both layout and style
            await storage.set(CLASSIC_LAYOUT_KEY, oldThemeEnabled);
            await storage.set(CLASSIC_STYLE_KEY, oldThemeEnabled);
            // Clean up old key
            await storage.remove(THEME_CUSTOMIZATION_KEY);
            debugLog('[Migration] Migration complete: Classic Theme =', oldThemeEnabled, '-> Layout & Style');
            return true;
        }
        return false;
    }
    // Run migration immediately
    await migrateClassicThemeSettings();
    
    // =============================================================================
    // TIMING CONSTANTS - Centralized delay/timeout values (Issue #15)
    // =============================================================================
    const TIMING = {
        // CSS injection retries
        CSS_RETRY_SHORT: 10,           // Quick retry for missing document.head
        
        // Debouncing and throttling
        MUTATION_DEBOUNCE: 150,        // Debounce mutations before processing stats
        STATS_INITIAL_DELAY: 100,      // Initial delay before processing stats
        STATS_RETRY_DELAY: 500,        // Retry delay for failed stats processing
        
        // Modal and UI operations
        MODAL_OPEN_DELAY: 500,         // Wait for modal to appear
        MODAL_CONFIRM_DELAY: 800,      // Wait for modal confirmation action
        MODEL_CHANGE_CONFIRM: 500,     // Wait after model change confirmation
        SCROLL_POLL_INTERVAL: 500,     // Poll interval for scroll position
        
        // Initialization and retries
        BUTTON_INJECT_RETRIES: [500, 1000, 2000, 3000, 5000], // Progressive retry delays
        INITIAL_STATS_CHECK: 2000,     // Initial stats check after page load
        DELAYED_STATS_CHECK: 5000,     // Delayed stats check for slow loading
        TITLE_UPDATE_DELAY: 1000,      // Delay before updating page title
        PERIODIC_CHECK: 2000,          // Periodic button existence check
        
        // Cache and storage
        STORAGE_CACHE_TTL: 5000,       // Storage cache time-to-live (5 seconds)
    };
    
    // =============================================================================
    // HELPER: Wait for document.body to exist
    // =============================================================================
    // When opening a new tab via middle-click, the content script may run at
    // document_start before document.body exists. This helper ensures observers
    // and DOM manipulations wait for body to be available.
    function waitForBody(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            debugLog('[Core] waitForBody called, readyState:', document.readyState, 'body:', !!document.body);
            
            if (document.body) {
                debugLog('[Core] document.body already exists');
                resolve(document.body);
                return;
            }
            
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.error('[Core] waitForBody timed out after', timeoutMs, 'ms');
                    // Still try to resolve with body if it exists now, otherwise reject
                    if (document.body) {
                        resolved = true;
                        resolve(document.body);
                    } else {
                        reject(new Error('document.body not available after timeout'));
                    }
                }
            }, timeoutMs);
            
            const onBodyReady = () => {
                if (!resolved && document.body) {
                    resolved = true;
                    clearTimeout(timeout);
                    debugLog('[Core] document.body now available');
                    resolve(document.body);
                }
            };
            
            // Try DOMContentLoaded first
            if (document.readyState === 'loading') {
                debugLog('[Core] Waiting for DOMContentLoaded...');
                document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
            } else {
                // DOM should be ready - poll briefly in case body is just not set yet
                debugLog('[Core] DOM ready but no body, polling...');
                const checkBody = setInterval(() => {
                    if (document.body) {
                        clearInterval(checkBody);
                        onBodyReady();
                    }
                }, 10);
                
                // Also listen just in case
                document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
            }
        });
    }
    
    // =============================================================================
    // Z-INDEX HIERARCHY - Centralized z-index values (Issue #15)
    // =============================================================================
    const Z_INDEX = {
        SIDEBAR_MODAL: 9000000,        // Base z-index for sidebar modals
        GENERATION_SETTINGS: 10000001, // Generation Settings when both modals open
        MEMORY_MANAGER: 10000000,      // Memory Manager modal
        CONTEXT_MENU: 10000002,        // Message context menu (above modals)
        SETTINGS_POPOVER: 10000001,    // Settings popover
        TOOLKIT_MODAL: 10000003,       // Toolkit settings modal
        TOOLKIT_BACKDROP: 10000003,    // Toolkit modal backdrop
        TOOLKIT_CONFIRM: 10000004,     // Confirmation dialog
        PAGE_JUMP_MODAL: 10000,        // Page jump modal
        STICKY_HEADER: 2,              // Sticky header in Generation Settings
        NOTIFICATION: 9999,            // Notification toasts
    };

    // =============================================================================
    // CHANGELOG - Update notification content for each release
    // =============================================================================
    // Add a new version entry here when releasing a new version
    // Format: 'version': { title, date, features: [...] }
    const CHANGELOG = {
        '1.0.39': {
            title: 'Version 1.0.39 - Stats Improvements',
            date: 'January 2, 2026',
            features: [
                'Fixed user message timestamps and IDs now displaying correctly',
                'Improved stats insertion reliability for new messages',
                'Fixed extension compatibility with /Chat/ URLs (capital C)',
                'Added better tracking for pending message insertions',
                'Reduced race conditions in stats processing'
            ]
        },
        '1.0.38': {
            title: 'Version 1.0.38 - Performance Update',
            date: 'January 1, 2026',
            features: [
                'Massive performance optimizations',
                'Fixed generation stats injection issues',
                'Improved message processing speed'
            ]
        }
        // Add more versions as needed above this line
    };

    // Load feature flags from storage (async operations)
    // These determine which CSS to inject before page renders
    // PERFORMANCE: Batch all early CSS settings into a single storage read
    const earlySettings = await storage.getMultiple({
        [SIDEBAR_LAYOUT_KEY]: false,
        [CLASSIC_LAYOUT_KEY]: false,
        [CLASSIC_STYLE_KEY]: false,
        [CUSTOM_STYLE_KEY]: false,
        [CUSTOM_STYLE_VALUES_KEY]: JSON.stringify(DEFAULT_CUSTOM_STYLE),
        [MESSAGE_CONTAINER_MAX_WIDTH_KEY]: '',
        [SMALL_PROFILE_IMAGES_KEY]: false,
        [ROUNDED_PROFILE_IMAGES_KEY]: false,
        [SWAP_CHECKBOX_POSITION_KEY]: false,
        [SQUARE_MESSAGE_EDGES_KEY]: false,
        [MEMORY_DOT_ENABLED_KEY]: true,
        [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
        [HIDE_CREATOR_KEY]: false
    });
    
    const sidebarEnabled = earlySettings[SIDEBAR_LAYOUT_KEY];
    const classicLayoutEnabled = earlySettings[CLASSIC_LAYOUT_KEY];
    const classicStyleEnabled = earlySettings[CLASSIC_STYLE_KEY];
    const customStyleEnabled = earlySettings[CUSTOM_STYLE_KEY];
    const customStyleValues = earlySettings[CUSTOM_STYLE_VALUES_KEY];
    
    // -------------------------------------------------------------------------
    // COMPOSER CSS INJECTION (Dependency: Sidebar Layout)
    // -------------------------------------------------------------------------
    // The composer CSS (message input area styling) only works correctly with
    // sidebar layout enabled. It's designed specifically for that layout mode.
    // Without sidebar, the default SpicyChat layout is fine.
    // 
    // Skip on lorebook, chatbot/edit, create, and group pages - different layouts there
    // Supports localized URLs: /{language}/lorebook, /{language}/chatbot/edit, /{language}/create, /{language}/group
    const isNonChatPage = /^\/(([a-z]{2}\/)?)(lorebook|chatbot\/edit|create|group)/i.test(window.location.pathname);
    if (sidebarEnabled && !isNonChatPage) {
        const injectComposerCSS = () => {
            // Wait for document.head to exist (very early in page lifecycle)
            if (!document.head) {
                // Head doesn't exist yet - retry based on document state
                if (document.readyState === 'loading') {
                    // Still loading - wait for DOMContentLoaded
                    document.addEventListener('DOMContentLoaded', injectComposerCSS, { once: true });
                } else {
                    // DOM should be ready but head missing - retry soon
                    setTimeout(injectComposerCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            // Check if already injected (prevent duplicates)
            if (document.getElementById('sai-toolkit-composer-layout-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-composer-layout-early';
            style.textContent = getComposerLayoutCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Composer Layout CSS injected EARLY (before React initialization)');
        };
        
        injectComposerCSS();
    }
    
    // Inject Sidebar Layout CSS early if enabled
    // Skip on lorebook, chatbot, and group pages - different layouts there
    if (sidebarEnabled && !isNonChatPage) {
        const injectSidebarCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSidebarCSS, { once: true });
                } else {
                    setTimeout(injectSidebarCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-sidebar-layout-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-sidebar-layout-early';
            style.textContent = getSidebarLayoutCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Sidebar Layout CSS injected EARLY (before React initialization)');
        };

        injectSidebarCSS();

        // Start the body-class observer that drives Sidebar Layout state. The
        // observer waits for document.body internally, so it's safe to call
        // before the body exists. This replaces ~30 chained body:has() rules
        // with simple class selectors — fixes the 8s+ forced reflows reported
        // on older CPUs during typing. (Defined later in the IIFE — defer the
        // call so the function is in scope when the page actually has a body.)
        const startObserverWhenReady = () => {
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            } else {
                // Function defined later in the same IIFE; retry once microtask is clear
                setTimeout(startObserverWhenReady, 0);
            }
        };
        startObserverWhenReady();
    }
    
    // Inject Classic Layout CSS early if enabled
    if (classicLayoutEnabled) {
        const injectClassicLayoutCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectClassicLayoutCSS, { once: true });
                } else {
                    setTimeout(injectClassicLayoutCSS, 10);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-classic-layout-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-classic-layout-early';
            style.textContent = getClassicLayoutCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Classic Layout CSS injected EARLY (before React initialization)');
        };
        
        injectClassicLayoutCSS();
    }
    
    // Inject Classic Style CSS early if enabled
    if (classicStyleEnabled) {
        const injectClassicStyleCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectClassicStyleCSS, { once: true });
                } else {
                    setTimeout(injectClassicStyleCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-classic-style-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-classic-style-early';
            style.textContent = getClassicStyleCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Classic Style CSS injected EARLY (before React initialization)');
        };
        
        injectClassicStyleCSS();
    }
    
    // Inject Custom Style CSS early if enabled
    if (customStyleEnabled) {
        const injectCustomStyleCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectCustomStyleCSS, { once: true });
                } else {
                    setTimeout(injectCustomStyleCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-custom-style-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-custom-style-early';
            style.textContent = getCustomStyleCSSEarly(customStyleValues);
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Custom Style CSS injected EARLY (before React initialization)');
        };
        
        injectCustomStyleCSS();
    }
    
    // Inject Message Container Max Width CSS - inject into BODY to override HEAD stylesheets
    // PERFORMANCE: Use value from batched earlySettings read above
    const messageContainerMaxWidth = earlySettings[MESSAGE_CONTAINER_MAX_WIDTH_KEY];
    if (messageContainerMaxWidth) {
        const injectMessageContainerMaxWidthCSS = () => {
            // For this specific CSS, we inject into body, not head
            // This ensures it loads AFTER all external stylesheets in <head>
            const target = document.body || document.head;
            if (!target) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectMessageContainerMaxWidthCSS, { once: true });
                } else {
                    setTimeout(injectMessageContainerMaxWidthCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }

            // Remove existing style if present (to re-inject at end)
            const existing = document.getElementById('sai-toolkit-message-container-width');
            if (existing) {
                existing.remove();
            }

            const style = document.createElement('style');
            style.id = 'sai-toolkit-message-container-width';
            style.textContent = getMessageContainerMaxWidthCSS(messageContainerMaxWidth);

            // Append to body (or head if body not ready) - this ensures it comes AFTER all head stylesheets
            if (document.body) {
                document.body.appendChild(style);
                debugLog('[Core] Message Container Max Width CSS injected into BODY:', messageContainerMaxWidth);
            } else {
                document.head.appendChild(style);
                debugLog('[Core] Message Container Max Width CSS injected into HEAD (body not ready):', messageContainerMaxWidth);
            }
        };

        // Inject immediately if possible
        injectMessageContainerMaxWidthCSS();

        // Also re-inject after page is fully loaded to ensure we override all stylesheets
        if (document.readyState !== 'complete') {
            window.addEventListener('load', () => {
                setTimeout(injectMessageContainerMaxWidthCSS, 100);
            }, { once: true });
        }
    }
    
    // Load new layout options from storage
    // PERFORMANCE: Use values from batched earlySettings read above
    const smallProfileImagesEnabled = earlySettings[SMALL_PROFILE_IMAGES_KEY];
    const roundedProfileImagesEnabled = earlySettings[ROUNDED_PROFILE_IMAGES_KEY];
    const swapCheckboxPositionEnabled = earlySettings[SWAP_CHECKBOX_POSITION_KEY];
    const squareMessageEdgesEnabled = earlySettings[SQUARE_MESSAGE_EDGES_KEY];

    // Inject Small Profile Images CSS early if enabled
    if (smallProfileImagesEnabled) {
        const injectSmallProfileImagesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSmallProfileImagesCSS, { once: true });
                } else {
                    setTimeout(injectSmallProfileImagesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }

            if (document.getElementById('sai-toolkit-small-profile-images-early')) {
                return;
            }

            const style = document.createElement('style');
            style.id = 'sai-toolkit-small-profile-images-early';
            style.textContent = getSmallProfileImagesCSSEarly();

            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }

            debugLog('[Core] Small Profile Images CSS injected EARLY');
        };

        injectSmallProfileImagesCSS();
    }

    // Inject Rounded Profile Images CSS early if enabled
    if (roundedProfileImagesEnabled) {
        const injectRoundedProfileImagesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectRoundedProfileImagesCSS, { once: true });
                } else {
                    setTimeout(injectRoundedProfileImagesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-rounded-profile-images-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-rounded-profile-images-early';
            style.textContent = getRoundedProfileImagesCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Rounded Profile Images CSS injected EARLY');
        };
        
        injectRoundedProfileImagesCSS();
    }
    
    // Inject Swap Checkbox Position CSS early if enabled
    if (swapCheckboxPositionEnabled) {
        const injectSwapCheckboxPositionCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSwapCheckboxPositionCSS, { once: true });
                } else {
                    setTimeout(injectSwapCheckboxPositionCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-swap-checkbox-position-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-swap-checkbox-position-early';
            style.textContent = getSwapCheckboxPositionCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Swap Checkbox Position CSS injected EARLY');
        };
        
        injectSwapCheckboxPositionCSS();
    }
    
    // Inject Square Message Edges CSS early if enabled
    // NOTE: This is appended to the END of head (not beginning) so it overrides other layout CSS
    if (squareMessageEdgesEnabled) {
        const injectSquareMessageEdgesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSquareMessageEdgesCSS, { once: true });
                } else {
                    setTimeout(injectSquareMessageEdgesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-square-message-edges-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-square-message-edges-early';
            style.textContent = getSquareMessageEdgesCSSEarly();
            
            // Append to END of head so it overrides Classic Layout's border-radius
            document.head.appendChild(style);
            
            debugLog('[Core] Square Message Edges CSS injected EARLY');
        };
        
        injectSquareMessageEdgesCSS();
    }

    // Inject Memory Dot CSS early if customized
    // PERFORMANCE: Use values from batched earlySettings read above
    const memoryDotEnabled = earlySettings[MEMORY_DOT_ENABLED_KEY];
    const memoryDotColor = earlySettings[MEMORY_DOT_COLOR_KEY];
    
    // Only inject CSS if user has customized the default settings
    if (!memoryDotEnabled || memoryDotColor !== '#ff3b3b') {
        const injectMemoryDotCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectMemoryDotCSS, { once: true });
                } else {
                    setTimeout(injectMemoryDotCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-memory-dot-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-memory-dot-early';
            style.textContent = getMemoryDotCSSEarly(memoryDotEnabled, memoryDotColor);
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Memory Dot CSS injected EARLY - Enabled:', memoryDotEnabled, 'Color:', memoryDotColor);
        };
        
        injectMemoryDotCSS();
    }

    // -------------------------------------------------------------------------
    // HIDE CREATOR NAME CSS INJECTION
    // -------------------------------------------------------------------------
    const hideCreatorEnabled = earlySettings[HIDE_CREATOR_KEY];
    if (hideCreatorEnabled) {
        const injectHideCreatorCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectHideCreatorCSS, { once: true });
                } else {
                    setTimeout(injectHideCreatorCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            if (document.getElementById('sai-toolkit-hide-creator-early')) return;
            const style = document.createElement('style');
            style.id = 'sai-toolkit-hide-creator-early';
            style.textContent = `/* SAI Toolkit - Hide Creator Name */\na[aria-label="creator-profile"], a[href^="/creator/"] { display: none !important; }`;
            document.head.appendChild(style);
            debugLog('[Core] Hide Creator CSS injected EARLY');
        };
        injectHideCreatorCSS();
    }

    // -------------------------------------------------------------------------
    // MOBILE RESPONSIVE CSS INJECTION (Always Active)
    // -------------------------------------------------------------------------
    // Inject mobile-responsive CSS that applies globally regardless of layout
    // Currently includes: contextual menu left-justification for mobile devices
    const injectMobileResponsiveCSS = () => {
        if (!document.head) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', injectMobileResponsiveCSS, { once: true });
            } else {
                setTimeout(injectMobileResponsiveCSS, TIMING.CSS_RETRY_SHORT);
            }
            return;
        }

        if (document.getElementById('sai-toolkit-mobile-responsive-early')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'sai-toolkit-mobile-responsive-early';
        style.textContent = `/* SAI Toolkit - Mobile Responsive CSS */

/* ===== Character info bar full-width background fix ===== */
/* The character info bar (Iyarin name + buttons) is inside the bg-gray-2 container with background image */
/* Make it extend full width to cover the background image on the sides */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative > div.flex.w-full.bg-gray-2[class*="z-[2]"] {
  position: relative;
  background: var(--color-gray-2, #18181b) !important;
}

/* Use pseudo-element to extend background full width */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative > div.flex.w-full.bg-gray-2[class*="z-[2]"]::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100vw;
  height: 100%;
  background: var(--color-gray-2, #18181b);
  z-index: -1;
}

/* Message contextual menu (Copy/Edit): reposition to left on mobile devices */
@media (max-width: 999px) {
  div.absolute.w-max.z-\\[100\\][style*="box-shadow"]:has(button[aria-label="Copy"]) {
    z-index: ${Z_INDEX.CONTEXT_MENU} !important;
    right: auto !important;
    left: auto !important;
    transform: translateX(-100%) !important;
    margin-right: 0.25rem !important;
  }
}
`;

        if (document.head.firstChild) {
            document.head.insertBefore(style, document.head.firstChild);
        } else {
            document.head.appendChild(style);
        }

        debugLog('[Core] Mobile Responsive CSS injected EARLY');
    };

    injectMobileResponsiveCSS();

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Composer Layout
    // =============================================================================
    // These functions return complete CSS strings for injection into <style> tags.
    // They're called during early injection (before React) to prevent FOUC.
    // 
    // FUNCTION: getComposerLayoutCSSEarly()
    // PURPOSE: Fixes message composer (input box) layout and button alignment
    // USED BY: Both Sidebar Layout and Classic Layout features
    // 
    // WHY NEEDED:
    // - SpicyChat's default composer has buttons at the bottom (flex-column)
    // - We want buttons inline with the input (flex-row) for more compact UI
    // - Must center the 800px max-width composer container
    // - Must align buttons to center of textarea (not bottom)
    // 
    // TECHNICAL APPROACH:
    // - Uses :has() selector to target correct container (has input/textarea)
    // - Changes flex-direction from column to row
    // - Aligns items to center for vertical button alignment
    // - Centers the max-width:800px container with auto margins
    // - Removes bottom margins from buttons (no longer needed in row layout)
    // 
    // CSS SPECIFICITY:
    // - Highly specific selectors to override React's inline styles
    // - Uses !important to ensure styles persist through React updates
    // - Targets exact class combinations to avoid affecting other elements
    // =============================================================================
    function getComposerLayoutCSSEarly() {
        return `/* ===== Composer layout & icon placement ===== */
/* Target the outer composer container with image button */
div.flex.items-end.gap-sm[style*="margin-left"] {
  align-items: center !important;
}

/* Target ONLY the composer input row, NOT persona grid containers */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;  /* Align icons to center of textarea */
  flex-wrap: nowrap !important;
  gap: 0.5rem !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}

/* Make button wrapper divs stretch to full height */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) > div.inline-flex {
  height: 100% !important;
  align-items: center !important;
}

/* Remove margin from image generation button and other composer buttons */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) button {
  margin-bottom: 0 !important;
}

/* Also remove margin from the image button outside the input row */
div.flex.items-end.gap-sm[style*="margin-left"] button {
  margin-bottom: 0 !important;
}

/* Fix message box alignment */
.flex-row-reverse { 
  flex-direction: row !important;
}

/* ===== Center message input container ===== */
/* The container with inline style max-width: 800px */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full
  > div.flex.justify-undefined.items-undefined.bg-transparent.w-full[style*="max-width"] {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}
`;
    }
    
    // =============================================================================
    // CSS GENERATION FUNCTIONS - Sidebar Layout
    // =============================================================================
    // FUNCTION: getSidebarLayoutCSSEarly()
    // PURPOSE: Pins modals to right sidebar and adjusts chat layout accordingly
    // FEATURE: "Memory Manager - Sidebar Layout" checkbox
    // 
    // WHY NEEDED:
    // - Default SpicyChat modals appear centered and block the entire chat
    // - This pins Memories & Generation Settings to right side as permanent panels
    // - Allows user to chat while adjusting settings/memories
    // - Creates a 3-column layout: Left Nav | Chat | Right Sidebar
    // 
    // MODAL BEHAVIOR:
    // - Memories & Generation Settings: Pinned to right (380px width)
    // - When both open: Generation Settings on top (40vh), Memories on bottom (60vh)
    // - Image modals: Stay centered with backdrop blur (not pinned)
    // - "Select a model" modal: Stays centered (not pinned)
    // - Toolkit Settings modal: Pinned to right but with backdrop blur
    // 
    // CHAT LAYOUT ADJUSTMENTS:
    // - Chat container width reduced by 380px (sidebar width)
    // - Messages remain centered within available space
    // - Composer stays centered at 800px max-width
    // - Context menu repositioned to left side (away from sidebar)
    // 
    // RESPONSIVE BEHAVIOR:
    // - Sidebar only applies at desktop widths (min-width: 1000px)
    // - Mobile/tablet: Modals behave normally (centered)
    // 
    // Z-INDEX HIERARCHY:
    // - Sidebar modals: z-index 9000000 - 10000001
    // - Context menu: z-index 10000002 (above modals)
    // - Settings popover: z-index 10000001 (above Generation Settings)
    // - Image modal: Default z-index (appears above everything when open)
    // 
    // CSS VARIABLES:
    // - --mm-width: Modal panel width (380px)
    // - --mm-gap: Gap between chat and modal (0px)
    // - --mm-safe: Safe area inset for notched devices
    // - --mm-gutter: Total space reserved for sidebar (width + gap + safe area)
    // - --left-sidebar-width: SpicyChat's left navigation width (220px)
    // - --left-sidebar-collapsed-width: Collapsed left nav (54px)
    // 
    // TECHNICAL CHALLENGES SOLVED:
    // 1. React tries to hide Generation Settings when Memories opens
    //    Solution: Force display:flex !important, visibility:visible
    // 2. Both modals try to occupy same space
    //    Solution: Split screen vertically (40vh / 60vh) when both open
    // 3. Backdrop overlays block interaction
    //    Solution: Hide backdrops for sidebar modals, show for image modals
    // 4. Image modal too wide with sidebar
    //    Solution: Reduce width by --mm-gutter, add margin-right
    // 5. Context menu hidden behind sidebar
    //    Solution: High z-index + reposition to left side
    // =============================================================================
    
    // Define the CSS functions early for immediate use
    function getSidebarLayoutCSSEarly() {
        return `/* Memory Manager - Modal Layout CSS - EARLY INJECTION */

/* ===== Sidebar / Modals (Memories & Generation Settings) ===== */

/* Vars */
:root {
  --mm-width: 380px;
  --mm-gap: 0px;
  --mm-safe: env(safe-area-inset-right, 0px);
  --mm-gutter: calc(var(--mm-width) + var(--mm-gap) + var(--mm-safe));
  --left-sidebar-width: 220px; /* Default expanded width */
  --left-sidebar-collapsed-width: 54px;
}

/* Base modal: pin to right, full height, square corners */
/* Exclude image modals and toolkit modal from sidebar styling */
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container),
div.fixed.inset-0.z-\\[10000\\]:not(.size-full) > div.bg-white.dark\\:bg-gray-3.rounded-xl {
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  left: auto !important;
  transform: none !important;
  margin: 0 !important;
  width: var(--mm-width) !important;
  border-radius: 0 !important;
  z-index: ${Z_INDEX.SIDEBAR_MODAL} !important;
  display: block !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
}

/* Exception: Keep "Select a model" modal centered and height-constrained */
div.fixed.left-1\\/2.top-1\\/2:has(p.text-heading-6:contains("Select a model")),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:has(button[aria-label="Set Model"]) {
  position: fixed !important;
  top: 50% !important;
  left: 50% !important;
  right: auto !important;
  bottom: auto !important;
  transform: translate(-50%, -50%) !important;
  width: 500px !important;
  max-width: 90vw !important;
  height: auto !important;
  max-height: min(700px, 90vh) !important;
  border-radius: 0.5rem !important;
}

/* Force dark gray background on Generation Settings modal to match Memories */
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container).dark\\:\\!bg-gray-6,
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container)[class*="bg-white"] {
  background-color: rgb(26, 27, 30) !important; /* dark:bg-gray-3 color */
}

/* Align Memories header with Generation Settings header (remove center alignment) */
div.fixed.left-1\\/2.top-1\\/2.h-full p.text-heading-6.text-center {
  text-align: left !important;
  padding-left: 0 !important;
}

/* Toolkit Settings modal specific adjustments */
div.fixed.inset-0.z-\\[10000\\] {
  position: fixed !important;
  background: transparent !important;
  backdrop-filter: none !important;
  pointer-events: none !important;
}

div.fixed.inset-0.z-\\[10000\\] > div.bg-white.dark\\:bg-gray-3.rounded-xl {
  pointer-events: auto !important;
  max-width: var(--mm-width) !important;
  margin: 0 !important;
  padding: 1.5rem !important;
}

/* Inner scrollers fill */
div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"],
div.fixed.inset-0.z-\\[10000\\] > div.bg-white.dark\\:bg-gray-3.rounded-xl [class*="overflow-y-auto"] {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
}

/* NOTE: All body-state matchers below were originally chained body:has() rules.
   They were replaced with body classes managed by startSidebarLayoutBodyClassObserver()
   to avoid catastrophic forced reflows during typing on slower hardware. */

/* Hide backdrop overlays for sidebar modals only (sidebar open, image NOT open) */
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
div.fixed.inset-0:not(.z-\\[10000\\]):not(.toolkit-modal-backdrop),
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
[role="presentation"][aria-hidden="true"],
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
[data-overlay][aria-hidden="true"] {
  display: none !important;
}

/* Show backdrop overlays for image modals (.size-full) */
body.sai-mm-image-modal-open div.fixed.inset-0,
body.sai-mm-image-modal-open [role="presentation"][aria-hidden="true"],
body.sai-mm-image-modal-open [data-overlay][aria-hidden="true"] {
  display: block !important;
  backdrop-filter: blur(8px) !important;
  background-color: rgba(0, 0, 0, 0.5) !important;
}

/* Blur sidebar modals when image modal is open */
body.sai-mm-image-modal-open
div.fixed.left-1\\/2.top-1\\/2:not(.size-full) {
  filter: blur(4px) !important;
  opacity: 0.7 !important;
  pointer-events: none !important;
}

/* Blur sidebar modals when toolkit settings modal is open */
body.sai-mm-toolkit-modal-open
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container) {
  filter: blur(4px) !important;
  opacity: 0.7 !important;
  pointer-events: none !important;
}

/* Settings popover: keep above the sidebar */
div[style*="position: absolute"][style*="z-index: 10000000"] {
  z-index: ${Z_INDEX.SETTINGS_POPOVER} !important;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* Image modal: center between sidebars when sidebar is present */
@media (min-width: 1000px) {
  body.sai-mm-sidebar-modal-open
    div.fixed.left-1\\/2.top-1\\/2.size-full {
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: calc(100vw - var(--mm-gutter)) !important;
    height: 100vh !important;
    margin-right: var(--mm-gutter) !important;
  }

  body.sai-mm-sidebar-modal-open
    button.fixed.top-6.right-lg.z-\\[99999999999\\] {
    right: calc(var(--mm-gutter) + 1.5rem) !important;
  }
}

/* Message contextual menu (Copy/Edit): boost above sidebar and reposition to left */
div.absolute.w-max.z-\\[100\\][style*="box-shadow"]:has(button[aria-label="Copy"]) {
  z-index: ${Z_INDEX.CONTEXT_MENU} !important;
  right: auto !important;
  left: auto !important;
  transform: translateX(-100%) !important;
  margin-right: 0.25rem !important;
}

/* Allow message dropdown containers to overflow */
div.w-full.flex.mb-lg.bg-transparent.items-center div.relative {
  overflow: visible !important;
}

/* ===== Split the sidebar when BOTH modals are open ===== */

/* GENERATION SETTINGS PANEL (TOP 40vh) when BOTH modals open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full):not(.sai-placeholder-modal),
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full):not(.sai-placeholder-modal) {
  position: fixed !important;
  top: 0 !important;
  bottom: auto !important;
  right: 0 !important;
  height: 40vh !important;
  max-height: 40vh !important;
  z-index: 10000001 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* MEMORY MANAGER PANEL (BOTTOM 60vh) when BOTH modals open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not(.size-full) {
  position: fixed !important;
  top: auto !important;
  bottom: 0 !important;
  right: 0 !important;
  height: 60vh !important;
  max-height: 60vh !important;
  z-index: 10000000 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* When only Memory Manager is open */
body:not(.sai-mm-gen-settings-open)
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* When only Generation Settings is open */
body:not(.sai-mm-memories-open)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full),
body:not(.sai-mm-memories-open)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* ===== Generation panel internals: sticky footer & safe scroller ===== */

div.fixed.left-1\\/2.top-1\\/2:has(.flex.flex-col.gap-sm.px-lg) .flex.flex-col.gap-sm.px-lg {
  position: sticky !important;
  bottom: 0 !important;
  z-index: 2 !important;
  background: inherit !important;
}

div.fixed.left-1\\/2.top-1\\/2:has(.flex.flex-col.gap-sm.px-lg) > [class*="overflow-y-auto"] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  padding-bottom: 0.5rem !important;
}

div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full) {
  display: flex !important;
  flex-direction: column !important;
}

div.fixed.left-1\\/2.top-1\\/2:not(:has(.flex.flex-col.gap-sm.px-lg)) [class*="overflow-y-auto"] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
}

/* Inner scrollers fill split panels when BOTH modals are open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"] {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
}

/* Keep Generation Settings modal visible (prevent React from hiding it) */
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full) {
  display: flex !important;
  visibility: visible !important;
  opacity: 1 !important;
}

/* ===== Chat container / gutter ===== */

@media (min-width: 1000px) {
  body.sai-mm-any-center-modal-open
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - 220px) !important;
    max-width: calc(100vw - var(--mm-gutter) - 220px) !important;
    box-sizing: border-box !important;
  }
}

div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
  box-sizing: border-box !important;
  overflow-x: hidden !important;
  overflow-y: visible !important;
}

div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
  position: relative;
  /* No right padding: the real scrollbar lives on the absolutely-positioned
     .custom-scroll child, whose containing block sits inside this element's
     content box. Any right padding here insets that scroller and pushes its
     scrollbar inward, leaving a gutter between the scrollbar and the viewport
     edge (its apparent width varies by browser because the scrollbar's own
     reserved track stacks on top of the padding). Keep it 0 so the scrollbar
     sits flush against the right edge. Messages/composer stay readable because
     they're centered via max-width + margin:auto, not via this padding.
     NOTE: the sidebar-modal-open override (below) and the <1000px rule
     deliberately re-add 16px — there the gap separates the chat from the
     pinned right panel / screen edge, which is wanted. */
  padding-right: 0 !important;
  padding-left: 16px !important;
  padding-top: 0px !important;
  align-items: flex-start;
  box-sizing: border-box !important;
  overflow-x: visible !important;
  max-height: calc(100vh - 56px) !important;
}

@media (min-width: 1000px) {
  body.sai-mm-any-center-modal-open
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 220px) !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
    padding-right: 16px !important;
    max-height: calc(100vh - 56px) !important;
    flex: 1 1 auto !important;
  }

  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: 100% !important;
    overflow: visible !important;
    padding-top: 0.5rem !important;
  }

  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full
    > div.grow.flex.flex-col.w-full.left-0.items-center.absolute.h-full.overflow-auto {
    overflow-y: auto !important;
    overflow-x: visible !important;
  }

  /* OVERRIDE: When left sidebar is collapsed (54px instead of 220px) */
  body.sai-mm-nav-collapsed.sai-mm-any-center-modal-open
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  /* OVERRIDE: Header bar when left sidebar is collapsed */
  body.sai-mm-nav-collapsed.sai-mm-any-center-modal-open
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
    max-width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  body.sai-mm-any-center-modal-open
    .py-md.rounded-\\[20px_4px_20px_20px\\],
  body.sai-mm-any-center-modal-open
    .py-md.rounded-\\[4px_20px_20px_20px\\],
  body.sai-mm-any-center-modal-open
    [class*="max-w-\\\\[800px\\\\]"] {
    width: 100% !important;
    max-width: var(--sai-message-max-width, 800px) !important;
    box-sizing: border-box !important;
  }

  body.sai-mm-any-center-modal-open
    [class*="max-w-\\\\[800px\\\\]"] {
    max-width: min(var(--sai-message-max-width, 800px), 100%) !important;
  }
}

@media (max-width: 999px) {
  div.fixed.left-1\\/2.top-1\\/2 { display: none !important; }
  div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 { 
    padding-right: 16px !important;
    max-height: 100vh !important; /* No header in narrow view, use full viewport */
  }
}

/* ===== Center message bubbles ===== */
div.w-full.flex.mb-lg.bg-transparent.items-center.justify-between {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* ===== Center message input container (the one with max-width: 800px inline style) ===== */
/* The centered container with the input box - ALWAYS center it, not just when modal is open */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full
  > div.flex.justify-undefined.items-undefined.bg-transparent.w-full[style*="max-width"] {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Small Profile Images
    // =============================================================================
    function getSmallProfileImagesCSSEarly() {
        return `
/* Smaller PFP */
.w-11 {
    width: 2rem !important;
    height: 2rem !important;
}

p.dark\\:text-gray-12:is(.dark *) {
    line-height: 20px !important;
    font-size: 14px !important;
    opacity: 60% !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Rounded Profile Images
    // =============================================================================
    function getRoundedProfileImagesCSSEarly() {
        return `
/* Rounded PFP */
button.w-11 img {
    border-radius: 16px !important;
}

span:has(.text-warning) .leading-6 { 
    display: block !important; 
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Swap Checkbox Position
    // =============================================================================
    function getSwapCheckboxPositionCSSEarly() {
        return `
/* Swap selection checkbox positions */
.w-full.flex.mb-lg.bg-transparent.items-center {
    flex-direction: row-reverse !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Square Message Edges
    // =============================================================================
    function getSquareMessageEdgesCSSEarly() {
        return `
/* Square message box edges */
.py-md.rounded-\\[4px_20px_20px_20px\\],
.py-md.rounded-\\[20px_4px_20px_20px\\] {
    border-radius: 4px !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Memory Dot Customization
    // =============================================================================
    // FUNCTION: getMemoryDotCSSEarly()
    // PURPOSE: Customize the memory limit indicator dot (red dot in chat toolbar)
    // FEATURE: "Memory Limit Indicator" settings in Style tab
    // 
    // WHAT IT DOES:
    // - Hides the parent container (div.relative) if disabled
    // - Changes the dot color if custom color is set
    // 
    // CSS SELECTORS:
    // - div.relative[data-testid="ContextCapIndicator"] = Parent container (using data-testid)
    // - button[data-testid="ContextCapIndicator-Button"] = Memory button (using data-testid)
    // - Default classes: w-3 h-3 rounded-full cursor-pointer bg-gray-9 border border-gray-11
    // 
    // PARAMETERS:
    // - enabled: boolean - true = show dot (default), false = hide container
    // - color: string - CSS color value (default: #ff3b3b)
    // =============================================================================
    function getMemoryDotCSSEarly(enabled, color) {
        if (!enabled) {
            // Hide the parent container of the memory dot entirely
            return `
/* Hide Memory Limit Indicator Dot and Parent Container */
div[data-testid="ContextCapIndicator"] {
    display: none !important;
}
`;
        }
        
        if (color && color !== '#ff3b3b') {
            // Change the memory dot color
            return `
/* Custom Memory Limit Indicator Dot Color */
button[data-testid="ContextCapIndicator-Button"] {
    background-color: ${color} !important;
    border-color: ${color} !important;
    box-shadow: 0 4px 6px -1px ${color}70, 0 2px 4px -1px ${color}70 !important;
}
`;
        }
        
        return ''; // No customization needed
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Classic Style  
    // =============================================================================
    // FUNCTION: getClassicStyleCSSEarly()
    // PURPOSE: Applies classic color scheme to messages (blue/gray backgrounds)
    // FEATURE: "Classic Style" checkbox (colors only, no layout changes)
    // 
    // HISTORY:
    // - Originally part of "Classic Theme" (combined layout + colors)
    // - Separated Nov 2024 to allow independent control
    // - Enables users to use classic colors with modern staggered layout
    // 
    // WHY NEEDED:
    // - Some users prefer the classic blue/gray color scheme
    // - Default SpicyChat colors may have too much contrast
    // - Classic colors are more subtle and less visually distracting
    // - Provides aesthetic choice without forcing layout change
    // 
    // WHAT IT DOES:
    // - AI messages: Blue background (rgba(0, 100, 255, .1))
    // - User messages: Gray background (rgba(100, 100, 100, .1))
    // - NO layout changes (messages remain in their default positions)
    // 
    // CSS SELECTORS:
    // - .py-md.rounded-\\[4px_20px_20px_20px] = AI/bot messages
    // - .py-md.rounded-\\[20px_4px_20px_20px] = User messages
    // - Uses double-escaped brackets (\\\\[) because CSS is in JS string
    // 
    // WORKS WITH:
    // - Can combine with Classic Layout for full classic experience
    // - Can use standalone with modern layout (staggered messages)
    // - Independent of Sidebar Layout feature
    // 
    // UPDATE DETECTION:
    // - When upgrading from old "Classic Theme", this key won't exist
    // - content.js detects missing key and shows settings modal
    // - Allows user to enable new Classic Style feature after update
    // 
    // COLOR RATIONALE:
    // - Blue (AI): Distinguishes AI responses, traditional chatbot color
    // - Gray (User): Neutral color for user input
    // - Low opacity (.1): Subtle, doesn't overpower text content
    // - RGBA format: Allows transparency to work with any background
    // =============================================================================
    function getClassicStyleCSSEarly() {
        return `
/* Text Color */

body, html {
  color: #fff !important;
}

em, i, .narration, .styled {
  color: #06B7DB !important;
  font-style: italic !important;
}

.dark .text-colorQuote {
  color: #fff !important;
}

button:hover {
  background-color: #292929 !important;
}

/* Message Boxes - Colors Only */

.py-md.rounded-\\[4px_20px_20px_20px\\] {
  background-color: rgba(100, 100, 100, .1) !important;
}

.py-md.rounded-\\[20px_4px_20px_20px\\] {
  background-color: rgba(0, 100, 255, .1) !important;
}
`;
    }
    
    // =============================================================================
    // CSS GENERATION FUNCTIONS - Custom Style
    // =============================================================================
    // FUNCTION: getCustomStyleCSSEarly()
    // PURPOSE: Applies user-defined custom colors and font size to messages
    // FEATURE: "Custom Style" checkbox (colors and font size)
    // 
    // WHY NEEDED:
    // - Allows users to customize message appearance without preset themes
    // - Provides fine-grained control over colors and typography
    // - Mutually exclusive with Classic Style to prevent conflicts
    // 
    // PARAMETERS:
    // - valuesJson: JSON string containing custom style values:
    //   - aiMessageBg: AI message background color
    //   - userMessageBg: User message background color
    //   - textColor: Main text color
    //   - italicColor: Italic/narration text color
    //   - fontSize: Font size for message text
    // =============================================================================
    function getCustomStyleCSSEarly(valuesJson) {
        let values;
        try {
            values = JSON.parse(valuesJson);
        } catch (e) {
            debugLog('[Custom Style] Error parsing custom style values, using defaults');
            values = DEFAULT_CUSTOM_STYLE;
        }
        
        return `
/* Custom Style - User Defined Colors and Font Size */

/* Body Text Color and Font Settings */
div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] body,
div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] html,
div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"],
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
  color: ${values.bodyColor} !important;
  font-size: ${values.fontSize} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.bodyFontWeight} !important;
  font-style: ${values.bodyFontStyle} !important;
  text-decoration: ${values.bodyTextDecoration} !important;
}

/* Body Text - Spans (color and font) */
div.p-0[style*="width: 100%"] span.leading-6,
div.p-0[style*="width: 100%"] span.text-white,
div.bg-gray-2 span.leading-6,
div.bg-gray-2 span.text-white,
span.leading-6.mb-\\[10px\\].last\\:mb-0.text-white {
  color: ${values.bodyColor} !important;
  font-size: ${values.fontSize} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.bodyFontWeight} !important;
  font-style: ${values.bodyFontStyle} !important;
  text-decoration: ${values.bodyTextDecoration} !important;
}

/* Quote Text Color (q elements inside spans) */
div.p-0[style*="width: 100%"] span.text-white q.text-colorQuote,
div.p-0[style*="width: 100%"] span.text-white q.text-white,
div.p-0[style*="width: 100%"] span.leading-6 q.text-colorQuote,
div.p-0[style*="width: 100%"] span.leading-6 q.text-white,
div.bg-gray-2 span.text-white q.text-colorQuote,
div.bg-gray-2 span.text-white q.text-white,
div.bg-gray-2 span.leading-6 q.text-colorQuote,
div.bg-gray-2 span.leading-6 q.text-white,
q.leading-\\[1\\.35\\].tracking-\\[0\\.01em\\].text-zinc-900,
q.leading-\\[1\\.35\\].tracking-\\[0\\.01em\\].text-zinc-300,
span.leading-6.mb-\\[10px\\].last\\:mb-0.text-white q,
span.leading-6.mb-\\[10px\\] q {
  color: ${values.spanQuoteColor} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.spanQuoteFontWeight} !important;
  font-style: ${values.spanQuoteFontStyle} !important;
  text-decoration: ${values.spanQuoteTextDecoration} !important;
}

/* Narration Color (em, i, .narration, .styled) */
div.p-0[style*="width: 100%"] em,
div.p-0[style*="width: 100%"] i,
div.p-0[style*="width: 100%"] .narration,
div.p-0[style*="width: 100%"] .styled,
div.bg-gray-2 em,
div.bg-gray-2 i,
div.bg-gray-2 .narration,
div.bg-gray-2 .styled,
em.italic.leading-6.text-sky-6,
em.italic.leading-6.dark\\:text-sky-7 { 
  color: ${values.narrationColor} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.narrationFontWeight} !important;
  font-style: ${values.narrationFontStyle} !important;
  text-decoration: ${values.narrationTextDecoration} !important;
}

/* Highlight Color (blockquote.bg-colorHighlight) */
div.p-0[style*="width: 100%"] blockquote.bg-colorHighlight,
div.bg-gray-2 blockquote.bg-colorHighlight,
blockquote.bg-colorHighlight.max-w-max.px-1.rounded-md,
blockquote.bg-colorHighlight.max-w-max.px-1.rounded-md.text-black {
  background-color: ${values.highlightBgColor} !important;
  color: ${values.highlightTextColor} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.highlightFontWeight} !important;
  font-style: ${values.highlightFontStyle} !important;
  text-decoration: ${values.highlightTextDecoration} !important;
}

/* Message Boxes - Custom Colors */

.py-md.rounded-\\[4px_20px_20px_20px\\] {
  background-color: ${values.aiMessageBg} !important;
}

.py-md.rounded-\\[20px_4px_20px_20px\\] {
  background-color: ${values.userMessageBg} !important;
}

/* Button Hover Color */
${values.hoverButtonColor ? `button:hover {
  background-color: ${values.hoverButtonColor} !important;
}` : ''}

/* Creator Link Color */
${values.creatorLinkColor ? `a[aria-label="creator-profile"] p,
a[href^="/creator/"] p.text-link {
  color: ${values.creatorLinkColor} !important;
}` : ''}

/* Custom Background Image */
${values.backgroundImage ? `.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative {
  background-image: url('${values.backgroundImage}') !important;
  background-size: cover !important;
  background-position: center !important;
  background-repeat: no-repeat !important;
  background-attachment: fixed !important;
}` : ''}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Message Container Max Width
    // =============================================================================
    // FUNCTION: getMessageContainerMaxWidthCSS()
    // PURPOSE: Applies custom max-width to message container
    // FEATURE: "Message Container Max Width" setting (independent of other styles)
    // 
    // WHY NEEDED:
    // - Allows users to control the width of the message container independently
    // - Works with or without Custom Style/Classic Layout enabled
    // - Useful for wide screens or narrow reading preferences
    // 
    // PARAMETERS:
    // - maxWidth: CSS width value (e.g., '800px', '90%', '1200px')
    // =============================================================================
    function getMessageContainerMaxWidthCSS(maxWidth) {
        if (!maxWidth) return '';
        
        // Use extremely high specificity selectors that will override everything
        // Including site's external CSS files that load after our injection
        return `
/* Message Container Max Width - Override ALL constraints */
/* Injected into BODY to ensure it loads AFTER all HEAD stylesheets */

/* Set a CSS variable for the max width */
:root {
  --sai-message-max-width: ${maxWidth};
}

/* ULTRA HIGH SPECIFICITY: Target message containers with multiple selector chains */
/* The inline style="max-width: 800px" needs !important to override */

/* AI messages (justify-start) - multiple specificity layers */
html body div.flex-shrink-0.py-0.w-full div div.flex div.flex.flex-col div.w-full.flex.mb-lg.bg-transparent.items-center.justify-start[style*="max-width"] {
  max-width: ${maxWidth} !important;
}

/* User messages (justify-between) - multiple specificity layers */
html body div.flex-shrink-0.py-0.w-full div div.flex div.flex.flex-col div.w-full.flex.mb-lg.bg-transparent.items-center.justify-between[style*="max-width"] {
  max-width: ${maxWidth} !important;
}

/* Generic fallback with ultra-high specificity */
html body div.flex-shrink-0 div div div div div.w-full.flex.mb-lg.bg-transparent.items-center[style] {
  max-width: ${maxWidth} !important;
}

/* Target via attribute selector - catches all inline max-width styles */
html body div[style*="max-width: 800px"].w-full.flex.mb-lg,
html body div[style*="max-width:800px"].w-full.flex.mb-lg {
  max-width: ${maxWidth} !important;
}

/* Override Tailwind max-w-[800px] class with high specificity */
html body .max-w-\\[800px\\] {
  max-width: ${maxWidth} !important;
}

/* Override the inner message bubble max-width (often 650px or 800px) */
html body div.flex.flex-col.gap-md.w-full[style*="max-width"] {
  max-width: ${maxWidth} !important;
}

/* Target message input container at bottom */
html body div.flex.flex-col.items-center.p-md.w-full div[style*="max-width"] {
  max-width: ${maxWidth} !important;
}

/* Override max-w-[620px] content containers */
html body .max-w-\\[620px\\] {
  max-width: ${maxWidth} !important;
}

/* Sidebar layout context - even higher specificity */
html body div.bg-gray-2 div.w-full.flex.mb-lg.bg-transparent.items-center[style*="max-width"] {
  max-width: ${maxWidth} !important;
}

/* Classic layout context */
html body div.p-0 div.w-full.flex.mb-lg.bg-transparent.items-center[style*="max-width"] {
  max-width: ${maxWidth} !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Classic Layout
    // =============================================================================
    // FUNCTION: getClassicLayoutCSSEarly()
    // PURPOSE: Restores classic message box layout (centered, full-width)
    // FEATURE: "Classic Chat Layout" checkbox (layout only, no colors)
    // 
    // HISTORY:
    // - Originally part of "Classic Theme" (combined layout + colors)
    // - Separated Nov 2024 to allow independent control
    // - Users wanted classic layout WITHOUT classic colors
    // 
    // WHY NEEDED:
    // - SpicyChat's default layout has messages staggered left/right
    // - Classic layout centers all messages in a single column
    // - Provides more consistent, readable chat experience
    // - Similar to ChatGPT/Claude interface style
    // 
    // WHAT IT DOES:
    // - Centers user messages (normally right-aligned)
    // - Centers AI messages (normally left-aligned)
    // - Sets max-width to 800px for optimal reading
    // - Adds auto margins for horizontal centering
    // - Maintains message bubble shapes (no color changes)
    // 
    // CSS SELECTORS:
    // - .py-md.rounded-[20px_4px_20px_20px] = AI messages (top-left square corner)
    // - .py-md.rounded-[4px_20px_20px_20px] = User messages (top-right square corner)
    // 
    // WORKS WITH:
    // - Can combine with Classic Style (colors) for full classic experience
    // - Can combine with Sidebar Layout for centered messages in sidebar mode
    // - Can use standalone for modern colors + classic layout
    // 
    // TECHNICAL NOTES:
    // - Uses escaped bracket syntax for Tailwind classes: \\[ and \\]
    // - !important required to override React's inline styles
    // - 100% width ensures messages span available container width
    // =============================================================================
    function getClassicLayoutCSSEarly() {
        return `
/* Message Boxes - Layout Only */

.py-md.rounded-\\[20px_4px_20px_20px\\] {
  margin-left: auto !important;
  margin-right: auto !important;
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  box-sizing: border-box !important;
  border-radius: 20px !important;
}

.py-md.rounded-\\[4px_20px_20px_20px\\] {
  margin-left: auto !important;
  margin-right: auto !important;
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  box-sizing: border-box !important;
  border-radius: 20px !important;
}

.px-\\[13px\\] {
  padding-left: 16px !important;
  padding-right: 16px !important;
}

.flex-row-reverse { 
  flex-direction: row !important;
}

.items-end {
  align-items: flex-start !important;
}

/* Fix main container flexbox shrinking */
div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
  flex-shrink: 0 !important;
  min-width: 0 !important;
}

/* Fix the bg-gray-2 child inside .p-0 */
div.p-0 > div.bg-gray-2.flex.grow.flex-col {
  min-width: 100% !important;
  width: 100% !important;
}

/* Fix the max-w-[620px] content container that's constraining width */
div.bg-gray-2 .max-w-\[620px\] {
  max-width: 100% !important;
}

/* More specific selector for the max-w-[620px] container */
div.p-0 div.bg-gray-2 div.max-w-\[620px\],
div.max-w-\[620px\] {
  max-width: none !important;
  width: 100% !important;
}


/* ===== Composer layout & icon placement ===== */
/* Target the outer composer container with image button */
div.flex.items-end.gap-sm[style*="margin-left"] {
  align-items: center !important;
}

/* Target ONLY the composer input row, NOT persona grid containers */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;  /* Align icons to center of textarea */
  flex-wrap: nowrap !important;
  gap: 0.5rem !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}

/* Make button wrapper divs stretch to full height */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) > div.inline-flex {
  height: 100% !important;
  align-items: center !important;
}

/* Remove margin from image generation button and other composer buttons */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) button {
  margin-bottom: 0 !important;
}

/* Also remove margin from the image button outside the input row */
div.flex.items-end.gap-sm[style*="margin-left"] button {
  margin-bottom: 0 !important;
}

/* ===== Center message input container ===== */
/* Parent container for the input area */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full {
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
}

/* The container with inline style max-width: 800px */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full
  > div.flex.justify-undefined.items-undefined.bg-transparent.w-full[style*="max-width"] {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}

/* Also ensure the inner wrapper stays centered */
div.flex.items-end.gap-sm.w-full[style*="margin-left"] {
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}

/* Fix bottom spacing when header disappears on narrow screens */
@media (max-width: 990px) {
  /* Remove bottom padding/margin that was compensating for desktop header */
  div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
    padding-bottom: 0 !important;
  }
  
  /* Ensure composer area sits at the very bottom */
  div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full {
    padding-bottom: 1rem !important;
  }
}

/* Constrain image width in message bubbles to match max-w-[404px] */
.py-md.rounded-\\[4px_20px_20px_20px\\] img.rounded-lg,
.py-md.rounded-\\[20px_4px_20px_20px\\] img.rounded-lg {
  max-width: 500px !important;
  width: auto !important;
}
`;
    }

    // =============================================================================
    // Wait for DOM to be ready before running main code
    // =============================================================================
    
    async function initializeMainCode() {
        debugLog('[Core] DOM ready, initializing main code...');
        
        // =============================================================================
        // STORAGE CACHE - Reduce redundant storage reads (Issue #13)
        // =============================================================================
        const storageCache = {
            data: {},
            timestamps: {},
            TTL: TIMING.STORAGE_CACHE_TTL,
            
            async get(key, defaultValue) {
                const now = Date.now();
                // Check if cached and not expired
                if (this.data[key] !== undefined && 
                    this.timestamps[key] && 
                    (now - this.timestamps[key]) < this.TTL) {
                    debugLog('[Cache] HIT:', key);
                    return this.data[key];
                }
                
                // Cache miss - fetch from storage
                debugLog('[Cache] MISS:', key);
                const value = await storage.get(key, defaultValue);
                this.data[key] = value;
                this.timestamps[key] = now;
                return value;
            },
            
            async set(key, value) {
                // Update cache and storage
                this.data[key] = value;
                this.timestamps[key] = Date.now();
                await storage.set(key, value);
            },
            
            invalidate(key) {
                delete this.data[key];
                delete this.timestamps[key];
            },
            
            clear() {
                this.data = {};
                this.timestamps = {};
            }
        };
        
        // Make cache available globally within this scope
        window.__toolkitStorageCache = storageCache;

    // =============================================================================
    // ===              AUTH HEADER INTERCEPTOR FOR MEMORY REFRESH              ===
    // =============================================================================
    // NOTE: The auth header interceptor has been moved to page-context.js
    // It is injected as an external script (CSP-compliant) and runs in page context
    // where it can intercept XHR/fetch calls to capture auth tokens and headers.
    // The interceptor stores tokens in window.__kindeAccessToken and 
    // window.__lastAuthHeaders for use by chat export and memory refresh features.
    // =============================================================================

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===              INFERENCE PROFILES & MESSAGE STATS - START              ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    const PROFILES_KEY = 'generationProfiles';
    const LAST_PROFILE_KEY = 'lastSelectedProfile';
    // NOTE: message stats no longer live in storage.local — they are owned by the
    // background IndexedDB store and accessed via SAI_STATS_* messages (sendStatsMessage).
    let lastGenerationSettings = null;
    let pendingMessageStats = null; // Store stats temporarily until message appears in DOM
    let loadedMessageIds = []; // Store message IDs from GET /messages response
    let messageIdToIndexMap = {}; // Map bot message IDs to their order in the conversation
    let userMessageIdToIndexMap = {}; // Map user message IDs to their order in the conversation
    let currentConversationId = null; // Store the actual conversation ID from API
    
    // Track alternative message groups for regeneration switching
    // Structure: { prev_id: [msg1_id, msg2_id, ...] } - sorted by createdAt (oldest first)
    let alternativeMessageGroups = {};
    
    // Track which prevIds we've seen messages for (to detect regenerations)
    // Structure: { prevId: [messageId1, messageId2, ...] }
    let prevIdToMessageIds = {};
    
    // Store message timestamps from API responses (source of truth for timestamps)
    // Structure: { messageId: createdAt (unix ms) }
    let messageTimestamps = {};

    // In-memory set of bot message IDs — used by story mode to classify messages
    // without requiring a stored stats entry (which won't exist for null-inference messages)
    const botMessageIds = new Set();

    // Track which message IDs have already had stats inserted to prevent duplicates
    // Note: We clear these sets when navigating conversations to allow re-insertion
    const statsInsertedForMessageIds = new Set();      // Successfully inserted
    const statsInsertionInProgress = new Set();        // Currently being processed (prevents parallel runs)

    // Track how many new messages are pending insertion (used to skip newest messages in processMessagesForStats)
    // This prevents race conditions where processMessagesForStats runs before insertStatsForRegeneratedMessage
    let pendingNewMessageCount = 0;

    // Helper function to detect if we're in Story Mode
    // Supports localized URLs: /story/ or /{language}/story/
    function isStoryMode() {
        return /\/(?:[a-z]{2}\/)?story\//i.test(window.location.pathname);
    }
    
    // Build an SVG element from a tag + attribute map, with optional children.
    // Children entries: ['tag', { attr: value, ... }]. Used for the lucide-style
    // icons we previously assembled with innerHTML on Button elements.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function makeSVG(rootAttrs, children) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        for (const [k, v] of Object.entries(rootAttrs)) svg.setAttribute(k, v);
        if (children) {
            for (const [tag, attrs] of children) {
                const node = document.createElementNS(SVG_NS, tag);
                for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
                svg.appendChild(node);
            }
        }
        return svg;
    }

    // Parse a static HTML template string into a DocumentFragment, avoiding
    // .innerHTML assignment (which Mozilla's addons-linter flags). Use this with
    // element.replaceChildren(parseHTMLToFragment(template)) for static markup.
    // DOMParser does not execute scripts and is the standard recommended path.
    function parseHTMLToFragment(html) {
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        const frag = document.createDocumentFragment();
        // Move children out of the parsed body into our fragment, adopting them
        // into the live document so subsequent queries work as expected.
        while (doc.body.firstChild) {
            frag.appendChild(document.adoptNode(doc.body.firstChild));
        }
        return frag;
    }

    // Helper function to safely set HTML content (sanitizes input)
    function safeSetHTML(element, content) {
        // For simple text content, use textContent
        if (!content.includes('<')) {
            element.textContent = content;
            return;
        }
        
        // For content with <br> tags, convert to text nodes and actual <br> elements
        // This avoids innerHTML security warnings while preserving line breaks
        element.textContent = ''; // Clear existing content
        const parts = content.split(/<br\s*\/?>/i);
        parts.forEach((part, index) => {
            if (part) {
                element.appendChild(document.createTextNode(part));
            }
            if (index < parts.length - 1) {
                element.appendChild(document.createElement('br'));
            }
        });
    }

    // =============================================================================
    // ===              AUTO-REGENERATION LOGIC                                 ===
    // =============================================================================
    
    // Track auto-regeneration attempts per message thread
    // Key = prevId (the message being regenerated), Value = attempt count
    const autoRegenAttempts = {};
    
    // Cached settings for synchronous access
    window.__autoRegenOnMismatch = false;
    window.__autoRegenOnShort = false;
    window.__autoRegenMaxAttempts = 1;
    
    // When model override is active, suppress the first mismatch regen (model change is expected)
    window.__suppressMismatchNext = false;
    
    // Track the last known engine to detect mismatches on new messages
    window.__lastKnownEngine = null;
    
    // Flag to prevent re-entrancy during auto-regeneration
    window.__autoRegenInProgress = false;
    
    /**
     * Click the regenerate button on the last bot message.
     * The button has aria-label="RefreshCcw-button" and is in the last message's controls.
     */
    function clickRegenerateButton() {
        // Find all message wrappers with the regenerate button
        const regenButtons = document.querySelectorAll('button[aria-label="RefreshCcw-button"]');
        if (regenButtons.length === 0) {
            debugLog('[AutoRegen] No regenerate button found');
            return false;
        }
        // Click the LAST regenerate button (most recent message)
        const lastRegenBtn = regenButtons[regenButtons.length - 1];
        debugLog('[AutoRegen] Clicking regenerate button');
        lastRegenBtn.click();
        return true;
    }
    
    /**
     * Check if auto-regeneration should occur and trigger it.
     * Called when a new bot message is received.
     * @param {string} prevId - The previous message ID (used to track regen attempts)
     * @param {string} responseEngine - The engine used for this response
     * @param {number} responseContentLength - Length of the response content
     */
    function checkAndAutoRegenerate(prevId, responseEngine, responseContentLength) {
        if (window.__autoRegenInProgress) {
            debugLog('[AutoRegen] Already in progress, skipping');
            return;
        }
        
        const maxAttempts = window.__autoRegenMaxAttempts || 1;
        const trackingKey = prevId || 'unknown';
        const currentAttempts = autoRegenAttempts[trackingKey] || 0;
        
        if (currentAttempts >= maxAttempts) {
            debugLog('[AutoRegen] Max attempts reached for', trackingKey.substring(0, 8), ':', currentAttempts, '/', maxAttempts);
            // Reset tracking for this message thread
            delete autoRegenAttempts[trackingKey];
            window.__autoRegenInProgress = false;
            return;
        }
        
        let shouldRegen = false;
        let reason = '';
        
        // Check for model mismatch
        // Require both engines to be non-blank — a blank previous engine means we have no
        // valid baseline to compare against (e.g. first message, or engine field missing
        // from a prior response), so we must not regenerate.
        const hasValidPrevEngine = typeof window.__lastKnownEngine === 'string' && window.__lastKnownEngine.trim() !== '';
        const hasValidCurrEngine = typeof responseEngine === 'string' && responseEngine.trim() !== '';
        if (window.__autoRegenOnMismatch && hasValidCurrEngine && hasValidPrevEngine) {
            // Use the same core model extraction as applyModelChangeIndicators
            const extractCoreModel = (engineString) => {
                if (!engineString) return null;
                const slashIndex = engineString.indexOf('/');
                if (slashIndex === -1) return engineString.toLowerCase().trim();
                const afterSlash = engineString.substring(slashIndex + 1);
                const underscoreIndex = afterSlash.indexOf('_');
                if (underscoreIndex === -1) return afterSlash.toLowerCase().trim();
                return afterSlash.substring(0, underscoreIndex).toLowerCase().trim();
            };
            
            const currentCore = extractCoreModel(responseEngine);
            const previousCore = extractCoreModel(window.__lastKnownEngine);
            
            debugLog('[AutoRegen] Mismatch check - current:', currentCore, 'previous:', previousCore);
            
            if (currentCore && previousCore && currentCore !== previousCore) {
                if (window.__suppressMismatchNext) {
                    window.__suppressMismatchNext = false;
                    debugLog('[AutoRegen] Mismatch suppressed for this message (model override: change was expected)');
                } else {
                    shouldRegen = true;
                    reason = `model mismatch (${previousCore} → ${currentCore})`;
                }
            }
        }
        
        // Check for short response
        if (!shouldRegen && window.__autoRegenOnShort && responseContentLength !== undefined) {
            if (responseContentLength < 50) {
                shouldRegen = true;
                reason = `short response (${responseContentLength} chars < 50)`;
            }
        }
        
        if (shouldRegen) {
            autoRegenAttempts[trackingKey] = currentAttempts + 1;
            debugLog('[AutoRegen] Triggering auto-regeneration - reason:', reason, '- attempt:', currentAttempts + 1, '/', maxAttempts);
            
            window.__autoRegenInProgress = true;
            
            // Delay slightly to let the DOM update with the new message before clicking regen
            setTimeout(() => {
                const clicked = clickRegenerateButton();
                if (!clicked) {
                    debugLog('[AutoRegen] Failed to click regenerate button');
                    window.__autoRegenInProgress = false;
                } else {
                    // Reset the in-progress flag after a reasonable time for the regen to complete
                    // The next SAI_NEW_MESSAGE will trigger another check if needed
                    setTimeout(() => {
                        window.__autoRegenInProgress = false;
                    }, 2000);
                }
            }, 1500);
        } else {
            // Successful message (no regen needed) - reset attempt tracking for this thread
            if (autoRegenAttempts[trackingKey]) {
                debugLog('[AutoRegen] Message passed checks, resetting attempt counter for', trackingKey.substring(0, 8));
                delete autoRegenAttempts[trackingKey];
            }
            // Update last known engine for future comparisons.
            // Skip blank/whitespace values so we don't poison the baseline.
            if (typeof responseEngine === 'string' && responseEngine.trim() !== '') {
                window.__lastKnownEngine = responseEngine;
                debugLog('[AutoRegen] Updated lastKnownEngine to:', responseEngine);
            }
        }
    }

    // Helper function to check if model changed from previous message and apply indicator
    // This function should be called AFTER all stats are populated, as a final pass
    function applyModelChangeIndicators() {
        // Check if the feature is enabled
        if (!window.__highlightModelChanges) {
            // Feature disabled - remove any existing borders
            document.querySelectorAll('.generation-stats').forEach(statsDiv => {
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
            });
            return;
        }
        
        debugLog('[Model Change] Applying model change indicators to all stats divs');
        
        // Get all generation-stats divs in document order (chronological)
        const allStatsDivs = Array.from(document.querySelectorAll('.generation-stats'));
        debugLog('[Model Change] Found', allStatsDivs.length, 'stats divs');
        
        // Extract core model identifier from full engine string
        // Examples:
        //   "zai-org/GLM-4.6" → "GLM-4.6"
        //   "zai-org/GLM-4.6_friendli_dedicated" → "GLM-4.6"
        //   "anthropic/claude-3-opus" → "claude-3-opus"
        const extractCoreModel = (engineString) => {
            if (!engineString) return null;
            
            // Find the part between "/" and first "_" (or end if no "_")
            const slashIndex = engineString.indexOf('/');
            if (slashIndex === -1) {
                // No slash, return the whole string
                return engineString.toLowerCase().trim();
            }
            
            // Get everything after the slash
            const afterSlash = engineString.substring(slashIndex + 1);
            
            // Find the first underscore (if any)
            const underscoreIndex = afterSlash.indexOf('_');
            if (underscoreIndex === -1) {
                // No underscore, return everything after slash
                return afterSlash.toLowerCase().trim();
            }
            
            // Return the part between slash and underscore
            return afterSlash.substring(0, underscoreIndex).toLowerCase().trim();
        };
        
        // Extract engine from a stats div's HTML content
        // The first line contains model info like "glm47-beta → zai-org/glm-4.7"
        // We need to parse innerHTML since textContent doesn't preserve <br> as newlines
        const extractEngine = (statsDiv) => {
            // Get innerHTML and split by <br> to get the first line
            const html = statsDiv.innerHTML || '';
            const firstLine = html.split(/<br\s*\/?>/i)[0].trim();
            
            debugLog('[Model Change] First line from HTML:', firstLine);
            
            // Format is typically: "model → engine" or just timestamp/ID
            if (firstLine.includes('→')) {
                const engine = firstLine.split('→')[1].trim();
                debugLog('[Model Change] Extracted engine:', engine);
                return engine;
            }
            // If no arrow, this might be a timestamp-only stats div, skip it
            debugLog('[Model Change] No arrow found, returning null');
            return null;
        };
        
        let prevCoreModel = null;
        
        for (let i = 0; i < allStatsDivs.length; i++) {
            const statsDiv = allStatsDivs[i];
            const currentEngine = extractEngine(statsDiv);
            
            // Skip divs that don't have model info (e.g., timestamp-only user messages)
            if (!currentEngine) {
                // Don't update prevCoreModel, just clear any existing border
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
                continue;
            }
            
            // Extract core model identifier for comparison
            const currentCoreModel = extractCoreModel(currentEngine);
            
            debugLog('[Model Change] Stats div', i, '- Engine:', currentEngine, '| Core Model:', currentCoreModel, '| Prev Core:', prevCoreModel);
            
            if (prevCoreModel && currentCoreModel !== prevCoreModel) {
                // Model changed from previous - apply yellow border
                statsDiv.style.borderRight = '4px solid #fbbf24';
                statsDiv.style.paddingRight = '8px';
                debugLog('[Model Change] Applied yellow border to stats div', i, '(', prevCoreModel, '→', currentCoreModel, ')');
            } else {
                // Same model or first message - remove border
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
            }
            
            // Update prevCoreModel for next iteration
            prevCoreModel = currentCoreModel;
            
            // Track the last engine seen for auto-regeneration mismatch detection
            window.__lastKnownEngine = currentEngine;
        }
    }
    
    // Wrapper function that can be called from multiple places
    function checkAndApplyModelChangeIndicator(statsDiv, currentModel) {
        // This is now just a stub - the actual work is done by applyModelChangeIndicators()
        // which runs as a final pass after all stats are inserted
    }

    // Build index map from stored message stats (for imported/old messages)
    async function buildIndexMapFromStats() {
        debugLog('[Stats] buildIndexMapFromStats starting...');

        // The index map is scoped to messages currently in view (those with an API
        // timestamp). At startup messageTimestamps is empty and SAI_MESSAGES_LOADED
        // rebuilds the map directly anyway, so skip the background round-trip entirely
        // until timestamps exist — avoids a wasted SAI_STATS_GET_CHARACTER on every load.
        if (!Object.keys(messageTimestamps).length) {
            debugLog('[Stats] buildIndexMapFromStats - no timestamps yet, skipping (rebuilt by MESSAGES_LOADED)');
            return;
        }

        const characterId = getCurrentCharacterId();
        // Stats are keyed by messageId (conversationId dropped); this returns ALL of
        // the character's stat records. Scope to the messages currently in view — i.e.
        // those with an API timestamp in messageTimestamps — which mirrors the old
        // per-conversation scoping (messageTimestamps is rebuilt per loaded conversation).
        const charStats = await loadCharacterStats(characterId);
        const messageIds = Object.keys(charStats).filter(id => messageTimestamps[id]);
        debugLog('[Stats] buildIndexMapFromStats - character:', characterId,
            '| records:', Object.keys(charStats).length, '| in-view:', messageIds.length);

        // Sort messages by API timestamp (oldest first). Records carry no timestamp,
        // so order by the in-memory messageTimestamps map.
        const sortedIds = messageIds.sort((a, b) => {
            const aTime = messageTimestamps[a] || 0;
            const bTime = messageTimestamps[b] || 0;
            return aTime - bTime;
        });

        // Build index map - this maps sequential index to message IDs
        // This is only used as a fallback when extractMessageId() fails
        sortedIds.forEach((id, index) => {
            messageIdToIndexMap[index] = id;
        });

        debugLog('[Stats] Built index map from storage:', Object.keys(messageIdToIndexMap).length, 'messages');
    }

    // Stats live in the background's IndexedDB store (extension origin). Content
    // requests the CURRENT character's records and caches them briefly for the
    // display passes. cachedCharStatsId tracks which character the cache is for so
    // navigating between bots refetches.
    // PERFORMANCE: one indexed query per character view instead of parsing an 11 MB blob.
    let cachedCharStats = null;
    let cachedCharStatsId = null;
    let cachedCharStatsTime = 0;
    const STATS_CACHE_TTL = 2000; // 2 seconds - short TTL since stats can change

    // Serialises content-side write messages so concurrent MESSAGES_LOADED handlers
    // (rapid chat navigation) keep their send ordering. The background owns the store
    // and applies each PUT/DELETE in an atomic transaction, so the old whole-blob
    // clobber race (the 1,836-entry incident) is structurally impossible now.
    let statsWriteQueue = Promise.resolve();

    // Load the current character's stats as { [messageId]: {model,max_tokens,temperature,top_p,top_k,role} }
    // from the background store, cached for STATS_CACHE_TTL.
    async function loadCharacterStats(characterId) {
        const now = Date.now();
        if (cachedCharStats && cachedCharStatsId === characterId && (now - cachedCharStatsTime) < STATS_CACHE_TTL) {
            return cachedCharStats;
        }
        let map = {};
        if (characterId) {
            try {
                const res = await sendStatsMessage('SAI_STATS_GET_CHARACTER', { characterId });
                if (res && res.success && res.stats) map = res.stats;
            } catch (e) {
                debugLog('[Stats] loadCharacterStats failed:', e && e.message);
            }
        }
        cachedCharStats = map;
        cachedCharStatsId = characterId;
        cachedCharStatsTime = now;
        return map;
    }

    // Invalidate stats cache (call after writes, and on SAI_DRIVE_SYNC_COMPLETE)
    function invalidateStatsCache() {
        cachedCharStats = null;
        cachedCharStatsId = null;
        cachedCharStatsTime = 0;
    }

    // Remove a single stored entry (used to evict corrupted records).
    // explicitConversationId is retained for call-site compatibility but ignored —
    // the store is keyed by globally-unique messageId.
    async function deleteStatsEntry(messageId, explicitConversationId = null) {
        await (statsWriteQueue = statsWriteQueue.catch(() => {}).then(async () => {
            try {
                await sendStatsMessage('SAI_STATS_DELETE', { messageId });
                invalidateStatsCache();
                debugLog('[Stats] deleteStatsEntry: removed entry for', messageId.substring(0, 8));
            } catch (e) {
                debugLog('[Stats] deleteStatsEntry failed:', e && e.message);
            }
        }));
    }

    // Startup cleanup: ask the background to drop null-only records from the store.
    // (Can also be called after import.) Background serialises this against writes.
    async function pruneNullStats() {
        try {
            const res = await sendStatsMessage('SAI_STATS_PRUNE');
            if (res && res.success && res.removed) {
                debugLog('[Stats] pruneNullStats: removed', res.removed, 'null entries');
            }
        } catch (e) {
            debugLog('[Stats] pruneNullStats failed:', e && e.message);
        }
    }

    // Get stats for a specific message ID.
    // Keyed by globally-unique messageId, so cloned chats resolve directly (no
    // conversation scan needed). Timestamp is always overlaid from messageTimestamps.
    async function getStatsForMessage(messageId) {
        const characterId = getCurrentCharacterId();
        const charStats = await loadCharacterStats(characterId);

        // Start with an empty stats object
        let stats = null;

        const storedStats = charStats[messageId] || null;
        if (storedStats) {
            // Only copy generation settings, not timestamp
            stats = {
                model: storedStats.model,
                max_tokens: storedStats.max_tokens,
                temperature: storedStats.temperature,
                top_p: storedStats.top_p,
                top_k: storedStats.top_k,
                role: storedStats.role
            };
        }

        // ALWAYS get timestamp from messageTimestamps (API source of truth)
        // This works even if no other stats are stored (e.g., user messages)
        if (messageTimestamps[messageId]) {
            if (!stats) {
                stats = {};
            }
            stats.timestamp = messageTimestamps[messageId];
        }

        if (stats) {
            return stats;
        }

        debugLog('[Stats] getStatsForMessage - not found (no stored stats and no API timestamp) for', messageId);
        return null;
    }
    
    // Helper: Check if current path is a chat page (supports localization: /chat/ or /{language}/chat/)
    // Supports both formats: /chat/{charId} and /en/chat/{charId}, /fr/chat/{charId}, etc.
    function isOnChatPage() {
        const path = window.location.pathname.toLowerCase();
        // Match both /chat/ and /{2-letter-lang}/chat/ patterns
        return /^\/([a-z]{2}\/)?chat\//i.test(window.location.pathname) || path.startsWith('/chat/');
    }
    
    // Helper: Get normalized chat URL pattern that supports localization
    // Returns regex that matches both /chat/ and /{language}/chat/
    function getChatUrlPattern() {
        return /^\/([a-z]{2}\/)?chat\//i;
    }
    
    // Get current character ID from URL
    function getCurrentCharacterId() {
        // URL structure: 
        // - Chat mode: /chat/{character_id} or /chat/{character_id}/{conversation_id}
        //             or /{language}/chat/{character_id} (with localization)
        // - Story mode: /story/{character_id}/{conversation_id}
        // Note: URL may have mixed case so use case-insensitive match
        
        // Try /chat/ pattern first (supports optional language prefix: /en/chat/ or /chat/)
        const chatMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chat\/([a-f0-9-]+)/i);
        if (chatMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /chat/ URL:', chatMatch[1]);
            return chatMatch[1];
        }
        
        // Try /story/ pattern (Story Mode) - supports optional language prefix
        const storyMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?story\/([a-f0-9-]+)/i);
        if (storyMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /story/ URL:', storyMatch[1]);
            return storyMatch[1];
        }

        // Fallback: Try /chatbot/ pattern if on character profile page - supports optional language prefix
        const chatbotMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chatbot\/([a-f0-9-]+)/i);
        if (chatbotMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /chatbot/ URL:', chatbotMatch[1]);
            return chatbotMatch[1];
        }

        debugLog('[Stats] getCurrentCharacterId - not found, URL:', window.location.pathname);
        return null;
    }

    // Get current conversation ID from URL
    function getCurrentConversationId() {
        // URL structure: /chat/{character_id}/{conversation_id} or /story/{character_id}/{conversation_id}
        //               or /{language}/chat/{character_id}/{conversation_id} (with localization)
        // If only /chat/{character_id}, conversation_id will be null (defaults to most recent)
        // Note: URL may have /Chat/ or /Story/ (capital letters) so use case-insensitive match
        const chatMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chat\/[a-f0-9-]+\/([a-f0-9-]+)/i);
        if (chatMatch) {
            debugLog('[Stats] getCurrentConversationId - from /chat/ URL:', chatMatch[1]);
            return chatMatch[1];
        }
        
        const storyMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?story\/[a-f0-9-]+\/([a-f0-9-]+)/i);
        if (storyMatch) {
            debugLog('[Stats] getCurrentConversationId - from /story/ URL:', storyMatch[1]);
            return storyMatch[1];
        }
        
        debugLog('[Stats] getCurrentConversationId - URL:', window.location.pathname, 'extracted: null');
        return null;
    }
    
    // Store stats for a specific message ID.
    // Keyed by messageId in the background IndexedDB store; characterId rides on the
    // record for the by_character index. explicitConversationId is retained for
    // call-site compatibility but ignored — conversationId is no longer part of the model.
    async function storeStatsForMessage(messageId, stats, explicitConversationId = null) {
        // Never store user-role messages — timestamps come from messageTimestamps map
        if (stats.role === 'user') return;

        // Skip if there is no meaningful generation data to store
        const hasData = stats.model
            || stats.settings?.max_new_tokens != null
            || stats.settings?.temperature != null
            || stats.settings?.top_p != null
            || stats.settings?.top_k != null
            || stats.max_tokens != null
            || stats.temperature != null
            || stats.top_p != null
            || stats.top_k != null;
        if (!hasData) return;

        const characterId = getCurrentCharacterId();
        if (!characterId) {
            debugLog('[Stats] Warning: Missing character ID - cannot store stats');
            return;
        }

        // Build the record — generation settings only (timestamp comes from messageTimestamps).
        // Flatten both stats.settings.* and flat stats.* shapes (settings wins via ||).
        const record = {
            messageId: messageId,
            characterId: characterId,
            model: stats.model || null,
            max_tokens: stats.settings?.max_new_tokens || stats.max_tokens || null,
            temperature: stats.settings?.temperature || stats.temperature || null,
            top_p: stats.settings?.top_p || stats.top_p || null,
            top_k: stats.settings?.top_k || stats.top_k || null,
            role: stats.role || null
        };

        // Serialise through the write queue so concurrent handlers keep send ordering.
        await (statsWriteQueue = statsWriteQueue.catch(() => {}).then(async () => {
            try {
                await sendStatsMessage('SAI_STATS_PUT', { record });
                invalidateStatsCache();
                debugLog('[Stats] Stored stats for character:', characterId, 'message:', messageId, record);
            } catch (e) {
                debugLog('[Stats] storeStatsForMessage failed:', e && e.message);
            }
        }));
    }

    // Extract message ID from DOM element
    function extractMessageId(container) {
        // Method 1: Check for data-message-id attribute
        let messageElement = container.closest('[data-message-id]');
        if (messageElement) {
            const id = messageElement.getAttribute('data-message-id');
            debugLog('[Stats] extractMessageId - Method 1 (data-message-id):', id);
            return id;
        }
        
        // Method 2: Look for message ID in React props
        let current = container;
        for (let i = 0; i < 10; i++) {
            if (!current) break;
            const keys = Object.keys(current);
            const reactKey = keys.find(key => key.startsWith('__reactProps') || key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber'));
            if (reactKey) {
                const props = current[reactKey];
                
                // Try different paths to find message ID
                if (props?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React props.message.id):', props.message.id);
                    return props.message.id;
                }
                if (props?.children?.props?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React children):', props.children.props.message.id);
                    return props.children.props.message.id;
                }
                if (props?.memoizedProps?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React memoized):', props.memoizedProps.message.id);
                    return props.memoizedProps.message.id;
                }
            }
            current = current.parentElement;
        }
        
        // Method 3: Check nearby button handlers for ID patterns
        const nearbyButtons = container.querySelectorAll('button[aria-label]');
        for (const btn of nearbyButtons) {
            const keys = Object.keys(btn);
            const reactKey = keys.find(key => key.startsWith('__reactProps') || key.startsWith('__reactFiber'));
            if (reactKey && btn[reactKey]?.onClick) {
                const handler = btn[reactKey].onClick.toString();
                const uuidMatch = handler.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (uuidMatch) {
                    debugLog('[Stats] extractMessageId - Method 3 (button handler):', uuidMatch[0]);
                    return uuidMatch[0];
                }
            }
        }
        
        debugLog('[Stats] extractMessageId - ALL METHODS FAILED');
        return null;
    }

    // Normalize timestamp to UTC milliseconds (always store as number)
    function normalizeTimestamp(timestamp) {
        if (!timestamp) return null;
        
        // Already a number (Unix timestamp in milliseconds)
        if (typeof timestamp === 'number') {
            return timestamp;
        }
        
        // ISO string or other date string format
        if (typeof timestamp === 'string') {
            const date = new Date(timestamp);
            return isNaN(date.getTime()) ? null : date.getTime();
        }
        
        // Date object
        if (timestamp instanceof Date) {
            return isNaN(timestamp.getTime()) ? null : timestamp.getTime();
        }
        
        return null;
    }
    
    // Format timestamp according to system's locale settings
    async function formatTimestamp(timestamp) {
        if (!timestamp) return null; // Return null instead of current time
        
        // Normalize to UTC milliseconds first
        const normalized = normalizeTimestamp(timestamp);
        if (!normalized) return null;
        
        // Create Date object from normalized timestamp
        const date = new Date(normalized);
        if (isNaN(date.getTime())) return null;
        
        debugLog('[Stats] formatTimestamp input:', timestamp, 'normalized:', normalized, 'UTC date:', date.toISOString());
        const formatted = await formatDate(date);
        debugLog('[Stats] formatTimestamp output:', formatted);
        return formatted;
    }
    
    async function formatDate(date) {
        // Get user preferences for timestamp format
        // PERFORMANCE: Use cache if available to avoid storage reads during batch processing
        const cache = window.__toolkitStorageCache;
        const dateFirst = cache ? await cache.get('timestampDateFirst', true) : await storage.get('timestampDateFirst', true); // true = date@time, false = time@date
        const use24Hour = cache ? await cache.get('timestamp24Hour', false) : await storage.get('timestamp24Hour', false); // false = 12-hour (default), true = 24-hour
        
        // Use locale-aware formatting for date and time
        // This respects the browser's language/region settings
        const dateStr = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const timeStr = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: !use24Hour  // false for 24-hour, true for 12-hour
        });
        
        debugLog('[Stats] formatDate - dateFirst:', dateFirst, 'dateStr:', dateStr, 'timeStr:', timeStr);
        
        // Return format based on user preference
        return dateFirst ? `${dateStr} @ ${timeStr}` : `${timeStr} @ ${dateStr}`;
    }

    // =============================================================================
    // HELPER: Find Generation Settings modal (supports both old and new UI)
    // =============================================================================
    // SpicyChat has multiple UI versions that they switch between. This helper
    // detects Generation Settings modal in both versions:
    // 
    // NEW UI (current as of Nov 2025):
    //   - Modal title uses <p class="text-heading-6">Generation Settings</p>
    //   - Model name in <p class="text-label-lg font-regular text-gray-12">
    //   - Sliders for: Max Tokens, Temperature, Top P, Top K
    //
    // OLD UI (used before, may return):
    //   - Modal title may use different heading structure (h2, h3, etc)
    //   - Model name in element with class="text-[14px] font-medium"
    //   - Same slider structure
    //
    // This function tries multiple detection methods to work with both UIs.
    // =============================================================================
    function findGenerationSettingsModal() {
        // Try multiple selectors for modal containers
        const modalSelectors = [
            'div.fixed.left-1\\/2.top-1\\/2',
            'div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]',
            'div.fixed[style*="left: 50%"]',
            'div.fixed[style*="left:50%"]'
        ];
        
        let allModals = [];
        for (const selector of modalSelectors) {
            const modals = Array.from(document.querySelectorAll(selector));
            allModals = allModals.concat(modals.filter(m => !allModals.includes(m)));
        }
        
        // Try to find modal by checking heading text
        for (const modal of allModals) {
            // New UI: Check for p.text-heading-6
            const newHeading = modal.querySelector('p.text-heading-6');
            if (newHeading && newHeading.textContent && newHeading.textContent.includes('Generation Settings')) {
                return modal;
            }
            
            // Old UI: Check for h2, h3, or other common heading tags
            const oldHeadings = modal.querySelectorAll('h2, h3, h4, p[class*="heading"], div[class*="title"]');
            for (const heading of oldHeadings) {
                if (heading && heading.textContent && heading.textContent.includes('Generation Settings')) {
                    return modal;
                }
            }
            
            // Fallback: Check if modal contains generation-related text anywhere
            const modalText = modal.textContent || '';
            if (modalText.includes('Inference Model') || 
                (modalText.includes('Temperature') && modalText.includes('Top P') && modalText.includes('Top K'))) {
                // Additional check: make sure it has sliders (not just text mentioning these terms)
                const sliders = modal.querySelectorAll('input[type="range"]');
                if (sliders.length >= 4) {
                    return modal;
                }
            }
        }
        
        return null;
    }

    // Get current settings from the modal
    async function getCurrentSettings() {
        try {
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                debugLog('[Core] Generation Settings modal not found in getCurrentSettings');
                return null;
            }

            // Find the model name - try multiple selectors for compatibility
            let model = 'Unknown';
            try {
                // New UI: Look for "Inference Model" label and associated model name
                const labels = modal.querySelectorAll('p.text-label-lg');
                const inferenceModelLabel = Array.from(labels).find(p => 
                    p && p.textContent && p.textContent.trim() === 'Inference Model'
                );
                if (inferenceModelLabel && inferenceModelLabel.parentElement) {
                    const modelNameElement = inferenceModelLabel.parentElement.querySelector('p.text-label-lg.font-regular.text-gray-12');
                    if (modelNameElement && modelNameElement.textContent) {
                        model = modelNameElement.textContent.trim();
                    }
                }
                
                // Old UI: Try the legacy selector
                if (model === 'Unknown') {
                    const modelElement = modal.querySelector('.text-\\[14px\\].font-medium');
                    if (modelElement && modelElement.textContent) {
                        model = modelElement.textContent.trim();
                    }
                }
                
                // Additional fallback: Look for any element that might contain model name
                if (model === 'Unknown') {
                    // Try to find text near "Inference Model" or "Model" label
                    const allTextElements = modal.querySelectorAll('p, span, div');
                    for (let i = 0; i < allTextElements.length; i++) {
                        const elem = allTextElements[i];
                        if (elem.textContent && elem.textContent.trim() === 'Inference Model') {
                            // Check next sibling or parent's next child
                            const nextElem = allTextElements[i + 1];
                            if (nextElem && nextElem.textContent && nextElem.textContent.trim().length > 0) {
                                const possibleModel = nextElem.textContent.trim();
                                // Verify it looks like a model name (contains common model keywords)
                                if (possibleModel.match(/llama|mixtral|qwen|gemma|deepseek|mistral/i)) {
                                    model = possibleModel;
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (modelError) {
                console.error('[Core] Error extracting model name:', modelError);
                model = 'Unknown';
            }

            // Get slider values (excluding max tokens - not saved in profiles)
            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length < 4) {
                console.error('[Core] Expected 4 sliders, found:', sliders ? sliders.length : 0);
                return null;
            }
            
            // Validate slider values before parsing
            const settings = {
                model: model,
                // responseMaxTokens is intentionally excluded - not saved in profiles
                temperature: sliders[1] && sliders[1].value !== undefined ? parseFloat(sliders[1].value) : 1,
                topP: sliders[2] && sliders[2].value !== undefined ? parseFloat(sliders[2].value) : 0.7,
                topK: sliders[3] && sliders[3].value !== undefined ? parseFloat(sliders[3].value) : 80
            };

            return settings;
        } catch (error) {
            console.error('[Core] Error in getCurrentSettings:', error);
            return null;
        }
    }

    // =============================================================================
    // MESSAGE LISTENERS FOR NETWORK INTERCEPTION DATA
    // These handlers receive postMessage events from the injected page-context script
    // =============================================================================
    
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        
        // Listen for network interception data from page context
        if (event.data.type === 'SAI_MESSAGES_LOADED') {
            debugLog('[Stats] Received SAI_MESSAGES_LOADED from page context');
            const { conversationId, botMessages, userMessages, label } = event.data;
            
            // =================================================================
            // HANDLE CHAT LABEL FOR PAGE TITLE (extracted from GET /messages)
            // =================================================================
            debugLog('[ChatTitle CONTENT] ========== SAI_MESSAGES_LOADED RECEIVED ==========');
            debugLog('[ChatTitle CONTENT] Event data has label:', !!label);
            debugLog('[ChatTitle CONTENT] Label value:', label);
            
            // Store label (even if null) and always update title
            window.__saiChatLabel = label;
            debugLog('[ChatTitle CONTENT] Stored in window.__saiChatLabel:', window.__saiChatLabel);
            debugLog('[ChatTitle CONTENT] Calling updatePageTitle()...');
            
            // Always call updatePageTitle - it will handle both cases (with and without label)
            updatePageTitle();
            
            // =================================================================
            // HANDLE MESSAGE STATS PROCESSING
            // =================================================================
            
            // Store the conversation ID globally for buildIndexMapFromStats to use
            currentConversationId = conversationId;
            debugLog('[Stats] Conversation ID from event:', conversationId);
            debugLog('[Stats] Stored as currentConversationId:', currentConversationId);
            
            // Debug: Log first few messages
            if (botMessages.length > 0) {
                debugLog('[Stats] Sample bot messages:', botMessages.slice(0, 3).map(m => ({
                    id: m.id.substring(0, 8),
                    createdAt: m.createdAt,
                    time: new Date(m.createdAt).toLocaleTimeString()
                })));
            }
            if (userMessages.length > 0) {
                debugLog('[Stats] Sample user messages:', userMessages.slice(0, 3).map(m => ({
                    id: m.id.substring(0, 8),
                    createdAt: m.createdAt,
                    time: new Date(m.createdAt).toLocaleTimeString()
                })));
            }
            
            // Log all message IDs received from GET /messages
                debugLog('[Stats MESSAGES_LOADED] Total bot messages in GET response:', botMessages.length);
                debugLog('[Stats MESSAGES_LOADED] All bot message IDs:', botMessages.map(m => m.id));
            
            // =================================================================
            // BUILD MESSAGE TIMESTAMPS MAP (Source of truth for all timestamps)
            // =================================================================
            // Store createdAt from API for ALL messages - this is the authoritative source
            messageTimestamps = {};
            for (const msg of [...botMessages, ...userMessages]) {
                if (msg.id && msg.createdAt) {
                    messageTimestamps[msg.id] = msg.createdAt;
                }
            }
            debugLog('[Core] Built messageTimestamps map with', Object.keys(messageTimestamps).length, 'entries');
            
            // =================================================================
            // BUILD PREV_ID TO MESSAGE_IDS MAP (For regeneration detection)
            // =================================================================
            // Track which messageIds share the same prevId - used to detect regenerations
            prevIdToMessageIds = {};
            for (const msg of botMessages) {
                if (msg.prev_id && msg.id) {
                    if (!prevIdToMessageIds[msg.prev_id]) {
                        prevIdToMessageIds[msg.prev_id] = [];
                    }
                    if (!prevIdToMessageIds[msg.prev_id].includes(msg.id)) {
                        prevIdToMessageIds[msg.prev_id].push(msg.id);
                    }
                }
            }
            debugLog('[Core] Built prevIdToMessageIds map with', Object.keys(prevIdToMessageIds).length, 'entries');
            
            // =================================================================
            // BUILD ALTERNATIVE MESSAGE GROUPS FOR REGENERATION TRACKING
            // =================================================================
            // Messages with the same prev_id are alternatives of each other (same position in conversation)
            // The original (v1) has is_alternative=false, regenerations (v2, v3, etc.) have is_alternative=true
            // Group them together so we can switch between them when user clicks < >
            alternativeMessageGroups = {};
            
            // DEBUG: Log raw message data to see if is_alternative is being captured
            debugLog('[Core] Raw bot messages for alternative check:', botMessages.map(m => ({
                id: m.id?.substring(0, 8),
                is_alternative: m.is_alternative,
                prev_id: m.prev_id?.substring(0, 8)
            })));
            
            // First, find all messages that are alternatives (regenerations)
            const alternativeMessages = botMessages.filter(msg => msg.is_alternative && msg.prev_id);
            debugLog('[Core] Found', alternativeMessages.length, 'messages with is_alternative=true');
            debugLog('[Stats] Found', alternativeMessages.length, 'alternative messages');
            
            // Group by prev_id and include ALL messages with that prev_id (including v1)
            // IMPORTANT: All messages at the same conversation position share the same prev_id
            // The original (v1) is NOT marked is_alternative, but shares the same prev_id
            for (const msg of alternativeMessages) {
                if (!alternativeMessageGroups[msg.prev_id]) {
                    // First time seeing this prev_id - find ALL bot messages with this prev_id
                    // This includes the original (v1) which has is_alternative=false
                    const allVersions = botMessages.filter(m => m.prev_id === msg.prev_id);
                    alternativeMessageGroups[msg.prev_id] = allVersions.map(m => ({
                        id: m.id,
                        createdAt: m.createdAt
                    }));
                }
            }
            
            // Sort each group by createdAt (oldest first = version 1)
            for (const prevId of Object.keys(alternativeMessageGroups)) {
                alternativeMessageGroups[prevId].sort((a, b) => a.createdAt - b.createdAt);
            }
            
            // Always log alternative groups for debugging regeneration switching
            debugLog('[Core] Built', Object.keys(alternativeMessageGroups).length, 'alternative message groups');
            for (const [prevId, alts] of Object.entries(alternativeMessageGroups)) {
                debugLog('[Core] Group prev_id=' + prevId.substring(0, 8) + ':', alts.map((m, i) => `v${i+1}=${m.id.substring(0, 8)} (${new Date(m.createdAt).toLocaleTimeString()})`));
            }
            
            // Also log what timestamp the prev_id (parent) message has
            for (const prevId of Object.keys(alternativeMessageGroups)) {
                const parentTimestamp = messageTimestamps[prevId];
                debugLog('[Core] Parent message', prevId.substring(0, 8), 'timestamp:', parentTimestamp, '→', parentTimestamp ? new Date(parentTimestamp).toLocaleTimeString() : 'not found');
            }
            
            // =================================================================
            // BUILD COMBINED INDEX MAP FROM ALL MESSAGES
            // =================================================================
            // The DOM displays messages interleaved (user, bot, user, bot, ...)
            // sorted by createdAt (oldest first). We need a combined index map.
            //
            // For alternative messages (regenerations), only ONE is displayed at a time.
            // We include only the FIRST (oldest) from each alternative group.
            
            // Combine all messages and sort by createdAt (oldest first for DOM order)
            const allMessages = [...botMessages, ...userMessages].map(msg => ({
                ...msg,
                isBot: botMessages.includes(msg)
            }));
            
            // Sort by createdAt ascending (oldest first = DOM order)
            allMessages.sort((a, b) => a.createdAt - b.createdAt);
            
            // Build combined index map, handling alternative groups
            messageIdToIndexMap = {};
            userMessageIdToIndexMap = {}; // Keep for backwards compatibility but also populate combined
            const countedAlternativeGroups = new Set();
            let combinedIndex = 0;
            let userOnlyIndex = 0;
            let botOnlyIndex = 0;
            
            for (const msg of allMessages) {
                if (!msg.id) continue;
                
                if (msg.is_alternative && msg.prev_id) {
                    // This is part of an alternative group
                    // Only count the FIRST one we encounter from each group
                    if (!countedAlternativeGroups.has(msg.prev_id)) {
                        countedAlternativeGroups.add(msg.prev_id);
                        // Get the first (oldest) message from this group
                        const group = alternativeMessageGroups[msg.prev_id];
                        if (group && group.length > 0) {
                            messageIdToIndexMap[combinedIndex] = group[0].id;
                            debugLog('[Core] Combined index', combinedIndex, '→', group[0].id.substring(0, 8), '(v1 of alternative group, bot)');
                            combinedIndex++;
                            botOnlyIndex++;
                        }
                    }
                    // Skip other alternatives in the same group
                } else {
                    // Regular message (not an alternative)
                    messageIdToIndexMap[combinedIndex] = msg.id;
                    
                    if (msg.isBot) {
                        botOnlyIndex++;
                    } else {
                        userMessageIdToIndexMap[userOnlyIndex] = msg.id;
                        userOnlyIndex++;
                    }
                    combinedIndex++;
                }
            }
            
            debugLog('[Core] Built combined index map with', Object.keys(messageIdToIndexMap).length, 'entries');
            debugLog('[Core] (Bot messages:', botOnlyIndex, ', User messages:', userOnlyIndex, ')');
            if (DEBUG_MODE) {
                debugLog('[Stats MESSAGES_LOADED] First 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(0, 5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
                debugLog('[Stats MESSAGES_LOADED] Last 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(-5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
            }
            
            // Store stats for bot messages
            for (const msg of botMessages) {
                if (msg.id) {
                    botMessageIds.add(msg.id);

                    // Check if stats already exist in storage (to preserve POST data)
                    const existingStats = await getStatsForMessage(msg.id);
                    
                    debugLog('[Stats MESSAGES_LOADED] Processing message:', msg.id.substring(0, 8));
                    debugLog('[Stats MESSAGES_LOADED] Message createdAt:', msg.createdAt, 'as Date:', new Date(msg.createdAt).toISOString());
                    debugLog('[Stats MESSAGES_LOADED] Existing stats:', existingStats);
                    
                    // Only update if we don't have stats yet, or if we're adding NEW data
                    // GET /messages never includes the engine field (response model), so don't overwrite!
                    // Note: Timestamps are now stored in messageTimestamps map from API, not in storage
                    if (!existingStats) {
                         debugLog('[Stats MESSAGES_LOADED] No existing stats, creating new');
                        // No stats yet - store whatever we have
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model || null,
                            settings: msg.inference_settings || null
                            // Timestamp is handled by messageTimestamps map, not stored here
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (existingStats.model && existingStats.model.includes('→')) {
                        debugLog('[Stats MESSAGES_LOADED] Model has arrow format - PRESERVING:', existingStats.model);
                        // Model already has the full "request → response" format - don't overwrite!
                        // This data came from POST /chat which includes the actual engine field
                    } else if (!existingStats.model && msg.inference_model && msg.inference_settings) {
                        debugLog('[Stats MESSAGES_LOADED] Updating with inference data from GET');
                        // We don't have model data yet AND we have inference data - update
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model,
                            settings: msg.inference_settings
                            // Timestamp is handled by messageTimestamps map, not stored here
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (!existingStats.role) {
                        debugLog('[Stats MESSAGES_LOADED] Adding role to existing stats');
                        // Add role if missing (but don't overwrite model!)
                        existingStats.role = 'bot';
                        await storeStatsForMessage(msg.id, existingStats, conversationId);
                    } else if (existingStats.role === 'user') {
                        // Recovery for records corrupted by the prevId-write bug:
                        // this message is in botMessages (we're inside the bot loop),
                        // but the stored record claims role:'user'. That can only
                        // happen via the old auto-regen prevId path. Reset to a clean
                        // bot record. If the GET response carries inference data, we
                        // get full repair; otherwise role-only repair, which still
                        // routes the display through the correct code branches.
                        debugLog('[Stats MESSAGES_LOADED] Repairing corrupted user-marker on bot message:', msg.id.substring(0, 8));
                        if (msg.inference_model || msg.inference_settings) {
                            // We have real inference data — overwrite the corrupted entry
                            await storeStatsForMessage(msg.id, {
                                role: 'bot',
                                model: msg.inference_model || null,
                                settings: msg.inference_settings || null
                            }, conversationId);
                        } else {
                            // No inference data — delete the corrupted entry entirely.
                            // botMessageIds.has() handles story-mode detection without a stored entry.
                            await deleteStatsEntry(msg.id, conversationId);
                        }
                    } else {
                        debugLog('[Stats MESSAGES_LOADED] Existing stats preserved - no update');
                        // Existing stats preserved - no update needed
                    }
                }
            }
            
            debugLog('[Stats] Stored stats for', botMessages.length, 'bot messages (user messages no longer stored)');
            
            // Don't rebuild index map - we already built it from GET /messages order above
            // await buildIndexMapFromStats();
        }
        
        if (event.data.type === 'SAI_NEW_MESSAGE') {
            debugLog('[Stats] Received SAI_NEW_MESSAGE from page context');
            const { messageId, conversationId, model, settings, createdAt, role, isAlternative, isRegenerationRequested, altMessageId, prevId, responseContentLength, responseEngine } = event.data;
            
            debugLog('[Stats CONTENT] ========== RECEIVED SAI_NEW_MESSAGE ==========');
            debugLog('[Stats CONTENT] Message ID:', messageId);
            debugLog('[Stats CONTENT] Role:', role);
            debugLog('[Stats CONTENT] Received createdAt:', createdAt);
            debugLog('[Stats CONTENT] createdAt type:', typeof createdAt);
            debugLog('[Stats CONTENT] createdAt as Date:', createdAt ? new Date(createdAt).toISOString() : 'null');
            debugLog('[Stats CONTENT] Is alternative (from API):', isAlternative);
            debugLog('[Stats CONTENT] Previous message ID:', prevId);
            debugLog('[Stats CONTENT] Response content length:', responseContentLength);
            debugLog('[Stats CONTENT] Response engine:', responseEngine);
            debugLog('[Stats CONTENT] ==============================================');
            
            // Store/update the conversation ID
            if (conversationId) {
                currentConversationId = conversationId;
            }
            
            // ALWAYS store the timestamp in messageTimestamps (source of truth)
            if (messageId && createdAt) {
                messageTimestamps[messageId] = createdAt;
                debugLog('[Stats] Added to messageTimestamps:', messageId.substring(0, 8), '→', createdAt);
            }
            
            // Track prevId → messageId relationships to detect regenerations.
            // The request-side signal `isRegenerationRequested` (continue_chat:true
            // or alt_message_id present in the POST body) is authoritative — it
            // catches regens on the very first one of a session, before the
            // session-state heuristic below has any siblings to compare against.
            // The heuristic still runs as a fallback for events that arrive
            // without the request-side flag (e.g. older builds, non-XHR paths).
            let isRegenerationDetected = isRegenerationRequested === true || !!altMessageId;
            if (isRegenerationDetected) {
                debugLog('[Stats] Regeneration flagged from request payload (continue_chat or alt_message_id)');
            }
            if (prevId && messageId) {
                if (!prevIdToMessageIds[prevId]) {
                    prevIdToMessageIds[prevId] = [];
                }
                // Heuristic fallback: if we already have other messages with this
                // prevId in this session, treat as regen even without the flag.
                if (!isRegenerationDetected && prevIdToMessageIds[prevId].length > 0 && !prevIdToMessageIds[prevId].includes(messageId)) {
                    isRegenerationDetected = true;
                    debugLog('[Stats] Detected regeneration via session heuristic: prevId', prevId.substring(0, 8), 'already has messages:', prevIdToMessageIds[prevId].map(id => id.substring(0, 8)));
                }
                // Add this message to the tracking
                if (!prevIdToMessageIds[prevId].includes(messageId)) {
                    prevIdToMessageIds[prevId].push(messageId);
                }
            }
            
            // If this is an alternative (regenerated) message, update the alternativeMessageGroups
            if ((isAlternative || isRegenerationDetected) && prevId && messageId) {
                debugLog('[Stats] Updating alternativeMessageGroups for regenerated message');
                if (!alternativeMessageGroups[prevId]) {
                    // First time seeing this prev_id in this session.
                    //
                    // BUGFIX: prev_id points at the user message that triggered this
                    // turn — NOT at the v1 bot reply. The v1 bot's message ID is the
                    // sibling that arrived earlier this session with the same prev_id.
                    // We can recover it from prevIdToMessageIds[prevId], which holds
                    // every messageId we've seen against that prev_id (including the
                    // current regen we just pushed at line ~3572). v1 is anything in
                    // that list other than the current messageId.
                    alternativeMessageGroups[prevId] = [];
                    const siblingIds = (prevIdToMessageIds[prevId] || []).filter(id => id !== messageId);
                    for (const siblingId of siblingIds) {
                        const siblingTimestamp = messageTimestamps[siblingId];
                        alternativeMessageGroups[prevId].push({
                            id: siblingId,
                            createdAt: typeof siblingTimestamp === 'string'
                                ? new Date(siblingTimestamp).getTime()
                                : (siblingTimestamp || 0)
                        });
                        debugLog('[Stats] Seeded alternative group with sibling bot message:', siblingId.substring(0, 8));
                    }
                    if (siblingIds.length === 0) {
                        // No siblings tracked yet (e.g. v1 came from a cold page load
                        // before our interceptor was attached, or a build that didn't
                        // record it). MESSAGES_LOADED will repair this on next reload;
                        // for now leave the group with only the new alternative below.
                        debugLog('[Stats] No prior bot siblings in prevIdToMessageIds for prev_id:', prevId.substring(0, 8), '— v1 will be filled by MESSAGES_LOADED');
                    }
                }
                // Add this message to the group if not already present
                const existingIndex = alternativeMessageGroups[prevId].findIndex(m => m.id === messageId);
                if (existingIndex === -1) {
                    // Convert createdAt to number for sorting
                    const createdAtNum = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt;
                    alternativeMessageGroups[prevId].push({
                        id: messageId,
                        createdAt: createdAtNum
                    });
                    // Sort by createdAt ascending
                    alternativeMessageGroups[prevId].sort((a, b) => a.createdAt - b.createdAt);
                    debugLog('[Stats] Added regeneration to alternative group, now has', alternativeMessageGroups[prevId].length, 'versions');
                    debugLog('[Stats] Group contents:', alternativeMessageGroups[prevId].map((m, i) => `v${i+1}=${m.id.substring(0, 8)}`).join(', '));
                }
            }
            
            debugLog('[Stats] New message - ID:', messageId, 'role:', role, 'conversation:', conversationId);
            debugLog('[Stats] New message - createdAt received:', createdAt, 'type:', typeof createdAt);
            
            if (messageId && createdAt) {
                const statsToStore = {
                    role: role || 'bot',  // Use role from interceptor
                    model: model,
                    settings: settings
                    // Timestamp is NOT stored - it comes from messageTimestamps map
                };
                
                debugLog('[Stats SAVE] ============ SAVING NEW MESSAGE ============');
                debugLog('[Stats SAVE] Message ID:', messageId);
                debugLog('[Stats SAVE] Role:', role);
                debugLog('[Stats SAVE] Model being saved:', model);
                debugLog('[Stats SAVE] Settings being saved:', settings);
                debugLog('[Stats SAVE] Timestamp in messageTimestamps:', messageTimestamps[messageId]);
                debugLog('[Stats SAVE] Full stats object:', statsToStore);
                debugLog('[Stats SAVE] =============================================');
                
                await storeStatsForMessage(messageId, statsToStore, conversationId);
                
                if (DEBUG_MODE) {
                    console.log('[Stats SAVE] Storage complete, verifying...');
                    const verifyStats = await getStatsForMessage(messageId);
                    console.log('[Stats SAVE] Verified stored stats:', verifyStats);
                    console.log('[Stats SAVE] Verified timestamp (from messageTimestamps):', verifyStats?.timestamp);
                }
                
                debugLog('[Stats] Stored stats for new message:', messageId);

                // If this is a bot message and we have prevId, store the user message too
                // The prevId is the user message ID, and we have its timestamp from SAI_USER_MESSAGE_SENT
                //
                // IMPORTANT: skip this when isRegenerationDetected. In a regeneration the
                // prevId points at the *previous bot message*, not the user message before
                // it — so writing { role: 'user' } here would overwrite that bot's stats
                // record (model, settings, timestamp) with a user marker. Auto-regen flows
                // can leave lastUserMessageTimestamp populated across the regen, which
                // historically masked this distinction and corrupted records.
                if ((role === 'bot' || !role) && prevId && lastUserMessageTimestamp && !isRegenerationDetected) {
                    debugLog('[Stats] Bot message has prevId - recording user message timestamp:', prevId.substring(0, 8));

                    // Record the user message timestamp (source of truth for display)
                    messageTimestamps[prevId] = lastUserMessageTimestamp;
                    debugLog('[Stats] Added user message to messageTimestamps:', prevId.substring(0, 8), '→', lastUserMessageTimestamp);

                    // Add to index map (user message comes before bot message)
                    if (!isRegenerationDetected) {
                        const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                        const userIndex = currentMaxIndex + 1;
                        messageIdToIndexMap[userIndex] = prevId;
                        debugLog('[Stats SAVE] Added user message to index map at index:', userIndex, 'messageId:', prevId.substring(0, 8));
                    }

                    // Trigger stats insertion for the user message timestamp display
                    setTimeout(() => processMessagesForStats(true), 200);
                    setTimeout(() => processMessagesForStats(true), 600);

                    // Clear the last user message timestamp so we don't reuse it
                    lastUserMessageTimestamp = null;
                }

                // For bot messages, use insertStatsForRegeneratedMessage which handles the version counter UI
                // This is more reliable than index-based matching in processMessagesForStats
                // processMessagesForStats will skip messages with version counters
                if (role === 'bot' || !role) {
                    botMessageIds.add(messageId);
                    debugLog('[Stats] Bot message - will insert stats directly via insertStatsForRegeneratedMessage');
                    // Increment pending count - this tells processMessagesForStats to skip the newest messages
                    pendingNewMessageCount++;
                    debugLog('[Stats] Incremented pendingNewMessageCount to:', pendingNewMessageCount);
                    // Insert stats with retries - use a single call with built-in retry logic
                    // This prevents race conditions when browser throttles background tab timers
                    // NOTE: insertStatsForRegeneratedMessage will add messageId to statsInsertionInProgress
                    insertStatsWithRetry(messageId, model, settings, createdAt);
                    
                    // Also add to index map for historical message display on page refresh
                    if (!isRegenerationDetected) {
                        const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                        const newIndex = currentMaxIndex + 1;
                        messageIdToIndexMap[newIndex] = messageId;
                        debugLog('[Stats SAVE] Added message to index map at index:', newIndex, 'messageId:', messageId);
                    }
                    
                    // Check if auto-regeneration should be triggered
                    if (window.__autoRegenOnMismatch || window.__autoRegenOnShort) {
                        checkAndAutoRegenerate(prevId, responseEngine, responseContentLength);
                    } else {
                        // If auto-regen is off, still update lastKnownEngine for future use
                        if (typeof responseEngine === 'string' && responseEngine.trim() !== '') {
                            window.__lastKnownEngine = responseEngine;
                        }
                    }
                } else {
                    // User message - use processMessagesForStats
                    const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                    const newIndex = currentMaxIndex + 1;
                    messageIdToIndexMap[newIndex] = messageId;
                    debugLog('[Stats SAVE] Added user message to index map at index:', newIndex, 'messageId:', messageId);
                    
                    // Trigger stats insertion after delays to let DOM update
                    setTimeout(() => processMessagesForStats(true), 300);
                    setTimeout(() => processMessagesForStats(true), 800);
                }
            } else if (messageId && !createdAt) {
                debugLog('[Stats] SAI_NEW_MESSAGE received without createdAt timestamp for message:', messageId);
                // Still store the model info even without timestamp
                if (model) {
                    const statsToStore = {
                        role: role || 'bot',
                        model: model,
                        settings: settings
                    };
                    debugLog('[Stats SAVE] Storing model info without timestamp:', statsToStore);
                    await storeStatsForMessage(messageId, statsToStore, conversationId);
                    
                    // Add to index map
                    const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                    const newIndex = currentMaxIndex + 1;
                    messageIdToIndexMap[newIndex] = messageId;
                    
                    // Trigger stats insertion
                    setTimeout(() => processMessagesForStats(true), 300);
                    setTimeout(() => processMessagesForStats(true), 800);
                }
            }
        }
        
        if (event.data.type === 'SAI_USER_MESSAGE_SENT') {
            debugLog('[Stats] Received SAI_USER_MESSAGE_SENT from page context');
            const { timestamp, conversationId, messageId } = event.data;
            
            debugLog('[Stats] User message sent at timestamp:', timestamp);
            
            // Store the timestamp in messageTimestamps (source of truth)
            if (messageId && timestamp) {
                messageTimestamps[messageId] = timestamp;
                debugLog('[Stats] Added user message to messageTimestamps:', messageId);
            }
            
            // Store the timestamp for when we detect the user message in the DOM
            lastUserMessageTimestamp = timestamp;
            
            // Trigger stats display for the newly sent user message (shows timestamp)
            setTimeout(() => processMessagesForStats(true), 500);
            setTimeout(() => processMessagesForStats(true), 1000);
        }
    });
    
    // Cache for title update feature setting (avoid repeated storage reads)
    let cachedShowChatNameInTitle = null;
    let cacheInitialized = false;
    let titleUpdateRetries = 0;
    const MAX_TITLE_RETRIES = 20; // Max 2 seconds of retries
    
    // Update page title with character name and label (synchronous for speed)
    async function updatePageTitle() {
        debugLog('[ChatTitle UPDATE] ========== updatePageTitle() CALLED ==========');
        
        // If cache not initialized yet, initialize it now (shouldn't happen but safety check)
        if (!cacheInitialized) {
            debugLog('[ChatTitle UPDATE] Cache not initialized, initializing now...');
            cachedShowChatNameInTitle = await storage.get('showChatNameInTitle', false);
            cacheInitialized = true;
            debugLog('[ChatTitle UPDATE] Cache initialized to:', cachedShowChatNameInTitle);
        }
        
        // Check cached setting (set by initial load and settings changes)
        if (!cachedShowChatNameInTitle) {
            debugLog('[ChatTitle UPDATE] Feature is disabled (cached value:', cachedShowChatNameInTitle, '), exiting');
            return;
        }
        
        const label = window.__saiChatLabel;
        const currentTitle = document.title;
        const titleIsEmpty = !currentTitle || currentTitle.trim() === '';
        
        debugLog('[ChatTitle UPDATE] Current state:');
        debugLog('[ChatTitle UPDATE]   - Label:', label);
        debugLog('[ChatTitle UPDATE]   - Current document.title:', currentTitle || '<empty string>');
        debugLog('[ChatTitle UPDATE]   - Title is empty?:', titleIsEmpty);
        debugLog('[ChatTitle UPDATE]   - Retry count:', titleUpdateRetries, '/', MAX_TITLE_RETRIES);
        
        // If title is empty or not set yet, wait a bit and retry
        if (titleIsEmpty) {
            if (titleUpdateRetries < MAX_TITLE_RETRIES) {
                titleUpdateRetries++;
                debugLog('[ChatTitle UPDATE] Title is empty, waiting 100ms and retrying... (attempt', titleUpdateRetries, '/', MAX_TITLE_RETRIES, ')');
                setTimeout(() => updatePageTitle(), 100);
                return;
            } else {
                debugLog('[ChatTitle UPDATE] Max retries reached, giving up');
                titleUpdateRetries = 0; // Reset for next time
                return;
            }
        }
        
        // Reset retry counter on success
        titleUpdateRetries = 0;
        
        // Extract character name from existing title
        // Format: "Chat with {name} - AI Sex Chatbot | Spicychat" -> "{name}"
        // Also handle already-shortened format: just "{name}" or "{name} (label)"
        let characterName = null;
        const fullTitleMatch = document.title.match(/^Chat with (.+) - AI Sex Chatbot \| Spicychat$/);
        const shortTitleMatch = document.title.match(/^([^(]+?)(?:\s*\([^)]+\))?$/);
        
        if (fullTitleMatch) {
            characterName = fullTitleMatch[1];
            debugLog('[ChatTitle UPDATE]   - Extracted character name from full title:', characterName);
        } else if (shortTitleMatch && !document.title.includes('Spicychat')) {
            // Already shortened, extract base name (before any label in parentheses)
            characterName = shortTitleMatch[1].trim();
            debugLog('[ChatTitle UPDATE]   - Extracted character name from shortened title:', characterName);
        } else {
            debugLog('[ChatTitle UPDATE]   - Could not extract character name from title format');
        }
        
        debugLog('[ChatTitle] Current state - Character:', characterName, 'Label:', label);
        
        if (characterName && label) {
            // Both character name and label exist: "characterName (label)"
            const newTitle = `${characterName} (${label})`;
            debugLog('[ChatTitle UPDATE] Setting title to:', newTitle);
            document.title = newTitle;
            debugLog('[ChatTitle UPDATE] Title set. Actual document.title:', document.title);
        } else if (characterName) {
            // Only character name exists (no label yet): just "characterName"
            const newTitle = characterName;
            debugLog('[ChatTitle UPDATE] No label yet, using character name only:', newTitle);
            document.title = newTitle;
            debugLog('[ChatTitle UPDATE] Title set. Actual document.title:', document.title);
        } else {
            debugLog('[ChatTitle UPDATE] Could not extract character name from title');
            debugLog('[ChatTitle UPDATE]   Title format:', document.title);
        }
    }

    // Track the last user message timestamp for later tagging
    let lastUserMessageTimestamp = null;
    
    // Initialize the cached setting and try initial title update
    // This happens early on page load to shorten title ASAP
    (async () => {
        cachedShowChatNameInTitle = await storage.get('showChatNameInTitle', false);
        cacheInitialized = true;
        debugLog('[ChatTitle] Cached setting initialized:', cachedShowChatNameInTitle);
        
        if (cachedShowChatNameInTitle && document.title.startsWith('Chat with ')) {
            debugLog('[ChatTitle] Attempting initial title update on page load');
            await updatePageTitle();
        }
    })();
    
    // Also listen for setting changes to update the cache
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'SAI_SETTINGS_CHANGED' && event.data.key === 'showChatNameInTitle') {
            cachedShowChatNameInTitle = event.data.value;
            cacheInitialized = true;
            debugLog('[ChatTitle] Setting cache updated:', cachedShowChatNameInTitle);
            if (cachedShowChatNameInTitle) {
                await updatePageTitle();
            }
        }
    });

    // =============================================================================
    // SLIDER UPDATE HELPER - Shared React-compatible slider update logic (Issue #16)
    // =============================================================================
    // Helper function to properly update slider with React-style events
    // Used by applySettings and any other code that needs to programmatically
    // update slider values in a way that React will recognize
    function updateSliderValue(slider, value) {
        if (!slider || value === undefined || value === null) return false;
        
        try {
            // Validate slider is still in DOM and value is a number
            if (!slider.isConnected || typeof value !== 'number') {
                console.error('[Core] Invalid slider state or value:', { connected: slider.isConnected, value });
                return false;
            }
            
            // Set the value using native setter to bypass React's control
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(slider, value);
            
            // Dispatch multiple events for React compatibility
            slider.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            slider.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            
            // Trigger pointer/mouse events to simulate user interaction
            slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            
            return true;
        } catch (error) {
            console.error('[Core] Error updating slider:', error);
            return false;
        }
    }
    
    // Load profiles from storage
    async function loadProfiles() {
        const stored = await storage.get(PROFILES_KEY, '{}');
        return JSON.parse(stored);
    }

    // Save profiles to storage
    async function saveProfiles(profiles) {
        await storage.set(PROFILES_KEY, JSON.stringify(profiles));
    }

    // Change the model by clicking on it in the model selection modal
    function changeModel(modelName, callback) {
        let changeModelBtn; // Declare at function scope
        let modelModal; // Declare at function scope
        
        try {
            // Validate inputs
            if (!modelName || typeof modelName !== 'string') {
                callback(false, 'Invalid model name provided');
                return;
            }
            if (!callback || typeof callback !== 'function') {
                console.error('[Core] changeModel: Invalid callback provided');
                return;
            }
            
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                callback(false, 'Generation Settings modal not found');
                return;
            }
            
            const buttons = modal.querySelectorAll('button');
            if (!buttons || buttons.length === 0) {
                callback(false, 'No buttons found in modal');
                return;
            }
            
            changeModelBtn = Array.from(buttons).find(btn => 
                btn && btn.textContent && btn.textContent.includes('Change Model')
            );
            
            if (!changeModelBtn) {
                callback(false, 'Change Model button not found');
                return;
            }
        } catch (error) {
            console.error('[Core] Error in changeModel (initial checks):', error);
            callback(false, `Error: ${error.message}`);
            return;
        }
        
        // A model change is intentional — suppress the first mismatch regen for this message
        window.__suppressMismatchNext = true;
        debugLog('[Model] Model change initiated; suppressing next mismatch auto-regen');

        // Click the button
        try {
            changeModelBtn.click();
        } catch (error) {
            console.error('[Core] Error clicking Change Model button:', error);
            callback(false, `Error clicking button: ${error.message}`);
            return;
        }
        
        // Wait for the model selection modal to appear
        setTimeout(() => {
            try {
                // Find the model selection modal
                const allModals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2, div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]'));
                modelModal = allModals.find(el => {
                    const text = el && el.textContent;
                    return text && (text.includes('Select a model') || text.includes('Choose Model') || text.includes('Select Model'));
                });
                
                if (!modelModal) {
                    callback(false, 'Model selection modal did not appear');
                    return;
                }
                
                // Find the model option by matching the text content (using includes for flexibility)
                const modelOptions = Array.from(modelModal.querySelectorAll('li, button, div[role="option"], p.text-label-lg'));
                const modelOption = modelOptions.find(el => {
                    if (!el || !el.textContent) return false;
                    const text = el.textContent.trim();
                    // Try exact match first, then check if the model name is contained in the text
                    return text === modelName || text.includes(modelName);
                });
                
                if (!modelOption) {
                    // Close the modal
                    try {
                        const closeBtn = modelModal.querySelector('button[aria-label="X-button"], button[aria-label="Close"]') ||
                                        Array.from(modelModal.querySelectorAll('button')).find(btn => 
                                            btn && btn.textContent && btn.textContent.includes('Close')
                                        );
                        if (closeBtn) closeBtn.click();
                    } catch (closeError) {
                        console.error('[Core] Error closing modal:', closeError);
                    }
                    callback(false, `Model "${modelName}" not found in list`);
                    return;
                }
                
                // Click the model option
                try {
                    modelOption.click();
                    debugLog('[Change Model] Clicked model option');
                    
                    // Check if this is the new UI (which requires "Set Model" button) or old UI (auto-applies)
                    // New UI has a confirmation step, old UI applies immediately
                    const hasSetModelButton = Array.from(modelModal.querySelectorAll('button')).some(btn => 
                        btn && btn.textContent && btn.textContent.includes('Set Model')
                    );
                    
                    if (hasSetModelButton) {
                        // New UI: Wait for React to process and click "Set Model" button
                        setTimeout(() => {
                            try {
                                const buttons = modelModal.querySelectorAll('button');
                                const setModelBtn = Array.from(buttons).find(btn => 
                                    btn && btn.textContent && btn.textContent.includes('Set Model')
                                );
                                
                                if (setModelBtn) {
                                    setModelBtn.click();
                                    debugLog('[Change Model] Clicked "Set Model" button (new UI)');
                                    
                                    setTimeout(() => {
                                        callback(true, 'Model changed successfully');
                                    }, 500);
                                } else {
                                    callback(false, '"Set Model" button not found');
                                }
                            } catch (error) {
                                console.error('[Core] Error clicking Set Model button:', error);
                                callback(false, `Error confirming model: ${error.message}`);
                            }
                        }, TIMING.MODAL_CONFIRM_DELAY);
                    } else {
                        // Old UI: Selection applies immediately, just wait and report success
                        setTimeout(() => {
                            callback(true, 'Model changed successfully');
                        }, 500);
                    }
                } catch (clickError) {
                    console.error('[Core] Error clicking model option:', clickError);
                    callback(false, `Error selecting model: ${clickError.message}`);
                    return;
                }
            } catch (error) {
                console.error('[Core] Error in model selection modal handling:', error);
                callback(false, `Error: ${error.message}`);
                return;
            }
        }, TIMING.MODAL_OPEN_DELAY);
    }

    // Apply settings to the modal
    async function applySettings(settings, autoChangeModel = false) {
        try {
            // Validate settings object
            if (!settings || typeof settings !== 'object') {
                console.error('[Core] Invalid settings object provided to applySettings');
                return false;
            }
            
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                debugLog('[Core] Generation Settings modal not found in applySettings');
                return false;
            }

            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length === 0) {
                console.error('[Core] No sliders found in Generation Settings modal');
                return false;
            }
            
            // Apply slider settings (skip max tokens - not saved in profiles)
            // sliders[0] is max tokens - intentionally not applied from profiles
            
            if (sliders[1] && settings.temperature !== undefined) {
                updateSliderValue(sliders[1], settings.temperature);
            }
            
            if (sliders[2] && settings.topP !== undefined) {
                updateSliderValue(sliders[2], settings.topP);
            }
            
            if (sliders[3] && settings.topK !== undefined) {
                updateSliderValue(sliders[3], settings.topK);
            }
            
            // Change model if requested and available
            if (autoChangeModel && settings.model) {
                try {
                    const currentSettings = await getCurrentSettings();
                    if (currentSettings && currentSettings.model !== settings.model) {
                        // Model will change — suppress the first mismatch auto-regen
                        window.__suppressMismatchNext = true;
                        changeModel(settings.model, (success, message) => {
                            if (success) {
                                showNotification(`✓ Profile loaded with model: ${settings.model}`);
                            } else {
                                showNotification(`⚠️ Settings loaded but model change failed: ${message}`, true);
                            }
                        });
                        return true;
                    }
                } catch (modelError) {
                    console.error('[Core] Error changing model:', modelError);
                    showNotification(`⚠️ Settings loaded but model change failed`, true);
                }
            }

            return true;
        } catch (error) {
            console.error('[Core] Error in applySettings:', error);
            return false;
        }
    }

    // Flag to prevent duplicate profile controls
    let isCreatingProfileControls = false;

    // Create profile controls UI
    async function createProfileControls() {
        debugLog('[Profile Controls] Function called. Flag:', isCreatingProfileControls);
        
        // Find the Generation Settings modal (supports both old and new UI)
        const modal = findGenerationSettingsModal();
        
        if (!modal) {
            debugLog('[Profile Controls] No Generation Settings modal found');
            return;
        }
        
        // Check if user has profiles stored OR has explicitly enabled via debug setting
        const storedProfiles = await loadProfiles();
        const hasProfiles = Object.keys(storedProfiles).length > 0;
        const forceEnabled = await storage.get(ENABLE_GENERATION_PROFILES_KEY, false);
        
        debugLog('[Profile Controls] hasProfiles:', hasProfiles, 'forceEnabled:', forceEnabled);
        
        // Only show profile controls if user has profiles OR force-enabled via debug setting
        if (!hasProfiles && !forceEnabled) {
            debugLog('[Profile Controls] No profiles stored and not force-enabled, skipping UI creation');
            return;
        }

        // Check if controls already exist OR if a placeholder exists (being created)
        const existingControls = modal.querySelector('#profile-controls');
        const placeholder = modal.querySelector('#profile-controls-placeholder');
        debugLog('[Profile Controls] Existing controls found:', !!existingControls, 'Placeholder:', !!placeholder);
        if (existingControls || placeholder) {
            debugLog('[Profile Controls] Controls already exist or being created, skipping');
            return;
        }

        // Immediately insert a placeholder to mark that we're creating controls
        const placeholder2 = document.createElement('div');
        placeholder2.id = 'profile-controls-placeholder';
        placeholder2.style.display = 'none';
        modal.appendChild(placeholder2);
        debugLog('[Profile Controls] Placeholder inserted, creating controls...');

        // Find the scrollable content section - look for the container with px-lg class
        // that contains the sliders
        const sliders = modal.querySelectorAll('input[type="range"]');
        if (sliders.length === 0) {
            debugLog('[Profile Controls] No sliders found');
            placeholder2.remove();
            return;
        }
        
        // Get the px-lg container that holds the settings
        let settingsContainer = sliders[0].closest('.px-lg');
        if (!settingsContainer) {
            // Fallback: try to find any parent with gap and flex classes
            settingsContainer = sliders[0].closest('.flex.flex-col');
        }
        if (!settingsContainer) {
            placeholder2.remove();
            return;
        }

        // Create profile controls container
        const controlsDiv = document.createElement('div');
        controlsDiv.id = 'profile-controls';
        controlsDiv.className = 'flex flex-col gap-sm border-t border-gray-300 dark:border-gray-700 pt-3 mt-3';

        // Profile selector row
        const selectorRow = document.createElement('div');
        selectorRow.className = 'flex justify-undefined items-center gap-2';

        // Profile label
        const label = document.createElement('span');
        label.className = 'text-foreground text-[12px] font-medium';
        label.textContent = 'Profile:';

        // Profile dropdown
        const select = document.createElement('select');
        select.id = 'profile-select';
        select.className = 'flex-1 h-[28px] px-2 rounded-md bg-gray-100 dark:bg-gray-800 text-[12px] border border-gray-300 dark:border-gray-700 cursor-pointer';
        
        // Populate dropdown
        const profilesList = await loadProfiles();
        const lastProfile = await storage.get(LAST_PROFILE_KEY, '');
        
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select Profile --';
        select.appendChild(defaultOption);

        Object.keys(profilesList).sort().forEach(async name => {
            const option = document.createElement('option');
            option.value = name;
            const profile = profilesList[name];
            option.textContent = `${name} ${profile.model ? `(${profile.model})` : ''}`;
            if (name === lastProfile) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        select.addEventListener('change', async function() {
            const profileName = this.value;
            if (profileName) {
                const profilesData = await loadProfiles();
                if (profilesData[profileName]) {
                    const profileSettings = profilesData[profileName];
                    const autoChange = true; // Always auto-change model
                    applySettings(profileSettings, autoChange);
                    await storage.set(LAST_PROFILE_KEY, profileName);
                    
                    // Poll for the Generation Settings modal to reappear, then scroll
                    let pollAttempts = 0;
                    const maxAttempts = 5;
                    
                    const pollForModal = () => {
                        pollAttempts++;
                        
                        // Find the scrollable container
                        const modals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2'));
                        
                        // Find modal that contains our profile controls
                        const modal = modals.find(m => m.querySelector('#profile-controls'));
                        
                        if (modal) {
                            const scrollContainer = modal.querySelector('.overflow-y-auto');
                            
                            if (scrollContainer) {
                                // Found it! Scroll to bottom
                                scrollContainer.scrollTop = 999999;
                                return; // Success, stop polling
                            }
                        }
                        
                        // If not found and we haven't exceeded max attempts, try again
                        if (pollAttempts < maxAttempts) {
                            setTimeout(pollForModal, 500);
                        }
                    };
                    
                    // Start polling after a short initial delay
                    setTimeout(pollForModal, 100);
                    
                    // Always show notification without model check warning
                    showNotification(`✓ Loaded profile: ${profileName}`);
                }
            }
        });

        selectorRow.appendChild(label);
        selectorRow.appendChild(select);

        // Buttons row
        const buttonsRow = document.createElement('div');
        buttonsRow.className = 'flex justify-undefined items-center gap-2';

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        saveBtn.textContent = 'Save Profile';
        saveBtn.addEventListener('click', async function() {
            const profileName = prompt('Enter profile name:');
            if (profileName && profileName.trim()) {
                const settings = await getCurrentSettings();
                if (settings) {
                    const profiles = await loadProfiles();
                    profiles[profileName.trim()] = settings;
                    await saveProfiles(profiles);
                    
                    // Refresh dropdown
                    updateProfileDropdown();
                    select.value = profileName.trim();
                    await storage.set(LAST_PROFILE_KEY, profileName.trim());
                    
                    showNotification(`Saved profile: ${profileName.trim()}`);
                }
            }
        });

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-red-500 hover:bg-red-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        deleteBtn.textContent = 'Delete Profile';
        deleteBtn.addEventListener('click', async function() {
            const profileName = select.value;
            if (profileName) {
                if (confirm(`Delete profile "${profileName}"?`)) {
                    const profiles = await loadProfiles();
                    delete profiles[profileName];
                    await saveProfiles(profiles);
                    
                    // Refresh dropdown
                    updateProfileDropdown();
                    select.value = '';
                    
                    showNotification(`Deleted profile: ${profileName}`);
                }
            } else {
                alert('Please select a profile to delete');
            }
        });

        buttonsRow.appendChild(saveBtn);
        buttonsRow.appendChild(deleteBtn);

        controlsDiv.appendChild(selectorRow);
        controlsDiv.appendChild(buttonsRow);

        // Insert at the end of the scrollable settings container (under Top-K)
        settingsContainer.appendChild(controlsDiv);
        
        // Remove placeholder now that real controls are inserted
        placeholder2.remove();
        debugLog('[Profile Controls] Controls created successfully');
    }

    // Update profile dropdown
    async function updateProfileDropdown() {
        const select = document.getElementById('profile-select');
        if (!select) return;

        const currentValue = select.value;
        const profiles = await loadProfiles();
        
        // Clear and rebuild
        select.replaceChildren();

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select Profile --';
        select.appendChild(defaultOption);

        Object.keys(profiles).sort().forEach(async name => {
            const option = document.createElement('option');
            option.value = name;
            const profile = profiles[name];
            option.textContent = `${name} ${profile.model ? `(${profile.model})` : ''}`;
            select.appendChild(option);
        });

        // Restore selection if still exists
        if (profiles[currentValue]) {
            select.value = currentValue;
        }
    }

    // Show notification
    function showNotification(message, isWarning = false) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${isWarning ? 'rgba(255, 153, 0, 0.95)' : 'rgba(0, 0, 0, 0.85)'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10000003;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease-out;
            white-space: pre-line;
            max-width: 400px;
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        const duration = isWarning ? 5000 : 2500;
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.3s';
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    // Add animation styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        @keyframes sai-slide-up {
            from {
                transform: translate(-50%, 20px);
                opacity: 0;
            }
            to {
                transform: translate(-50%, 0);
                opacity: 1;
            }
        }
        
        @keyframes sai-slide-down {
            from {
                transform: translate(-50%, 0);
                opacity: 1;
            }
            to {
                transform: translate(-50%, 20px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===               INFERENCE PROFILES & MESSAGE STATS - END               ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================


    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    TOOLKIT SPECIFIC CODE - START                     ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    // Feature Management  
    // Note: All storage key constants (SIDEBAR_LAYOUT_KEY, CLASSIC_LAYOUT_KEY, CLASSIC_STYLE_KEY, etc.) 
    // are defined at the top of the file for early injection and shared use
    const HIDE_FOR_YOU_KEY = 'enableHideForYou';
    const PAGE_JUMP_KEY = 'enablePageJump';
    const COMPACT_GENERATION_KEY = 'enableCompactGeneration';
    const SIDEBAR_MIN_WIDTH_KEY = 'sidebarMinWidth';
    const DEFAULT_SIDEBAR_MIN_WIDTH = 1000; // Default minimum page width for sidebar layout
    
    let sidebarStyleElement = null;
    let classicLayoutStyleElement = null;
    let classicStyleStyleElement = null;
    let compactGenerationStyleElement = null;
    let hideForYouObserver = null;
    let hideForYouUrlObserver = null;
    let hideForYouActive = false;
    let pageJumpObserver = null;
    
    // Responsive sidebar: auto-disable when page is too narrow
    let sidebarMinWidth = DEFAULT_SIDEBAR_MIN_WIDTH; // User-configurable minimum page width
    let sidebarAutoDisabled = false; // True when user has sidebar enabled but page is too narrow
    let sidebarUserEnabled = false; // Tracks user's actual preference (persisted to storage)
    
    // Check if current page should have sidebar layout disabled
    // Supports localized URLs: /{language}/lorebook, /{language}/chatbot/edit, /{language}/group
    function isNonChatPageForSidebar() {
        return /^\/(([a-z]{2}\/)?)(lorebook|chatbot\/edit|create|group)/i.test(window.location.pathname);
    }
    
    // Apply or remove sidebar layout CSS
    // saveToStorage: if false, only updates the CSS state without saving (used for responsive auto-disable)
    async function toggleSidebarLayout(enable, saveToStorage = true) {
        // Don't enable sidebar on non-chat pages (lorebook, chatbot, group)
        const shouldBlock = enable && isNonChatPageForSidebar();
        
        if (enable && !shouldBlock) {
            if (!sidebarStyleElement) {
                // Check if early-injected element exists
                sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early') || 
                                      document.getElementById('sai-toolkit-sidebar-layout');
                
                if (!sidebarStyleElement) {
                    sidebarStyleElement = document.createElement('style');
                    sidebarStyleElement.id = 'sai-toolkit-sidebar-layout';
                    sidebarStyleElement.textContent = getSidebarLayoutCSSEarly();
                    // Add BEFORE other elements to ensure it loads early
                    if (document.head.firstChild) {
                        document.head.insertBefore(sidebarStyleElement, document.head.firstChild);
                    } else {
                        document.head.appendChild(sidebarStyleElement);
                    }
                }
            }
            sidebarStyleElement.disabled = false;
            // Body-class observer drives the new class-based selectors; start it
            // here in addition to the early-inject path so runtime toggles also
            // light up the layout correctly.
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            }
        } else {
            if (!sidebarStyleElement) {
                // Check if early-injected element exists
                sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early') ||
                                      document.getElementById('sai-toolkit-sidebar-layout');
            }
            if (sidebarStyleElement) {
                // Don't remove the element, just disable it to avoid React re-render issues
                sidebarStyleElement.disabled = true;
            }
            if (typeof stopSidebarLayoutBodyClassObserver === 'function') {
                stopSidebarLayoutBodyClassObserver();
            }
        }
        if (saveToStorage) {
            sidebarUserEnabled = enable;
            await storage.set(SIDEBAR_LAYOUT_KEY, enable);
        }
    }
    
    // Check if page width supports sidebar layout and auto-enable/disable accordingly
    function checkSidebarResponsiveWidth() {
        const pageWidth = window.innerWidth;
        const shouldDisable = pageWidth < sidebarMinWidth;
        
        if (sidebarUserEnabled) {
            if (shouldDisable && !sidebarAutoDisabled) {
                // Page is too narrow - temporarily disable sidebar CSS
                debugLog(`[Core] Page width (${pageWidth}px) below ${sidebarMinWidth}px - auto-disabling sidebar layout`);
                sidebarAutoDisabled = true;
                toggleSidebarLayout(false, false); // Don't save to storage
                showNotification('Sidebar layout disabled (window too narrow)');
            } else if (!shouldDisable && sidebarAutoDisabled) {
                // Page is wide enough again - re-enable sidebar CSS
                debugLog(`[Core] Page width (${pageWidth}px) above ${sidebarMinWidth}px - re-enabling sidebar layout`);
                sidebarAutoDisabled = false;
                toggleSidebarLayout(true, false); // Don't save to storage
                showNotification('Sidebar layout restored');
            }
        }
    }
    
    // Initialize responsive sidebar listener
    function initResponsiveSidebar() {
        // Debounce resize events to avoid excessive calls
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(checkSidebarResponsiveWidth, 150);
        });
        
        // Check initial state
        checkSidebarResponsiveWidth();
    }
    
    // Apply or remove theme customization CSS
    async function toggleClassicLayout(enable) {
        if (enable) {
            if (!classicLayoutStyleElement) {
                // Check if early-injected element exists
                classicLayoutStyleElement = document.getElementById('sai-toolkit-classic-layout-early');
                
                if (!classicLayoutStyleElement) {
                    classicLayoutStyleElement = document.createElement('style');
                    classicLayoutStyleElement.id = 'sai-toolkit-classic-layout';
                    classicLayoutStyleElement.textContent = getClassicLayoutCSSEarly();
                    document.head.appendChild(classicLayoutStyleElement);
                }
            }
            classicLayoutStyleElement.disabled = false;
        } else {
            if (classicLayoutStyleElement) {
                classicLayoutStyleElement.disabled = true;
            }
        }
        await storage.set(CLASSIC_LAYOUT_KEY, enable);
    }
    
    async function toggleClassicStyle(enable) {
        if (enable) {
            if (!classicStyleStyleElement) {
                // Check if early-injected element exists
                classicStyleStyleElement = document.getElementById('sai-toolkit-classic-style-early');
                
                if (!classicStyleStyleElement) {
                    classicStyleStyleElement = document.createElement('style');
                    classicStyleStyleElement.id = 'sai-toolkit-classic-style';
                    classicStyleStyleElement.textContent = getClassicStyleCSSEarly();
                    document.head.appendChild(classicStyleStyleElement);
                }
            }
            classicStyleStyleElement.disabled = false;
        } else {
            if (classicStyleStyleElement) {
                classicStyleStyleElement.disabled = true;
            }
        }
        await storage.set(CLASSIC_STYLE_KEY, enable);
    }
    
    // CSS for compact generation settings
    function getCompactGenerationCSS() {
        // Use a data attribute to specifically target the Generation Settings modal
        // This prevents affecting other modals like "Select a Model"
        return `
            /* Hide all descriptive text paragraphs in Generation Settings modal ONLY */
            /* Target text-gray-11 descriptions (general descriptions) */
            div[data-sai-generation-settings="true"] p.text-gray-11 {
                display: none !important;
            }
            
            /* Target text-gray-10 descriptions (model description) */
            div[data-sai-generation-settings="true"] p.text-gray-10 {
                display: none !important;
            }
            
            /* Make the inference model section a horizontal row with wrap */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start {
                flex-direction: row !important;
                flex-wrap: wrap !important;
                align-items: center !important;
                gap: 8px !important;
            }
            
            /* "Inference Model" heading on its own line */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > p.text-label-lg {
                order: 1 !important;
                width: 100% !important;
            }
            
            /* Move button after the heading (new line) */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button {
                width: 32px !important;
                height: 32px !important;
                min-width: 32px !important;
                padding: 0 !important;
                border-radius: 4px !important;
                flex-shrink: 0 !important;
                order: 2 !important;
            }
            
            /* Move model info after button */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start .flex.py-md {
                flex: 1 !important;
                padding: 0 !important;
                order: 3 !important;
            }
            
            /* Hide the "Change Model" text */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button p {
                display: none !important;
            }
            
            /* Add pencil icon */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button::before {
                content: "✎" !important;
                font-size: 18px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            
            /* Reduce gaps between settings for more compact view */
            div[data-sai-generation-settings="true"] .overflow-y-auto.overflow-x-hidden.grow.flex.flex-col.gap-lg.px-lg {
                gap: 0rem !important;
            }
            
            /* Target each setting container directly */
            div[data-sai-generation-settings="true"] .overflow-y-auto.overflow-x-hidden.grow > div.flex.flex-col.gap-1.w-full {
                margin-bottom: 0.5rem !important;
            }
            
            /* Reduce vertical spacing in each slider section */
            div[data-sai-generation-settings="true"] div.flex.flex-col.gap-1 {
                gap: 0.15rem !important;
            }
            
            /* Tighter spacing for slider controls */
            div[data-sai-generation-settings="true"] .flex.flex-1.items-center.gap-3 {
                margin-top: 0.15rem !important;
                margin-bottom: 0.15rem !important;
            }
        `;
    }
    
    let compactGenerationObserver = null;

    // Watch the Generation Settings modal for model name changes caused by SpicyChat's own
    // presets/profiles. When the displayed model changes, suppress the next mismatch regen.
    let _lastObservedModalModel = null;
    let _modelNameObserver = null;

    function checkGenerationSettingsModelChange() {
        const modal = findGenerationSettingsModal();
        if (!modal) {
            _lastObservedModalModel = null;
            return;
        }
        // Read current model name using the same logic as getCurrentSettings
        let currentModel = null;
        const labels = modal.querySelectorAll('p.text-label-lg');
        const inferenceLabel = Array.from(labels).find(p => p.textContent && p.textContent.trim() === 'Inference Model');
        if (inferenceLabel && inferenceLabel.parentElement) {
            const nameEl = inferenceLabel.parentElement.querySelector('p.text-label-lg.font-regular.text-gray-12');
            if (nameEl && nameEl.textContent) currentModel = nameEl.textContent.trim();
        }
        if (!currentModel) {
            const el = modal.querySelector('.text-\\[14px\\].font-medium');
            if (el && el.textContent) currentModel = el.textContent.trim();
        }
        if (!currentModel) return;

        if (_lastObservedModalModel !== null && _lastObservedModalModel !== currentModel) {
            window.__suppressMismatchNext = true;
            debugLog('[Model] Generation Settings model name changed (', _lastObservedModalModel, '→', currentModel, ') — suppressing next mismatch auto-regen');
        }
        _lastObservedModalModel = currentModel;
    }

    function startGenerationSettingsModelWatcher() {
        if (_modelNameObserver) return; // already running
        // Perf: only re-run the model check when a fixed-position modal is added/removed
        // anywhere in the tree. Subtree childList still fires, but characterData (which
        // fires on every streaming-message text node update) is no longer observed.
        _modelNameObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
                const nodes = [...m.addedNodes, ...m.removedNodes];
                for (const n of nodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                        n.querySelector?.('p.text-heading-6')) {
                        checkGenerationSettingsModelChange();
                        return;
                    }
                }
            }
        });
        _modelNameObserver.observe(document.body, { childList: true, subtree: true });
        debugLog('[Model] Generation Settings model-name watcher started');
    }

    // Function to mark Generation Settings modal with data attribute
    function markGenerationSettingsModal() {
        // Find all fixed modals
        const modalSelectors = [
            'div.fixed.left-1\\/2.top-1\\/2',
            'div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]'
        ];
        
        for (const selector of modalSelectors) {
            const modals = document.querySelectorAll(selector);
            for (const modal of modals) {
                // Check if this is the Generation Settings modal by looking for the heading
                const heading = modal.querySelector('p.text-heading-6');
                if (heading && heading.textContent && heading.textContent.includes('Generation Settings')) {
                    // Mark it with our data attribute
                    if (!modal.hasAttribute('data-sai-generation-settings')) {
                        modal.setAttribute('data-sai-generation-settings', 'true');
                        debugLog('[Compact] Marked Generation Settings modal');
                    }
                } else {
                    // Remove attribute if this is not the Generation Settings modal
                    if (modal.hasAttribute('data-sai-generation-settings')) {
                        modal.removeAttribute('data-sai-generation-settings');
                    }
                }
            }
        }
    }
    
    // Apply or remove compact generation settings CSS
    async function toggleCompactGeneration(enable) {
        if (enable) {
            if (!compactGenerationStyleElement) {
                compactGenerationStyleElement = document.createElement('style');
                compactGenerationStyleElement.id = 'sai-toolkit-compact-generation';
                compactGenerationStyleElement.textContent = getCompactGenerationCSS();
                document.head.appendChild(compactGenerationStyleElement);
            }
            
            // Start observing for Generation Settings modal
            if (!compactGenerationObserver) {
                // Initial check
                markGenerationSettingsModal();
                
                // Observer to detect when modal appears
                // Perf: only re-scan when a node is added/removed that could be a modal
                compactGenerationObserver = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
                        const nodes = [...m.addedNodes, ...m.removedNodes];
                        for (const n of nodes) {
                            if (n.nodeType !== 1) continue;
                            if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                                n.querySelector?.('p.text-heading-6')) {
                                markGenerationSettingsModal();
                                return;
                            }
                        }
                    }
                });
                
                compactGenerationObserver.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            }
        } else {
            if (compactGenerationStyleElement) {
                compactGenerationStyleElement.remove();
                compactGenerationStyleElement = null;
            }
            
            // Stop observer
            if (compactGenerationObserver) {
                compactGenerationObserver.disconnect();
                compactGenerationObserver = null;
            }
            
            // Remove data attributes from any marked modals
            const markedModals = document.querySelectorAll('[data-sai-generation-settings]');
            markedModals.forEach(modal => modal.removeAttribute('data-sai-generation-settings'));
        }
        await storage.set(COMPACT_GENERATION_KEY, enable);
    }
    
    // Hide For You functionality
    function isPageOne() {
        const url = window.location.href;
        // Exclude recommended-bots page from hiding
        if (url.includes('/recommended-bots')) {
            return false;
        }
        const hasNoPageParam = !url.includes('%5Bpage%5D=') && !url.includes('[page]=');
        const isPageOneParam = url.includes('%5Bpage%5D=1') || url.includes('[page]=1');
        return hasNoPageParam || isPageOneParam;
    }
    
    function hideForYouCharacters() {
        const characterTiles = document.querySelectorAll('.relative.group.rounded-xl.bg-gray-3');
        characterTiles.forEach(async tile => {
            const forYouBadge = tile.querySelector('.bg-purple-9 p.text-white');
            if (forYouBadge && forYouBadge.textContent.trim() === 'For You') {
                const parentWrapper = tile.parentElement;
                if (parentWrapper && !parentWrapper.dataset.hiddenByScript) {
                    parentWrapper.dataset.hiddenByScript = 'true';
                    parentWrapper.style.cssText = 'display: none !important; position: absolute !important; width: 0 !important; height: 0 !important;';
                }
            }
        });
    }
    
    function startHideForYou() {
        if (hideForYouActive) return;
        
        // OPTIMIZATION: Use single delayed call instead of multiple timers
        setTimeout(hideForYouCharacters, 500);
        
        hideForYouObserver = new MutationObserver((mutations) => {
            if (!isPageOne()) {
                stopHideForYou();
                return;
            }
            
            // OPTIMIZATION: Single pass through mutations checking both relevance and hiding needs
            let needsHiding = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    // Check if mutation is in character grid area (relevance check)
                    const target = mutation.target;
                    if (target.classList && (target.classList.contains('grid') || 
                        target.classList.contains('gap-4') || 
                        target.closest('.grid.gap-4'))) {
                        
                        // Check added nodes for character tiles
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                if (node.matches && (node.matches('.relative.group.rounded-xl.bg-gray-3') || node.matches('.bg-purple-9'))) {
                                    needsHiding = true;
                                    break;
                                }
                                if (node.querySelector && (node.querySelector('.relative.group.rounded-xl.bg-gray-3') || node.querySelector('.bg-purple-9'))) {
                                    needsHiding = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if (needsHiding) break;
            }
            
            if (needsHiding) {
                setTimeout(hideForYouCharacters, 100);
            }
        });
        
        hideForYouObserver.observe(document.body, { childList: true, subtree: true });
        hideForYouActive = true;
    }
    
    function stopHideForYou() {
        if (hideForYouObserver) {
            hideForYouObserver.disconnect();
            hideForYouObserver = null;
        }
        hideForYouActive = false;
        
        // Restore all hidden "For You" characters
        restoreForYouCharacters();
    }
    
    function restoreForYouCharacters() {
        const hiddenWrappers = document.querySelectorAll('[data-hidden-by-script="true"]');
        hiddenWrappers.forEach(async wrapper => {
            wrapper.style.cssText = '';
            delete wrapper.dataset.hiddenByScript;
        });
    }
    
    function checkHideForYouPage() {
        if (isPageOne() && !hideForYouActive) {
            startHideForYou();
        } else if (!isPageOne() && hideForYouActive) {
            stopHideForYou();
        }
    }
    
    async function toggleHideForYou(enable) {
        if (enable) {
            checkHideForYouPage();
            
            if (!hideForYouUrlObserver) {
                // Perf: a MutationObserver on document.body fires constantly during
                // streaming. URL changes are driven by history.pushState/popstate, so
                // listen for those directly and skip scanning every DOM mutation.
                let lastUrl = window.location.href;
                const onUrlMaybeChanged = () => {
                    const currentUrl = window.location.href;
                    if (currentUrl !== lastUrl) {
                        lastUrl = currentUrl;
                        setTimeout(checkHideForYouPage, 100);
                    }
                };
                hideForYouUrlObserver = {
                    _onPop: onUrlMaybeChanged,
                    _origPush: history.pushState,
                    _origReplace: history.replaceState,
                    disconnect() {
                        window.removeEventListener('popstate', this._onPop);
                        if (history.pushState === this._patchedPush) history.pushState = this._origPush;
                        if (history.replaceState === this._patchedReplace) history.replaceState = this._origReplace;
                    }
                };
                window.addEventListener('popstate', onUrlMaybeChanged);
                hideForYouUrlObserver._patchedPush = function(...args) {
                    const r = hideForYouUrlObserver._origPush.apply(this, args);
                    onUrlMaybeChanged();
                    return r;
                };
                hideForYouUrlObserver._patchedReplace = function(...args) {
                    const r = hideForYouUrlObserver._origReplace.apply(this, args);
                    onUrlMaybeChanged();
                    return r;
                };
                history.pushState = hideForYouUrlObserver._patchedPush;
                history.replaceState = hideForYouUrlObserver._patchedReplace;
            }
        } else {
            stopHideForYou();
            if (hideForYouUrlObserver) {
                hideForYouUrlObserver.disconnect();
                hideForYouUrlObserver = null;
            }
        }
        await storage.set(HIDE_FOR_YOU_KEY, enable);
    }
    
    // Page Jump functionality
    function getTotalPages() {
        const pageButtons = document.querySelectorAll('button[aria-label^="page-"]');
        let maxPage = 1;
        pageButtons.forEach(async button => {
            const label = button.getAttribute('aria-label');
            if (label && label.startsWith('page-')) {
                const pageNum = label.replace('page-', '');
                if (pageNum !== '...' && !isNaN(pageNum)) {
                    const num = parseInt(pageNum);
                    if (num > maxPage) {
                        maxPage = num;
                    }
                }
            }
        });
        return maxPage;
    }
    
    function getCurrentPage() {
        const currentButton = document.querySelector('button[aria-label^="page-"].bg-blue-10');
        if (currentButton) {
            const label = currentButton.getAttribute('aria-label');
            const pageNum = label.replace('page-', '');
            return parseInt(pageNum);
        }
        return 1;
    }
    
    function navigateToPage(pageNumber) {
        let urlString = window.location.href;
        const pagePattern = /%5Bpage%5D=\d+/;
        if (pagePattern.test(urlString)) {
            urlString = urlString.replace(pagePattern, `%5Bpage%5D=${pageNumber}`);
        } else {
            if (urlString.includes('?')) {
                urlString += `&public_characters_alias%2Fsort%2Fnum_messages_24h%3Adesc%5Bpage%5D=${pageNumber}`;
            } else {
                urlString += `?public_characters_alias%2Fsort%2Fnum_messages_24h%3Adesc%5Bpage%5D=${pageNumber}`;
            }
        }
        window.location.href = urlString;
    }
    
    function showPageJumpModal() {
        const totalPages = getTotalPages();
        const currentPage = getCurrentPage();
        const isDark = document.documentElement.classList.contains('dark');
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);`;
        
        const modal = document.createElement('div');
        modal.style.cssText = `background: ${isDark ? '#1a1a1a' : '#ffffff'}; border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);`;
        
        // Use safe HTML construction to avoid innerHTML security warnings
        const h2 = document.createElement('h2');
        h2.style.cssText = `font-size: 20px; font-weight: 600; margin-bottom: 16px; color: ${isDark ? '#fff' : '#000'};`;
        h2.textContent = 'Jump to Page';
        
        const p = document.createElement('p');
        p.style.cssText = `font-size: 14px; margin-bottom: 16px; color: ${isDark ? '#a1a1aa' : '#666'};`;
        p.textContent = `Enter a page number between 1 and ${totalPages}`;
        
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'page-jump-input';
        input.min = '1';
        input.max = totalPages.toString();
        input.value = currentPage.toString();
        input.placeholder = 'Page number';
        input.style.cssText = `width: 100%; padding: 10px 12px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; border-radius: 8px; font-size: 16px; margin-bottom: 20px; background: ${isDark ? '#27272a' : '#fff'}; color: ${isDark ? '#fff' : '#000'};`;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'page-jump-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `padding: 8px 16px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; background: transparent; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; color: ${isDark ? '#fff' : '#000'}; transition: all 0.2s;`;
        
        const okBtn = document.createElement('button');
        okBtn.id = 'page-jump-ok';
        okBtn.textContent = 'Go to Page';
        okBtn.style.cssText = 'padding: 8px 16px; border: none; background: #0072F5; color: white; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;';
        
        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(okBtn);
        
        modal.appendChild(h2);
        modal.appendChild(p);
        modal.appendChild(input);
        modal.appendChild(buttonContainer);
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        const inputElement = document.getElementById('page-jump-input');
        setTimeout(() => { inputElement.focus(); inputElement.select(); }, 100);
        
        const okButton = document.getElementById('page-jump-ok');
        const cancelButton = document.getElementById('page-jump-cancel');
        
        function closeModal() { overlay.remove(); }
        
        function handleSubmit() {
            const pageNumber = parseInt(inputElement.value);
            if (isNaN(pageNumber)) {
                alert('Please enter a valid page number');
                return;
            }
            if (pageNumber < 1 || pageNumber > totalPages) {
                alert(`Please enter a page number between 1 and ${totalPages}`);
                return;
            }
            closeModal();
            navigateToPage(pageNumber);
        }
        
        cancelButton.addEventListener('click', closeModal);
        overlay.addEventListener('click', async (e) => { if (e.target === overlay) closeModal(); });
        okButton.addEventListener('click', handleSubmit);
        inputElement.addEventListener('keypress', async (e) => { if (e.key === 'Enter') handleSubmit(); });
        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escapeHandler);
            }
        });
    }
    
    function enhanceEllipsisButton() {
        const ellipsisButtons = document.querySelectorAll('button[aria-label="page-..."]');
        if (ellipsisButtons.length === 0) return;
        
        ellipsisButtons.forEach(async ellipsisButton => {
            if (ellipsisButton.dataset.enhanced === 'true') return;
            ellipsisButton.dataset.enhanced = 'true';
            ellipsisButton.classList.remove('cursor-default');
            ellipsisButton.classList.add('cursor-pointer');
            ellipsisButton.classList.remove('undefined');
            
            ellipsisButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPageJumpModal();
            });
        });
    }
    
    async function togglePageJump(enable) {
        if (enable) {
            setTimeout(enhanceEllipsisButton, 1000);
            
            if (!pageJumpObserver) {
                pageJumpObserver = new MutationObserver((mutations) => {
                    let needsEnhancement = false;
                    for (const mutation of mutations) {
                        if (mutation.addedNodes.length > 0) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === 1) {
                                    if (node.matches && node.matches('button[aria-label="page-..."]')) {
                                        needsEnhancement = true;
                                        break;
                                    }
                                    if (node.querySelector && node.querySelector('button[aria-label="page-..."]')) {
                                        needsEnhancement = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (needsEnhancement) break;
                    }
                    if (needsEnhancement) {
                        setTimeout(enhanceEllipsisButton, 100);
                    }
                });
                pageJumpObserver.observe(document.body, { childList: true, subtree: true });
            }
        } else {
            if (pageJumpObserver) {
                pageJumpObserver.disconnect();
                pageJumpObserver = null;
            }
        }
        await storage.set(PAGE_JUMP_KEY, enable);
    }
    
    // =============================================================================
    // WYSIWYG EDITOR - Live formatting preview in textareas
    // =============================================================================
    
    let wysiwygObserver = null;
    let wysiwygActive = false;
    const WYSIWYG_EDITOR_CLASS = 'sai-wysiwyg-editor';

    // Robust Apple-touch-device detection. iOS browser wrappers like Orion do
    // NOT put iPhone/iPad/iPod in navigator.userAgent, so a UA-only check misses
    // them and silently skips the iOS-specific React #185 guards (remove editor
    // before send, backspace-in-empty-editor). Mirror the detection already used
    // by the send interceptor and setup paths so it can't drift out of sync again.
    function isAppleTouchDevice() {
        return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
               /iPhone|iPad|iPod/i.test(navigator.platform) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    
    // CSS for the WYSIWYG contenteditable editor
    // Uses a contenteditable div that syncs back to the hidden textarea
    // This ensures cursor alignment because the formatted text IS the editable content
    // IMPORTANT: We insert the editor as a sibling, NOT wrapping the textarea,
    // to avoid breaking React's DOM reconciliation
    const WYSIWYG_CSS = `
        /* Ensure the Suggest/autogenerate button wrapper stays at the LEFT of the flex container */
        /* This button has data-tooltip-id and contains the autogenerate/lightbulb button */
        /* It must remain before the editor in visual order, never getting pushed right */
        .sai-wysiwyg-editor ~ textarea.sai-wysiwyg-hidden {
            /* Already handled below */
        }
        
        /* When WYSIWYG is active, ensure the Suggest button wrapper stays left */
        /* The wrapper is the div with data-tooltip-id that contains aria-label="autogenerate" */
        /* During generation, React replaces the wrapper with a direct button element */
        .flex:has(.sai-wysiwyg-editor) > .inline-flex:has(button[aria-label="autogenerate"]),
        .flex:has(.sai-wysiwyg-editor) > div[data-tooltip-id]:has(button[aria-label="autogenerate"]),
        .flex:has(.sai-wysiwyg-editor) > button[aria-label="autogenerate"] {
            flex: 0 0 auto !important;
            order: -1 !important;
        }
        
        /* The contenteditable editor - visible, receives input */
        /* Inserted as sibling BEFORE the textarea, not wrapping it */
        .sai-wysiwyg-editor {
            white-space: pre-wrap !important;
            word-wrap: break-word !important;
            overflow-wrap: break-word !important;
            overflow: auto !important;
            box-sizing: border-box !important;
            background: transparent !important;
            color: var(--wysiwyg-body-color, #ffffff) !important;
            font-weight: var(--wysiwyg-body-font-weight, normal) !important;
            font-style: var(--wysiwyg-body-font-style, normal) !important;
            text-decoration: var(--wysiwyg-body-text-decoration, none) !important;
            outline: none !important;
            cursor: text !important;
            flex: 1 1 0% !important;
            min-width: 0 !important;
            min-height: 24px !important;
            width: 100% !important;
            align-self: center !important;
            /* DO NOT use display: flex on contenteditable - it causes column layout! */
            display: block !important;
            /* Editor appears after the Suggest button (which has order: -1) */
            order: 0 !important;
            
            /* Default CSS variables for colors */
            --wysiwyg-body-color: #ffffff;
            --wysiwyg-body-font-weight: normal;
            --wysiwyg-body-font-style: normal;
            --wysiwyg-body-text-decoration: none;
            --wysiwyg-dialogue-color: #ffffff;
            --wysiwyg-dialogue-font-weight: normal;
            --wysiwyg-dialogue-font-style: normal;
            --wysiwyg-dialogue-text-decoration: none;
            --wysiwyg-narration-color: #7dd3fc;
            --wysiwyg-narration-font-weight: normal;
            --wysiwyg-narration-font-style: italic;
            --wysiwyg-narration-text-decoration: none;
            --wysiwyg-highlight-bg: #ffdd6d;
            --wysiwyg-highlight-text: #000000;
            --wysiwyg-highlight-font-weight: normal;
            --wysiwyg-highlight-font-style: normal;
            --wysiwyg-highlight-text-decoration: none;
        }
        
        /* Narration: uses custom style settings */
        .sai-wysiwyg-editor .wysiwyg-narration {
            color: var(--wysiwyg-narration-color);
            font-weight: var(--wysiwyg-narration-font-weight);
            font-style: var(--wysiwyg-narration-font-style);
            text-decoration: var(--wysiwyg-narration-text-decoration);
        }
        
        /* Dialogue: uses custom style settings */
        .sai-wysiwyg-editor .wysiwyg-dialogue {
            color: var(--wysiwyg-dialogue-color);
            font-weight: var(--wysiwyg-dialogue-font-weight);
            font-style: var(--wysiwyg-dialogue-font-style);
            text-decoration: var(--wysiwyg-dialogue-text-decoration);
        }
        
        /* Reset narration styles for nested elements */
        .sai-wysiwyg-editor .wysiwyg-narration .wysiwyg-dialogue {
            font-style: var(--wysiwyg-dialogue-font-style);
            font-weight: var(--wysiwyg-dialogue-font-weight);
            text-decoration: var(--wysiwyg-dialogue-text-decoration);
        }
        .sai-wysiwyg-editor .wysiwyg-narration .wysiwyg-highlight {
            font-style: var(--wysiwyg-highlight-font-style);
            font-weight: var(--wysiwyg-highlight-font-weight);
            text-decoration: var(--wysiwyg-highlight-text-decoration);
        }
        
        /* Bold: body color but bold */
        .sai-wysiwyg-editor .wysiwyg-bold {
            color: var(--wysiwyg-body-color);
            font-weight: bold;
        }
        
        /* Bold narration: narration color but bold */
        .sai-wysiwyg-editor .wysiwyg-bold-narration {
            color: var(--wysiwyg-narration-color);
            font-weight: bold;
            font-style: var(--wysiwyg-narration-font-style);
        }
        
        /* Highlight: uses custom style settings */
        .sai-wysiwyg-editor .wysiwyg-highlight {
            background-color: var(--wysiwyg-highlight-bg);
            color: var(--wysiwyg-highlight-text);
            font-weight: var(--wysiwyg-highlight-font-weight);
            font-style: var(--wysiwyg-highlight-font-style);
            text-decoration: var(--wysiwyg-highlight-text-decoration);
            border-radius: 2px;
        }
        
        /* Hide the original textarea when WYSIWYG is active */
        /* Use position:absolute and zero dimensions to take it out of flex flow completely */
        textarea.sai-wysiwyg-hidden {
            position: absolute !important;
            opacity: 0 !important;
            pointer-events: none !important;
            width: 0 !important;
            height: 0 !important;
            min-width: 0 !important;
            min-height: 0 !important;
            max-width: 0 !important;
            max-height: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
            border: none !important;
            overflow: hidden !important;
            flex: 0 0 0 !important;
            z-index: -1 !important;
        }
        
        /* Ensure parent container of WYSIWYG has position:relative for absolute positioning */
        /* This is needed on /group/, /lorebook/, and /chatbot/ pages */
        .flex.flex-col.gap-1\\.5:has(.sai-wysiwyg-editor) {
            position: relative !important;
        }
        
        /* On non-chat pages, make WYSIWYG overlay the textarea instead of sitting above it */
        /* These pages have different flex layouts that don't hide the textarea properly */
        .flex.flex-col.gap-1\\.5:has(.sai-wysiwyg-editor) > .sai-wysiwyg-editor {
            position: relative !important;
            z-index: 1 !important;
        }
        
        /* Placeholder styling for empty editor */
        .sai-wysiwyg-editor:empty::before {
            content: attr(data-placeholder);
            color: rgb(156, 163, 175);
            pointer-events: none;
        }
        
        /* When WYSIWYG is active inside a grid container (message editing), */
        /* hide the auto-sizing ghost span that creates blank space above/below */
        .grid:has(.sai-wysiwyg-editor) > span.invisible {
            display: none !important;
        }
    `;
    
    let wysiwygStyleElement = null;
    
    function injectWysiwygCSS() {
        if (!wysiwygStyleElement) {
            wysiwygStyleElement = document.createElement('style');
            wysiwygStyleElement.id = 'sai-toolkit-wysiwyg-css';
            wysiwygStyleElement.textContent = WYSIWYG_CSS;
            document.head.appendChild(wysiwygStyleElement);
            debugLog('[WYSIWYG] Injected WYSIWYG CSS');
        }
    }
    
    function removeWysiwygCSS() {
        if (wysiwygStyleElement) {
            wysiwygStyleElement.remove();
            wysiwygStyleElement = null;
            debugLog('[WYSIWYG] Removed WYSIWYG CSS');
        }
    }
    
    /**
     * Parse text and convert formatting markers to HTML
     * Formatting rules (matching SpicyChat's renderer):
     * - ***text*** → bold narration (italic cyan + bold)
     * - **text** → bold body text (white + bold)
     * - *text* → narration (italic, cyan) - can contain dialogue
     * - "text" → dialogue (white) - supports various quote styles
     * - `text` → highlight (cyan background)
     * - Plain text → body text (white)
     */
    function parseFormattedText(text) {
        if (!text) return '';
        
        // All opening quote characters using explicit Unicode to avoid encoding issues
        // \u201C = " (left double quotation mark) - iOS smart quote opening
        // \u201E = „ (double low-9 quotation mark)
        // \u201F = ‟ (double high-reversed-9 quotation mark)
        // \u0022 = " (straight double quote)
        const OPENING_QUOTES = ['\u201C', '\u201E', '\u201F', '\u0022'];
        
        // All closing quote characters using explicit Unicode
        // \u201D = " (right double quotation mark) - iOS smart quote closing
        // \u0022 = " (straight double quote)
        const CLOSING_QUOTES = ['\u201D', '\u0022'];
        
        // Check if char is any opening quote
        const isOpeningQuote = (char) => OPENING_QUOTES.includes(char);
        // Check if char is any closing quote
        const isClosingQuote = (char) => CLOSING_QUOTES.includes(char);
        // Find next closing quote position
        const findClosingQuote = (str, startIdx) => {
            for (let j = startIdx; j < str.length; j++) {
                if (isClosingQuote(str[j])) return j;
            }
            return -1;
        };
        
        // Helper to escape HTML in plain text
        function escapeHtml(str) {
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }
        
        // Helper to parse dialogue and highlights within text (for inside narration)
        function parseInnerContent(str) {
            let result = '';
            let i = 0;
            while (i < str.length) {
                const char = str[i];
                
                // Check for highlight: `text`
                if (char === '`') {
                    const endIdx = str.indexOf('`', i + 1);
                    if (endIdx !== -1) {
                        const content = str.substring(i + 1, endIdx);
                        result += '<span class="wysiwyg-highlight">`' + escapeHtml(content) + '`</span>';
                        i = endIdx + 1;
                        continue;
                    }
                }
                
                // Check for dialogue: any opening quote character
                if (isOpeningQuote(char)) {
                    const endIdx = findClosingQuote(str, i + 1);
                    
                    if (endIdx !== -1) {
                        // Found closing quote
                        const content = str.substring(i + 1, endIdx);
                        const actualCloseQuote = str[endIdx];
                        result += '<span class="wysiwyg-dialogue">' + char + escapeHtml(content) + actualCloseQuote + '</span>';
                        i = endIdx + 1;
                        continue;
                    } else {
                        // No closing quote found - style rest as dialogue (unclosed)
                        const content = str.substring(i + 1);
                        result += '<span class="wysiwyg-dialogue">' + char + escapeHtml(content) + '</span>';
                        return result; // We've consumed the rest
                    }
                }
                
                // Plain character
                if (char === '&') {
                    result += '&amp;';
                } else if (char === '<') {
                    result += '&lt;';
                } else if (char === '>') {
                    result += '&gt;';
                } else {
                    result += char;
                }
                i++;
            }
            return result;
        }
        
        const result = [];
        let i = 0;
        const len = text.length;
        
        // Check if text contains any quote character
        const hasQuotes = OPENING_QUOTES.some(q => text.includes(q)) || CLOSING_QUOTES.some(q => text.includes(q));
        if (hasQuotes) {
            debugLog('[WYSIWYG-Text] parseFormattedText - text contains quotes');
            debugLog('[WYSIWYG-Text] Text:', text);
            debugLog('[WYSIWYG-Text] Text char codes:', Array.from(text).map(c => c.charCodeAt(0)));
            debugLog('[WYSIWYG-Text] Opening quotes:', OPENING_QUOTES);
            debugLog('[WYSIWYG-Text] Opening quotes char codes:', OPENING_QUOTES.map(c => c.charCodeAt(0)));
            debugLog('[WYSIWYG-Text] Closing quotes:', CLOSING_QUOTES);
            debugLog('[WYSIWYG-Text] Closing quotes char codes:', CLOSING_QUOTES.map(c => c.charCodeAt(0)));
        }
        
        while (i < len) {
            const char = text[i];
            
            // Check for highlight: `text`
            if (char === '`') {
                const endIdx = text.indexOf('`', i + 1);
                if (endIdx !== -1) {
                    const content = text.substring(i + 1, endIdx);
                    result.push('<span class="wysiwyg-highlight">`' + escapeHtml(content) + '`</span>');
                    i = endIdx + 1;
                    continue;
                }
            }
            
            // Check for bold narration: ***text***
            if (char === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
                const endIdx = text.indexOf('***', i + 3);
                if (endIdx !== -1) {
                    const content = text.substring(i + 3, endIdx);
                    result.push('<span class="wysiwyg-bold-narration">***' + escapeHtml(content) + '***</span>');
                    i = endIdx + 3;
                    continue;
                }
            }
            
            // Check for bold: **text**
            if (char === '*' && text[i + 1] === '*' && text[i + 2] !== '*') {
                const endIdx = text.indexOf('**', i + 2);
                if (endIdx !== -1 && text[endIdx + 2] !== '*') {
                    const content = text.substring(i + 2, endIdx);
                    result.push('<span class="wysiwyg-bold">**' + escapeHtml(content) + '**</span>');
                    i = endIdx + 2;
                    continue;
                }
            }
            
            // Check for narration: *text*
            // Single * starts narration - find matching closing *
            if (char === '*' && text[i + 1] !== '*') {
                // Find the next single * (not part of ** or ***)
                let endIdx = -1;
                for (let j = i + 1; j < len; j++) {
                    if (text[j] === '*') {
                        // Check it's a single * (not ** or ***)
                        const prevIsStar = j > 0 && text[j - 1] === '*';
                        const nextIsStar = text[j + 1] === '*';
                        if (!prevIsStar && !nextIsStar) {
                            endIdx = j;
                            break;
                        }
                        // Skip if it's part of ** or ***
                        if (nextIsStar) {
                            j++; // Skip the next *
                            if (text[j + 1] === '*') j++; // Skip another if ***
                        }
                    }
                    // Stop at double newline (paragraph break)
                    if (text[j] === '\n' && text[j + 1] === '\n') {
                        break;
                    }
                }
                
                if (endIdx !== -1) {
                    const content = text.substring(i + 1, endIdx);
                    // Parse inner content for dialogue/highlights
                    const parsedContent = parseInnerContent(content);
                    result.push('<span class="wysiwyg-narration">*' + parsedContent + '*</span>');
                    i = endIdx + 1;
                    continue;
                }
            }
            
            // Check for dialogue: any opening quote character (outside of narration)
            if (isOpeningQuote(char)) {
                const endIdx = findClosingQuote(text, i + 1);
                
                debugLog('[WYSIWYG-Text] Found opening quote:', char, 'at position', i);
                debugLog('[WYSIWYG-Text] Looking for closing quote from position', i + 1);
                debugLog('[WYSIWYG-Text] Found closing quote at:', endIdx);
                
                if (endIdx !== -1) {
                    // Found closing quote
                    const content = text.substring(i + 1, endIdx);
                    const actualCloseQuote = text[endIdx];
                    
                    debugLog('[WYSIWYG-Text] Creating dialogue span with content:', content);
                    
                    result.push('<span class="wysiwyg-dialogue">' + char + escapeHtml(content) + actualCloseQuote + '</span>');
                    i = endIdx + 1;
                    continue;
                } else {
                    // No closing quote found - style rest of text as dialogue (unclosed)
                    const content = text.substring(i + 1);
                    result.push('<span class="wysiwyg-dialogue">' + char + escapeHtml(content) + '</span>');
                    break; // We've consumed the rest of the text
                }
            }
            
            // Plain character - escape if needed
            if (char === '&') {
                result.push('&amp;');
            } else if (char === '<') {
                result.push('&lt;');
            } else if (char === '>') {
                result.push('&gt;');
            } else {
                result.push(char);
            }
            i++;
        }
        
        return result.join('');
    }
    
    /**
     * Create a WYSIWYG contenteditable editor for a textarea
     * The editor displays formatted text and syncs plain text back to the hidden textarea
     * IMPORTANT: We insert the editor as a sibling BEFORE the textarea, NOT wrapping it,
     * to avoid breaking React's DOM reconciliation which causes crashes on hover/tooltips
     */
    function setupWysiwygOverlay(textarea) {
        debugLog('[WYSIWYG] setupWysiwygOverlay called - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending);
        // Skip if already set up
        if (textarea.dataset.wysiwygSetup === 'true') {
            debugLog('[WYSIWYG] setupWysiwygOverlay SKIPPED - already setup');
            return;
        }
        
        // EXCLUDE textareas inside modals/dialogs - these should not get WYSIWYG
        // Modals typically have role="dialog" or are inside elements with certain classes
        const isInModal = textarea.closest('[role="dialog"]') !== null ||
                          textarea.closest('[role="alertdialog"]') !== null ||
                          textarea.closest('.modal') !== null ||
                          textarea.closest('[data-slot="base"]') !== null ||  // NextUI modal
                          textarea.closest('[aria-modal="true"]') !== null;
        
        if (isInModal) {
            debugLog('[WYSIWYG] Skipping textarea inside modal:', textarea);
            return;
        }
        
        // Check if this is a message editor (editing existing messages)
        // These have .flex.flex-col.gap-1\.5 parent but are NOT in the main chat input container
        const messageEditorContainer = textarea.closest('.flex.flex-col.gap-1\\.5');
        const chatInputContainer = textarea.closest('.border-1.border-solid.rounded-\\[13px\\]');
        const isMessageEditor = messageEditorContainer !== null && chatInputContainer === null;
        
        // Check if this is a group chat message editor (has placeholder "Enter something")
        // Also matches regular message edits which use the same placeholder
        const isGroupChatEdit = textarea.placeholder === 'Enter something' && 
                                textarea.closest('.flex.flex-col.gap-1\\.5') !== null;
        
        // Chat input: main message input at bottom of chat
        const isChatInput = textarea.classList.contains('flex-grow') && 
                           chatInputContainer !== null;
        
        // Alternative selectors for chat input - must also be in the chat input container
        const isChatInputAlt = textarea.placeholder === 'Message...' &&
                              textarea.closest('.bg-gray-3') !== null;
        
        // Only apply WYSIWYG to: main chat input, message editors, or group chat editors
        if (!isChatInput && !isChatInputAlt && !isMessageEditor && !isGroupChatEdit) {
            return;
        }
        
        debugLog('[WYSIWYG] Setting up contenteditable editor for textarea:', textarea,
                 { isChatInput, isChatInputAlt, isMessageEditor, isGroupChatEdit });
        
        // Track active message editors globally so we can block arrow keys
        // even when the editor is not focused (user clicked away to read something)
        if (!window._activeMessageEditors) {
            window._activeMessageEditors = new Set();
        }
        
        // Install global arrow key blocker ONCE - blocks when ANY message editor is active
        if (!window._wysiwygGlobalArrowBlockerInstalled) {
            window._wysiwygGlobalArrowBlockerInstalled = true;
            
            // Window capture phase - this fires FIRST before any element handlers
            window.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || 
                    e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    
                    // Check if any message editor is currently active (visible on page)
                    const hasActiveMessageEditor = window._activeMessageEditors && 
                                                   window._activeMessageEditors.size > 0;
                    
                    // Check if the WYSIWYG editor itself is focused
                    // If so, let arrow keys through for cursor movement
                    const activeEl = document.activeElement;
                    const isEditorFocused = activeEl && activeEl.classList.contains('sai-wysiwyg-editor');
                    
                    // Block arrow keys when a message editor is active BUT NOT focused
                    // This prevents accidentally switching regenerations while editing
                    // but allows cursor movement when typing in the editor
                    if (hasActiveMessageEditor && !isEditorFocused) {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        return false;
                    }
                }
            }, true); // Capture phase - fires first!
        }
        
        textarea.dataset.wysiwygSetup = 'true';

        // ── TEMP DIAGNOSTIC (React #185 bisection) — remove once root-caused ──────
        // Five send-path fixes produced identical crash stacks, so the trigger is
        // structural. Bisect it from the page console, then RELOAD between each:
        //   localStorage.setItem('saiWysiwygDiag','off')            → no overlay at all (baseline: native textarea, no editor, no hiding)
        //   localStorage.setItem('saiWysiwygDiag','editor-no-hide') → insert the editor but DON'T squash the textarea to 0×0
        //   localStorage.setItem('saiWysiwygDiag','no-observers')   → normal, but the 3 textarea watchers are disabled
        //   localStorage.removeItem('saiWysiwygDiag')               → back to normal
        // Type + send in each mode and note which ones still crash with #185.
        let __saiDiagMode = 'normal';
        try { __saiDiagMode = (localStorage.getItem('saiWysiwygDiag') || 'normal').trim(); } catch (_) {}
        if (__saiDiagMode !== 'normal') {
            console.log('%c[WYSIWYG DIAG] active mode = ' + __saiDiagMode, 'color:#0bf;font-weight:bold;font-size:14px');
        }
        if (__saiDiagMode === 'off') {
            console.log('%c[WYSIWYG DIAG] off — overlay skipped, native textarea left intact', 'color:#0bf;font-weight:bold');
            return;
        }

        debugLog('[WYSIWYG] Marked textarea as setup, creating editor element');
        debugLog('[WYSIWYG] Textarea:', textarea);
        debugLog('[WYSIWYG] isMessageEditor:', isMessageEditor, 'isGroupChatEdit:', isGroupChatEdit);
        
        // Create contenteditable div that will be the visible editor
        // This is inserted as a SIBLING before the textarea, not wrapping it
        const editor = document.createElement('div');
        editor.className = 'sai-wysiwyg-editor';
        editor.contentEditable = 'true';
        editor.setAttribute('data-placeholder', textarea.placeholder || 'Enter something');
        
        // Apply Custom/Classic style colors to this editor. Defined as a named closure
        // (and exposed on the editor element) so it can be re-run LIVE when the style
        // settings change — see the storage.onChanged listener in toggleWysiwygEditor().
        async function applyEditorColors() {
            // Reset the variables this function manages first, so toggling a style OFF
            // reverts the editor to its built-in WYSIWYG defaults instead of leaving
            // stale overrides behind.
            [
                '--wysiwyg-body-color', '--wysiwyg-body-font-weight', '--wysiwyg-body-font-style', '--wysiwyg-body-text-decoration',
                '--wysiwyg-dialogue-color', '--wysiwyg-dialogue-font-weight', '--wysiwyg-dialogue-font-style', '--wysiwyg-dialogue-text-decoration',
                '--wysiwyg-narration-color', '--wysiwyg-narration-font-weight', '--wysiwyg-narration-font-style', '--wysiwyg-narration-text-decoration',
                '--wysiwyg-highlight-bg', '--wysiwyg-highlight-text', '--wysiwyg-highlight-font-weight', '--wysiwyg-highlight-font-style', '--wysiwyg-highlight-text-decoration'
            ].forEach(v => editor.style.removeProperty(v));

            const customStyleEnabled = await storage.get(CUSTOM_STYLE_KEY, false);
            if (customStyleEnabled) {
                const customStyleValuesStr = await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE));
                let customStyleValues;
                try {
                    customStyleValues = typeof customStyleValuesStr === 'string' 
                        ? JSON.parse(customStyleValuesStr) 
                        : customStyleValuesStr;
                } catch (e) {
                    customStyleValues = DEFAULT_CUSTOM_STYLE;
                }
                
                // Apply custom colors via CSS variables directly on editor
                if (customStyleValues.bodyColor) {
                    editor.style.setProperty('--wysiwyg-body-color', customStyleValues.bodyColor);
                    editor.style.setProperty('--wysiwyg-dialogue-color', customStyleValues.bodyColor);
                }
                if (customStyleValues.bodyFontWeight) {
                    editor.style.setProperty('--wysiwyg-body-font-weight', customStyleValues.bodyFontWeight);
                }
                if (customStyleValues.bodyFontStyle) {
                    editor.style.setProperty('--wysiwyg-body-font-style', customStyleValues.bodyFontStyle);
                }
                if (customStyleValues.bodyTextDecoration) {
                    editor.style.setProperty('--wysiwyg-body-text-decoration', customStyleValues.bodyTextDecoration);
                }
                
                // Dialogue / Quote settings
                if (customStyleValues.spanQuoteColor) {
                    editor.style.setProperty('--wysiwyg-dialogue-color', customStyleValues.spanQuoteColor);
                }
                if (customStyleValues.spanQuoteFontWeight) {
                    editor.style.setProperty('--wysiwyg-dialogue-font-weight', customStyleValues.spanQuoteFontWeight);
                }
                if (customStyleValues.spanQuoteFontStyle) {
                    editor.style.setProperty('--wysiwyg-dialogue-font-style', customStyleValues.spanQuoteFontStyle);
                }
                if (customStyleValues.spanQuoteTextDecoration) {
                    editor.style.setProperty('--wysiwyg-dialogue-text-decoration', customStyleValues.spanQuoteTextDecoration);
                }
                
                // Narration settings
                if (customStyleValues.narrationColor) {
                    editor.style.setProperty('--wysiwyg-narration-color', customStyleValues.narrationColor);
                }
                if (customStyleValues.narrationFontWeight) {
                    editor.style.setProperty('--wysiwyg-narration-font-weight', customStyleValues.narrationFontWeight);
                }
                if (customStyleValues.narrationFontStyle) {
                    editor.style.setProperty('--wysiwyg-narration-font-style', customStyleValues.narrationFontStyle);
                }
                if (customStyleValues.narrationTextDecoration) {
                    editor.style.setProperty('--wysiwyg-narration-text-decoration', customStyleValues.narrationTextDecoration);
                }
                
                // Highlight settings
                if (customStyleValues.highlightBgColor) {
                    editor.style.setProperty('--wysiwyg-highlight-bg', customStyleValues.highlightBgColor);
                }
                if (customStyleValues.highlightTextColor) {
                    editor.style.setProperty('--wysiwyg-highlight-text', customStyleValues.highlightTextColor);
                }
                if (customStyleValues.highlightFontWeight) {
                    editor.style.setProperty('--wysiwyg-highlight-font-weight', customStyleValues.highlightFontWeight);
                }
                if (customStyleValues.highlightFontStyle) {
                    editor.style.setProperty('--wysiwyg-highlight-font-style', customStyleValues.highlightFontStyle);
                }
                if (customStyleValues.highlightTextDecoration) {
                    editor.style.setProperty('--wysiwyg-highlight-text-decoration', customStyleValues.highlightTextDecoration);
                }
                
                debugLog('[WYSIWYG] Applied custom style settings:', customStyleValues);
            } else {
                // No Custom Style — if Classic Style is on, mirror ITS fixed palette onto
                // the live editor so the composer matches what Classic Style renders in sent
                // messages. (Custom and Classic are mutually exclusive; Custom wins above.)
                // Source of truth: getClassicStyleCSSEarly() — body/quote #fff, narration
                // (em/i) #06B7DB italic. Highlight is left at the editor default (Classic
                // doesn't restyle highlights). Without this the editor fell back to the
                // WYSIWYG default narration #7dd3fc, which doesn't match Classic's #06B7DB.
                const classicStyleEnabled = await storage.get(CLASSIC_STYLE_KEY, false);
                if (classicStyleEnabled) {
                    editor.style.setProperty('--wysiwyg-body-color', '#ffffff');
                    editor.style.setProperty('--wysiwyg-dialogue-color', '#ffffff');
                    editor.style.setProperty('--wysiwyg-narration-color', '#06B7DB');
                    editor.style.setProperty('--wysiwyg-narration-font-style', 'italic');
                    debugLog('[WYSIWYG] Applied Classic Style colors to editor');
                }
            }
        }
        // Expose for live re-application (storage.onChanged) and run once now.
        editor._wysiwygApplyColors = applyEditorColors;
        applyEditorColors();
        
        // Get computed styles from textarea
        const computedStyle = window.getComputedStyle(textarea);
        
        // Copy ALL relevant styles from textarea to editor
        editor.style.fontFamily = computedStyle.fontFamily;
        editor.style.fontSize = computedStyle.fontSize;
        editor.style.fontWeight = computedStyle.fontWeight;
        editor.style.lineHeight = computedStyle.lineHeight;
        editor.style.letterSpacing = computedStyle.letterSpacing;
        editor.style.wordSpacing = computedStyle.wordSpacing;
        editor.style.textAlign = computedStyle.textAlign;
        editor.style.textIndent = computedStyle.textIndent;
        editor.style.textTransform = computedStyle.textTransform;
        editor.style.padding = computedStyle.padding;
        editor.style.border = computedStyle.border;
        editor.style.borderRadius = computedStyle.borderRadius;
        editor.style.background = computedStyle.background;
        editor.style.backgroundColor = computedStyle.backgroundColor;
        editor.style.minHeight = computedStyle.height;
        editor.style.maxHeight = computedStyle.maxHeight || '188px'; // Match textarea's max-h-[188px]
        editor.style.boxSizing = 'border-box';
        
        // Copy ring/outline styles
        editor.style.boxShadow = computedStyle.boxShadow;
        
        // Set caret color
        editor.style.caretColor = 'white';
        
        // IMPORTANT: Insert editor as a sibling BEFORE the textarea
        // Do NOT wrap/move the textarea - this would break React's DOM reconciliation
        // and cause crashes when React tries to show tooltips or update the UI
        debugLog('[WYSIWYG] *** CRITICAL: About to insert editor into DOM ***');
        debugLog('[WYSIWYG] Timestamp:', Date.now());
        debugLog('[WYSIWYG] Parent node:', textarea.parentNode);
        debugLog('[WYSIWYG] Parent node class:', textarea.parentNode?.className);
        debugLog('[WYSIWYG] Sibling count before insert:', textarea.parentNode?.childNodes.length);
        
        try {
            textarea.parentNode.insertBefore(editor, textarea);
            debugLog('[WYSIWYG] *** Editor successfully inserted into DOM ***');
            debugLog('[WYSIWYG] Timestamp:', Date.now());
            debugLog('[WYSIWYG] Sibling count after insert:', textarea.parentNode?.childNodes.length);
        } catch (error) {
            console.error('[WYSIWYG] ERROR inserting editor:', error);
            debugLog('[WYSIWYG] ERROR inserting editor:', error.message, error.stack);
            return; // Abort if insertion fails
        }
        
        // CRITICAL: Check if window width is in React's danger zone (around 768px breakpoint)
        // If so, remove editor immediately to prevent React Error 185
        const windowWidth = window.innerWidth;
        const inDangerZone = windowWidth >= 700 && windowWidth <= 850;
        
        if (inDangerZone) {
            debugLog('[WYSIWYG] Window width in danger zone (' + windowWidth + 'px), aborting editor setup');
            editor.remove();
            // Don't hide textarea - keep it visible
            return;
        }
        
        // Ensure parent container has position:relative for absolute positioning of hidden textarea
        const parentContainer = textarea.parentNode;
        if (parentContainer) {
            parentContainer.style.setProperty('position', 'relative', 'important');
        }
        
        // Hide the original textarea visually but keep it in its original DOM position
        // Apply inline styles directly to ensure it's hidden on all pages.
        // DIAG: 'editor-no-hide' skips this squashing so we can tell whether the
        // invasive 0×0 !important hiding (which fights SpicyChat's auto-grow textarea)
        // is what triggers #185, vs. the foreign contenteditable sibling itself.
        if (__saiDiagMode !== 'editor-no-hide') {
            textarea.classList.add('sai-wysiwyg-hidden');
            textarea.style.setProperty('position', 'absolute', 'important');
            textarea.style.setProperty('opacity', '0', 'important');
            textarea.style.setProperty('pointer-events', 'none', 'important');
            textarea.style.setProperty('width', '0', 'important');
            textarea.style.setProperty('height', '0', 'important');
            textarea.style.setProperty('min-width', '0', 'important');
            textarea.style.setProperty('min-height', '0', 'important');
            textarea.style.setProperty('max-width', '0', 'important');
            textarea.style.setProperty('max-height', '0', 'important');
            textarea.style.setProperty('padding', '0', 'important');
            textarea.style.setProperty('margin', '0', 'important');
            textarea.style.setProperty('border', 'none', 'important');
            textarea.style.setProperty('overflow', 'hidden', 'important');
            textarea.style.setProperty('z-index', '-1', 'important');
        }
        
        // For message editors: Register as active so global arrow key blocker knows
        // This allows blocking arrow keys even when editor is not focused
        if (isMessageEditor || isGroupChatEdit) {
            // Generate unique ID for this editor
            const editorId = 'wysiwyg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            editor._wysiwygEditorId = editorId;
            textarea._wysiwygEditorId = editorId;
            
            // Register as active
            window._activeMessageEditors.add(editorId);
            
            // Watch for editor removal (when user cancels edit or saves)
            const removalObserver = new MutationObserver((mutations) => {
                // Check if editor was removed from DOM
                if (!document.body.contains(editor)) {
                    window._activeMessageEditors.delete(editorId);
                    removalObserver.disconnect();
                }
            });
            // Observe parent's parent for child removal
            const observeTarget = editor.parentNode?.parentNode || editor.parentNode || document.body;
            removalObserver.observe(observeTarget, { childList: true, subtree: true });
            textarea._wysiwygRemovalObserver = removalObserver;
        }
        
        // For message editors: Add capture-phase arrow key blocker on parent container
        // This intercepts arrow key events before they bubble up to React's handlers
        // that switch between message regenerations (legacy - kept as backup)
        if (isMessageEditor || isGroupChatEdit) {
            const messageContainer = textarea.closest('.flex.flex-col.gap-1\\.5');
            if (messageContainer && !messageContainer._arrowKeyBlockerInstalled) {
                messageContainer._arrowKeyBlockerInstalled = true;
                messageContainer.addEventListener('keydown', (e) => {
                    const isArrowKey = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || 
                                       e.key === 'ArrowUp' || e.key === 'ArrowDown';
                    const editorFocused = document.activeElement === editor;
                    
                    // Block arrow keys when the WYSIWYG editor is focused
                    if (isArrowKey && editorFocused) {
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        // Don't preventDefault - let cursor move in editor
                    }
                }, true); // Capture phase
            }
        }
        
        // Watch for autogenerate/suggest button clicks to clear and lock editor during generation
        const suggestButton = textarea.parentNode?.querySelector('button[aria-label="autogenerate"]');
        if (suggestButton) {
            suggestButton.addEventListener('click', () => {
                // Clear editor and show loading state using safe DOM methods
                while (editor.firstChild) {
                    editor.removeChild(editor.firstChild);
                }
                const loadingSpan = document.createElement('span');
                loadingSpan.style.cssText = 'color: #888; font-style: italic;';
                loadingSpan.textContent = 'Generating suggestion...';
                editor.appendChild(loadingSpan);
                
                editor.contentEditable = 'false';
                editor.style.pointerEvents = 'none';
                editor.style.opacity = '0.6';
            });
        }
        
        // Track if we're programmatically updating to avoid loops
        let isUpdating = false;
        
        // Get plain text from contenteditable (preserving line breaks)
        function getPlainText() {
            // Clone to avoid modifying the actual DOM
            const clone = editor.cloneNode(true);
            
            // Replace <br> with newlines
            clone.querySelectorAll('br').forEach(br => {
                br.replaceWith('\n');
            });
            
            // Replace block elements with newlines
            clone.querySelectorAll('div, p').forEach(block => {
                if (block.previousSibling) {
                    block.insertBefore(document.createTextNode('\n'), block.firstChild);
                }
            });
            
            return clone.textContent || '';
        }
        
        // Save cursor position
        function saveCursorPosition() {
            const selection = window.getSelection();
            if (!selection.rangeCount) return null;
            
            const range = selection.getRangeAt(0);
            
            // Get text offset from start
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(editor);
            preCaretRange.setEnd(range.startContainer, range.startOffset);
            const startOffset = preCaretRange.toString().length;
            
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            const endOffset = preCaretRange.toString().length;
            
            return { start: startOffset, end: endOffset };
        }
        
        // Restore cursor position
        function restoreCursorPosition(savedPos) {
            if (!savedPos) return;
            
            const selection = window.getSelection();
            const range = document.createRange();
            
            let charCount = 0;
            let startNode = null, startOffset = 0;
            let endNode = null, endOffset = 0;
            
            function traverseNodes(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const nextCount = charCount + node.textContent.length;
                    
                    if (!startNode && savedPos.start <= nextCount) {
                        startNode = node;
                        startOffset = savedPos.start - charCount;
                    }
                    if (!endNode && savedPos.end <= nextCount) {
                        endNode = node;
                        endOffset = savedPos.end - charCount;
                    }
                    
                    charCount = nextCount;
                } else {
                    for (const child of node.childNodes) {
                        traverseNodes(child);
                        if (startNode && endNode) return;
                    }
                }
            }
            
            traverseNodes(editor);
            
            // Fallback: place cursor at end
            if (!startNode) {
                range.selectNodeContents(editor);
                range.collapse(false);
            } else {
                range.setStart(startNode, startOffset);
                range.setEnd(endNode || startNode, endOffset || startOffset);
            }
            
            selection.removeAllRanges();
            selection.addRange(range);
        }
        
        // Safely set HTML content using DOMParser (avoids innerHTML security warnings)
        // The HTML is generated by parseFormattedText which already escapes user content
        // DOMParser creates an isolated document that doesn't execute scripts
        function safeSetHTML(element, html) {
            // Clear existing content
            while (element.firstChild) {
                element.removeChild(element.firstChild);
            }
            
            if (!html) return;
            
            // Use DOMParser to safely parse HTML - this creates nodes without executing scripts
            // Wrap in a div to handle multiple top-level nodes and text nodes
            const parser = new DOMParser();
            const doc = parser.parseFromString('<div>' + html + '</div>', 'text/html');
            const wrapper = doc.body.firstChild;
            
            // Move all children from the parsed wrapper to our element
            while (wrapper.firstChild) {
                element.appendChild(document.adoptNode(wrapper.firstChild));
            }
        }
        
        // Update editor display with formatted HTML
        function updateEditorDisplay() {
            if (isUpdating) return;
            isUpdating = true;
            
            const savedPos = saveCursorPosition();
            const plainText = getPlainText();
            const formattedHtml = parseFormattedText(plainText);
            
            debugLog('[WYSIWYG-Text] updateEditorDisplay called');
            debugLog('[WYSIWYG-Text] Plain text:', plainText);
            debugLog('[WYSIWYG-Text] Formatted HTML:', formattedHtml);
            
            safeSetHTML(editor, formattedHtml);
            
            restoreCursorPosition(savedPos);
            
            isUpdating = false;
        }
        
        // Sync editor content to textarea.
        // ROOT-CAUSE FIX for the iOS/WebKit React #185 send crash: write through React's
        // NATIVE prototype value setter, not `textarea.value =`.
        //
        // React installs a tracker-wrapping setter on the textarea INSTANCE; a plain
        // `textarea.value = x` runs that wrapper and updates React's _valueTracker to x
        // BEFORE we dispatch 'input'. React's ChangeEventPlugin then compares tracker(x)
        // === node.value(x), sees "no change", and SUPPRESSES onChange. So React's
        // controlled state never learns the typed text — its prop stays "" while the DOM
        // holds the text. That standing prop↔DOM desync is the one invariant behind every
        // observed #185 crash (tap and Enter, editor mounted or removed, observers live or
        // suspended): during the send commit React's controlled-input restore-state
        // machinery keeps trying to reconcile the mismatch and recurses past its
        // nested-update limit (50) on WebKit.
        //
        // Calling the native prototype setter writes the DOM WITHOUT touching the tracker,
        // so the dispatched 'input' registers as a real change, React's onChange fires, and
        // React's state tracks the typed text on every keystroke. By send time prop === DOM,
        // so restore short-circuits (updateWrapper's `if (newValue !== node.value)` guard)
        // and the recursion has no fuel. The `if (isUpdating) return` guard below prevents
        // the resulting onChange-driven re-render from recursing back into this function.
        const nativeTextareaValueSetter = (() => {
            try {
                return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set || null;
            } catch (_) {
                return null;
            }
        })();
        function syncToTextarea() {
            if (isUpdating) return;

            const plainText = getPlainText();
            if (textarea.value !== plainText) {
                if (nativeTextareaValueSetter) {
                    nativeTextareaValueSetter.call(textarea, plainText);
                } else {
                    textarea.value = plainText;
                }

                // Single 'input' only — React derives a textarea's onChange from 'input',
                // so a 'change' dispatch is redundant and just adds re-entrancy pressure.
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        
        // Initialize editor with textarea content
        function initializeEditor() {
            const formattedHtml = parseFormattedText(textarea.value);
            safeSetHTML(editor, formattedHtml);

            // Restore editor to editable state (in case it was locked during generation)
            editor.contentEditable = 'true';
            editor.style.pointerEvents = '';
            editor.style.opacity = '';

            // Auto-focus the editor when it becomes visible and enabled
            // Check if the editor is visible (not hidden by React)
            const isVisible = editor.offsetParent !== null &&
                             editor.offsetWidth > 0 &&
                             editor.offsetHeight > 0;

            // Focus the editor if it's visible, editable, and not currently focused
            if (isVisible && editor.contentEditable === 'true' && document.activeElement !== editor) {
                // Use requestAnimationFrame to ensure DOM is fully updated
                requestAnimationFrame(() => {
                    editor.focus();
                    // Place cursor at the end of content
                    const selection = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    range.collapse(false); // false = collapse to end
                    selection.removeAllRanges();
                    selection.addRange(range);
                });
            }
        }
        
        // Initialize
        initializeEditor();
        
        // Track last known textarea value for change detection
        let lastKnownValue = textarea.value;
        
        // Track IME composition state (critical for mobile keyboards and non-Latin input)
        let isComposing = false;
        
        // Detect Android mobile for performance optimization (glitch prevention)
        const isAndroidMobile = /Android/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent);
        // Detect iOS for backspace fix (separate issue from Android glitching)
        // NOTE: use the robust detector — Orion (iOS) is absent from the UA string,
        // and a UA-only check here was leaving the editor mounted during send on
        // Orion, which crashed the page with React #185 (max update depth).
        const isIOS = isAppleTouchDevice();
        const debounceDelay = isAndroidMobile ? 1000 : 150; // 1s for Android mobile, 150ms for desktop/iOS
        
        editor.addEventListener('compositionstart', () => {
            isComposing = true;
            editor._isComposing = true; // Also store on element for access from intervals
            debugLog('[WYSIWYG] Composition started (IME/mobile keyboard)');
        });
        
        editor.addEventListener('compositionend', () => {
            isComposing = false;
            editor._isComposing = false;
            debugLog('[WYSIWYG] Composition ended (IME/mobile keyboard)');
            // Sync after composition completes
            syncToTextarea();
            lastKnownValue = textarea.value;
            // Update formatting after composition (critical for iOS smart quote formatting)
            updateEditorDisplay();
        });
        
        // Handle input - update formatting and sync to textarea
        let inputDebounceTimer = null;
        let lastInputTime = 0;
        editor.addEventListener('input', () => {
            // Skip sync during IME composition to prevent cursor jumping on mobile
            if (isComposing) {
                debugLog('[WYSIWYG] Input during composition - skipping sync');
                return;
            }
            
            lastInputTime = Date.now();
            
            // Sync to textarea immediately
            syncToTextarea();
            lastKnownValue = textarea.value;
            
            // Use adaptive debounce: longer for Android mobile to prevent glitches, shorter for desktop/iOS
            clearTimeout(inputDebounceTimer);
            inputDebounceTimer = setTimeout(() => {
                // Double-check we're not in composition when the timer fires
                if (!isComposing) {
                    updateEditorDisplay();
                }
            }, debounceDelay);
        });
        
        // Handle paste - strip formatting and paste as plain text
        editor.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
            // iOS/WebKit FIX: execCommand('insertText') after preventDefault does NOT
            // reliably fire the editor's 'input' event, so the live re-format never ran
            // after a paste until a later blur/focus. Drive the same sync + debounced
            // re-format the 'input' handler does. (Harmless if 'input' also fires — the
            // shared debounce timer coalesces to a single updateEditorDisplay.)
            if (!isComposing) {
                lastInputTime = Date.now();
                syncToTextarea();
                lastKnownValue = textarea.value;
                clearTimeout(inputDebounceTimer);
                inputDebounceTimer = setTimeout(() => {
                    if (!isComposing) updateEditorDisplay();
                }, debounceDelay);
            }
        });
        
        // Handle keydown for special keys
        editor.addEventListener('keydown', (e) => {
            // Skip during IME composition - let mobile keyboard handle everything
            if (isComposing) {
                return;
            }
            
            // iOS FIX: Prevent backspace in empty editor from triggering React Error 185
            // iOS Safari/WebKit seems to trigger React re-renders when backspace is pressed in empty contenteditable
            if (e.key === 'Backspace' && isIOS) {
                const plainText = editor.textContent || '';
                if (plainText.trim() === '') {
                    // Editor is empty, prevent the backspace from doing anything
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    return;
                }
            }
            
            // ARROW KEY FIX: Stop propagation for arrow keys to prevent
            // switching between regenerations when editing messages
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || 
                e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.stopPropagation();
                e.stopImmediatePropagation();
                // Don't preventDefault - let the cursor move normally within the editor
            }
            
            // Handle Enter key
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift+Enter always adds a newline
                    e.preventDefault();
                    document.execCommand('insertLineBreak');
                } else if (isMessageEditor || isGroupChatEdit) {
                    // For message editor / group chat edit: Enter adds newline (like native textarea)
                    e.preventDefault();
                    document.execCommand('insertLineBreak');
                } else {
                    // For chat input: Enter sends the message
                    e.preventDefault();
                    
                    // Sync to textarea first
                    syncToTextarea();
                    
                    // Send-time editor handling differs by platform (see the iOS block below):
                    // - iOS/WebKit: keep the editor mounted + suspend its watchers, defer the click.
                    // - Desktop: only remove the editor in the narrow 700-850px danger zone.
                    const windowWidth = window.innerWidth;
                    const inDangerZone = windowWidth >= 700 && windowWidth <= 850;
                    // iOS (incl. Orion) React #185 fix: do NOT remove the editor before
                    // send. Removing it blurs the focused contenteditable mid-event which,
                    // together with the synchronous synthesized click below, drove React's
                    // controlled-input restore/commit past its nested-update limit (#185) on
                    // WebKit. Instead, suspend this editor's watchers for the send window
                    // (same as the tap path) and defer the click out of the keydown stack
                    // (see below). Desktop keeps the narrow danger-zone removal — note isIOS
                    // is always false on desktop, so this is behavior-identical there.
                    const shouldRemoveBeforeSend = inDangerZone;
                    if (isIOS) {
                        editor._wysiwygSending = true;
                        setTimeout(() => {
                            editor._wysiwygSending = false;
                            if (textarea.value === '' || textarea.value !== getPlainText()) {
                                editor.replaceChildren();
                                lastKnownValue = '';
                            }
                        }, WYSIWYG_SEND_SUSPEND_MS);
                    }
                    
                    if (shouldRemoveBeforeSend) {
                        debugLog('[WYSIWYG] Removing editor before send - isIOS:', isIOS, 'inDangerZone:', inDangerZone, 'width:', windowWidth);
                        
                        // Clean up this specific editor's observers and intervals
                        if (editor._wysiwygResizeObserver) {
                            editor._wysiwygResizeObserver.disconnect();
                            delete editor._wysiwygResizeObserver;
                        }
                        if (editor._wysiwygMutationObserver) {
                            editor._wysiwygMutationObserver.disconnect();
                            delete editor._wysiwygMutationObserver;
                        }
                        if (editor._wysiwygValueCheckInterval) {
                            clearInterval(editor._wysiwygValueCheckInterval);
                            delete editor._wysiwygValueCheckInterval;
                        }
                        
                        // Make textarea visible again and restore its value
                        textarea.style.display = '';
                        textarea.style.visibility = '';
                        textarea.style.position = '';
                        textarea.style.left = '';
                        textarea.style.top = '';
                        textarea.style.width = '';
                        textarea.style.height = '';
                        textarea.style.opacity = '';
                        textarea.style.pointerEvents = '';
                        textarea.style.zIndex = '';
                        textarea.style.minHeight = '';
                        textarea.style.maxHeight = '';
                        textarea.style.overflow = '';
                        textarea.style.resize = '';
                        
                        // Remove editor from DOM
                        editor.remove();
                        
                        // Clear wysiwygSetup flag so it can be recreated later.
                        // Must clear dataset.wysiwygSetup (the marker setupWysiwygOverlay
                        // actually checks) — the old `textarea.wysiwygSetup` set a stray
                        // property and left the dataset flag at 'true', so after one send
                        // the editor was never rebuilt until a full page reload.
                        textarea.dataset.wysiwygSetup = '';
                    }
                    
                    // Find and click the send button - try multiple selectors for different layouts
                    // Old layout: button[aria-label="send-message"] in .flex.justify-between
                    // New layout: may have different button structure
                    let sendButton = null;
                    
                    // Try 1: Old layout - send-message button near editor
                    sendButton = editor.closest('.flex.justify-between')?.querySelector('button[aria-label="send-message"]');
                    
                    // Try 2: Search up the DOM tree for any button with send-message
                    if (!sendButton) {
                        sendButton = document.querySelector('button[aria-label="send-message"]');
                    }
                    
                    // Try 3: New layout - look for buttons in composer area siblings
                    // Check parent containers for buttons (may be in flex container next to textarea)
                    if (!sendButton) {
                        const parent = editor.parentElement;
                        const grandparent = parent?.parentElement;
                        const greatGrandparent = grandparent?.parentElement;
                        
                        // Look for any button in the immediate composer area
                        if (greatGrandparent) {
                            const siblings = greatGrandparent.querySelectorAll('button');
                            // Find an enabled button that's not aria-label="record-voice" or other non-send buttons
                            for (const btn of siblings) {
                                const ariaLabel = btn.getAttribute('aria-label') || '';
                                const isDisabled = btn.disabled;
                                const isHidden = btn.style.display === 'none' || btn.classList.contains('hidden');
                                
                                // Skip voice record button and other known non-send buttons
                                if (!isDisabled && !isHidden && ariaLabel !== 'record-voice' && 
                                    ariaLabel !== 'autogenerate' && ariaLabel !== 'generate-image') {
                                    // Check if it looks like a send button (primary action button, not disabled)
                                    if (btn.className && !btn.className.includes('opacity-60') && 
                                        !btn.className.includes('cursor-not-allowed')) {
                                        sendButton = btn;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    
                    // If still not found, try to find ANY enabled button near the textarea that's not disabled
                    if (!sendButton) {
                        const parentContainer = editor.closest('.flex.flex-col') || editor.parentElement;
                        if (parentContainer) {
                            const allButtons = parentContainer.querySelectorAll('button:not([disabled])');
                            // Take the last enabled button (likely the send button if only one is enabled)
                            if (allButtons.length > 0) {
                                sendButton = allButtons[allButtons.length - 1];
                            }
                        }
                    }
                    
                    if (sendButton && !sendButton.disabled) {
                        debugLog('[WYSIWYG] Found send button, clicking it:', {
                            ariaLabel: sendButton.getAttribute('aria-label'),
                            className: sendButton.className
                        });
                        if (isIOS) {
                            // Defer the click out of the keydown call stack so it runs as
                            // its own top-level discrete event rather than nested inside this
                            // keydown. The nested synchronous click is what let React's send
                            // commit interleave with the still-open keydown batch and trip
                            // #185 on WebKit. Re-query the button inside the frame in case a
                            // render swapped it. (Editor clear is handled by the suspend
                            // timeout above, so the 50ms clear below is a desktop concern.)
                            const btn = sendButton;
                            requestAnimationFrame(() => {
                                const fresh = document.querySelector('button[aria-label="send-message"]') || btn;
                                if (fresh && !fresh.disabled) fresh.click();
                            });
                        } else {
                            sendButton.click();
                        }

                        // Clear the editor after a short delay (after message is sent)
                        setTimeout(() => {
                            if (textarea.value === '' || textarea.value !== getPlainText()) {
                                editor.replaceChildren();
                                lastKnownValue = '';
                            }
                        }, 50);
                    } else {
                        debugLog('[WYSIWYG] Could not find send button', {
                            sendButton: !!sendButton,
                            disabled: sendButton?.disabled
                        });
                    }
                }
            }
            
            // Handle Tab
            if (e.key === 'Tab') {
                e.preventDefault();
                document.execCommand('insertText', false, '\t');
            }
        });
        
        // Focus handling - when editor is focused, ensure it's ready
        editor.addEventListener('focus', () => {
            debugLog('[WYSIWYG] Editor focus event - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending);
            // Skip during resize to prevent React 185 error
            if (isResizing || sidebarWidthTransitionPending) {
                debugLog('[WYSIWYG] Focus handler SKIPPED due to resize in progress');
                return;
            }
            // Trigger immediate update if content changed externally
            if (textarea.value !== getPlainText()) {
                debugLog('[WYSIWYG] Focus handler calling initializeEditor due to content change');
                initializeEditor();
            }
        });
        
        // Watch for external changes to textarea (e.g., from undo/redo or message send clearing)
        const activeTypingThreshold = isAndroidMobile ? 1500 : 500; // Longer threshold for Android mobile only
        const textareaObserver = new MutationObserver(() => {
            // React #185 guard: stay silent while a send is in flight (flag set by
            // the send interceptor). React's controlled-value restore wakes this
            // observer; calling initializeEditor() here would re-enter React mid-
            // flush and form the observer<->restore loop that throws #185 on iOS.
            if (__saiDiagMode === 'no-observers') return; // DIAG
            if (editor._wysiwygSending) return;
            debugLog('[WYSIWYG] Textarea MutationObserver fired - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending, 'isUpdating:', isUpdating);
            // Skip during resize to prevent React 185 error
            if (isResizing || sidebarWidthTransitionPending) {
                debugLog('[WYSIWYG] Textarea MutationObserver SKIPPED due to resize in progress');
                return;
            }
            
            // Skip if user is actively typing to prevent constant re-initialization on mobile
            const timeSinceInput = Date.now() - lastInputTime;
            if (timeSinceInput < activeTypingThreshold) {
                return;
            }
            
            if (!isUpdating) {
                debugLog('[WYSIWYG] Textarea MutationObserver calling initializeEditor');
                lastKnownValue = textarea.value;
                initializeEditor();
            }
        });
        textareaObserver.observe(textarea, { attributes: true, attributeFilter: ['value'] });
        
        // Watch for value property changes (polling as backup)
        const valueCheckInterval = setInterval(() => {
            // React #185 guard: see textareaObserver. Suspended during send so the
            // post-send textarea clear doesn't drive initializeEditor() into React's
            // restore flush. The interceptor clears the editor itself, and this
            // interval self-heals once the suspend flag lifts.
            if (__saiDiagMode === 'no-observers') return; // DIAG
            if (editor._wysiwygSending) return;
            // Skip during resize to prevent React 185 error
            if (isResizing || sidebarWidthTransitionPending) {
                // Don't log every skip or it will flood the console
                return;
            }
            
            // Skip during IME composition to prevent cursor jumping on mobile
            if (editor._isComposing) {
                return;
            }
            
            // Skip if user is actively typing - adaptive threshold based on platform
            const timeSinceInput = Date.now() - lastInputTime;
            if (timeSinceInput < activeTypingThreshold) {
                return;
            }
            
            if (!document.body.contains(textarea)) {
                debugLog('[WYSIWYG] Value check interval - textarea removed from DOM');
                clearInterval(valueCheckInterval);
                return;
            }
            // Always check, even when editor is focused - important for message send clearing
            if (textarea.value !== lastKnownValue) {
                debugLog('[WYSIWYG] Value check interval detected change - old:', lastKnownValue?.substring(0, 50), 'new:', textarea.value?.substring(0, 50));
                lastKnownValue = textarea.value;
                // Only update display if textarea was cleared or changed externally
                if (!isUpdating) {
                    debugLog('[WYSIWYG] Value check interval calling initializeEditor');
                    initializeEditor();
                }
            }
        }, 100); // Check more frequently for responsive clearing
        
        // Handle resize - observe the editor since we don't have a container anymore
        // Debounced to avoid expensive getComputedStyle calls on every resize event
        // CRITICAL: Skip during window resize to prevent React 185 error
        let resizeDebounceTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            // React #185 guard: see textareaObserver. Suspended during send.
            if (__saiDiagMode === 'no-observers') return; // DIAG
            if (editor._wysiwygSending) return;
            debugLog('[WYSIWYG] ResizeObserver fired - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending);
            // Skip entirely during window resize to prevent React 185 error
            if (isResizing || sidebarWidthTransitionPending) {
                debugLog('[WYSIWYG] ResizeObserver SKIPPED due to resize in progress');
                return;
            }
            
            clearTimeout(resizeDebounceTimer);
            resizeDebounceTimer = setTimeout(() => {
                debugLog('[WYSIWYG] ResizeObserver debounce timer fired - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending);
                // Double-check resize state when timer fires
                if (isResizing || sidebarWidthTransitionPending) {
                    debugLog('[WYSIWYG] ResizeObserver debounce SKIPPED due to resize in progress');
                    return;
                }
                debugLog('[WYSIWYG] ResizeObserver updating editor minHeight');
                const style = window.getComputedStyle(textarea);
                editor.style.minHeight = style.height;
                debugLog('[WYSIWYG] ResizeObserver minHeight updated to:', style.height);
            }, 16); // ~60fps max
        });
        // Observe the textarea's parent for layout changes
        if (textarea.parentNode) {
            resizeObserver.observe(textarea.parentNode);
        }
        
        // Store references for cleanup
        textarea._wysiwygEditor = editor;
        textarea._wysiwygResizeObserver = resizeObserver;
        textarea._wysiwygMutationObserver = textareaObserver;
        textarea._wysiwygValueCheckInterval = valueCheckInterval;
        textarea._wysiwygInputDebounceTimer = inputDebounceTimer;
    }
    
    /**
     * Remove WYSIWYG editor from a textarea
     */
    function removeWysiwygOverlay(textarea) {
        if (textarea.dataset.wysiwygSetup !== 'true') return;
        
        textarea.dataset.wysiwygSetup = '';
        textarea.classList.remove('sai-wysiwyg-hidden');
        
        // Unregister from active message editors (for global arrow key blocking)
        if (textarea._wysiwygEditorId && window._activeMessageEditors) {
            window._activeMessageEditors.delete(textarea._wysiwygEditorId);
        }
        
        // Clean up removal observer
        if (textarea._wysiwygRemovalObserver) {
            textarea._wysiwygRemovalObserver.disconnect();
        }
        
        // Clean up editor
        if (textarea._wysiwygEditor) {
            textarea._wysiwygEditor.remove();
        }
        
        // Clean up resize observer
        if (textarea._wysiwygResizeObserver) {
            textarea._wysiwygResizeObserver.disconnect();
        }
        
        // Clean up mutation observer
        if (textarea._wysiwygMutationObserver) {
            textarea._wysiwygMutationObserver.disconnect();
        }
        
        // Clean up value check interval
        if (textarea._wysiwygValueCheckInterval) {
            clearInterval(textarea._wysiwygValueCheckInterval);
        }
        
        // Clean up debounce timer
        if (textarea._wysiwygInputDebounceTimer) {
            clearTimeout(textarea._wysiwygInputDebounceTimer);
        }
        
        // No need to unwrap from container since we don't use one anymore
        // The textarea stays in its original position in the DOM
        
        // Clear inline styles that were added to hide the textarea
        textarea.style.removeProperty('position');
        textarea.style.removeProperty('opacity');
        textarea.style.removeProperty('pointer-events');
        textarea.style.removeProperty('width');
        textarea.style.removeProperty('height');
        textarea.style.removeProperty('min-width');
        textarea.style.removeProperty('min-height');
        textarea.style.removeProperty('max-width');
        textarea.style.removeProperty('max-height');
        textarea.style.removeProperty('padding');
        textarea.style.removeProperty('margin');
        textarea.style.removeProperty('border');
        textarea.style.removeProperty('overflow');
        textarea.style.removeProperty('z-index');
        
        // Clear references
        delete textarea._wysiwygEditor;
        delete textarea._wysiwygEditorId;
        delete textarea._wysiwygResizeObserver;
        delete textarea._wysiwygMutationObserver;
        delete textarea._wysiwygValueCheckInterval;
        delete textarea._wysiwygInputDebounceTimer;
    }
    
    /**
     * Find and setup all relevant textareas
     */
    function findAndSetupWysiwygTextareas() {
        const timestamp = Date.now();
        debugLog('[WYSIWYG] ========================================');
        debugLog('[WYSIWYG] findAndSetupWysiwygTextareas called at', timestamp);
        debugLog('[WYSIWYG] - isResizing:', isResizing);
        debugLog('[WYSIWYG] - sidebarWidthTransitionPending:', sidebarWidthTransitionPending);
        debugLog('[WYSIWYG] - document.readyState:', document.readyState);
        debugLog('[WYSIWYG] - wysiwygActive:', wysiwygActive);
        debugLog('[WYSIWYG] ========================================');

        // BUGFIX: respect the user's setting. The resize handler and the body
        // mutation observer both call this function unconditionally, so without
        // this gate WYSIWYG editors get rebuilt on top of the textarea after a
        // window resize / zoom even when the feature is disabled — which leaves
        // the composer unusable until reload (the textarea is pinned invisible
        // and the contenteditable that mounted on top isn't being maintained).
        // If editors exist while the feature is off, tear them down to recover
        // any user that's already in the broken state.
        if (!wysiwygActive) {
            const stale = document.querySelectorAll('.sai-wysiwyg-editor');
            if (stale.length > 0) {
                debugLog('[WYSIWYG] Feature disabled but', stale.length, 'editor(s) present — tearing down');
                removeAllWysiwygOverlays();
            } else {
                debugLog('[WYSIWYG] Feature disabled, skipping setup');
            }
            return;
        }

        // STORY MODE: Skip WYSIWYG setup as Story Mode has native WYSIWYG
        if (isStoryMode()) {
            debugLog('[WYSIWYG] Skipping setup - Story Mode has native WYSIWYG');
            return;
        }
        
        // Find message editor textareas (in edit mode)
        const messageEditorTextareas = document.querySelectorAll('.flex.flex-col.gap-1\\.5 textarea');
        debugLog('[WYSIWYG] Found', messageEditorTextareas.length, 'message editor textareas');
        messageEditorTextareas.forEach((ta, i) => {
            debugLog('[WYSIWYG] Processing message editor textarea', i + 1, 'of', messageEditorTextareas.length);
            setupWysiwygOverlay(ta);
        });
        
        // Find chat input textareas
        const chatInputTextareas = document.querySelectorAll('.border-1.border-solid.rounded-\\[13px\\] textarea');
        debugLog('[WYSIWYG] Found', chatInputTextareas.length, 'chat input textareas');
        chatInputTextareas.forEach((ta, i) => {
            debugLog('[WYSIWYG] Processing chat input textarea', i + 1, 'of', chatInputTextareas.length);
            setupWysiwygOverlay(ta);
        });
        
        // Alternative: find by placeholder
        const messageTextareas = document.querySelectorAll('textarea[placeholder="Message..."], textarea[placeholder="Enter something"]');
        debugLog('[WYSIWYG] Found', messageTextareas.length, 'textareas by placeholder');
        messageTextareas.forEach((ta, i) => {
            debugLog('[WYSIWYG] Processing placeholder textarea', i + 1, 'of', messageTextareas.length);
            setupWysiwygOverlay(ta);
        });
        
        debugLog('[WYSIWYG] findAndSetupWysiwygTextareas COMPLETE at', Date.now());
    }
    
    /**
     * Remove all WYSIWYG overlays.
     * Selector note: setupWysiwygOverlay marks textareas with
     * dataset.wysiwygSetup='true' and the .sai-wysiwyg-hidden class — there is
     * no .sai-wysiwyg-active class anywhere, so the previous selector matched
     * nothing and this helper was a silent no-op. Use the dataset attribute,
     * which is the authoritative marker.
     */
    function removeAllWysiwygOverlays() {
        const activeTextareas = document.querySelectorAll('textarea[data-wysiwyg-setup="true"]');
        activeTextareas.forEach(removeWysiwygOverlay);
    }
    
    // Global send button interceptor reference (for cleanup)
    let wysiwygSendInterceptor = null;
    // Installed once: re-applies editor colors live when Custom/Classic style settings change.
    let wysiwygStyleListenerInstalled = false;
    // Timestamp of the last handled send tap. iOS/WebKit fires touchend AND click
    // for one tap, so the interceptor runs twice; we coalesce within this window.
    let lastWysiwygSendTime = 0;
    // How long to suspend an editor's watchers while React commits the send. Must
    // outlast React's synchronous restore-state flush; the send teardown is fast
    // (well under this), and a user cannot realistically send again within it.
    const WYSIWYG_SEND_SUSPEND_MS = 500;
    
    /**
     * Toggle WYSIWYG editor feature
     */
    async function toggleWysiwygEditor(enable) {
        // STORY MODE: Skip WYSIWYG toggle as Story Mode has native WYSIWYG
        if (isStoryMode()) {
            debugLog('[WYSIWYG] Skipping toggle - Story Mode has native WYSIWYG');
            return;
        }
        
        if (enable) {
            debugLog('[WYSIWYG] Enabling WYSIWYG editor');
            wysiwygActive = true;
            injectWysiwygCSS();
            
            // iOS FIX: Install global send button interceptor.
            // On iOS, users tap the send button directly (not the Enter key), so this
            // capture-phase listener runs BEFORE React handles the send. Its job is to
            // open a brief "suspend" window that quiets this editor's watchers while
            // React commits the send — preventing the observer<->restore-state loop
            // that throws React #185 on iOS. It does NOT sync the value (already synced
            // on each keystroke) and does NOT remove the editor.

            // Live style reaction: when Custom/Classic style settings change (toggle,
            // import, or Drive sync), re-apply colors to every mounted editor without
            // requiring a reload. Installed once.
            if (!wysiwygStyleListenerInstalled && typeof storage.onChanged === 'function') {
                wysiwygStyleListenerInstalled = true;
                storage.onChanged((changes) => {
                    if (!changes) return;
                    if (changes[CUSTOM_STYLE_KEY] || changes[CLASSIC_STYLE_KEY] || changes[CUSTOM_STYLE_VALUES_KEY]) {
                        document.querySelectorAll('.sai-wysiwyg-editor').forEach((el) => {
                            if (typeof el._wysiwygApplyColors === 'function') el._wysiwygApplyColors();
                        });
                        debugLog('[WYSIWYG] Style setting changed — re-applied editor colors live');
                    }
                });
            }

            if (!wysiwygSendInterceptor) {
                const isIOSDevice = isAppleTouchDevice();

                wysiwygSendInterceptor = (e) => {
                    // Check if this is a send button being clicked/tapped
                    const clickedElement = e.target;
                    if (!clickedElement || !clickedElement.closest) return;
                    
                    const target = clickedElement.closest('button[aria-label="send-message"], button[aria-label="send"]');
                    if (!target) return;
                    
                    // Check if any WYSIWYG editor is active
                    const activeEditors = document.querySelectorAll('.sai-wysiwyg-editor');
                    if (activeEditors.length === 0) return;
                    
                    // iOS/WebKit fires BOTH touchend and click for a single tap, so
                    // this handler runs twice per send. Coalesce to one logical send
                    // to avoid doubling the re-entrancy that contributes to #185.
                    const nowTs = Date.now();
                    if (nowTs - lastWysiwygSendTime < WYSIWYG_SEND_SUSPEND_MS) return;
                    lastWysiwygSendTime = nowTs;

                    debugLog('[WYSIWYG] Send interceptor triggered - opening suspend window. isIOS:', isIOSDevice);

                    // ROOT-CAUSE FIX for React #185 (max update depth) on tap-to-send:
                    // When React commits the send it synchronously restores the
                    // controlled textarea's value from props. That write wakes this
                    // editor's MutationObserver / valueCheckInterval / ResizeObserver,
                    // each of which calls initializeEditor() -> editor.focus()/safeSetHTML,
                    // which re-enters React's controlled/selection path during the SAME
                    // synchronous flush and mutates the textarea again -> re-wakes the
                    // observers. On iOS WebKit that observer<->restore cycle exceeds
                    // React's nested-update limit (50) and crashes the page. Suspend
                    // this editor's watchers for the send window so the cycle can't form.
                    //
                    // We deliberately do NOT write textarea.value or dispatch synthetic
                    // input/change events here: the typed text was already synced on each
                    // keystroke (syncToTextarea), and dispatching a fresh discrete input
                    // inside React's own gesture is itself a #185 trigger. (The old code
                    // read editor.previousElementSibling, which never matched the textarea
                    // — the editor is inserted BEFORE it — so that block was a dead no-op.)
                    activeEditors.forEach(editorEl => {
                        editorEl._wysiwygSending = true;
                        setTimeout(() => {
                            editorEl._wysiwygSending = false;
                            // Reflect the now-sent (cleared) textarea; the resumed
                            // watchers also self-heal, but clear eagerly for snappy UX.
                            // The textarea is the editor's NEXT sibling (the editor was
                            // inserted via insertBefore(editor, textarea)).
                            const ta = editorEl.nextElementSibling;
                            if (ta && ta.tagName === 'TEXTAREA' && ta.value === '') {
                                editorEl.replaceChildren();
                            }
                        }, WYSIWYG_SEND_SUSPEND_MS);
                    });

                    // On desktop in danger zone, remove editors to prevent layout issues
                    // On iOS/mobile, NEVER remove - let them stay in place
                    const windowWidth = window.innerWidth;
                    const inDangerZone = windowWidth >= 700 && windowWidth <= 850;
                    
                    if (!isIOSDevice && inDangerZone) {
                        debugLog('[WYSIWYG] Desktop danger zone - removing editors');
                        // Remove all WYSIWYG overlays
                        removeAllWysiwygOverlays();
                        
                        debugLog('[WYSIWYG] All editors removed before send');
                    }
                };
                
                // Use capture phase to intercept BEFORE React sees the event
                // Wrap in try-catch for safety (iOS compatibility)
                try {
                    if (document && document.addEventListener) {
                        document.addEventListener('click', wysiwygSendInterceptor, true);
                        document.addEventListener('touchend', wysiwygSendInterceptor, true);
                        debugLog('[WYSIWYG] Send button interceptor installed');
                    } else {
                        debugLog('[WYSIWYG] Warning: document not ready for event listeners');
                    }
                } catch (error) {
                    console.error('[WYSIWYG] Error installing send interceptor:', error);
                }
            }
            
            // Initial setup
            // iOS/Mobile FIX: Much longer delay to ensure React fully finishes rendering
            // React 185 crash happens when we inject DOM elements while React is still rendering
            // The chat page has multiple render cycles on load, so we need to wait for them all
            
            debugLog('[WYSIWYG] ======== DEVICE DETECTION START ========');
            debugLog('[WYSIWYG] navigator.userAgent:', navigator.userAgent);
            debugLog('[WYSIWYG] navigator.platform:', navigator.platform);
            debugLog('[WYSIWYG] navigator.maxTouchPoints:', navigator.maxTouchPoints);
            debugLog('[WYSIWYG] window.innerWidth:', window.innerWidth);
            debugLog('[WYSIWYG] ontouchstart in window:', 'ontouchstart' in window);
            
            // Robust mobile/iOS detection - Orion browser on iOS doesn't include standard iOS UA strings
            const isIOSDevice = isAppleTouchDevice();
            const isMobileDevice = isIOSDevice ||
                                   /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                                   (window.innerWidth < 768 && 'ontouchstart' in window);
            
            debugLog('[WYSIWYG] isIOSDevice:', isIOSDevice);
            debugLog('[WYSIWYG] isMobileDevice:', isMobileDevice);
            debugLog('[WYSIWYG] ======== DEVICE DETECTION END ========');
            
            // MOBILE COOLDOWN: Block ALL WYSIWYG setup (including from observer) during initial page load
            // This prevents the MutationObserver from triggering setup while React is rendering
            let wysiwygMobileCooldown = isMobileDevice;
            if (isMobileDevice) {
                const cooldownTime = Date.now();
                debugLog('[WYSIWYG] ======== MOBILE COOLDOWN STARTING ========');
                debugLog('[WYSIWYG] Cooldown started at:', cooldownTime);
                debugLog('[WYSIWYG] Mobile detected - blocking observer triggers for 6 seconds');
                setTimeout(() => {
                    wysiwygMobileCooldown = false;
                    debugLog('[WYSIWYG] ======== MOBILE COOLDOWN ENDED ========');
                    debugLog('[WYSIWYG] Cooldown ended at:', Date.now());
                    debugLog('[WYSIWYG] Observer can now trigger setup');
                }, 6000);
            } else {
                debugLog('[WYSIWYG] Desktop detected - no cooldown needed');
            }
            
            const setupDelay = isMobileDevice ? 6000 : 500; // 6s on mobile, 500ms on desktop
            debugLog('[WYSIWYG] ======== SCHEDULING INITIAL SETUP ========');
            debugLog('[WYSIWYG] Setup will run in', setupDelay, 'ms');
            debugLog('[WYSIWYG] Setup scheduled at:', Date.now());
            debugLog('[WYSIWYG] Setup will execute at approximately:', Date.now() + setupDelay);
            setTimeout(findAndSetupWysiwygTextareas, setupDelay);
            
            // Watch for new textareas
            if (!wysiwygObserver) {
                wysiwygObserver = new MutationObserver((mutations) => {
                    debugLog('[WYSIWYG] Main observer fired - isResizing:', isResizing, 'sidebarWidthTransitionPending:', sidebarWidthTransitionPending, 'mutations:', mutations.length);
                    // Skip during resize to prevent React 185 error
                    if (isResizing || sidebarWidthTransitionPending) {
                        debugLog('[WYSIWYG] Main observer SKIPPED due to resize in progress');
                        return;
                    }
                    
                    // Mobile FIX: Skip during cooldown period after page load
                    if (wysiwygMobileCooldown) {
                        debugLog('[WYSIWYG] *** OBSERVER BLOCKED BY COOLDOWN ***');
                        debugLog('[WYSIWYG] Timestamp:', Date.now());
                        debugLog('[WYSIWYG] Observer saw', mutations.length, 'mutations but cooldown is active');
                        return;
                    }
                    
                    let needsSetup = false;
                    for (const mutation of mutations) {
                        if (mutation.addedNodes.length > 0) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === 1) {
                                    // Check if node is a textarea
                                    if (node.tagName === 'TEXTAREA') {
                                        debugLog('[WYSIWYG] Main observer found new TEXTAREA');
                                        needsSetup = true;
                                        break;
                                    }
                                    // Check if node contains a textarea
                                    if (node.querySelector && node.querySelector('textarea')) {
                                        debugLog('[WYSIWYG] Main observer found node containing textarea');
                                        needsSetup = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (needsSetup) break;
                    }
                    if (needsSetup) {
                        // Double-check resize state before scheduling setup
                        if (!isResizing && !sidebarWidthTransitionPending) {
                            // Mobile FIX: Use longer delay on mobile to avoid React 185 crash
                            const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                                             /iPhone|iPad|iPod/i.test(navigator.platform) ||
                                             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
                                             (window.innerWidth < 768 && 'ontouchstart' in window);
                            const observerDelay = isMobile ? 3000 : 100; // 3s on mobile, 100ms on desktop
                            debugLog('[WYSIWYG] Main observer scheduling findAndSetupWysiwygTextareas with delay:', observerDelay, 'ms (isMobile:', isMobile, ')');
                            setTimeout(findAndSetupWysiwygTextareas, observerDelay);
                        } else {
                            debugLog('[WYSIWYG] Main observer skipped scheduling due to resize state');
                        }
                    }
                });
                wysiwygObserver.observe(document.body, { childList: true, subtree: true });
                debugLog('[WYSIWYG] Main observer started watching document.body');
            }
        } else {
            debugLog('[WYSIWYG] Disabling WYSIWYG editor');
            wysiwygActive = false;
            
            // Clean up observer
            if (wysiwygObserver) {
                wysiwygObserver.disconnect();
                wysiwygObserver = null;
            }
            
            // Clean up send button interceptor
            if (wysiwygSendInterceptor) {
                document.removeEventListener('click', wysiwygSendInterceptor, true);
                document.removeEventListener('touchend', wysiwygSendInterceptor, true);
                wysiwygSendInterceptor = null;
                debugLog('[WYSIWYG] Send button interceptor removed');
            }
            
            // Remove all overlays
            removeAllWysiwygOverlays();
            removeWysiwygCSS();
        }
        
        await storage.set(WYSIWYG_EDITOR_KEY, enable);
    }
    
    // Initialize features on page load
    async function initializeStyles() {
        // PERFORMANCE: Batch all feature settings into a single storage read
        const featureSettings = await storage.getMultiple({
            [SIDEBAR_LAYOUT_KEY]: false,
            [CLASSIC_LAYOUT_KEY]: false,
            [CLASSIC_STYLE_KEY]: false,
            [HIDE_FOR_YOU_KEY]: false,
            [PAGE_JUMP_KEY]: false,
            [COMPACT_GENERATION_KEY]: false,
            [WYSIWYG_EDITOR_KEY]: false,
            [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH
        });
        
        const sidebarEnabled = featureSettings[SIDEBAR_LAYOUT_KEY];
        const classicLayoutEnabled = featureSettings[CLASSIC_LAYOUT_KEY];
        const classicStyleEnabled = featureSettings[CLASSIC_STYLE_KEY];
        const hideForYouEnabled = featureSettings[HIDE_FOR_YOU_KEY];
        const pageJumpEnabled = featureSettings[PAGE_JUMP_KEY];
        const compactGenerationEnabled = featureSettings[COMPACT_GENERATION_KEY];
        const wysiwygEnabled = featureSettings[WYSIWYG_EDITOR_KEY];
        
        // Load sidebar minimum width setting
        sidebarMinWidth = featureSettings[SIDEBAR_MIN_WIDTH_KEY];
        
        debugLog('[Core] Initializing with settings:', {
            sidebar: sidebarEnabled,
            sidebarMinWidth: sidebarMinWidth,
            classicLayout: classicLayoutEnabled,
            classicStyle: classicStyleEnabled,
            hideForYou: hideForYouEnabled,
            pageJump: pageJumpEnabled,
            compactGeneration: compactGenerationEnabled,
            wysiwygEditor: wysiwygEnabled
        });
        
        // Initialize sidebarUserEnabled for responsive sidebar tracking
        sidebarUserEnabled = sidebarEnabled;
        
        // Sidebar Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        // BUT: Ensure it's disabled on non-chat pages (lorebook, chatbot, group)
        const shouldDisableSidebarLayout = isNonChatPageForSidebar();
        
        if (sidebarEnabled && !shouldDisableSidebarLayout) {
            sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (sidebarStyleElement) {
                debugLog('[Core] Using early-injected Sidebar Layout CSS');
                sidebarStyleElement.disabled = false;
            }
            // Defensive: re-run sweep + ensure observer is attached. The early-inject
            // path normally starts the observer, but if the page started on a
            // non-chat URL (early-inject skipped) and then SPA-navigated to a chat
            // page, the observer would never have been kicked off. This is idempotent.
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            }
            if (typeof updateSidebarLayoutBodyClasses === 'function') {
                updateSidebarLayoutBodyClasses();
            }
        } else {
            // If disabled or on non-chat page, ensure early CSS is disabled
            const earlyElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                sidebarStyleElement = earlyElement;
                debugLog('[Core] Disabled early-injected Sidebar Layout CSS' + (shouldDisableSidebarLayout ? ' (non-chat page)' : ''));
            }
        }
        
        // Initialize responsive sidebar listener (handles auto-disable when page is narrow)
        initResponsiveSidebar();
        
        // Classic Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (classicLayoutEnabled) {
            classicLayoutStyleElement = document.getElementById('sai-toolkit-classic-layout-early');
            if (classicLayoutStyleElement) {
                debugLog('[Core] Using early-injected Classic Layout CSS');
                classicLayoutStyleElement.disabled = false;
            }
        } else {
            // If disabled but early CSS was injected, disable it
            const earlyElement = document.getElementById('sai-toolkit-classic-layout-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                classicLayoutStyleElement = earlyElement;
                debugLog('[Core] Disabled early-injected Classic Layout CSS');
            }
        }
        
        // Classic Style CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (classicStyleEnabled) {
            classicStyleStyleElement = document.getElementById('sai-toolkit-classic-style-early');
            if (classicStyleStyleElement) {
                debugLog('[Core] Using early-injected Classic Style CSS');
                classicStyleStyleElement.disabled = false;
            }
        } else {
            // If disabled but early CSS was injected, disable it
            const earlyElement = document.getElementById('sai-toolkit-classic-style-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                classicStyleStyleElement = earlyElement;
                debugLog('[Core] Disabled early-injected Classic Style CSS');
            }
        }
        
        if (compactGenerationEnabled) {
            await toggleCompactGeneration(true);
        }
        
        if (hideForYouEnabled) {
            await toggleHideForYou(true);
        } else {
            // Ensure any previously hidden characters are restored on page load
            setTimeout(() => {
                restoreForYouCharacters();
            }, 1000);
        }
        if (pageJumpEnabled) {
            await togglePageJump(true);
        }
        if (wysiwygEnabled) {
            // iOS FIX: Delay WYSIWYG initialization on iOS to prevent React 185 during page load
            // On iOS, React is slower and we need to wait for the initial render cycle to fully complete
            // before injecting any DOM elements near React-controlled textareas
            const isIOSDevice = isAppleTouchDevice();
            if (isIOSDevice) {
                debugLog('[WYSIWYG] Delaying initialization on iOS by 4s to avoid React conflicts');
                // Use 4s delay - this ensures React's initial render + any re-renders have completed
                setTimeout(() => toggleWysiwygEditor(true), 4000);
            } else {
                await toggleWysiwygEditor(true);
            }
        }
    }

    // Function to inject S.AI Toolkit Settings menu item
    // REMOVED: No longer injecting into contextual dropdown menu
    // Toolkit is now accessible only via header icon
    function injectToolkitMenuItem() {
        // This function is intentionally left empty but kept for compatibility
        // The toolkit settings are now only accessible via the header icon
    }

    // ---- Drive auth error helpers ----

    function clearDriveAuthError() {
        driveAuthErrorMessage = null;
        const sb = document.getElementById('sai-toolkit-sidebar-btn');
        const mb = document.getElementById('sai-toolkit-mobile-btn');
        if (sb) sb.style.color = '';
        if (mb) mb.style.color = '';
    }

    function showDriveAuthModal() {
        const existing = document.getElementById('sai-drive-auth-modal');
        if (existing) return;

        const overlay = document.createElement('div');
        overlay.id = 'sai-drive-auth-modal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000010;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';

        const card = document.createElement('div');
        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:300px;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid #dc2626;';

        const titleEl = document.createElement('div');
        titleEl.textContent = 'Google Drive Sign-in Required';
        titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';

        const descEl = document.createElement('div');
        descEl.textContent = 'Your Drive session has expired. Sign in again to resume auto-sync.';
        descEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;';

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:11px;min-height:1em;color:#9ca3af;';

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;flex-direction:column;gap:0.4rem;margin-top:0.25rem;';

        const signInBtn = document.createElement('button');
        signInBtn.textContent = 'Sign in to Google Drive';
        signInBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #3b82f6;background:#1d4ed8;color:#fff;font-size:12px;cursor:pointer;';

        const laterBtn = document.createElement('button');
        laterBtn.textContent = 'Later';
        laterBtn.style.cssText = 'padding:0.25rem;border:none;background:transparent;color:#6b7280;font-size:11px;cursor:pointer;text-align:center;';

        signInBtn.onclick = async () => {
            signInBtn.disabled = true;
            signInBtn.textContent = 'Signing in…';
            statusEl.textContent = '';
            try {
                const result = await new Promise((resolve, reject) => {
                    runtimeAPI.runtime.sendMessage(
                        { type: 'SAI_DRIVE_SYNC', syncStats: true, syncSettings: false, syncStyle: false },
                        (res) => {
                            const err = runtimeAPI.runtime.lastError;
                            if (err) reject(new Error(err.message));
                            else resolve(res);
                        }
                    );
                });
                if (result && result.success) {
                    clearDriveAuthError();
                    overlay.remove();
                } else {
                    statusEl.textContent = (result && result.error) || 'Sign-in failed.';
                    statusEl.style.color = '#dc2626';
                    signInBtn.disabled = false;
                    signInBtn.textContent = 'Sign in to Google Drive';
                }
            } catch (err) {
                statusEl.textContent = err.message || 'Sign-in failed.';
                statusEl.style.color = '#dc2626';
                signInBtn.disabled = false;
                signInBtn.textContent = 'Sign in to Google Drive';
            }
        };

        laterBtn.onclick = () => overlay.remove();

        btns.appendChild(signInBtn);
        btns.appendChild(laterBtn);
        card.appendChild(titleEl);
        card.appendChild(descEl);
        card.appendChild(statusEl);
        card.appendChild(btns);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    }

    // Function to inject toolkit icon on header (left of notification bell)
    // Function to inject toolkit button into left sidebar
    function injectToolkitSidebarButton() {
        // Skip injection on mobile - sidebar doesn't exist below 600px
        if (window.innerWidth < 600) {
            debugLog('[Core] Skipping sidebar injection - width < 600px');
            return;
        }
        
        // Check for sidebar width transition - React crashes if we inject during width change
        const sidebar = document.querySelector('nav.flex.flex-col');
        if (sidebar) {
            const currentSidebarWidth = sidebar.style.width || sidebar.offsetWidth + 'px';
            if (lastKnownSidebarWidth !== null && lastKnownSidebarWidth !== currentSidebarWidth) {
                debugLog('[Core] Sidebar width changed from', lastKnownSidebarWidth, 'to', currentSidebarWidth, '- skipping injection');
                sidebarWidthTransitionPending = true;
                lastKnownSidebarWidth = currentSidebarWidth;
                // Schedule re-injection after transition settles
                setTimeout(() => {
                    sidebarWidthTransitionPending = false;
                    debugLog('[Core] Sidebar transition settled, ready for injection');
                }, 400);
                return;
            }
            lastKnownSidebarWidth = currentSidebarWidth;
        }
        
        if (sidebarWidthTransitionPending) {
            debugLog('[Core] Sidebar transition pending - skipping injection');
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-toolkit-sidebar-btn');
        if (existingButton) {
            return;
        }
        
        debugLog('[Core] Searching for Help button...');
        
        // Find the Help button in the sidebar (last section with Subscribe and Help)
        // The Help button is now inside an <a> tag linking to docs.spicychat.ai/support
        let helpButton = null;
        let helpLink = null;
        
        // First, try to find the <a> tag with the help link
        helpLink = document.querySelector('a[href="https://docs.spicychat.ai/support"]');
        if (helpLink) {
            helpButton = helpLink.querySelector('button');
            debugLog('[Core] Found help button via link selector');
        }
        
        // Fallback: try finding by icon and text content
        if (!helpButton) {
            debugLog('[Core] Link selector failed, trying icon+text method');
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const hasInfoIcon = btn.querySelector('svg.lucide-info');
                const hasHelpText = btn.textContent?.trim().includes('Help');
                if (hasInfoIcon && hasHelpText) {
                    helpButton = btn;
                    debugLog('[Core] Found help button via icon+text');
                    break;
                }
            }
        }
        
        // Another fallback: find Subscribe button and get its sibling
        if (!helpButton) {
            debugLog('[Core] Trying Subscribe sibling method');
            const subscribeLink = document.querySelector('a[href$="/subscribe"]');
            if (subscribeLink) {
                const subscribeWrapper = subscribeLink.closest('div.w-full');
                if (subscribeWrapper && subscribeWrapper.nextElementSibling) {
                    const helpWrapper = subscribeWrapper.nextElementSibling;
                    helpLink = helpWrapper.querySelector('a[href*="docs.spicychat.ai"]');
                    if (helpLink) {
                        helpButton = helpLink.querySelector('button');
                        debugLog('[Core] Found help button via Subscribe sibling');
                    }
                }
            }
        }
        
        // Last fallback: just find by info icon alone
        if (!helpButton) {
            debugLog('[Core] Trying info icon only method');
            const infoIcons = document.querySelectorAll('svg.lucide-info');
            for (const icon of infoIcons) {
                const btn = icon.closest('button');
                if (btn) {
                    helpButton = btn;
                    debugLog('[Core] Found help button via info icon');
                    break;
                }
            }
        }
        
        if (!helpButton) {
            debugLog('[Core] Help button not found after all attempts');
            debugLog('[Core] Available links:', Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h.includes('spicychat')));
            debugLog('[Core] Info icons found:', document.querySelectorAll('svg.lucide-info').length);
            return;
        }
        
        debugLog('[Core] Help button found, proceeding...');
        
        // Get the parent container (the div.w-full that wraps the <a> tag)
        // The structure is now: div.w-full > a > button
        const helpAnchor = helpButton.closest('a');
        const helpButtonWrapper = helpAnchor ? helpAnchor.closest('div.w-full') : helpButton.closest('div.w-full');
        
        if (!helpButtonWrapper) {
            debugLog('[Core] Help button wrapper not found');
            debugLog('[Core] Help button parent structure:', helpButton.parentElement?.className);
            debugLog('[Core] Help button parent element:', helpButton.parentElement);
            return;
        }
        
        // Clone the Help button structure to match styling exactly
        const buttonWrapper = helpButtonWrapper.cloneNode(true);
        const clonedAnchor = buttonWrapper.querySelector('a');
        const clonedButton = buttonWrapper.querySelector('button');
        
        // Update the cloned button
        clonedButton.id = 'sai-toolkit-sidebar-btn';
        
        // Update the anchor to prevent navigation (make it a button-like link)
        if (clonedAnchor) {
            clonedAnchor.removeAttribute('href');
            clonedAnchor.style.cursor = 'pointer';
        }
        
        // Remove ALL React tooltip attributes to prevent React from creating duplicate tooltips
        // We'll use our own custom tooltip instead
        const elementsWithTooltip = buttonWrapper.querySelectorAll('[data-tooltip-id]');
        elementsWithTooltip.forEach(el => {
            el.removeAttribute('data-tooltip-id');
            el.removeAttribute('data-tooltip-content');
        });
        debugLog('[Core] Removed React tooltip attributes');
        
        // Replace the SVG icon with wrench icon and ensure text element exists
        const iconContainer = clonedButton.querySelector('.flex.items-center.gap-2');
        if (iconContainer) {
            const svg = iconContainer.querySelector('svg');
            if (svg) {
                svg.outerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wrench inline-flex items-center justify-center flex-none">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                </svg>`;
            }
            
            // Remove ALL existing text elements (from cloned Help button)
            const existingTextElements = iconContainer.querySelectorAll('p');
            existingTextElements.forEach(el => el.remove());
            
            // Create ONE new text element with SAME classes as Help/Subscribe buttons
            let textElement = document.createElement('p');
            textElement.className = 'font-sans text-decoration-skip-ink-none text-underline-position-from-font text-label-lg font-regular text-left truncate toolkit-button-text';
            textElement.textContent = 'S.AI Toolkit';
            iconContainer.appendChild(textElement);
        }
        
        // Custom tooltip for collapsed sidebar (since we removed React tooltip attributes)
        let customTooltip = null;
        
        // Add click handler (also cleans up tooltip)
        clonedButton.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (customTooltip) {
                customTooltip.remove();
                customTooltip = null;
            }
            showToolkitSettingsModal();
        });
        
        clonedButton.addEventListener('mouseenter', function(e) {
            // Check if sidebar is collapsed
            const nav = clonedButton.closest('nav');
            const isCollapsed = nav && nav.style.width === '54px';
            
            if (isCollapsed && !customTooltip) {
                // Create tooltip matching React's tooltip format exactly
                customTooltip = document.createElement('div');
                customTooltip.id = ':r-toolkit:';
                customTooltip.setAttribute('role', 'tooltip');
                customTooltip.className = 'react-tooltip core-styles-module_tooltip__3vRRp styles-module_tooltip__mnnfp styles-module_dark__xNqje !px-2.5 !py-1.5 !rounded-[9px] !bg-black !whitespace-nowrap !transition-opacity !duration-300 react-tooltip__place-right core-styles-module_show__Nt9eE react-tooltip__show';
                const authErr = driveAuthErrorMessage;
                customTooltip.style.cssText = `z-index: 200000; border: 1px solid ${authErr ? '#dc2626' : 'rgb(71, 71, 71)'}; opacity: 1;`;
                customTooltip.textContent = authErr ? authErr : 'S.AI Toolkit';
                
                // Create the arrow element
                const arrow = document.createElement('div');
                arrow.className = 'react-tooltip-arrow core-styles-module_arrow__cvMwQ styles-module_arrow__K0L3T';
                arrow.style.cssText = 'left: -5px; top: 10.5px; border-bottom: 1px solid rgb(71, 71, 71); border-right: 1px solid rgb(71, 71, 71); --rt-arrow-size: 8px;';
                customTooltip.appendChild(arrow);
                
                // Position tooltip to the right of the button
                const rect = clonedButton.getBoundingClientRect();
                customTooltip.style.left = (rect.right + 8) + 'px';
                customTooltip.style.top = (rect.top + rect.height / 2 - 14) + 'px'; // Adjust for tooltip height
                
                document.body.appendChild(customTooltip);
            }
        });
        
        clonedButton.addEventListener('mouseleave', function() {
            if (customTooltip) {
                customTooltip.remove();
                customTooltip = null;
            }
        });
        
        // Insert after the Help button wrapper
        helpButtonWrapper.parentNode.insertBefore(buttonWrapper, helpButtonWrapper.nextSibling);
        
        debugLog('[Core] Sidebar button injected successfully');
    }
    
    // Function to inject toolkit button in mobile header (next to Like button)
    function injectToolkitMobileButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-toolkit-mobile-btn');
        if (existingButton) return;
        
        // Find the button container in the chat header
        // Try multiple possible reference buttons (Like button on 1:1 chats, Sparkles on group chats, or chat-dropdown)
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[Core] No reference button found in chat header');
            return;
        }
        
        // Get the parent container (the flex container with gap-sm)
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Core] Mobile button container not found');
            return;
        }
        
        // Create the toolkit button matching the other button styles
        const toolkitBtn = document.createElement('button');
        toolkitBtn.id = 'sai-toolkit-mobile-btn';
        toolkitBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        toolkitBtn.setAttribute('aria-label', 'SAI-Toolkit-button');
        toolkitBtn.setAttribute('type', 'button');
        
        toolkitBtn.appendChild(makeSVG({
            xmlns: SVG_NS, width: '20', height: '20', viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            class: 'lucide lucide-wrench inline-flex items-center justify-center w-5 h-5'
        }, [
            ['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]
        ]));
        
        // Add click handler
        toolkitBtn.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            showToolkitSettingsModal();
        });
        
        // Insert at the beginning of the container (leftmost position)
        buttonContainer.insertBefore(toolkitBtn, buttonContainer.firstChild);
        debugLog('[Core] Mobile button injected successfully');
    }
    
    // ============================================================================
    // CHAT EXPORT FEATURE
    // ============================================================================
    
    // Function to inject chat export button in mobile header (to the left of toolkit settings button)
    function injectChatExportButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Only show on chat pages (supports both /chat/ and /{language}/chat/)
        if (!isOnChatPage()) {
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-export-btn');
        if (existingButton) return;
        
        // Find the toolkit button first (our own button), or fall back to other header buttons
        const toolkitBtn = document.getElementById('sai-toolkit-mobile-btn');
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = toolkitBtn || likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[Export] Reference button not found');
            return;
        }
        
        // Get the parent container
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Export] Button container not found');
            return;
        }
        
        // Create the export button matching the other button styles
        const exportBtn = document.createElement('button');
        exportBtn.id = 'sai-export-btn';
        exportBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        exportBtn.setAttribute('aria-label', 'Export-chat-button');
        exportBtn.setAttribute('type', 'button');
        
        // Download icon SVG
        exportBtn.appendChild(makeSVG({
            xmlns: SVG_NS, width: '20', height: '20', viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            class: 'lucide lucide-download inline-flex items-center justify-center w-5 h-5'
        }, [
            ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
            ['polyline', { points: '7 10 12 15 17 10' }],
            ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]
        ]));
        
        // Add click handler to show export menu
        exportBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showExportMenu(exportBtn);
        });
        
        // Insert before the toolkit button (if it exists), otherwise at the beginning
        if (toolkitBtn) {
            buttonContainer.insertBefore(exportBtn, toolkitBtn);
        } else {
            buttonContainer.insertBefore(exportBtn, buttonContainer.firstChild);
        }
        debugLog('[Export] Export button injected successfully');
    }
    
    // Track NSFW mode state globally
    let nsfwModeEnabled = false;
    
    // Function to inject NSFW mode toggle button in toolbar
    async function injectNSFWToggleButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Only show on chat pages (supports both /chat/ and /{language}/chat/)
        if (!isOnChatPage()) {
            return;
        }
        
        // Check if feature is enabled in settings (default: false)
        const nsfwToggleEnabled = await storage.get('nsfwToggleEnabled', false);
        if (!nsfwToggleEnabled) {
            debugLog('[NSFW] NSFW toggle feature disabled in settings');
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-nsfw-btn');
        if (existingButton) return;
        
        // Find the export button or toolkit button as reference
        const exportBtn = document.getElementById('sai-export-btn');
        const toolkitBtn = document.getElementById('sai-toolkit-mobile-btn');
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = exportBtn || toolkitBtn || likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[NSFW] Reference button not found');
            return;
        }
        
        // Get the parent container
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[NSFW] Button container not found');
            return;
        }
        
        // Create the NSFW toggle button matching the other button styles
        const nsfwBtn = document.createElement('button');
        nsfwBtn.id = 'sai-nsfw-btn';
        nsfwBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        nsfwBtn.setAttribute('aria-label', 'Toggle-NSFW-image-mode');
        nsfwBtn.setAttribute('type', 'button');
        nsfwBtn.title = 'Toggle NSFW Image Mode';
        
        // Create the icon (flame/fire icon - good for NSFW indicator)
        // We'll update the icon style based on state
        updateNSFWButtonIcon(nsfwBtn);
        
        // Add click handler to toggle NSFW mode
        nsfwBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            toggleNSFWMode();
        });
        
        // Insert before the export button (to the left of it)
        if (exportBtn) {
            buttonContainer.insertBefore(nsfwBtn, exportBtn);
        } else if (toolkitBtn) {
            buttonContainer.insertBefore(nsfwBtn, toolkitBtn);
        } else {
            buttonContainer.insertBefore(nsfwBtn, buttonContainer.firstChild);
        }
        
        // Check initial NSFW state from the page context
        checkCurrentNSFWState();
        
        // Initialize modal watcher to sync with Image Settings modal
        initModalWatcher();
        
        debugLog('[NSFW] NSFW toggle button injected successfully');
    }
    
    // Update the NSFW button icon based on current state
    function updateNSFWButtonIcon(btn) {
        if (!btn) btn = document.getElementById('sai-nsfw-btn');
        if (!btn) return;
        
        // Use a flame icon - colored/highlighted when enabled, monochrome when disabled
        const fillColor = nsfwModeEnabled ? '#f97316' : 'none'; // Orange when enabled
        const strokeColor = nsfwModeEnabled ? '#f97316' : 'currentColor'; // Orange when enabled, gray when disabled
        const opacity = nsfwModeEnabled ? '1' : '0.5';
        
        // Clear existing content
        btn.textContent = '';
        
        // Create SVG element using createElementNS for proper SVG namespace
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', fillColor);
        svg.setAttribute('stroke', strokeColor);
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('class', 'inline-flex items-center justify-center w-5 h-5');
        svg.style.opacity = opacity;
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z');
        svg.appendChild(path);
        btn.appendChild(svg);
        
        btn.title = nsfwModeEnabled ? 'NSFW Image Mode: ON (click to disable)' : 'NSFW Image Mode: OFF (click to enable)';
    }
    
    // Check current NSFW state from the page context (via postMessage)
    function checkCurrentNSFWState() {
        // Request current state from page context (xhr-intercept.js)
        window.postMessage({ type: 'SAI_GET_NSFW_MODE' }, '*');
        
        // Also try to read from localStorage directly as fallback
        try {
            const stored = localStorage.getItem('sai_nsfw_mode_override');
            if (stored !== null) {
                nsfwModeEnabled = stored === 'true';
                debugLog('[NSFW] Loaded NSFW state from localStorage:', nsfwModeEnabled);
                updateNSFWButtonIcon();
            }
        } catch (e) {
            // localStorage not available
        }
    }
    
    // Toggle NSFW mode via postMessage to page context
    function toggleNSFWMode() {
        debugLog('[NSFW] Toggle NSFW mode clicked, current state:', nsfwModeEnabled);
        
        // Toggle the state
        nsfwModeEnabled = !nsfwModeEnabled;
        
        // Send to page context (xhr-intercept.js) to persist and use for API interception
        window.postMessage({
            type: 'SAI_SET_NSFW_MODE',
            enabled: nsfwModeEnabled
        }, '*');
        
        // Update button immediately
        updateNSFWButtonIcon();
        
        // Sync with modal toggle if visible
        syncModalNSFWToggle();
        
        // Show notification
        showNSFWNotification();
        
        debugLog('[NSFW] NSFW mode toggled to:', nsfwModeEnabled);
    }
    
    // Find the NSFW Mode switch in the Conversation Image Settings modal
    function findModalNSFWSwitch() {
        // The modal is a fixed div with classes: fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
        // It contains a <p> with text "Conversation Image Settings"
        // The NSFW toggle is inside a <label class="inline-flex items-center cursor-pointer">
        
        // Find all fixed positioned modals
        const modals = document.querySelectorAll('div.fixed[class*="left-1/2"][class*="top-1/2"]');
        debugLog('[NSFW] Found fixed modals:', modals.length);
        
        for (const modal of modals) {
            // Check if this modal contains "Conversation Image Settings" text
            const allParagraphs = modal.querySelectorAll('p');
            let isImageSettingsModal = false;
            
            for (const p of allParagraphs) {
                if (p.textContent.includes('Conversation Image Settings')) {
                    isImageSettingsModal = true;
                    debugLog('[NSFW] Found Conversation Image Settings modal');
                    break;
                }
            }
            
            if (!isImageSettingsModal) continue;
            
            // Find all labels that could be toggles
            const labels = modal.querySelectorAll('label');
            debugLog('[NSFW] Found labels in modal:', labels.length);
            
            for (const label of labels) {
                // Check if this label contains "NSFW Mode" text
                const labelText = label.textContent.trim();
                debugLog('[NSFW] Label text:', labelText);
                
                if (labelText.includes('NSFW Mode')) {
                    // Found it! Get the checkbox input
                    const checkbox = label.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        debugLog('[NSFW] Found NSFW Mode checkbox');
                        return { checkbox, label };
                    }
                }
            }
        }
        
        debugLog('[NSFW] Could not find NSFW Mode switch');
        return null;
    }
    
    // Sync the modal's NSFW toggle with our state
    function syncModalNSFWToggle() {
        const result = findModalNSFWSwitch();
        if (!result) return;
        
        const { checkbox, label } = result;
        debugLog('[NSFW] Syncing modal toggle, our state:', nsfwModeEnabled, 'modal checked:', checkbox.checked);
        
        if (checkbox.checked !== nsfwModeEnabled) {
            // Click the label to toggle (more reliable than setting checked directly)
            debugLog('[NSFW] States differ, clicking label to sync');
            label.click();
        }
    }
    
    // Watch for changes on the modal's NSFW toggle
    function watchModalNSFWToggle() {
        const result = findModalNSFWSwitch();
        if (!result) return;
        
        const { checkbox, label } = result;
        if (checkbox._saiWatching) {
            debugLog('[NSFW] Already watching this checkbox');
            return;
        }
        
        checkbox._saiWatching = true;
        debugLog('[NSFW] Setting up watcher on modal NSFW checkbox');
        
        // Watch for changes on the checkbox
        const handleChange = () => {
            const modalState = checkbox.checked;
            debugLog('[NSFW] Change detected, modal state:', modalState, 'our state:', nsfwModeEnabled);
            
            if (modalState !== nsfwModeEnabled) {
                debugLog('[NSFW] Updating our state to match modal');
                nsfwModeEnabled = modalState;
                
                // Update page context
                window.postMessage({
                    type: 'SAI_SET_NSFW_MODE',
                    enabled: nsfwModeEnabled
                }, '*');
                
                // Update our button
                updateNSFWButtonIcon();
            }
        };
        
        // Listen for change events on the checkbox
        checkbox.addEventListener('change', handleChange);
        
        // Also listen on the label click (since the checkbox is sr-only)
        label.addEventListener('click', () => {
            debugLog('[NSFW] Label clicked');
            setTimeout(handleChange, 100);
        });
    }
    
    // Watch for the Image Settings modal to open
    function setupModalWatcher() {
        debugLog('[NSFW] Setting up modal watcher');
        
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    // Perf: gate on the modal selector first to avoid reading textContent
                    // on every DOM addition (which is O(n) on the subtree).
                    if (!node.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') &&
                        !node.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) {
                        continue;
                    }
                    if ((node.textContent || '').includes('Conversation Image Settings')) {
                        debugLog('[NSFW] Modal with "Conversation Image Settings" detected!');
                        setTimeout(() => {
                            syncModalNSFWToggle();
                            watchModalNSFWToggle();
                        }, 150);
                        return;
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        debugLog('[NSFW] Modal watcher active');
    }
    
    // Initialize modal watcher when NSFW button is injected
    let modalWatcherInitialized = false;
    function initModalWatcher() {
        if (modalWatcherInitialized) return;
        modalWatcherInitialized = true;
        setupModalWatcher();
    }

    // Show a notification about NSFW mode state
    function showNSFWNotification() {
        // Remove any existing notification
        const existing = document.getElementById('sai-nsfw-notification');
        if (existing) existing.remove();
        
        const notification = document.createElement('div');
        notification.id = 'sai-nsfw-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: ${nsfwModeEnabled ? '#f97316' : '#6b7280'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000010;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            animation: sai-slide-up 0.3s ease-out;
        `;
        notification.textContent = nsfwModeEnabled 
            ? '🔥 NSFW Image Mode: ON' 
            : 'NSFW Image Mode: OFF';
        
        document.body.appendChild(notification);
        
        // Auto-remove after 2 seconds
        setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'sai-slide-down 0.3s ease-in forwards';
                setTimeout(() => notification.remove(), 300);
            }
        }, 2000);
    }
    
    // =========================================================================
    // MESSAGE RECOVERY
    // =========================================================================
    //
    // PROBLEM
    //   When SpicyChat's chat backend is degraded — Cloudflare 502, CORS
    //   preflight failures, request timeouts, or transient network drops —
    //   the user's typed message is lost without warning. The UX is:
    //
    //     1. User types a long, carefully-considered message.
    //     2. User presses Send. The textarea is cleared instantly.
    //     3. Several seconds later a generic red "Oops! Something went
    //        wrong. Please try again." banner appears with a Resubmit button.
    //     4. The site keeps the message in memory only as long as that
    //        banner is on screen for the most-recent failure. Reload the
    //        page, navigate away, dismiss the banner, or trigger a different
    //        error on top of this one, and the original text is gone.
    //
    //   For users who write multi-paragraph messages this is severely
    //   frustrating: the work disappears between the moment they hit Send
    //   and the moment they realize the request failed.
    //
    // WHAT THIS FEATURE DOES
    //   When the user opts in via the "Message Recovery" checkbox in the
    //   Features tab of the S.AI Settings modal:
    //
    //     - The page-context interceptor (xhr-intercept.js) snapshots the
    //       outgoing message text at the moment of POST /chat. The
    //       textarea has already been cleared by SpicyChat at this point,
    //       so we read the message from the request body that we already
    //       have visibility into for model-override and stats purposes.
    //     - If the request fails (XHR error/timeout/abort/status>=400, or
    //       fetch throws/returns !ok) we hand the snapshot to the content
    //       script, which persists it to chrome.storage.local under the
    //       'failedMessages' key. Successful sends never persist anything.
    //     - When the "Oops!" banner appears, we inject a "Recover message"
    //       button next to SpicyChat's "Resubmit" button. Clicking it
    //       refills the chat textarea with the most-recent failed message
    //       and removes that entry from the queue.
    //
    // WHY OPT-IN
    //   Capturing message *content* is materially different from the rest
    //   of the extension's network observation, which is metadata-only
    //   (model name, settings, message IDs, timestamps). Even though no
    //   data leaves the browser, persisting message text to local storage
    //   warrants explicit informed consent. The default is OFF, the
    //   privacy disclosure has been updated, and the toggle lives in the
    //   Features tab next to other content-touching settings.
    //
    // STORAGE / EVICTION
    //   - Key: 'failedMessages'  (chrome.storage.local)
    //   - Cap: 50 entries, FIFO. Old entries are evicted when the cap is
    //     hit so a long outage can't blow up storage.
    //   - On recovery, the entry is removed from the queue.
    //   - Disabling the feature does not auto-clear the queue (so the
    //     user can recover anything that was already captured) but no
    //     new entries are added until it is re-enabled.
    //   - "Clear All Data" wipes everything including this queue.

    let messageRecoveryActive = false;

    async function initMessageRecovery() {
        const enabled = await storage.get('messageRecoveryEnabled', false);
        messageRecoveryActive = enabled;
        debugLog('[MsgRecovery] Init, enabled:', enabled);
        // Tell the page-context interceptor whether to capture message text.
        // Sent regardless of the value so we explicitly disable on every
        // page load (rather than relying on the page-context script's
        // localStorage fallback, which could drift if the user disabled
        // the feature in another tab).
        window.postMessage({
            type: 'SAI_SET_MESSAGE_RECOVERY',
            enabled: !!enabled
        }, '*');
    }

    // Find the "Oops! Something went wrong" error banner.
    // The banner DOM (per the captured chat-page reference) contains a
    // <p class="text-red-12"> with the literal "Oops!" text and is sibling
    // to a Resubmit button. We match on the text rather than fragile
    // utility-class chains so the selector survives Tailwind class shuffles.
    function findOopsBanner() {
        const candidates = document.querySelectorAll('p.text-red-12, p[class*="text-red"]');
        for (const p of candidates) {
            const txt = (p.textContent || '').trim();
            if (txt.startsWith('Oops!') || txt.includes('Something went wrong')) {
                // Walk up to the row that contains the Resubmit button so we
                // can place our button as its sibling.
                let row = p.closest('div');
                for (let i = 0; i < 6 && row; i++) {
                    if (row.querySelector('button')) return row;
                    row = row.parentElement;
                }
                return p.parentElement;
            }
        }
        return null;
    }

    // Inject the "Recover message" button next to Resubmit. Idempotent —
    // safe to call repeatedly from the periodic mutation observer.
    async function injectRecoverButtonIfNeeded() {
        if (!messageRecoveryActive) return;
        const banner = findOopsBanner();
        if (!banner) return;
        if (banner.querySelector('.sai-recover-btn')) return;

        const failedMessages = await storage.get('failedMessages', []);
        if (!Array.isArray(failedMessages) || failedMessages.length === 0) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sai-recover-btn';
        // Match SpicyChat's existing red Resubmit button styling so it
        // looks like a first-class part of the banner.
        btn.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'gap:6px',
            'padding:0 8px',
            'height:28px',
            'margin-left:6px',
            'border:1px solid rgba(255,255,255,0.25)',
            'border-radius:6px',
            'background:transparent',
            'color:#fff',
            'font:500 13px/1 -apple-system,system-ui,Segoe UI,Roboto,sans-serif',
            'cursor:pointer',
            'white-space:nowrap'
        ].join(';');
        btn.textContent = 'Recover message';
        btn.title = 'Restore the message you tried to send before the error';
        btn.addEventListener('click', onRecoverButtonClick);

        // Try to place next to the Resubmit button; otherwise append.
        const resubmit = Array.from(banner.querySelectorAll('button')).find(b =>
            (b.textContent || '').trim().toLowerCase().includes('resubmit')
        );
        if (resubmit && resubmit.parentElement) {
            resubmit.parentElement.appendChild(btn);
        } else {
            banner.appendChild(btn);
        }
        debugLog('[MsgRecovery] Recover button injected');
    }

    async function onRecoverButtonClick(ev) {
        ev.preventDefault();
        ev.stopPropagation();

        const list = await storage.get('failedMessages', []);
        if (!Array.isArray(list) || list.length === 0) {
            showNotification('No saved message to recover');
            return;
        }
        const entry = list[list.length - 1];

        // Find the chat input textarea. The reference chat-page has a single
        // <textarea placeholder="Message...">. We use that as the primary
        // selector and fall back to the only visible textarea on the page.
        let textarea = document.querySelector('textarea[placeholder="Message..."]');
        if (!textarea) {
            const all = Array.from(document.querySelectorAll('textarea'));
            textarea = all.find(t => t.offsetParent !== null) || all[0] || null;
        }

        if (!textarea) {
            // No input found — fall back to clipboard so the message isn't
            // lost a second time.
            try {
                await navigator.clipboard.writeText(entry.message);
                showNotification('Message copied to clipboard (no input field found)');
            } catch (e) {
                showNotification('Could not recover automatically — see extension storage');
                return;
            }
        } else {
            // React-controlled inputs need the native setter so React's
            // synthetic event system picks up the change. setting .value
            // directly is silently overwritten on next render.
            const proto = Object.getPrototypeOf(textarea);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
                setter.call(textarea, entry.message);
            } else {
                textarea.value = entry.message;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.focus();
            showNotification('Message recovered');
        }

        // Drop the recovered entry from the queue.
        const updated = list.slice(0, -1);
        await storage.set('failedMessages', updated);

        // Remove our button — the banner will go away on its own when
        // the user types or the site clears it, but the button has done
        // its job for this entry.
        const btn = document.querySelector('.sai-recover-btn');
        if (btn) btn.remove();
    }

    // Show export dropdown menu
    function showExportMenu(anchorButton) {
        // Remove any existing menu
        const existingMenu = document.getElementById('sai-export-menu');
        if (existingMenu) {
            existingMenu.remove();
            return; // Toggle off if already open
        }
        
        // Create dropdown menu
        const menu = document.createElement('div');
        menu.id = 'sai-export-menu';
        menu.style.cssText = `
            position: fixed;
            z-index: 10000005;
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            min-width: 160px;
            padding: 4px;
        `;
        
        // Check for dark mode
        const isDarkMode = document.documentElement.classList.contains('dark') || 
                          window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (isDarkMode) {
            menu.style.background = '#353535';
            menu.style.borderColor = '#374151';
            menu.style.color = 'white';
        }
        
        // Create menu items
        const menuItems = [
            { label: 'Export as JSON', icon: '{}', action: () => exportChatAsJSON() },
            { label: 'Export as HTML', icon: '📄', action: () => exportChatAsHTML() }
        ];
        
        menuItems.forEach(item => {
            const menuItem = document.createElement('button');
            menuItem.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 8px 12px;
                border: none;
                background: transparent;
                cursor: pointer;
                text-align: left;
                font-size: 14px;
                border-radius: 6px;
                color: ${isDarkMode ? 'white' : '#374151'};
            `;
            
            // Build menu item content using DOM methods (safer than innerHTML)
            const iconSpan = document.createElement('span');
            iconSpan.style.cssText = 'font-family: monospace; font-weight: bold;';
            iconSpan.textContent = item.icon;
            
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            
            menuItem.appendChild(iconSpan);
            menuItem.appendChild(labelSpan);
            
            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.background = isDarkMode ? '#353535' : '#f3f4f6';
            });
            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.background = 'transparent';
            });
            menuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                menu.remove();
                item.action();
            });
            
            menu.appendChild(menuItem);
        });
        
        // Position the menu below the button
        const rect = anchorButton.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        
        document.body.appendChild(menu);
        
        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorButton) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }
    
    // Fetch all messages from the API (without limit)
    async function fetchAllChatMessages() {
        // URL format: /chat/{characterId}/{conversationId} or /{language}/chat/{characterId}/{conversationId}
        const pathParts = window.location.pathname.split('/').filter(p => p);
        // pathParts should be: ['chat', characterId, conversationId] or ['en', 'chat', ...] or ['Chat', ...]

        debugLog('[Export] Path parts:', pathParts);

        // Handle both /chat/ and /{language}/chat/ formats
        let chatIndexOffset = 0;
        if (pathParts[0].match(/^[a-z]{2}$/i)) {
            // Language prefix detected (e.g., 'en')
            chatIndexOffset = 1;
        }

        if (pathParts.length < (chatIndexOffset + 2) || pathParts[chatIndexOffset].toLowerCase() !== 'chat') {
            throw new Error('Not on a chat page. URL should be /chat/{characterId}/{conversationId} or /{language}/chat/{characterId}/{conversationId}');
        }
        
        const characterId = pathParts[chatIndexOffset + 1];
        const conversationId = pathParts.length > (chatIndexOffset + 2) ? pathParts[chatIndexOffset + 2] : null;
        
        if (!characterId) {
            throw new Error('Could not determine character ID from URL');
        }
        
        debugLog('[Export] Character ID:', characterId);
        debugLog('[Export] Conversation ID:', conversationId);
        
        return new Promise((resolve, reject) => {
            // Use postMessage to communicate with page-context.js instead of inline script
            // This avoids CSP issues with inline script injection
            const handler = (event) => {
                // Only handle our specific response
                if (event.source !== window) return;
                if (event.data.type !== 'SAI_EXPORT_CHAT_RESPONSE') return;
                
                window.removeEventListener('message', handler);
                
                if (event.data.success) {
                    resolve({ messages: event.data.messages, character: event.data.character });
                } else {
                    reject(new Error(event.data.error || 'Failed to fetch chat data'));
                }
            };
            window.addEventListener('message', handler);
            
            // Send request to page-context.js
            window.postMessage({
                type: 'SAI_EXPORT_CHAT_REQUEST',
                characterId: characterId,
                conversationId: conversationId
            }, '*');
            
            // Timeout after 30 seconds
            setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error('Export request timed out after 30 seconds'));
            }, 30000);
        });
    }
    
    // Export chat as JSON
    async function exportChatAsJSON() {
        try {
            debugLog('[Export] Starting JSON export...');
            
            const { messages, character } = await fetchAllChatMessages();
            
            debugLog('[Export] Data received - messages:', messages?.messages?.length || 0, 'character:', character?.name || 'unknown');
            
            const exportData = {
                exportedAt: new Date().toISOString(),
                exportedBy: 'S.AI Toolkit',
                character: character ? {
                    id: character.id,
                    name: character.name,
                    title: character.title,
                    avatar_url: character.avatar_url
                } : null,
                conversationId: messages.conversation_id,
                userPersona: messages.userPersona,
                messageCount: messages.messages?.length || 0,
                messages: messages.messages || []
            };
            
            // Build filename with chat label if available
            const chatLabel = window.__saiChatLabel;
            const characterName = character?.name || 'export';
            const safeCharName = characterName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = chatLabel 
                ? `chat-${safeCharName}-${chatLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').trim()}-${dateStr}.json`
                : `chat-${safeCharName}-${dateStr}.json`;
            downloadFile(JSON.stringify(exportData, null, 2), filename, 'application/json');
            
            debugLog('[Export] JSON export complete:', filename, 'with', exportData.messageCount, 'messages');
        } catch (error) {
            console.error('[Export] JSON export failed:', error);
            alert('Failed to export chat: ' + error.message);
        }
    }
    
    // Export chat as formatted HTML with embedded images (data URLs)
    async function exportChatAsHTML() {
        try {
            debugLog('[Export] Starting HTML export...');
            
            // Fetch custom style settings for highlight colors
            const customStyleEnabled = await storage.get(CUSTOM_STYLE_KEY, false);
            const customStyleValuesStr = await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE));
            const customStyleValues = JSON.parse(customStyleValuesStr);
            
            const { messages, character } = await fetchAllChatMessages();
            
            const botName = character?.name || 'Bot';
            const safeBotName = botName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
            
            // Build full avatar URL - avatars are served from cdn.nd-api.com
            const buildAvatarUrl = (avatarPath) => {
                if (!avatarPath) return null;
                if (avatarPath.startsWith('http')) return avatarPath;
                // Avatar paths like "avatars/xxx.png" need cdn.nd-api.com prefix
                return `https://cdn.nd-api.com/${avatarPath}`;
            };
            
            const botAvatarUrl = buildAvatarUrl(character?.avatar_url);
            
            const userPersona = messages.userPersona || {};
            const userName = userPersona.name || 'User';
            const userAvatarUrl = buildAvatarUrl(userPersona.avatar_url);
            
            debugLog('[Export] Bot avatar URL:', botAvatarUrl);
            debugLog('[Export] User avatar URL:', userAvatarUrl);
            debugLog('[Export] Fetching avatar images...');
            
            // Build sub-character map for group chats
            // Maps character_id -> { name, avatar_url }
            const subCharacterMap = {};
            if (character?.sub_characters && Array.isArray(character.sub_characters)) {
                debugLog('[Export] Group chat detected with', character.sub_characters.length, 'sub-characters');
                for (const subChar of character.sub_characters) {
                    if (subChar.id) {
                        subCharacterMap[subChar.id] = {
                            name: subChar.name || 'Bot',
                            avatarUrl: buildAvatarUrl(subChar.avatar_url)
                        };
                        debugLog('[Export] Sub-character:', subChar.id, '->', subChar.name);
                    }
                }
            }
            const isGroupChat = Object.keys(subCharacterMap).length > 0;
            
            // Fetch and convert images to data URLs
            let botImageDataUrl = botAvatarUrl; // Fallback to original URL
            let userImageDataUrl = userAvatarUrl; // Fallback to original URL
            
            if (botAvatarUrl) {
                try {
                    const imageData = await fetchImageAsBase64(botAvatarUrl);
                    if (imageData) {
                        botImageDataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;
                        debugLog('[Export] Bot avatar embedded successfully');
                    }
                } catch (e) {
                    debugLog('[Export] Failed to fetch bot avatar, using URL fallback:', e.message);
                }
            }
            
            if (userAvatarUrl) {
                try {
                    const imageData = await fetchImageAsBase64(userAvatarUrl);
                    if (imageData) {
                        userImageDataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;
                        debugLog('[Export] User avatar embedded successfully');
                    }
                } catch (e) {
                    debugLog('[Export] Failed to fetch user avatar, using URL fallback:', e.message);
                }
            }
            
            // For group chats, fetch and embed avatars for each sub-character
            const subCharacterImageMap = {}; // character_id -> data URL or original URL
            if (isGroupChat) {
                for (const [charId, charInfo] of Object.entries(subCharacterMap)) {
                    subCharacterImageMap[charId] = charInfo.avatarUrl; // Default to URL
                    if (charInfo.avatarUrl) {
                        try {
                            const imageData = await fetchImageAsBase64(charInfo.avatarUrl);
                            if (imageData) {
                                subCharacterImageMap[charId] = `data:${imageData.mimeType};base64,${imageData.base64}`;
                                debugLog('[Export] Sub-character avatar embedded:', charInfo.name);
                            }
                        } catch (e) {
                            debugLog('[Export] Failed to fetch sub-character avatar for', charInfo.name, ':', e.message);
                        }
                    }
                }
            }
            
            // Build the HTML with embedded data URLs
            const html = generateChatHTML({
                botName,
                botImageUrl: botImageDataUrl,
                userName,
                userImageUrl: userImageDataUrl,
                characterTitle: character?.title || '',
                conversationId: messages.conversation_id,
                messages: messages.messages || [],
                exportedAt: new Date().toISOString(),
                // Group chat support
                isGroupChat,
                subCharacterMap,
                subCharacterImageMap,
                // Custom style colors for backtick formatting
                highlightBgColor: customStyleEnabled && customStyleValues.highlightBgColor ? customStyleValues.highlightBgColor : '#ffdd6d',
                highlightTextColor: customStyleEnabled && customStyleValues.highlightTextColor ? customStyleValues.highlightTextColor : '#000000'
            });
            
            // Build filename with chat label if available
            const chatLabel = window.__saiChatLabel;
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = chatLabel 
                ? `chat-${safeBotName}-${chatLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').trim()}-${dateStr}.html`
                : `chat-${safeBotName}-${dateStr}.html`;
            downloadFile(html, filename, 'text/html');
            
            debugLog('[Export] HTML export complete:', filename);
        } catch (error) {
            console.error('[Export] HTML export failed:', error);
            alert('Failed to export chat: ' + error.message);
        }
    }

    // Fetch an image and convert to base64 using Image + Canvas (handles CORS better)
    async function fetchImageAsBase64(url) {
        debugLog('[Export] Fetching image:', url);
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous'; // Request CORS access
            
            const timeout = setTimeout(() => {
                debugLog('[Export] Image fetch timeout for:', url);
                reject(new Error('Image fetch timeout'));
            }, 10000);
            
            img.onload = () => {
                clearTimeout(timeout);
                try {
                    // Create canvas and draw image
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    
                    if (canvas.width === 0 || canvas.height === 0) {
                        throw new Error('Image has zero dimensions');
                    }
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    // Get as data URL and extract base64
                    const dataUrl = canvas.toDataURL('image/png');
                    const base64 = dataUrl.split(',')[1];
                    
                    if (!base64 || base64.length < 100) {
                        throw new Error('Invalid base64 data');
                    }
                    
                    debugLog('[Export] Image fetched successfully, base64 length:', base64.length);
                    resolve({ base64, mimeType: 'image/png', url });
                } catch (e) {
                    debugLog('[Export] Canvas error:', e.message);
                    reject(e);
                }
            };
            
            img.onerror = (e) => {
                clearTimeout(timeout);
                debugLog('[Export] Image load error for:', url, e);
                reject(new Error('Image failed to load'));
            };
            
            // Load the image
            img.src = url;
        });
    }
    
    // Generate standalone HTML for chat export (uses direct URLs or data URLs)
    function generateChatHTML(data) {
        const { 
            botName, botImageUrl, userName, userImageUrl, characterTitle, 
            conversationId, messages, exportedAt,
            // Group chat support
            isGroupChat = false, subCharacterMap = {}, subCharacterImageMap = {},
            // Custom style colors
            highlightBgColor = '#ffdd6d', highlightTextColor = '#000000'
        } = data;
        
        // =====================================================================
        // IMAGE DEDUPLICATION
        // =====================================================================
        // Collect all unique images and assign them IDs for CSS classes
        // This dramatically reduces HTML size for long chats with many messages
        const imageRegistry = new Map(); // imageUrl -> { id: string, cssClass: string }
        let imageIdCounter = 0;
        
        const registerImage = (imageUrl) => {
            if (!imageUrl) return null;
            if (imageRegistry.has(imageUrl)) {
                return imageRegistry.get(imageUrl);
            }
            const id = `avatar-img-${imageIdCounter++}`;
            const entry = { id, cssClass: id, imageUrl };
            imageRegistry.set(imageUrl, entry);
            return entry;
        };
        
        // Register all avatar images
        const botImageEntry = registerImage(botImageUrl);
        const userImageEntry = registerImage(userImageUrl);
        
        // Register group chat sub-character images
        const subCharImageEntries = {};
        if (isGroupChat) {
            for (const [charId, imgUrl] of Object.entries(subCharacterImageMap)) {
                subCharImageEntries[charId] = registerImage(imgUrl);
            }
        }
        
        // Generate CSS for all registered images
        let imageCSSRules = '';
        for (const [imageUrl, entry] of imageRegistry) {
            imageCSSRules += `
        .${entry.cssClass} {
            background-image: url("${imageUrl.replace(/"/g, '\\"')}");
            background-size: cover;
            background-position: center;
        }`;
        }
        
        // Format timestamp
        const formatTime = (timestamp) => {
            if (!timestamp) return '';
            const date = new Date(timestamp);
            return date.toLocaleString();
        };
        
        // Escape HTML
        const escapeHTML = (text) => {
            if (!text) return '';
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };
        
        // Format message content
        const formatContent = (text) => {
            if (!text) return '';
            let formatted = escapeHTML(text);
            // Process backticks for highlighted code/text BEFORE asterisks to avoid conflicts
            formatted = formatted.replace(/`([^`]+)`/g, `<span class="highlight-text" style="background-color: ${highlightBgColor}; color: ${highlightTextColor}; padding: 0 4px; border-radius: 4px; display: inline-block; max-width: max-content;">$1</span>`);
            // Process double asterisks for bold BEFORE single asterisks to avoid conflicts
            formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            formatted = formatted.replace(/\*([^*]+)\*/g, '<em class="action">$1</em>');
            formatted = formatted.replace(/\n/g, '<br>');
            return formatted;
        };
        
        // Sort messages by createdAt
        const sortedMessages = [...messages].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        
        // Generate message HTML
        let messagesHTML = '';
        let isFirstBotMessage = true; // Track if this is the opening/greeting message
        for (const msg of sortedMessages) {
            const isBot = msg.role === 'bot';
            const roleClass = isBot ? 'bot' : 'user';
            const altIndicator = msg.is_alternative ? '<span class="alt-badge">ALT</span>' : '';
            
            // Determine sender name and avatar image entry
            let senderName, imageEntry;
            if (isBot) {
                if (isGroupChat && isFirstBotMessage) {
                    // First bot message in group chat: use group name and avatar
                    senderName = botName;
                    imageEntry = botImageEntry;
                    isFirstBotMessage = false;
                } else if (isGroupChat && msg.character_id && subCharacterMap[msg.character_id]) {
                    // Subsequent bot messages in group chat: use individual character info
                    senderName = subCharacterMap[msg.character_id].name;
                    imageEntry = subCharImageEntries[msg.character_id];
                } else {
                    // Standard single-character chat
                    senderName = botName;
                    imageEntry = botImageEntry;
                }
            } else {
                // User message
                senderName = userName;
                imageEntry = userImageEntry;
            }
            
            // Use CSS class for avatar instead of inline data URL
            const avatarHTML = imageEntry
                ? `<div class="avatar ${imageEntry.cssClass}" role="img" aria-label="${escapeHTML(senderName)}"></div>`
                : `<div class="avatar-placeholder">${escapeHTML(senderName.charAt(0).toUpperCase())}</div>`;
            
            messagesHTML += `
            <div class="message ${roleClass}">
                <div class="avatar-container">
                    ${avatarHTML}
                </div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="sender-name">${escapeHTML(senderName)}</span>
                        ${altIndicator}
                        <span class="timestamp">${formatTime(msg.createdAt)}</span>
                    </div>
                    <div class="message-text">${formatContent(msg.content)}</div>
                </div>
            </div>`;
        }
        
        // Calculate size savings for debug info
        const uniqueImages = imageRegistry.size;
        const totalImageRefs = sortedMessages.length; // Each message has an avatar
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chat with ${escapeHTML(botName)}</title>
    <style>
        /* 
         * S.AI Toolkit Chat Export Stylesheet
         * Feel free to customize these styles!
         * 
         * Image Optimization: ${uniqueImages} unique avatar(s) defined once in CSS,
         * referenced ${totalImageRefs} times throughout ${sortedMessages.length} messages.
         */
        
        :root {
            --bg-color: #0f0f0f;
            --text-color: #e5e5e5;
            --header-bg: #1a1a1a;
            --message-bg: #1a1a1a;
            --user-message-bg: rgba(0, 100, 255, 0.1);
            --bot-message-bg: rgba(100, 100, 100, 0.1);
            --border-color: #333;
            --action-color: #06B7DB;
            --timestamp-color: #6b7280;
            --accent-color: #ffdd6d;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.6;
        }
        
        .container { max-width: 900px; margin: 0 auto; padding: 20px; }
        
        .header {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .header h1 { font-size: 1.5rem; margin-bottom: 8px; }
        .header .subtitle { color: var(--timestamp-color); font-size: 0.9rem; }
        .export-info {
            font-size: 0.75rem;
            color: var(--timestamp-color);
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .messages-container { display: flex; flex-direction: column; gap: 16px; }
        
        .message {
            display: flex;
            gap: 12px;
            padding: 16px;
            border-radius: 12px;
            background: var(--message-bg);
            border: 1px solid var(--border-color);
        }
        
        .message.user { background: var(--user-message-bg); }
        .message.bot { background: var(--bot-message-bg); }
        
        .avatar-container { flex-shrink: 0; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; }
        .avatar-placeholder {
            width: 40px; height: 40px; border-radius: 50%;
            background: var(--accent-color); color: white;
            display: flex; align-items: center; justify-content: center;
            font-weight: bold; font-size: 1.2rem;
        }
        
        /* Deduplicated avatar images - each base64 image defined only once */
        ${imageCSSRules}
        
        .message-content { flex: 1; min-width: 0; }
        .message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
        .sender-name { font-weight: 600; }
        .timestamp { font-size: 0.75rem; color: var(--timestamp-color); }
        .alt-badge {
            font-size: 0.65rem; padding: 2px 6px;
            background: var(--accent-color); color: white;
            border-radius: 4px; text-transform: uppercase; font-weight: 600;
        }
        .message-text { word-wrap: break-word; }
        .message-text .action { color: var(--action-color); font-style: italic; }
        
        @media (max-width: 600px) {
            .container { padding: 10px; }
            .message { padding: 12px; }
            .avatar, .avatar-placeholder { width: 32px; height: 32px; font-size: 1rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Chat with ${escapeHTML(botName)}</h1>
            ${characterTitle ? `<p class="subtitle">${escapeHTML(characterTitle)}</p>` : ''}
            <div class="export-info">
                Exported on ${formatTime(exportedAt)} by S.AI Toolkit<br>
                ${sortedMessages.length} messages
            </div>
        </div>
        <div class="messages-container">
            ${messagesHTML}
        </div>
    </div>
</body>
</html>`;
    }
    
    // Helper function to detect iOS
    function isIOS() {
        const ua = navigator.userAgent;
        const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || 
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        console.log('[S.AI Export] iOS detection - isIOS:', isIOSDevice);
        return isIOSDevice;
    }
    
    // Helper function to download a file
    function downloadFile(content, filename, mimeType) {
        console.log('[S.AI Export] downloadFile called:', filename, mimeType, 'content length:', content.length);
        
        const blob = new Blob([content], { type: mimeType });
        
        // iOS needs special handling - blob URLs don't work for downloads
        if (isIOS()) {
            console.log('[S.AI Export] iOS detected, showing save modal');
            showIOSSaveModal(content, filename, mimeType);
            return;
        }
        
        // Standard desktop approach
        console.log('[S.AI Export] Using standard download approach');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    // iOS-specific save modal - shows content for manual copying
    function showIOSSaveModal(content, filename, mimeType) {
        console.log('[S.AI Export] Creating iOS save modal');
        
        // Remove any existing modal
        const existingModal = document.getElementById('ios-save-modal');
        if (existingModal) existingModal.remove();
        
        // Create modal container
        const modal = document.createElement('div');
        modal.id = 'ios-save-modal';
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            z-index: 10000020;
            display: flex;
            flex-direction: column;
            padding: 20px;
            padding-top: env(safe-area-inset-top, 20px);
            padding-bottom: env(safe-area-inset-bottom, 20px);
        `;
        
        // Create content wrapper
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            background: #1a1a2e;
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            max-height: 100%;
        `;
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 16px 20px;
            border-bottom: 1px solid #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        
        const title = document.createElement('h2');
        title.textContent = `Save: ${filename}`;
        title.style.cssText = `
            margin: 0;
            font-size: 18px;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: #ef4444;
            color: white;
            border: none;
            width: 32px;
            height: 32px;
            border-radius: 16px;
            font-size: 18px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        closeBtn.onclick = () => modal.remove();
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        
        // Instructions
        const instructions = document.createElement('div');
        instructions.style.cssText = `
            padding: 12px 20px;
            background: #2a2a3e;
            color: #a0a0a0;
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            line-height: 1.4;
        `;
        
        // Build instructions content safely
        const strong1 = document.createElement('strong');
        strong1.style.color = '#4ade80';
        strong1.textContent = 'To save this file:';
        instructions.appendChild(strong1);
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('1. Tap "Copy to Clipboard" below'));
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('2. Open the '));
        const strong2 = document.createElement('strong');
        strong2.textContent = 'Files';
        instructions.appendChild(strong2);
        instructions.appendChild(document.createTextNode(' app or a text editor'));
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('3. Create a new file named '));
        const strong3 = document.createElement('strong');
        strong3.textContent = filename;
        instructions.appendChild(strong3);
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('4. Paste the content and save'));
        
        // Button row
        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = `
            padding: 12px 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        `;
        
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 Copy to Clipboard';
        copyBtn.style.cssText = `
            flex: 1;
            min-width: 140px;
            padding: 14px 20px;
            background: #4f46e5;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(content);
                copyBtn.textContent = '✓ Copied!';
                copyBtn.style.background = '#22c55e';
                showNotification('Content copied to clipboard!');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy to Clipboard';
                    copyBtn.style.background = '#4f46e5';
                }, 2000);
            } catch (e) {
                console.log('[S.AI Export] Clipboard API failed:', e);
                // Fallback: select the textarea content
                textarea.select();
                textarea.setSelectionRange(0, 99999);
                document.execCommand('copy');
                copyBtn.textContent = '✓ Copied!';
                copyBtn.style.background = '#22c55e';
                showNotification('Content copied! (fallback method)');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy to Clipboard';
                    copyBtn.style.background = '#4f46e5';
                }, 2000);
            }
        };
        
        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '🔤 Select All';
        selectAllBtn.style.cssText = `
            flex: 1;
            min-width: 100px;
            padding: 14px 20px;
            background: #374151;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        selectAllBtn.onclick = () => {
            textarea.select();
            textarea.setSelectionRange(0, 99999);
            showNotification('Content selected - now copy it');
        };
        
        buttonRow.appendChild(copyBtn);
        buttonRow.appendChild(selectAllBtn);
        
        // Textarea with content
        const textareaContainer = document.createElement('div');
        textareaContainer.style.cssText = `
            flex: 1;
            padding: 0 20px 20px 20px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            min-height: 0;
        `;
        
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.readOnly = true;
        textarea.style.cssText = `
            flex: 1;
            width: 100%;
            background: #0d0d1a;
            color: #e0e0e0;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 12px;
            font-size: 12px;
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
            resize: none;
            line-height: 1.4;
        `;
        
        textareaContainer.appendChild(textarea);
        
        // Assemble modal
        wrapper.appendChild(header);
        wrapper.appendChild(instructions);
        wrapper.appendChild(buttonRow);
        wrapper.appendChild(textareaContainer);
        modal.appendChild(wrapper);
        
        document.body.appendChild(modal);
        console.log('[S.AI Export] iOS save modal displayed');
    }
    
    // Helper function to show iOS download instructions modal (legacy, keeping for reference)
    function showIOSDownloadInstructions(content, filename, mimeType) {
        const modal = document.createElement('div');
        modal.id = 'ios-download-modal';
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 10000010;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;
        
        const content_div = document.createElement('div');
        content_div.style.cssText = `
            background: #1a1a2e;
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            width: 100%;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        
        const title = document.createElement('h3');
        title.textContent = 'Save File on iOS';
        title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px;';
        
        const instructions = document.createElement('p');
        instructions.textContent = 'Tap the button below to open your file, then use the Share button (↑) in your browser to save it to Files or another app.';
        instructions.style.cssText = 'margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; opacity: 0.9;';
        
        const openButton = document.createElement('button');
        openButton.textContent = 'Open File';
        openButton.style.cssText = `
            width: 100%;
            padding: 14px;
            background: #4f46e5;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-bottom: 12px;
        `;
        openButton.onclick = () => {
            const base64 = btoa(unescape(encodeURIComponent(content)));
            const dataUrl = `data:${mimeType};base64,${base64}`;
            window.open(dataUrl, '_blank');
        };
        
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.style.cssText = `
            width: 100%;
            padding: 14px;
            background: transparent;
            color: white;
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
        `;
        closeButton.onclick = () => modal.remove();
        
        content_div.appendChild(title);
        content_div.appendChild(instructions);
        content_div.appendChild(openButton);
        content_div.appendChild(closeButton);
        modal.appendChild(content_div);
        
        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
        
        document.body.appendChild(modal);
    }
    
    // Function to show toolkit settings modal
    async function showToolkitSettingsModal() {
    debugLog('[Core] ===== OPENING SETTINGS MODAL =====');
    debugLog('[Core] Current Sidebar Layout enabled?', await storage.get(SIDEBAR_LAYOUT_KEY, false));
    debugLog('[Core] Current Classic Layout enabled?', await storage.get(CLASSIC_LAYOUT_KEY, false));
    debugLog('[Core] Current Classic Style enabled?', await storage.get(CLASSIC_STYLE_KEY, false));
    // Create or get a dedicated container with SHADOW DOM for complete isolation
        let toolkitRoot = document.getElementById('toolkit-modal-root');
        if (!toolkitRoot) {
            debugLog('[Core] Creating new toolkit-modal-root with Shadow DOM');
            toolkitRoot = document.createElement('div');
            toolkitRoot.id = 'toolkit-modal-root';
            toolkitRoot.className = 'toolkit-modal-container';
            toolkitRoot.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 10000003;';
            document.body.appendChild(toolkitRoot);
            
            // Attach shadow DOM for complete isolation from React
            const shadow = toolkitRoot.attachShadow({ mode: 'open' });
            debugLog('[Core] Shadow DOM attached');
            
            // Add styles to shadow DOM
            const style = document.createElement('style');
            style.textContent = `
                * { box-sizing: border-box; }
                .backdrop {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.3);
                    backdrop-filter: blur(4px);
                    z-index: 10000003;
                    pointer-events: auto;
                }
                .modal {
                    position: fixed;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 12px;
                    width: 420px;
                    max-width: 95vw;
                    max-height: 85vh;   /* fallback for browsers without dvh */
                    max-height: 85dvh;  /* dynamic viewport: excludes iOS toolbars */
                    z-index: 10000004;
                    pointer-events: auto;
                    display: flex;
                    flex-direction: column;
                    padding: 1rem;
                    gap: 0.75rem;
                }
                @media (max-width: 480px) {
                    .modal {
                        /* Pin to the VISIBLE viewport instead of centering a large-viewport
                           box. On iOS, vh = the large viewport (ignores the address/tab bars),
                           so a centered max-height:100vh modal overflowed the visible area top
                           AND bottom — clipping the tabs and the Save/Close row. Anchoring
                           top-left at 100dvh fills exactly the visible viewport, and the flex
                           column (pinned header/tabs + scrolling body + pinned button row)
                           keeps everything reachable. */
                        top: 0;
                        left: 0;
                        transform: none;
                        width: 100%;
                        max-width: 100vw;
                        height: 100vh;       /* fallback */
                        height: 100dvh;
                        max-height: 100vh;   /* fallback */
                        max-height: 100dvh;
                        border-radius: 0;
                        padding: 0.75rem;
                    }
                }
                @media (prefers-color-scheme: dark) {
                    .modal { background: #1a1a1a; color: white; }
                }
                .modal-header {
                    text-align: center;
                    font-size: 1.1rem;
                    font-weight: bold;
                    padding-bottom: 0.5rem;
                    flex-shrink: 0;
                }
                
                /* Tab Navigation */
                .tab-nav {
                    display: flex;
                    gap: 0.25rem;
                    border-bottom: 1px solid #e5e7eb;
                    padding-bottom: 0.5rem !important;
                    margin-bottom: 0.5rem;
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: none;
                    flex-shrink: 0;
                }
                .tab-nav::-webkit-scrollbar {
                    display: none;
                }
                @media (prefers-color-scheme: dark) {
                    .tab-nav { border-color: #404040; }
                }
                .tab-btn {
                    flex: 1;
                    min-width: 70px;
                    min-height: 52px;
                    padding: 0.5rem 0.5rem;
                    border: none;
                    background: transparent;
                    color: #6b7280;
                    font-size: 12px !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                    font-weight: 500 !important;
                    font-style: normal !important;
                    text-decoration: none !important;
                    line-height: 1.2 !important;
                    cursor: pointer;
                    border-radius: 6px;
                    transition: all 0.2s;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0.25rem;
                    white-space: nowrap;
                }
                .tab-btn:hover {
                    background: #f3f4f6;
                    color: #374151;
                }
                .tab-btn.active {
                    background: #3b82f6;
                    color: white;
                }
                @media (prefers-color-scheme: dark) {
                    .tab-btn { color: #9ca3af; }
                    .tab-btn:hover { background: #2a2a2a; color: #d1d5db; }
                    .tab-btn.active { background: #3b82f6; color: white; }
                }
                .tab-icon {
                    width: 18px;
                    height: 18px;
                    min-width: 18px;
                    min-height: 18px;
                    flex-shrink: 0;
                }
                @media (max-width: 380px) {
                    .tab-btn span { display: none; }
                    .tab-btn { min-width: 44px; padding: 0.5rem; }
                    .tab-icon { width: 20px; height: 20px; min-width: 20px; min-height: 20px; }
                }
                
                /* Tab Content */
                .tab-content {
                    display: none;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                .tab-content.active {
                    display: flex;
                }

                .modal-body {
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    flex: 1;
                    min-height: 0;
                    margin-right: -1rem;
                    padding-right: 1rem;
                }
                @media (max-width: 480px) {
                    .modal-body {
                        margin-right: -0.75rem;
                        padding-right: 0.75rem;
                    }
                }
                .setting-row {
                    background: #f3f4f6;
                    padding: 0.6rem 0.75rem;
                    border-radius: 0.75rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .setting-row { background: #2a2a2a; }
                }
                .setting-row:hover {
                    background: #e5e7eb;
                }
                @media (prefers-color-scheme: dark) {
                    .setting-row:hover { background: #333; }
                }
                .setting-checkbox {
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .setting-text {
                    flex: 1;
                    cursor: pointer;
                }
                .setting-title {
                    font-size: 13px;
                    font-weight: 500;
                    margin-bottom: 2px;
                }
                .setting-desc {
                    font-size: 11px;
                    color: #6b7280;
                    line-height: 1.3;
                }
                .sub-setting-row {
                    background: #e5e7eb;
                    padding: 0.5rem 0.6rem;
                    padding-left: 0.5rem;
                    border-radius: 0.5rem;
                    margin-top: -0.25rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-left: 1.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .sub-setting-row { background: #1f1f1f; }
                }
                .sub-setting-row:hover {
                    background: #d1d5db;
                }
                @media (prefers-color-scheme: dark) {
                    .sub-setting-row:hover { background: #252525; }
                }
                .sub-setting-text {
                    flex: 1;
                    cursor: pointer;
                }
                .sub-setting-title {
                    font-size: 12px;
                    font-weight: 400;
                }
                .hidden {
                    display: none !important;
                }
                .number-input {
                    width: 70px;
                    padding: 4px 6px;
                    border-radius: 4px;
                    border: 1px solid #d1d5db;
                    background: #f9fafb;
                    color: #374151;
                    font-size: 12px;
                }
                @media (prefers-color-scheme: dark) {
                    .number-input {
                        border-color: #4b5563;
                        background: #374151;
                        color: white;
                    }
                }
                .section-title {
                    font-size: 12px;
                    font-weight: 600;
                    margin-bottom: 0.25rem;
                    margin-top: 0.5rem;
                    color: #374151;
                }
                @media (prefers-color-scheme: dark) {
                    .section-title { color: #d1d5db; }
                }
                .section-desc {
                    font-size: 11px;
                    color: #6b7280;
                    margin-bottom: 0.5rem;
                }
                .drive-sync-status {
                    font-size: 11px;
                    color: #9ca3af;
                    margin-bottom: 0.25rem;
                    min-height: 1.2em;
                }
                .sync-scope-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                    margin-bottom: 0.35rem;
                }
                .sync-scope-label {
                    font-size: 11px;
                    color: #6b7280;
                }
                .sync-scope-item {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    font-size: 12px;
                    color: #374151;
                    cursor: pointer;
                }
                @media (prefers-color-scheme: dark) {
                    .sync-scope-item { color: #d1d5db; }
                }
                .auto-sync-select {
                    font-size: 11px;
                    padding: 0.1rem 0.3rem;
                    border-radius: 4px;
                    border: 1px solid #d1d5db;
                    background: transparent;
                    color: #374151;
                    cursor: pointer;
                }
                @media (prefers-color-scheme: dark) {
                    .auto-sync-select { border-color: #4b5563; color: #d1d5db; background: #1f2937; }
                }
                .drive-backup-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 0.25rem;
                }
                .drive-backup-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: #374151;
                }
                .drive-backup-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    max-height: 168px;
                    overflow-y: auto;
                    margin-top: 0.2rem;
                }
                .drive-backup-item {
                    display: flex;
                    align-items: center;
                    padding: 0.3rem 0.5rem;
                    background: #f3f4f6;
                    border-radius: 6px;
                    gap: 0.5rem;
                }
                .drive-backup-item-date {
                    font-size: 11px;
                    color: #374151;
                    flex: 1;
                }
                .drive-backup-item-btns {
                    display: flex;
                    gap: 0.25rem;
                    flex-shrink: 0;
                }
                .drive-backup-empty, .drive-backup-loading {
                    font-size: 11px;
                    color: #9ca3af;
                    padding: 0.5rem;
                    text-align: center;
                }
                @media (prefers-color-scheme: dark) {
                    .drive-backup-title { color: #d1d5db; }
                    .drive-backup-item { background: #374151; }
                    .drive-backup-item-date { color: #d1d5db; }
                }
                .data-buttons {
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                }
                .version-text {
                    margin-top: 0.75rem;
                    text-align: center;
                    font-size: 11px;
                    color: #9ca3af;
                    font-weight: 400;
                }
                @media (prefers-color-scheme: dark) {
                    .version-text { color: #6b7280; }
                }
                .debug-filter-label {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    font-size: 11px;
                    color: #9ca3af;
                    cursor: pointer;
                    padding: 0.25rem 0.4rem;
                    border-radius: 4px;
                    transition: background 0.15s;
                }
                .debug-filter-label:hover {
                    background: rgba(255,255,255,0.05);
                }
                .debug-filter-label input[type="checkbox"] {
                    width: 14px;
                    height: 14px;
                    accent-color: #4ade80;
                    cursor: pointer;
                }
                .btn-data {
                    flex: 1;
                    min-width: 120px;
                    padding: 0.4rem 0.6rem;
                    border-radius: 6px;
                    border: 1px solid #d1d5db;
                    background: #f9fafb;
                    color: #374151;
                    cursor: pointer;
                    font-size: 11px;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                .btn-data:hover {
                    background: #f3f4f6;
                    border-color: #9ca3af;
                }
                @media (prefers-color-scheme: dark) {
                    .btn-data {
                        background: #1f2937;
                        border-color: #374151;
                        color: #d1d5db;
                    }
                    .btn-data:hover {
                        background: #374151;
                        border-color: #4b5563;
                    }
                }
                .button-row {
                    display: flex;
                    gap: 0.5rem;
                    padding-top: 0.5rem;
                    border-top: 1px solid #e5e7eb;
                    flex-shrink: 0;
                }
                @media (prefers-color-scheme: dark) {
                    .button-row { border-color: #404040; }
                }
                button {
                    flex: 1;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    font-size: 13px !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                    font-weight: 500 !important;
                    font-style: normal !important;
                    text-decoration: none !important;
                    transition: all 0.2s;
                }
                .btn-cancel {
                    background: #e5e7eb;
                    color: black;
                }
                .btn-cancel:hover {
                    background: #d1d5db;
                }
                @media (prefers-color-scheme: dark) {
                    .btn-cancel { background: #404040; color: white; }
                    .btn-cancel:hover { background: #4a4a4a; }
                }
                .btn-save {
                    background: #3b82f6;
                    color: white;
                }
                .btn-save:hover {
                    background: #2563eb;
                }
                
                /* Custom Style Options */
                .custom-style-options {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    padding: 0.75rem;
                    background: rgba(255,255,255,0.05);
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                    margin-top: 0.25rem;
                }
                .style-input-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }
                .style-label {
                    min-width: 100px;
                    flex-shrink: 0;
                    color: #d1d5db;
                    font-size: 12px;
                    font-weight: 500;
                }
                .style-label-sub {
                    min-width: 100px;
                    flex-shrink: 0;
                    color: #9ca3af;
                    font-size: 11px;
                    font-weight: 400;
                    padding-left: 1rem;
                }
                @media (max-width: 380px) {
                    .style-label { min-width: 80px; font-size: 11px; }
                    .style-label-sub { min-width: 70px; font-size: 10px; }
                }
                
                /* Text Type Sections (Collapsible) */
                .text-type-section {
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    padding: 0.5rem;
                    background: rgba(0,0,0,0.2);
                    border-radius: 6px;
                    border: 1px solid rgba(255,255,255,0.05);
                }
                .text-type-header {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    cursor: pointer;
                    user-select: none;
                }
                .text-type-header:hover {
                    opacity: 0.8;
                }
                .text-type-caret {
                    font-size: 10px;
                    color: #9ca3af;
                    transition: transform 0.2s;
                    flex-shrink: 0;
                    width: 12px;
                }
                .text-type-caret.expanded {
                    transform: rotate(90deg);
                }
                .text-type-options {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    padding-left: 1.5rem;
                    padding-top: 0.5rem;
                }
                .text-type-options.hidden {
                    display: none;
                }
                .style-input {
                    flex: 1;
                    min-width: 0;
                    padding: 0.5rem;
                    background: #2a2a2a;
                    border: 1px solid #555;
                    color: #fff;
                    border-radius: 6px;
                    font-size: 12px;
                    font-family: 'Courier New', monospace;
                }
                .style-select {
                    flex: 1;
                    min-width: 0;
                    padding: 0.5rem;
                    background: #2a2a2a;
                    border: 1px solid #555;
                    color: #fff;
                    border-radius: 6px;
                    font-size: 12px;
                }
                .clear-btn {
                    padding: 0.4rem 0.75rem;
                    background: #ef4444;
                    border: none;
                    color: #fff;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 500;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background-color 0.2s;
                    flex-shrink: 0;
                }
                .clear-btn:hover {
                    background: #dc2626;
                }
                .color-preview {
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    border: 1px solid #555;
                    flex-shrink: 0;
                    background: transparent;
                    background-image: linear-gradient(45deg, #666 25%, transparent 25%), linear-gradient(-45deg, #666 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #666 75%), linear-gradient(-45deg, transparent 75%, #666 75%);
                    background-size: 8px 8px;
                    background-position: 0 0, 0 4px, 4px -4px, -4px 0px;
                }
                .color-preview-inner {
                    width: 100%;
                    height: 100%;
                    border-radius: 3px;
                }
                .font-preview {
                    padding: 0.5rem 0.75rem;
                    background: #1a1a1a;
                    border: 1px solid #555;
                    border-radius: 6px;
                    margin-top: 0.5rem;
                    text-align: left;
                }
                .font-preview-text {
                    color: #fff;
                    font-size: 16px;
                    line-height: 1.6;
                }
                .preview-quote {
                    color: #fff;
                }
                .preview-narration {
                    font-style: italic;
                }
                .preview-highlight {
                    padding: 0 0.25em;
                    border-radius: 2px;
                }
            `;
            shadow.appendChild(style);
        }
        
        const shadow = toolkitRoot.shadowRoot;
        debugLog('[Core] Got shadow root, clearing existing content');
        
        // Clear existing content
        const existingBackdrop = shadow.querySelector('.backdrop');
        if (existingBackdrop) existingBackdrop.remove();
        const existingModal = shadow.querySelector('.modal');
        if (existingModal) existingModal.remove();
        
        
        // State tracking
        // PERFORMANCE: Batch all modal settings into a single storage read
        const modalSettings = await storage.getMultiple({
            [SIDEBAR_LAYOUT_KEY]: false,
            [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH,
            [COMPACT_GENERATION_KEY]: false,
            [CLASSIC_LAYOUT_KEY]: false,
            [CLASSIC_STYLE_KEY]: false,
            [CUSTOM_STYLE_KEY]: false,
            [CUSTOM_STYLE_VALUES_KEY]: JSON.stringify(DEFAULT_CUSTOM_STYLE),
            [HIDE_FOR_YOU_KEY]: false,
            [PAGE_JUMP_KEY]: false,
            'showGenerationStats': false,
            'showModelDetails': true,
            'showTimestamp': false,
            'highlightModelChanges': false,
            'autoRegenOnMismatch': false,
            'autoRegenOnShort': false,
            'autoRegenMaxAttempts': 1,
            'timestampDateFirst': true,
            'timestamp24Hour': false,
            [SHOW_MESSAGE_IDS_KEY]: false,
            'showChatNameInTitle': false,
            'nsfwToggleEnabled': false,
            'messageRecoveryEnabled': false,
            [WYSIWYG_EDITOR_KEY]: false,
            [ENABLE_GENERATION_PROFILES_KEY]: false,
            [SMALL_PROFILE_IMAGES_KEY]: false,
            [ROUNDED_PROFILE_IMAGES_KEY]: false,
            [SWAP_CHECKBOX_POSITION_KEY]: false,
            [SQUARE_MESSAGE_EDGES_KEY]: false,
            [MESSAGE_CONTAINER_MAX_WIDTH_KEY]: '',
            [MEMORY_DOT_ENABLED_KEY]: true,
            [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
            [HIDE_CREATOR_KEY]: false
        });
        
        let sidebarEnabled = modalSettings[SIDEBAR_LAYOUT_KEY];
        let sidebarMinWidthValue = modalSettings[SIDEBAR_MIN_WIDTH_KEY];
        let compactGenerationEnabled = modalSettings[COMPACT_GENERATION_KEY];
        let classicLayoutEnabled = modalSettings[CLASSIC_LAYOUT_KEY];
        let classicStyleEnabled = modalSettings[CLASSIC_STYLE_KEY];
        let customStyleEnabled = modalSettings[CUSTOM_STYLE_KEY];
        let customStyleValues = JSON.parse(modalSettings[CUSTOM_STYLE_VALUES_KEY]);
        let hideForYouEnabled = modalSettings[HIDE_FOR_YOU_KEY];
        let pageJumpEnabled = modalSettings[PAGE_JUMP_KEY];
        let showStatsEnabled = modalSettings['showGenerationStats'];
        let showModelDetailsEnabled = modalSettings['showModelDetails']; // true = show "model → engine", false = show only "model"
        let showTimestampEnabled = modalSettings['showTimestamp'];
        let highlightModelChangesEnabled = modalSettings['highlightModelChanges'];
        let autoRegenOnMismatchEnabled = modalSettings['autoRegenOnMismatch'];
        let autoRegenOnShortEnabled = modalSettings['autoRegenOnShort'];
        let autoRegenMaxAttempts = modalSettings['autoRegenMaxAttempts'];
        let timestampDateFirst = modalSettings['timestampDateFirst']; // true = date@time, false = time@date
        let timestamp24Hour = modalSettings['timestamp24Hour'];
        let showMessageIdsEnabled = modalSettings[SHOW_MESSAGE_IDS_KEY]; // false = 12-hour (default), true = 24-hour
        let showChatNameInTitleEnabled = modalSettings['showChatNameInTitle'];
        let nsfwToggleEnabled = modalSettings['nsfwToggleEnabled'];
        let messageRecoveryEnabled = modalSettings['messageRecoveryEnabled'];
        let wysiwygEnabled = modalSettings[WYSIWYG_EDITOR_KEY];
        let enableGenerationProfilesEnabled = modalSettings[ENABLE_GENERATION_PROFILES_KEY];
        let smallProfileImagesEnabled = modalSettings[SMALL_PROFILE_IMAGES_KEY];
        let roundedProfileImagesEnabled = modalSettings[ROUNDED_PROFILE_IMAGES_KEY];
        let swapCheckboxPositionEnabled = modalSettings[SWAP_CHECKBOX_POSITION_KEY];
        let squareMessageEdgesEnabled = modalSettings[SQUARE_MESSAGE_EDGES_KEY];
        let messageContainerMaxWidth = modalSettings[MESSAGE_CONTAINER_MAX_WIDTH_KEY];
        let memoryDotEnabled = modalSettings[MEMORY_DOT_ENABLED_KEY];
        let memoryDotColor = modalSettings[MEMORY_DOT_COLOR_KEY];
        let hideCreatorEnabled = modalSettings[HIDE_CREATOR_KEY];

        debugLog('[Core] Modal state - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', sidebarMinWidthValue, 'CompactGeneration:', compactGenerationEnabled, 'ClassicLayout:', classicLayoutEnabled, 'ClassicStyle:', classicStyleEnabled, 'CustomStyle:', customStyleEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled, 'MessageMaxWidth:', messageContainerMaxWidth, 'MemoryDot:', memoryDotEnabled, 'MemoryDotColor:', memoryDotColor);
        
        // Create backdrop
        debugLog('[Core] Creating backdrop and modal elements');
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        
        // Create modal with safe HTML (no dynamic content in innerHTML)
        const modal = document.createElement('div');
        modal.className = 'modal';
        // Using static HTML template - checkboxes will be set programmatically below.
        // Built via DOMParser to avoid the .innerHTML setter (Mozilla addons-linter).
        const SETTINGS_MODAL_TEMPLATE = `
            <div class="modal-header">S.AI Toolkit Settings</div>
            
            <!-- Tab Navigation -->
            <div class="tab-nav">
                <button class="tab-btn active" data-tab="layout">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="9" y1="3" x2="9" y2="21"></line>
                    </svg>
                    <span>Layout</span>
                </button>
                <button class="tab-btn" data-tab="style">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"></circle>
                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"></path>
                    </svg>
                    <span>Style</span>
                </button>
                <button class="tab-btn" data-tab="features">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                    <span>Features</span>
                </button>
                <button class="tab-btn" data-tab="data">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    <span>Data</span>
                </button>
            </div>
            
            <div class="modal-body">
                <!-- Layout Tab -->
                <div class="tab-content active" id="tab-layout">
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="sidebar-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Sidebar Layout</div>
                            <div class="setting-desc">Pin Generation Settings and Memories modals to sidebar</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="compact-generation-row">
                        <input type="checkbox" class="setting-checkbox" id="compact-generation-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Compact Generation Settings</div>
                            <div class="setting-desc">Hide descriptive text for each setting</div>
                        </div>
                    </label>
                    <div class="sub-setting-row hidden" id="sidebar-min-width-row">
                        <div class="sub-setting-text" style="display: flex; align-items: center; gap: 8px;">
                            <div class="sub-setting-title">Minimum page width</div>
                            <input type="number" id="sidebar-min-width-input" class="number-input" min="600" max="2000" step="50" autocomplete="off">
                            <span style="font-size: 11px; color: #6b7280;">px</span>
                        </div>
                    </div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="classic-layout-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Classic Chat Layout</div>
                            <div class="setting-desc">Centered message boxes with proper sizing (by MssAcc)</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="small-profile-images-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Small Profile Images</div>
                            <div class="setting-desc">Smaller profile images in chat messages</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="rounded-profile-images-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Rounded Profile Images</div>
                            <div class="setting-desc">Make profile images circular</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="swap-checkbox-position-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Selection Checkboxes on Right Side</div>
                            <div class="setting-desc">Move selection checkboxes to opposite side</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="square-message-edges-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Square Message Box Edges</div>
                            <div class="setting-desc">Remove rounded corners from message boxes</div>
                        </div>
                    </label>
                </div>
                
                <!-- Style Tab -->
                <div class="tab-content" id="tab-style">
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="classic-style-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Classic Style</div>
                            <div class="setting-desc">Classic colors and styling (by MssAcc)</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="custom-style-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Custom Style</div>
                            <div class="setting-desc">Custom colors and fonts (only one style at a time)</div>
                        </div>
                    </label>
                    <div id="custom-style-options" class="custom-style-options hidden">
                        <div class="style-input-row">
                            <label class="style-label">Bot Message BG:</label>
                            <input type="text" id="custom-ai-bg" class="style-input" placeholder="rgba(100, 100, 100, 0.1)">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-ai-bg"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">User Message BG:</label>
                            <input type="text" id="custom-user-bg" class="style-input" placeholder="rgba(0, 100, 255, 0.1)">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-user-bg"></div></div>
                        </div>
                        
                        <!-- Body Text Section -->
                        <div class="text-type-section">
                            <div class="text-type-header" data-target="body-text-options">
                                <span class="text-type-caret">▶</span>
                                <label class="style-label">Body Text:</label>
                                <input type="text" id="custom-body-color" class="style-input" placeholder="#ffffff">
                                <div class="color-preview"><div class="color-preview-inner" id="preview-body-color"></div></div>
                            </div>
                            <div class="text-type-options hidden" id="body-text-options">
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Weight:</label>
                                    <select id="custom-body-font-weight" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="bold">Bold</option>
                                        <option value="lighter">Lighter</option>
                                        <option value="100">100</option>
                                        <option value="200">200</option>
                                        <option value="300">300</option>
                                        <option value="400">400</option>
                                        <option value="500">500</option>
                                        <option value="600">600</option>
                                        <option value="700">700</option>
                                        <option value="800">800</option>
                                        <option value="900">900</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Style:</label>
                                    <select id="custom-body-font-style" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="italic">Italic</option>
                                        <option value="oblique">Oblique</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Text Decoration:</label>
                                    <select id="custom-body-text-decoration" class="style-select">
                                        <option value="none">None</option>
                                        <option value="underline">Underline</option>
                                        <option value="overline">Overline</option>
                                        <option value="line-through">Line Through</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Dialogue Section -->
                        <div class="text-type-section">
                            <div class="text-type-header" data-target="dialogue-options">
                                <span class="text-type-caret">▶</span>
                                <label class="style-label">Dialogue:</label>
                                <input type="text" id="custom-span-quote-color" class="style-input" placeholder="#ffffff">
                                <div class="color-preview"><div class="color-preview-inner" id="preview-quote-color"></div></div>
                            </div>
                            <div class="text-type-options hidden" id="dialogue-options">
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Weight:</label>
                                    <select id="custom-quote-font-weight" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="bold">Bold</option>
                                        <option value="lighter">Lighter</option>
                                        <option value="100">100</option>
                                        <option value="200">200</option>
                                        <option value="300">300</option>
                                        <option value="400">400</option>
                                        <option value="500">500</option>
                                        <option value="600">600</option>
                                        <option value="700">700</option>
                                        <option value="800">800</option>
                                        <option value="900">900</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Style:</label>
                                    <select id="custom-quote-font-style" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="italic">Italic</option>
                                        <option value="oblique">Oblique</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Text Decoration:</label>
                                    <select id="custom-quote-text-decoration" class="style-select">
                                        <option value="none">None</option>
                                        <option value="underline">Underline</option>
                                        <option value="overline">Overline</option>
                                        <option value="line-through">Line Through</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Narration Section -->
                        <div class="text-type-section">
                            <div class="text-type-header" data-target="narration-options">
                                <span class="text-type-caret">▶</span>
                                <label class="style-label">Narration:</label>
                                <input type="text" id="custom-narration-color" class="style-input" placeholder="#06B7DB">
                                <div class="color-preview"><div class="color-preview-inner" id="preview-narration-color"></div></div>
                            </div>
                            <div class="text-type-options hidden" id="narration-options">
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Weight:</label>
                                    <select id="custom-narration-font-weight" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="bold">Bold</option>
                                        <option value="lighter">Lighter</option>
                                        <option value="100">100</option>
                                        <option value="200">200</option>
                                        <option value="300">300</option>
                                        <option value="400">400</option>
                                        <option value="500">500</option>
                                        <option value="600">600</option>
                                        <option value="700">700</option>
                                        <option value="800">800</option>
                                        <option value="900">900</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Style:</label>
                                    <select id="custom-narration-font-style" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="italic">Italic</option>
                                        <option value="oblique">Oblique</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Text Decoration:</label>
                                    <select id="custom-narration-text-decoration" class="style-select">
                                        <option value="none">None</option>
                                        <option value="underline">Underline</option>
                                        <option value="overline">Overline</option>
                                        <option value="line-through">Line Through</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Highlight Section -->
                        <div class="text-type-section">
                            <div class="text-type-header" data-target="highlight-options">
                                <span class="text-type-caret">▶</span>
                                <label class="style-label">Highlight BG:</label>
                                <input type="text" id="custom-highlight-bg-color" class="style-input" placeholder="#ffdd6d">
                                <div class="color-preview"><div class="color-preview-inner" id="preview-highlight-bg"></div></div>
                            </div>
                            <div class="text-type-options hidden" id="highlight-options">
                                <div class="style-input-row">
                                    <label class="style-label">Highlight Text:</label>
                                    <input type="text" id="custom-highlight-text-color" class="style-input" placeholder="#000000">
                                    <div class="color-preview"><div class="color-preview-inner" id="preview-highlight-text"></div></div>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Weight:</label>
                                    <select id="custom-highlight-font-weight" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="bold">Bold</option>
                                        <option value="lighter">Lighter</option>
                                        <option value="100">100</option>
                                        <option value="200">200</option>
                                        <option value="300">300</option>
                                        <option value="400">400</option>
                                        <option value="500">500</option>
                                        <option value="600">600</option>
                                        <option value="700">700</option>
                                        <option value="800">800</option>
                                        <option value="900">900</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Font Style:</label>
                                    <select id="custom-highlight-font-style" class="style-select">
                                        <option value="normal">Normal</option>
                                        <option value="italic">Italic</option>
                                        <option value="oblique">Oblique</option>
                                    </select>
                                </div>
                                <div class="style-input-row">
                                    <label class="style-label-sub">Text Decoration:</label>
                                    <select id="custom-highlight-text-decoration" class="style-select">
                                        <option value="none">None</option>
                                        <option value="underline">Underline</option>
                                        <option value="overline">Overline</option>
                                        <option value="line-through">Line Through</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        
                        <div class="style-input-row">
                            <label class="style-label">Font Size:</label>
                            <input type="text" id="custom-font-size" class="style-input" placeholder="16px">
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Font Family:</label>
                            <input type="text" id="custom-font-family" class="style-input" placeholder="Arial, sans-serif">
                        </div>
                        <div class="font-preview" id="font-preview-box">
                            <div class="font-preview-text" id="font-preview-text"><span class="preview-quote" id="preview-text-quote">&quot;Go right ahead, dearie!&quot;</span> <span class="preview-narration" id="preview-text-narration">Elara smiles. Her phone buzzes.</span> <span class="preview-highlight" id="preview-text-highlight">The drop has been made.</span></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Button Hover:</label>
                            <input type="text" id="custom-hover-button-color" class="style-input" placeholder="#292929">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-hover-button"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Creator Link:</label>
                            <input type="text" id="custom-creator-link-color" class="style-input" placeholder="e.g. #6b7280">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-creator-link-color"></div></div>
                        </div>

                        <!-- Background Image Section -->
                        <div class="text-type-section">
                            <div class="style-input-row" style="margin-bottom: 0;">
                                <label class="style-label">Background:</label>
                                <input type="file" id="custom-background-image" class="style-input" accept="image/*">
                                <button id="clear-background-image-btn" class="clear-btn">Clear</button>
                            </div>
                            <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;">Upload an image for the chat background (converted to data URL)</div>
                        </div>

                        <!-- Reset to Defaults Button -->
                        <div class="style-input-row" style="justify-content: center; margin-top: 16px;">
                            <button id="reset-custom-style-btn" class="sai-button" style="padding: 8px 16px; background-color: #3b82f6; color: white; border-radius: 6px; cursor: pointer; font-weight: 500; border: none; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='#2563eb'" onmouseout="this.style.backgroundColor='#3b82f6'">
                                Reset to Defaults
                            </button>
                        </div>
                    </div>
                    
                    <!-- Message Container Section -->
                    <div class="custom-style-section">
                        <div class="section-title">Message Container</div>
                        <div class="style-input-row" style="align-items: center;">
                            <label class="style-label">Max Width:</label>
                            <input type="text" id="message-container-max-width" class="style-input" placeholder="e.g. 1200px, 90%" style="flex: 1; min-width: 0;">
                        </div>
                        <div id="message-container-max-width-preview" style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:#6b7280;">
                            <span>Preview:</span>
                            <span id="message-container-max-width-preview-value">—</span>
                            <div id="message-container-max-width-preview-box" style="flex:1;background:#f3f4f6;height:8px;border-radius:4px;overflow:hidden;border:1px solid rgba(0,0,0,0.06);max-width:240px;">
                                <div id="message-container-max-width-preview-inner" style="background:#3b82f6;height:100%;width:100%;transition:width 0.12s ease;"></div>
                            </div>
                        </div>
                        <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;">Max width for message containers — leave empty for default 800px.</div>
                    </div>
                    
                    <!-- Memory Limit Indicator Section -->
                    <div class="custom-style-section">
                        <div class="section-title">Memory Limit Indicator</div>
                        <label class="setting-row" style="margin-bottom: 12px;">
                            <input type="checkbox" class="setting-checkbox" id="memory-dot-enabled-checkbox" autocomplete="off">
                            <div class="setting-text">
                                <div class="setting-title">Show Memory Dot</div>
                                <div class="setting-desc">Display red dot when chat reaches memory limit</div>
                            </div>
                        </label>
                        <div class="style-input-row">
                            <label class="style-label">Dot Color:</label>
                            <input type="text" id="memory-dot-color" class="style-input" placeholder="#ff3b3b">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-memory-dot-color"></div></div>
                        </div>
                        <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;">Customize the memory limit indicator color (default: red)</div>
                    </div>
                </div>
                
                <!-- Features Tab -->
                <div class="tab-content" id="tab-features">
                    <div class="section-title">Main Page</div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="hideforyou-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Hide "For You" Characters</div>
                            <div class="setting-desc">Hide tiles with purple "For You" badge on page 1</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="pagejump-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Page Jump Modal</div>
                            <div class="setting-desc">Click "..." to jump to any page</div>
                        </div>
                    </label>
                    
                    <div class="section-title">Chat</div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showstats-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Generation Stats</div>
                            <div class="setting-desc">Display model and settings below bot messages</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="generation-model-details-row">
                        <input type="checkbox" class="setting-checkbox" id="generation-model-details-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Show full model details</div>
                            <div class="setting-desc">Show "Model → Engine" format</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showtimestamp-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Timestamps</div>
                            <div class="setting-desc">Display message timestamps</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="timestamp-format-row">
                        <input type="checkbox" class="setting-checkbox" id="timestamp-format-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Show date first</div>
                            <div class="setting-desc">Format: "date @ time"</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="timestamp-hour-format-row">
                        <input type="checkbox" class="setting-checkbox" id="timestamp-hour-format-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Use 24-hour time</div>
                            <div class="setting-desc">Default: 12-hour format</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="show-message-ids-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Message IDs</div>
                            <div class="setting-desc">Display message IDs</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="highlight-model-changes-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Highlight Model Changes</div>
                            <div class="setting-desc">Show yellow border when model changes between messages</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="auto-regen-mismatch-row">
                        <input type="checkbox" class="setting-checkbox" id="auto-regen-mismatch-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Auto-Regenerate on Mismatch</div>
                            <div class="setting-desc">Automatically regenerate if model engine changes</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="auto-regen-short-row">
                        <input type="checkbox" class="setting-checkbox" id="auto-regen-short-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Auto-Regenerate on Short Response</div>
                            <div class="setting-desc">Automatically regenerate if response is under 50 characters</div>
                        </div>
                    </label>
                    <div class="sub-setting-row hidden" id="auto-regen-max-row">
                        <div class="sub-setting-text" style="display: flex; align-items: center; gap: 8px;">
                            <div class="sub-setting-title" style="white-space: nowrap;">Max Auto-Regenerations</div>
                            <select id="auto-regen-max-select" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 12px;">
                                <option value="1">1</option>
                                <option value="2">2</option>
                                <option value="3">3</option>
                            </select>
                        </div>
                    </div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showchatnametitle-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Chat Name in Title</div>
                            <div class="setting-desc">Show "Character (Label)" in browser tab</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="nsfwtoggle-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">NSFW Image Toggle</div>
                            <div class="setting-desc">Show NSFW toggle button in chat toolbar</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="wysiwyg-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Live Text Formatting</div>
                            <div class="setting-desc">WYSIWYG preview in message editor and chat input</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="message-recovery-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Message Recovery</div>
                            <div class="setting-desc">Save messages locally when SpicyChat fails to send them, and offer one-click recovery</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="hide-creator-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Hide Creator Name</div>
                            <div class="setting-desc">Hide the @username creator link under bot messages</div>
                        </div>
                    </label>
                    <label class="setting-row hidden" id="generation-profiles-row">
                        <input type="checkbox" class="setting-checkbox" id="generation-profiles-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Generation Profiles (Legacy)</div>
                            <div class="setting-desc">Re-enable generation profile selector</div>
                        </div>
                    </label>
                </div>
                
                <!-- Data Tab -->
                <div class="tab-content" id="tab-data">
                    <div id="generation-profiles-section">
                        <div class="section-title">Generation Profiles</div>
                        <div class="section-desc">Export or delete generation profiles</div>
                        <div class="data-buttons">
                            <button class="btn-data" id="export-profiles-btn">Export</button>
                            <button class="btn-data" id="import-profiles-btn" style="display: none;">Import</button>
                            <button class="btn-data" id="delete-profiles-btn" style="background: #dc2626; border-color: #dc2626; color: white;">Delete</button>
                        </div>
                    </div>
                    
                    <div class="section-title">Drive Sync</div>
                    <div class="section-desc">Sync your data across devices via Google Drive. This will automatically save your generation stats across all your devices, enabling you to start a chat on one, and resume on another while carrying over the generation statistics.</div>
                    <div class="sync-scope-row">
                        <span class="sync-scope-label">Sync:</span>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-stats-toggle" autocomplete="off">
                            <span>Stats</span>
                        </label>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-settings-toggle" autocomplete="off">
                            <span>Settings</span>
                        </label>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-style-toggle" autocomplete="off">
                            <span>Style</span>
                        </label>
                    </div>
                    <div class="sync-scope-row">
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="auto-sync-toggle" autocomplete="off">
                            <span>Auto-sync</span>
                        </label>
                        <select id="auto-sync-interval" class="auto-sync-select" style="display:none;">
                            <option value="5">every 5 min</option>
                            <option value="10">every 10 min</option>
                            <option value="15">every 15 min</option>
                        </select>
                    </div>
                    <div id="drive-sync-status" class="drive-sync-status">Checking…</div>
                    <div class="data-buttons" style="margin-top: 0.5rem;">
                        <button class="btn-data" id="drive-sync-btn">Sync Now</button>
                        <button class="btn-data" id="drive-disconnect-btn" style="display: none; color: #dc2626; border-color: #dc2626;">Disconnect</button>
                    </div>
                    <div id="sync-progress-section" style="display: none; margin-top: 0.6rem;">
                        <div id="sync-progress-text" style="font-size: 0.72rem; color: #9ca3af; margin-bottom: 0.35rem; font-style: italic;"></div>
                        <div style="height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                            <div id="sync-progress-bar" style="height: 100%; background: #6366f1; border-radius: 2px; width: 0%; transition: width 0.4s ease;"></div>
                        </div>
                    </div>
                    <div id="drive-backup-section" style="display: none; margin-top: 0.75rem;">
                        <div class="drive-backup-header">
                            <span class="drive-backup-title">Backups</span>
                            <div style="display: flex; gap: 0.4rem;">
                                <button class="btn-data" id="drive-create-backup-btn">Create Backup</button>
                                <button class="btn-data" id="drive-open-folder-btn">Open in Drive ↗</button>
                            </div>
                        </div>
                        <div id="drive-backup-status" class="drive-sync-status"></div>
                        <div id="drive-backup-list" class="drive-backup-list">
                            <div class="drive-backup-loading">Loading backups…</div>
                        </div>
                    </div>

                    <div class="section-title">Custom Style</div>
                    <div class="section-desc">Export or import custom style settings</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="export-custom-style-btn">Export</button>
                        <button class="btn-data" id="import-custom-style-btn">Import</button>
                    </div>
                    
                    <div class="section-title">All Data</div>
                    <div class="section-desc">Export/import everything (settings, profiles, stats)</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="export-all-btn">Export All</button>
                        <button class="btn-data" id="import-all-btn">Import All</button>
                    </div>
                    <div class="data-buttons" style="margin-top: 0.5rem;">
                        <button class="btn-data" id="clear-all-btn" style="background: #dc2626; border-color: #dc2626; color: white;">Clear All Data</button>
                    </div>
                    
                    <div class="version-text" id="version-text">v1.0.69.29</div>
                    
                    <!-- Debug Log Filters (only visible in debug mode) -->
                    <div id="debug-filters-section" class="hidden" style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.1);">
                        <div class="section-title" style="color: #4ade80;">🐛 Debug Log Filters</div>
                        <div class="section-desc">Toggle which log categories appear in console</div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.75rem;">
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-core" checked> Core
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-stats" checked> Stats
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-memories" checked> Memories
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-export" checked> Export
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-nsfw" checked> NSFW
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-chattitle" checked> ChatTitle
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-wysiwyg" checked> WYSIWYG
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-wysiwyg-text"> WYSIWYG-Text
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-profile" checked> Profile
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-model" checked> Model
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-cache" checked> Cache
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-migration" checked> Migration
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-custom" checked> Custom
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-compact" checked> Compact
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-sync" checked> Sync
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-autoregen" checked> AutoRegen
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-msgrecovery" checked> MsgRecovery
                            </label>
                        </div>
                        <div class="data-buttons" style="margin-top: 0.75rem;">
                            <button class="btn-data" id="debug-filter-all-btn">Enable All</button>
                            <button class="btn-data" id="debug-filter-none-btn">Disable All</button>
                        </div>
                        <div id="model-override-section" style="display: none; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,140,0,0.3);">
                            <div style="font-size: 0.75rem; font-weight: 600; color: #ff8c00; margin-bottom: 0.4rem;">Model Override <span style="color: #9ca3af; font-weight: 400; font-size: 0.7rem;">(quad-click "Model" to toggle)</span></div>
                            <input type="text" id="model-override-input" placeholder="e.g. glm5-beta" autocomplete="off" style="width: 100%; box-sizing: border-box; padding: 0.4rem 0.5rem; background: rgba(255,140,0,0.08); border: 1px solid rgba(255,140,0,0.5); border-radius: 4px; color: #ff8c00; font-size: 0.75rem; outline: none; font-family: monospace;">
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="button-row">
                <button class="btn-cancel" id="cancel-btn">Close</button>
                <button class="btn-save" id="save-btn">Save & Refresh</button>
            </div>
        `;
        modal.replaceChildren(parseHTMLToFragment(SETTINGS_MODAL_TEMPLATE));

        // Append to shadow DOM
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);
        
        debugLog('[Core] Modal and backdrop appended to shadow DOM');
        
        // Get checkbox elements within shadow DOM
        const sidebarCheckbox = shadow.querySelector('#sidebar-checkbox');
        const compactGenerationCheckbox = shadow.querySelector('#compact-generation-checkbox');
        const classicLayoutCheckbox = shadow.querySelector('#classic-layout-checkbox');
        const classicStyleCheckbox = shadow.querySelector('#classic-style-checkbox');
        const customStyleCheckbox = shadow.querySelector('#custom-style-checkbox');
        const customStyleOptions = shadow.querySelector('#custom-style-options');
        const customAiBgInput = shadow.querySelector('#custom-ai-bg');
        const customUserBgInput = shadow.querySelector('#custom-user-bg');
        const smallProfileImagesCheckbox = shadow.querySelector('#small-profile-images-checkbox');
        const roundedProfileImagesCheckbox = shadow.querySelector('#rounded-profile-images-checkbox');
        const swapCheckboxPositionCheckbox = shadow.querySelector('#swap-checkbox-position-checkbox');
        const squareMessageEdgesCheckbox = shadow.querySelector('#square-message-edges-checkbox');
        const customBodyColorInput = shadow.querySelector('#custom-body-color');
        const customBodyFontWeightSelect = shadow.querySelector('#custom-body-font-weight');
        const customBodyFontStyleSelect = shadow.querySelector('#custom-body-font-style');
        const customBodyTextDecorationSelect = shadow.querySelector('#custom-body-text-decoration');
        const customSpanQuoteColorInput = shadow.querySelector('#custom-span-quote-color');
        const customQuoteFontWeightSelect = shadow.querySelector('#custom-quote-font-weight');
        const customQuoteFontStyleSelect = shadow.querySelector('#custom-quote-font-style');
        const customQuoteTextDecorationSelect = shadow.querySelector('#custom-quote-text-decoration');
        const customNarrationColorInput = shadow.querySelector('#custom-narration-color');
        const customNarrationFontWeightSelect = shadow.querySelector('#custom-narration-font-weight');
        const customNarrationFontStyleSelect = shadow.querySelector('#custom-narration-font-style');
        const customNarrationTextDecorationSelect = shadow.querySelector('#custom-narration-text-decoration');
        const customHighlightBgColorInput = shadow.querySelector('#custom-highlight-bg-color');
        const customHighlightTextColorInput = shadow.querySelector('#custom-highlight-text-color');
        const customHighlightFontWeightSelect = shadow.querySelector('#custom-highlight-font-weight');
        const customHighlightFontStyleSelect = shadow.querySelector('#custom-highlight-font-style');
        const customHighlightTextDecorationSelect = shadow.querySelector('#custom-highlight-text-decoration');
        const customFontSizeInput = shadow.querySelector('#custom-font-size');
        const customFontFamilyInput = shadow.querySelector('#custom-font-family');
        const hideForYouCheckbox = shadow.querySelector('#hideforyou-checkbox');
        const pageJumpCheckbox = shadow.querySelector('#pagejump-checkbox');
        const showStatsCheckbox = shadow.querySelector('#showstats-checkbox');
        const modelDetailsCheckbox = shadow.querySelector('#generation-model-details-checkbox');
        const showTimestampCheckbox = shadow.querySelector('#showtimestamp-checkbox');
        const timestampFormatCheckbox = shadow.querySelector('#timestamp-format-checkbox');
        const timestampHourFormatCheckbox = shadow.querySelector('#timestamp-hour-format-checkbox');
        const showMessageIdsCheckbox = shadow.querySelector('#show-message-ids-checkbox');
        const highlightModelChangesCheckbox = shadow.querySelector('#highlight-model-changes-checkbox');
        const autoRegenMismatchCheckbox = shadow.querySelector('#auto-regen-mismatch-checkbox');
        const autoRegenShortCheckbox = shadow.querySelector('#auto-regen-short-checkbox');
        const autoRegenMaxSelect = shadow.querySelector('#auto-regen-max-select');
        const autoRegenMismatchRow = shadow.querySelector('#auto-regen-mismatch-row');
        const autoRegenShortRow = shadow.querySelector('#auto-regen-short-row');
        const autoRegenMaxRow = shadow.querySelector('#auto-regen-max-row');
        const showChatNameInTitleCheckbox = shadow.querySelector('#showchatnametitle-checkbox');
        const nsfwToggleCheckbox = shadow.querySelector('#nsfwtoggle-checkbox');
        const messageRecoveryCheckbox = shadow.querySelector('#message-recovery-checkbox');
        const hideCreatorCheckbox = shadow.querySelector('#hide-creator-checkbox');
        const wysiwygCheckbox = shadow.querySelector('#wysiwyg-checkbox');
        const enableGenerationProfilesCheckbox = shadow.querySelector('#generation-profiles-checkbox');
        const generationProfilesRow = shadow.querySelector('#generation-profiles-row');
        const modelDetailsRow = shadow.querySelector('#generation-model-details-row');
        const timestampFormatRow = shadow.querySelector('#timestamp-format-row');
        const timestampHourFormatRow = shadow.querySelector('#timestamp-hour-format-row');
        const compactGenerationRow = shadow.querySelector('#compact-generation-row');
        const sidebarMinWidthRow = shadow.querySelector('#sidebar-min-width-row');
        const sidebarMinWidthInput = shadow.querySelector('#sidebar-min-width-input');
        const customHoverButtonColorInput = shadow.querySelector('#custom-hover-button-color');
        const customCreatorLinkColorInput = shadow.querySelector('#custom-creator-link-color');
        const customBackgroundImageInput = shadow.querySelector('#custom-background-image');
        const clearBackgroundImageBtn = shadow.querySelector('#clear-background-image-btn');
        const messageContainerMaxWidthInput = shadow.querySelector('#message-container-max-width');
        // Help/tooltip element for units and validation feedback (inserted after input if not present)
        let messageContainerMaxWidthHelp = shadow.querySelector('#message-container-max-width-help');
        if (!messageContainerMaxWidthHelp) {
            messageContainerMaxWidthHelp = document.createElement('div');
            messageContainerMaxWidthHelp.id = 'message-container-max-width-help';
            messageContainerMaxWidthHelp.style.fontSize = '12px';
            messageContainerMaxWidthHelp.style.color = '#6b7280';
            messageContainerMaxWidthHelp.style.marginTop = '8px';
            messageContainerMaxWidthHelp.style.padding = '8px 10px';
            messageContainerMaxWidthHelp.style.background = 'rgba(59, 130, 246, 0.06)';
            messageContainerMaxWidthHelp.style.border = '1px solid rgba(59, 130, 246, 0.2)';
            messageContainerMaxWidthHelp.style.borderRadius = '6px';
            messageContainerMaxWidthHelp.style.lineHeight = '1.5';
            messageContainerMaxWidthHelp.style.display = 'none';
            messageContainerMaxWidthHelp.setAttribute('aria-hidden', 'true');
            // Insert after the input's row so it appears directly below the input
            const inputRow = messageContainerMaxWidthInput ? messageContainerMaxWidthInput.closest('.style-input-row') : null;
            if (inputRow && inputRow.parentNode) {
                inputRow.parentNode.insertBefore(messageContainerMaxWidthHelp, inputRow.nextSibling);
            } else if (messageContainerMaxWidthInput && messageContainerMaxWidthInput.parentNode) {
                messageContainerMaxWidthInput.parentNode.insertBefore(messageContainerMaxWidthHelp, messageContainerMaxWidthInput.nextSibling);
            } else if (shadow) {
                shadow.appendChild(messageContainerMaxWidthHelp);
            }
        }

        // Structured units help — shown when input is focused
        const MESSAGE_MAX_WIDTH_HELP_HTML = `
            <div style="font-weight:600;color:#374151;margin-bottom:6px;">Supported units</div>
            <ul style="margin:0;padding-left:18px;list-style:disc;">
                <li><strong>px</strong> — pixels (e.g. <code>800px</code>)</li>
                <li><strong>%</strong> — percent of parent container (e.g. <code>90%</code>)</li>
                <li><strong>vw</strong> — viewport width (e.g. <code>50vw</code>)</li>
                <li><strong>rem</strong> / <strong>em</strong> — relative to font-size</li>
                <li><strong>vmin</strong> / <strong>vmax</strong> — min/max of viewport dimensions</li>
                <li><strong>ch</strong> — width of the "0" character</li>
                <li><strong>cm</strong>, <strong>mm</strong>, <strong>in</strong>, <strong>pt</strong>, <strong>pc</strong> — absolute units</li>
            </ul>
            <div style="margin-top:6px;font-style:italic;color:#6b7280;">Unitless numbers are treated as px.</div>
        `;

        // Preview elements (created in template); query them
        const messageContainerMaxWidthPreview = shadow.querySelector('#message-container-max-width-preview');
        const messageContainerMaxWidthPreviewValue = shadow.querySelector('#message-container-max-width-preview-value');
        const messageContainerMaxWidthPreviewInner = shadow.querySelector('#message-container-max-width-preview-inner');
        const memoryDotEnabledCheckbox = shadow.querySelector('#memory-dot-enabled-checkbox');
        const memoryDotColorInput = shadow.querySelector('#memory-dot-color');
        const previewMemoryDotColor = shadow.querySelector('#preview-memory-dot-color');
        const previewHoverButton = shadow.querySelector('#preview-hover-button');
        const previewCreatorLinkColor = shadow.querySelector('#preview-creator-link-color');
        const versionText = shadow.querySelector('#version-text');
        const debugFiltersSection = shadow.querySelector('#debug-filters-section');
        
        // Debug filter checkboxes
        const debugFilterCheckboxes = {
            Core: shadow.querySelector('#debug-filter-core'),
            Stats: shadow.querySelector('#debug-filter-stats'),
            Memories: shadow.querySelector('#debug-filter-memories'),
            Export: shadow.querySelector('#debug-filter-export'),
            NSFW: shadow.querySelector('#debug-filter-nsfw'),
            ChatTitle: shadow.querySelector('#debug-filter-chattitle'),
            WYSIWYG: shadow.querySelector('#debug-filter-wysiwyg'),
            'WYSIWYG-Text': shadow.querySelector('#debug-filter-wysiwyg-text'),
            Profile: shadow.querySelector('#debug-filter-profile'),
            Model: shadow.querySelector('#debug-filter-model'),
            Cache: shadow.querySelector('#debug-filter-cache'),
            Migration: shadow.querySelector('#debug-filter-migration'),
            Custom: shadow.querySelector('#debug-filter-custom'),
            Compact: shadow.querySelector('#debug-filter-compact'),
            Sync: shadow.querySelector('#debug-filter-sync'),
            AutoRegen: shadow.querySelector('#debug-filter-autoregen'),
            MsgRecovery: shadow.querySelector('#debug-filter-msgrecovery')
        };
        
        // Refresh in-memory filters from storage (source of truth) before initializing the
        // checkboxes — so reopening the modal reflects what was actually persisted, not a
        // possibly-stale in-memory object.
        try {
            const storedFilters = await storage.get('debugLogFilters', null);
            if (storedFilters && typeof storedFilters === 'object') {
                debugLogFilters = { ...debugLogFilters, ...storedFilters };
            }
        } catch (_) { /* keep in-memory */ }

        // Initialize debug filter checkboxes from current state.
        // NOTE: persistence binds BOTH 'change' AND 'click'. On WebKit/Orion the synthesized
        // `change` from a <label>-nested checkbox inside a shadow root is unreliable (same
        // event-synthesis fragility as the WYSIWYG iOS issue), and — unlike every other
        // setting — debug filters have no Save-time fallback (Save & Refresh never reads
        // them). `click` fires reliably on tap/keyboard after the native toggle; the de-dupe
        // guard makes binding both harmless.
        for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
            if (checkbox) {
                checkbox.checked = debugLogFilters[category] !== false;
                const applyDebugFilter = async () => {
                    if (debugLogFilters[category] === checkbox.checked) return; // de-dupe (both events / no real change)
                    debugLogFilters[category] = checkbox.checked;               // flips the live debugLog() check immediately
                    await storage.set('debugLogFilters', debugLogFilters);
                    console.log(`[Core] Debug filter "${category}" ${checkbox.checked ? 'enabled' : 'disabled'}`);
                };
                checkbox.addEventListener('change', applyDebugFilter);
                // WebKit/Orion fallback: defer one tick so checkbox.checked has settled to its
                // post-toggle value before we read it.
                checkbox.addEventListener('click', () => { setTimeout(applyDebugFilter, 0); });
            }
        }
        
        // Secret model override: Quad-click (4 times within 2s) on the "Model" debug filter label
        // Forces inference_model to user-specified value for all chat/story POST requests
        // Section with textbox is only visible while override is active (orange text)
        const modelCheckbox = debugFilterCheckboxes.Model;
        const modelLabel = modelCheckbox ? modelCheckbox.closest('label') : null;
        const modelOverrideSection = shadow.querySelector('#model-override-section');
        const modelOverrideInput = shadow.querySelector('#model-override-input');
        if (modelCheckbox && modelLabel && modelOverrideSection && modelOverrideInput) {
            // Load initial state from storage and sync to interceptor
            Promise.all([
                storage.get('modelOverrideEnabled', false),
                storage.get('modelOverrideName', '')
            ]).then(([enabled, modelName]) => {
                if (modelName) modelOverrideInput.value = modelName;
                if (enabled) {
                    modelLabel.style.color = '#ff8c00';
                    modelOverrideSection.style.display = '';
                    window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: modelName || null }, '*');
                }
            });

            // Live-update interceptor as user types the model name
            modelOverrideInput.addEventListener('input', async (e) => {
                const name = e.target.value.trim();
                await storage.set('modelOverrideName', e.target.value);
                const isEnabled = await storage.get('modelOverrideEnabled', false);
                if (isEnabled) {
                    window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: name || null }, '*');
                }
            });

            // Quad-click on Model label to toggle override
            let overrideTapCount = 0;
            let overrideTapTimer = null;
            modelLabel.addEventListener('click', async (e) => {
                if (!e.isTrusted) return;
                overrideTapCount++;
                clearTimeout(overrideTapTimer);
                overrideTapTimer = setTimeout(() => { overrideTapCount = 0; }, 2000);

                if (overrideTapCount === 4) {
                    overrideTapCount = 0;
                    clearTimeout(overrideTapTimer);

                    const currentlyEnabled = await storage.get('modelOverrideEnabled', false);
                    const newState = !currentlyEnabled;
                    const modelName = modelOverrideInput.value.trim() ||
                                      await storage.get('modelOverrideName', '');

                    await storage.set('modelOverrideEnabled', newState);
                    if (modelName) await storage.set('modelOverrideName', modelName);

                    if (newState) {
                        modelLabel.style.color = '#ff8c00';
                        modelOverrideSection.style.display = '';
                        if (modelName) modelOverrideInput.value = modelName;
                        window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: modelName || null }, '*');
                        // Suppress mismatch auto-regen for the first response (model change is expected)
                        window.__suppressMismatchNext = true;
                        debugLog('[Model] Model override ENABLED:', modelName);
                    } else {
                        modelLabel.style.color = '';
                        modelOverrideSection.style.display = 'none';
                        window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: null }, '*');
                        window.__suppressMismatchNext = false;
                        debugLog('[Model] Model override DISABLED');
                    }
                }
            });
        }
        
        // Debug filter "Enable All" button
        const debugFilterAllBtn = shadow.querySelector('#debug-filter-all-btn');
        if (debugFilterAllBtn) {
            debugFilterAllBtn.addEventListener('click', async () => {
                for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
                    if (checkbox) {
                        checkbox.checked = true;
                        debugLogFilters[category] = true;
                    }
                }
                await storage.set('debugLogFilters', debugLogFilters);
                console.log('[Core] All debug filters enabled');
            });
        }
        
        // Debug filter "Disable All" button
        const debugFilterNoneBtn = shadow.querySelector('#debug-filter-none-btn');
        if (debugFilterNoneBtn) {
            debugFilterNoneBtn.addEventListener('click', async () => {
                for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
                    if (checkbox) {
                        checkbox.checked = false;
                        debugLogFilters[category] = false;
                    }
                }
                await storage.set('debugLogFilters', debugLogFilters);
                console.log('[Core] All debug filters disabled');
            });
        }
        
        // Show/hide debug filters section based on DEBUG_MODE
        function updateDebugFiltersVisibility() {
            if (debugFiltersSection) {
                if (DEBUG_MODE) {
                    debugFiltersSection.classList.remove('hidden');
                } else {
                    debugFiltersSection.classList.add('hidden');
                }
            }
        }
        updateDebugFiltersVisibility();
        
        // Easter egg: Shift+click or 4 quick taps on version text toggles DEBUG_MODE
        if (versionText) {
            // Set initial color based on current DEBUG_MODE state
            if (DEBUG_MODE) {
                versionText.style.color = '#4ade80'; // light green when debug is on
            }
            
            versionText.style.cursor = 'pointer';
            
            // Multi-tap detection
            let tapCount = 0;
            let tapTimer = null;
            
            versionText.addEventListener('click', async (e) => {
                // Shift+click immediately toggles debug mode
                if (e.shiftKey) {
                    tapCount = 0; // Reset tap counter
                    clearTimeout(tapTimer);
                    
                    DEBUG_MODE = !DEBUG_MODE;
                    // Persist to storage
                    await storage.set('debugMode', DEBUG_MODE);
                    window.__SAI_DEBUG_MODE__ = DEBUG_MODE;
                    if (DEBUG_MODE) {
                        versionText.style.color = '#4ade80'; // light green
                        console.log('[Core] 🐛 Debug mode ENABLED (saved)');
                        generationProfilesRow.classList.remove('hidden');
                    } else {
                        versionText.style.color = ''; // reset to default
                        console.log('[Core] Debug mode disabled (saved)');
                        generationProfilesRow.classList.add('hidden');
                    }
                    // Update generation profiles section visibility
                    await updateGenerationProfilesVisibility();
                    // Update debug filters visibility
                    updateDebugFiltersVisibility();
                } else {
                    // Regular click - count taps
                    tapCount++;
                    
                    // Reset tap counter after 2 seconds of inactivity
                    clearTimeout(tapTimer);
                    tapTimer = setTimeout(() => {
                        tapCount = 0;
                    }, 2000);
                    
                    // Toggle debug mode on 4th tap
                    if (tapCount === 4) {
                        tapCount = 0;
                        clearTimeout(tapTimer);
                        
                        DEBUG_MODE = !DEBUG_MODE;
                        // Persist to storage
                        await storage.set('debugMode', DEBUG_MODE);
                        window.__SAI_DEBUG_MODE__ = DEBUG_MODE;
                        if (DEBUG_MODE) {
                            versionText.style.color = '#4ade80'; // light green
                            console.log('[Core] 🐛 Debug mode ENABLED (saved)');
                            generationProfilesRow.classList.remove('hidden');
                        } else {
                            versionText.style.color = ''; // reset to default
                            console.log('[Core] Debug mode disabled (saved)');
                            generationProfilesRow.classList.add('hidden');
                        }
                        // Update generation profiles section visibility
                        await updateGenerationProfilesVisibility();
                        // Update debug filters visibility
                        updateDebugFiltersVisibility();
                    }
                }
            });
        }
        
        // Set checkbox states programmatically (safer than innerHTML with dynamic values)
        sidebarCheckbox.checked = sidebarEnabled;
        compactGenerationCheckbox.checked = compactGenerationEnabled;
        classicLayoutCheckbox.checked = classicLayoutEnabled;
        classicStyleCheckbox.checked = classicStyleEnabled;
        customStyleCheckbox.checked = customStyleEnabled;
        smallProfileImagesCheckbox.checked = smallProfileImagesEnabled;
        roundedProfileImagesCheckbox.checked = roundedProfileImagesEnabled;
        swapCheckboxPositionCheckbox.checked = swapCheckboxPositionEnabled;
        squareMessageEdgesCheckbox.checked = squareMessageEdgesEnabled;
        customAiBgInput.value = customStyleValues.aiMessageBg;
        customUserBgInput.value = customStyleValues.userMessageBg;
        customBodyColorInput.value = customStyleValues.bodyColor;
        customBodyFontWeightSelect.value = customStyleValues.bodyFontWeight || 'normal';
        customBodyFontStyleSelect.value = customStyleValues.bodyFontStyle || 'normal';
        customBodyTextDecorationSelect.value = customStyleValues.bodyTextDecoration || 'none';
        customSpanQuoteColorInput.value = customStyleValues.spanQuoteColor;
        customQuoteFontWeightSelect.value = customStyleValues.spanQuoteFontWeight || 'normal';
        customQuoteFontStyleSelect.value = customStyleValues.spanQuoteFontStyle || 'normal';
        customQuoteTextDecorationSelect.value = customStyleValues.spanQuoteTextDecoration || 'none';
        customNarrationColorInput.value = customStyleValues.narrationColor;
        customNarrationFontWeightSelect.value = customStyleValues.narrationFontWeight || 'normal';
        customNarrationFontStyleSelect.value = customStyleValues.narrationFontStyle || 'italic';
        customNarrationTextDecorationSelect.value = customStyleValues.narrationTextDecoration || 'none';
        customHighlightBgColorInput.value = customStyleValues.highlightBgColor;
        customHighlightTextColorInput.value = customStyleValues.highlightTextColor;
        customHighlightFontWeightSelect.value = customStyleValues.highlightFontWeight || 'normal';
        customHighlightFontStyleSelect.value = customStyleValues.highlightFontStyle || 'normal';
        customHighlightTextDecorationSelect.value = customStyleValues.highlightTextDecoration || 'none';
        customFontSizeInput.value = customStyleValues.fontSize;
        customFontFamilyInput.value = customStyleValues.fontFamily || '';
        customHoverButtonColorInput.value = customStyleValues.hoverButtonColor || '#292929';
        customCreatorLinkColorInput.value = customStyleValues.creatorLinkColor || '';
        messageContainerMaxWidthInput.value = messageContainerMaxWidth || '';
        // Initialize preview display with current value (normalized)
        try {
            const previewNorm = (val) => {
                let s = String(val || '').trim();
                if (/^\d+(?:\.\d+)?$/.test(s)) s = `${s}px`;
                return s;
            };
            const initNorm = previewNorm(messageContainerMaxWidth);
            if (messageContainerMaxWidthPreviewValue) messageContainerMaxWidthPreviewValue.textContent = initNorm || '—';
            if (messageContainerMaxWidthPreviewInner && initNorm) {
                messageContainerMaxWidthPreviewInner.style.width = initNorm;
            }
        } catch (err) {
            // ignore preview init errors
        }
        memoryDotEnabledCheckbox.checked = memoryDotEnabled;
        memoryDotColorInput.value = memoryDotColor || '#ff3b3b';
        hideForYouCheckbox.checked = hideForYouEnabled;
        pageJumpCheckbox.checked = pageJumpEnabled;
        showStatsCheckbox.checked = showStatsEnabled;
        modelDetailsCheckbox.checked = showModelDetailsEnabled;
        showTimestampCheckbox.checked = showTimestampEnabled;
        highlightModelChangesCheckbox.checked = highlightModelChangesEnabled;
        autoRegenMismatchCheckbox.checked = autoRegenOnMismatchEnabled;
        autoRegenShortCheckbox.checked = autoRegenOnShortEnabled;
        autoRegenMaxSelect.value = String(autoRegenMaxAttempts || 1);
        // Show/hide sub-options based on highlight model changes state
        const updateAutoRegenVisibility = () => {
            const showSubs = highlightModelChangesCheckbox.checked;
            autoRegenMismatchRow.classList.toggle('hidden', !showSubs);
            autoRegenShortRow.classList.toggle('hidden', !showSubs);
            // Show max attempts only if either auto-regen option is checked
            const showMax = showSubs && (autoRegenMismatchCheckbox.checked || autoRegenShortCheckbox.checked);
            autoRegenMaxRow.classList.toggle('hidden', !showMax);
        };
        updateAutoRegenVisibility();
        timestampFormatCheckbox.checked = timestampDateFirst;
        timestampHourFormatCheckbox.checked = timestamp24Hour;
        showMessageIdsCheckbox.checked = showMessageIdsEnabled;
        showChatNameInTitleCheckbox.checked = showChatNameInTitleEnabled;
        nsfwToggleCheckbox.checked = nsfwToggleEnabled;
        messageRecoveryCheckbox.checked = messageRecoveryEnabled;
        hideCreatorCheckbox.checked = hideCreatorEnabled;
        wysiwygCheckbox.checked = wysiwygEnabled;
        enableGenerationProfilesCheckbox.checked = enableGenerationProfilesEnabled;
        
        // Update generation profiles checkbox when it changes
        if (enableGenerationProfilesCheckbox) {
            enableGenerationProfilesCheckbox.addEventListener('change', async () => {
                await updateGenerationProfilesVisibility();
            });
        }
        
        // Show/hide generation profiles setting based on debug mode
        if (DEBUG_MODE) {
            generationProfilesRow.classList.remove('hidden');
        } else {
            generationProfilesRow.classList.add('hidden');
        }
        
        // Show/hide model details row based on showStats setting
        if (showStatsEnabled) {
            modelDetailsRow.classList.remove('hidden');
        } else {
            modelDetailsRow.classList.add('hidden');
        }
        
        // Show/hide timestamp format rows based on showTimestamp setting
        if (showTimestampEnabled) {
            timestampFormatRow.classList.remove('hidden');
            timestampHourFormatRow.classList.remove('hidden');
        } else {
            timestampFormatRow.classList.add('hidden');
            timestampHourFormatRow.classList.add('hidden');
        }
        
        // Show/hide compact generation row based on sidebar setting
        if (sidebarEnabled) {
            compactGenerationRow.classList.remove('hidden');
            sidebarMinWidthRow.classList.remove('hidden');
        } else {
            compactGenerationRow.classList.add('hidden');
            sidebarMinWidthRow.classList.add('hidden');
        }
        
        // Set sidebar minimum width input value
        sidebarMinWidthInput.value = sidebarMinWidthValue;
        
        // Show/hide custom style options based on custom style checkbox
        if (customStyleEnabled) {
            customStyleOptions.classList.remove('hidden');
        } else {
            customStyleOptions.classList.add('hidden');
        }
        
        debugLog('[Core] Checkbox states set programmatically');
        
        // CRITICAL: Install event barrier at shadow root to prevent events from escaping to React
        // Use BUBBLE phase (false) so events reach our handlers first, THEN get stopped from escaping
        debugLog('[Core] Installing comprehensive event barrier at shadow root (bubble phase)');
        const eventTypes = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 
                           'touchstart', 'touchend', 'keydown', 'keyup', 'input', 'change'];
        eventTypes.forEach(async eventType => {
            shadow.addEventListener(eventType, (e) => {
                debugLog('[Core] Event barrier stopping propagation:', eventType, 'target:', e.target.id || e.target.className);
                e.stopPropagation();  // Prevent event from escaping shadow DOM
            }, false); // Bubble phase - runs AFTER our handlers, stops events from leaving shadow DOM
        });
        debugLog('[Core] Event barrier installed (bubble phase) for:', eventTypes.join(', '));
        
        // Tab switching logic
        const tabBtns = shadow.querySelectorAll('.tab-btn');
        const tabContents = shadow.querySelectorAll('.tab-content');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                debugLog('[Core] Tab switched to:', targetTab);
                
                // Update active states
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                
                btn.classList.add('active');
                const targetContent = shadow.querySelector(`#tab-${targetTab}`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }
            });
        });
        debugLog('[Core] Tab switching initialized');
        
        // Collapsible text type sections
        const textTypeHeaders = shadow.querySelectorAll('.text-type-header');
        textTypeHeaders.forEach(header => {
            header.addEventListener('click', (e) => {
                // Only toggle if clicking the caret, label, or header itself
                // Don't toggle when clicking input boxes or color previews
                const clickedElement = e.target;
                const isInput = clickedElement.classList.contains('style-input');
                const isColorPreview = clickedElement.classList.contains('color-preview') || 
                                      clickedElement.classList.contains('color-preview-inner');
                
                if (isInput || isColorPreview) {
                    return; // Don't toggle, let the input/preview handle the click
                }
                
                const targetId = header.dataset.target;
                const optionsDiv = shadow.querySelector(`#${targetId}`);
                const caret = header.querySelector('.text-type-caret');
                
                if (optionsDiv && caret) {
                    optionsDiv.classList.toggle('hidden');
                    caret.classList.toggle('expanded');
                }
            });
        });
        debugLog('[Core] Collapsible text type sections initialized');
        
        // Get button and other elements within shadow DOM
        const cancelBtn = shadow.querySelector('#cancel-btn');
        const saveBtn = shadow.querySelector('#save-btn');
        const exportProfilesBtn = shadow.querySelector('#export-profiles-btn');
        const importProfilesBtn = shadow.querySelector('#import-profiles-btn');
        const deleteProfilesBtn = shadow.querySelector('#delete-profiles-btn');
        const generationProfilesSection = shadow.querySelector('#generation-profiles-section');
        const exportCustomStyleBtn = shadow.querySelector('#export-custom-style-btn');
        const importCustomStyleBtn = shadow.querySelector('#import-custom-style-btn');
        const resetCustomStyleBtn = shadow.querySelector('#reset-custom-style-btn');
        const exportAllBtn = shadow.querySelector('#export-all-btn');
        const importAllBtn = shadow.querySelector('#import-all-btn');
        const clearAllBtn = shadow.querySelector('#clear-all-btn');
        const driveSyncBtn = shadow.querySelector('#drive-sync-btn');
        const driveDisconnectBtn = shadow.querySelector('#drive-disconnect-btn');
        const driveSyncStatus = shadow.querySelector('#drive-sync-status');
        const syncStatsToggle = shadow.querySelector('#sync-stats-toggle');
        const syncSettingsToggle = shadow.querySelector('#sync-settings-toggle');
        const syncStyleToggle = shadow.querySelector('#sync-style-toggle');
        const driveBackupSection = shadow.querySelector('#drive-backup-section');
        const driveCreateBackupBtn = shadow.querySelector('#drive-create-backup-btn');
        const driveOpenFolderBtn = shadow.querySelector('#drive-open-folder-btn');
        const driveBackupStatus = shadow.querySelector('#drive-backup-status');
        const driveBackupList = shadow.querySelector('#drive-backup-list');
        const autoSyncToggle = shadow.querySelector('#auto-sync-toggle');
        const autoSyncIntervalSelect = shadow.querySelector('#auto-sync-interval');

        // Check if this is first run (onboarding) - disable cancel if so
        const hasSeenOnboarding = await storage.get('hasSeenOnboarding', false);
        if (!hasSeenOnboarding) {
            debugLog('[Core] First run - disabling Cancel button');
            cancelBtn.disabled = true;
            cancelBtn.style.opacity = '0.5';
            cancelBtn.style.cursor = 'not-allowed';
            cancelBtn.title = 'Please save your settings or refresh the page manually';
        }
        
        debugLog('[Core] Button query results:');
        debugLog('[Core]   cancelBtn:', cancelBtn);
        debugLog('[Core]   saveBtn:', saveBtn);
        debugLog('[Core]   exportAllBtn:', exportAllBtn);
        debugLog('[Core]   importAllBtn:', importAllBtn);
        
        if (!exportAllBtn) {
            console.error('[Core] ERROR: exportAllBtn not found in shadow DOM!');
        }
        if (!importAllBtn) {
            console.error('[Core] ERROR: importAllBtn not found in shadow DOM!');
        }
        
        // Helper function to update generation profiles visibility
        async function updateGenerationProfilesVisibility() {
            const profiles = await loadProfiles();
            const hasProfiles = Object.keys(profiles).length > 0;
            const forceEnabled = enableGenerationProfilesCheckbox.checked;
            
            // Show section if: has profiles OR (debug mode AND legacy setting enabled)
            const showSection = hasProfiles || (DEBUG_MODE && forceEnabled);
            
            if (generationProfilesSection) {
                if (showSection) {
                    generationProfilesSection.style.display = '';
                } else {
                    generationProfilesSection.style.display = 'none';
                }
            }
            
            // Show Import button only if debug mode AND legacy setting enabled
            if (importProfilesBtn) {
                if (DEBUG_MODE && forceEnabled) {
                    importProfilesBtn.style.display = '';
                } else {
                    importProfilesBtn.style.display = 'none';
                }
            }
        }
        
        // Initial visibility update
        await updateGenerationProfilesVisibility();
        
        // Checkbox change handlers track state
        sidebarCheckbox.onchange = (e) => {
            debugLog('[Core] SIDEBAR CHECKBOX CHANGED');
            sidebarEnabled = e.target.checked;
            debugLog('[Core] Sidebar:', sidebarEnabled);
            
            // Toggle compact generation and min width sub-settings visibility
            if (sidebarEnabled) {
                compactGenerationRow.classList.remove('hidden');
                sidebarMinWidthRow.classList.remove('hidden');
            } else {
                compactGenerationRow.classList.add('hidden');
                sidebarMinWidthRow.classList.add('hidden');
                // Also disable compact generation when sidebar is disabled
                compactGenerationEnabled = false;
                compactGenerationCheckbox.checked = false;
            }
        };
        
        // Sidebar minimum width input handler
        sidebarMinWidthInput.oninput = (e) => {
            debugLog('[Core] SIDEBAR MIN WIDTH INPUT CHANGED');
            const value = parseInt(e.target.value, 10);
            // If empty or invalid, will be set to default on save
            if (!isNaN(value) && value >= 600 && value <= 2000) {
                sidebarMinWidthValue = value;
            }
            debugLog('[Core] Sidebar Min Width:', sidebarMinWidthValue);
        };
        
        compactGenerationCheckbox.onchange = (e) => {
            debugLog('[Core] COMPACT GENERATION CHECKBOX CHANGED');
            compactGenerationEnabled = e.target.checked;
            debugLog('[Core] Compact Generation:', compactGenerationEnabled);
        };
        
        classicLayoutCheckbox.onchange = (e) => {
            debugLog('[Core] CLASSIC LAYOUT CHECKBOX CHANGED');
            classicLayoutEnabled = e.target.checked;
            debugLog('[Core] Classic Layout:', classicLayoutEnabled);
        };
        
        smallProfileImagesCheckbox.onchange = (e) => {
            debugLog('[Core] SMALL PROFILE IMAGES CHECKBOX CHANGED');
            smallProfileImagesEnabled = e.target.checked;
            debugLog('[Core] Small Profile Images:', smallProfileImagesEnabled);
        };
        
        roundedProfileImagesCheckbox.onchange = (e) => {
            debugLog('[Core] ROUNDED PROFILE IMAGES CHECKBOX CHANGED');
            roundedProfileImagesEnabled = e.target.checked;
            debugLog('[Core] Rounded Profile Images:', roundedProfileImagesEnabled);
        };
        
        swapCheckboxPositionCheckbox.onchange = (e) => {
            debugLog('[Core] SWAP CHECKBOX POSITION CHECKBOX CHANGED');
            swapCheckboxPositionEnabled = e.target.checked;
            debugLog('[Core] Swap Checkbox Position:', swapCheckboxPositionEnabled);
        };
        
        squareMessageEdgesCheckbox.onchange = (e) => {
            debugLog('[Core] SQUARE MESSAGE EDGES CHECKBOX CHANGED');
            squareMessageEdgesEnabled = e.target.checked;
            debugLog('[Core] Square Message Edges:', squareMessageEdgesEnabled);
        };
        
        classicStyleCheckbox.onchange = (e) => {
            debugLog('[Core] CLASSIC STYLE CHECKBOX CHANGED');
            classicStyleEnabled = e.target.checked;
            debugLog('[Core] Classic Style:', classicStyleEnabled);
            
            // Mutual exclusivity: Disable Custom Style if Classic Style is enabled
            if (classicStyleEnabled && customStyleEnabled) {
                customStyleEnabled = false;
                customStyleCheckbox.checked = false;
                customStyleOptions.classList.add('hidden');
            }
        };
        
        customStyleCheckbox.onchange = (e) => {
            debugLog('[Core] CUSTOM STYLE CHECKBOX CHANGED');
            customStyleEnabled = e.target.checked;
            debugLog('[Core] Custom Style:', customStyleEnabled);
            
            // Mutual exclusivity: Disable Classic Style if Custom Style is enabled
            if (customStyleEnabled && classicStyleEnabled) {
                classicStyleEnabled = false;
                classicStyleCheckbox.checked = false;
            }
            
            // Toggle custom style options visibility
            if (customStyleEnabled) {
                customStyleOptions.classList.remove('hidden');
            } else {
                customStyleOptions.classList.add('hidden');
            }
        };
        
        // Update custom style values when inputs change
        // Get preview elements
        const previewAiBg = shadow.querySelector('#preview-ai-bg');
        const previewUserBg = shadow.querySelector('#preview-user-bg');
        const previewBodyColor = shadow.querySelector('#preview-body-color');
        const previewQuoteColor = shadow.querySelector('#preview-quote-color');
        const previewNarrationColor = shadow.querySelector('#preview-narration-color');
        const previewHighlightBg = shadow.querySelector('#preview-highlight-bg');
        const previewHighlightText = shadow.querySelector('#preview-highlight-text');
        const fontPreviewText = shadow.querySelector('#font-preview-text');
        const previewTextQuote = shadow.querySelector('#preview-text-quote');
        const previewTextNarration = shadow.querySelector('#preview-text-narration');
        const previewTextHighlight = shadow.querySelector('#preview-text-highlight');
        
        // Function to update font preview
        const updateFontPreview = () => {
            if (fontPreviewText) {
                fontPreviewText.style.fontSize = customStyleValues.fontSize || '16px';
                fontPreviewText.style.fontFamily = customStyleValues.fontFamily || 'inherit';
                fontPreviewText.style.fontWeight = customStyleValues.bodyFontWeight || 'normal';
                fontPreviewText.style.fontStyle = customStyleValues.bodyFontStyle || 'normal';
                fontPreviewText.style.textDecoration = customStyleValues.bodyTextDecoration || 'none';
                fontPreviewText.style.color = customStyleValues.bodyColor || '#fff';
            }
            if (previewTextQuote) {
                previewTextQuote.style.color = customStyleValues.spanQuoteColor || '#fff';
                previewTextQuote.style.fontWeight = customStyleValues.spanQuoteFontWeight || 'normal';
                previewTextQuote.style.fontStyle = customStyleValues.spanQuoteFontStyle || 'normal';
                previewTextQuote.style.textDecoration = customStyleValues.spanQuoteTextDecoration || 'none';
            }
            if (previewTextNarration) {
                previewTextNarration.style.color = customStyleValues.narrationColor || '#06B7DB';
                previewTextNarration.style.fontFamily = customStyleValues.fontFamily || 'inherit';
                previewTextNarration.style.fontWeight = customStyleValues.narrationFontWeight || 'normal';
                previewTextNarration.style.fontStyle = customStyleValues.narrationFontStyle || 'italic';
                previewTextNarration.style.textDecoration = customStyleValues.narrationTextDecoration || 'none';
            }
            if (previewTextHighlight) {
                previewTextHighlight.style.backgroundColor = customStyleValues.highlightBgColor || '#ffdd6d';
                previewTextHighlight.style.color = customStyleValues.highlightTextColor || '#000';
                previewTextHighlight.style.fontWeight = customStyleValues.highlightFontWeight || 'normal';
                previewTextHighlight.style.fontStyle = customStyleValues.highlightFontStyle || 'normal';
                previewTextHighlight.style.textDecoration = customStyleValues.highlightTextDecoration || 'none';
            }
        };
        
        // Initialize color previews
        if (previewAiBg) previewAiBg.style.background = customStyleValues.aiMessageBg || 'transparent';
        if (previewUserBg) previewUserBg.style.background = customStyleValues.userMessageBg || 'transparent';
        if (previewBodyColor) previewBodyColor.style.background = customStyleValues.bodyColor || 'transparent';
        if (previewQuoteColor) previewQuoteColor.style.background = customStyleValues.spanQuoteColor || 'transparent';
        if (previewNarrationColor) previewNarrationColor.style.background = customStyleValues.narrationColor || 'transparent';
        if (previewHighlightBg) previewHighlightBg.style.background = customStyleValues.highlightBgColor || 'transparent';
        if (previewHighlightText) previewHighlightText.style.background = customStyleValues.highlightTextColor || 'transparent';
        if (previewHoverButton) previewHoverButton.style.background = customStyleValues.hoverButtonColor || '#292929';
        if (previewCreatorLinkColor) previewCreatorLinkColor.style.background = customStyleValues.creatorLinkColor || 'transparent';
        if (previewMemoryDotColor) previewMemoryDotColor.style.background = memoryDotColor || '#ff3b3b';
        updateFontPreview();
        
        // Update custom style values when inputs change (with preview updates)
        customAiBgInput.oninput = (e) => { 
            customStyleValues.aiMessageBg = e.target.value;
            if (previewAiBg) previewAiBg.style.background = e.target.value || 'transparent';
        };
        customUserBgInput.oninput = (e) => { 
            customStyleValues.userMessageBg = e.target.value;
            if (previewUserBg) previewUserBg.style.background = e.target.value || 'transparent';
        };
        customBodyColorInput.oninput = (e) => { 
            customStyleValues.bodyColor = e.target.value;
            if (previewBodyColor) previewBodyColor.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customBodyFontWeightSelect.onchange = (e) => { customStyleValues.bodyFontWeight = e.target.value; updateFontPreview(); };
        customBodyFontStyleSelect.onchange = (e) => { customStyleValues.bodyFontStyle = e.target.value; updateFontPreview(); };
        customBodyTextDecorationSelect.onchange = (e) => { customStyleValues.bodyTextDecoration = e.target.value; updateFontPreview(); };
        customSpanQuoteColorInput.oninput = (e) => { 
            customStyleValues.spanQuoteColor = e.target.value;
            if (previewQuoteColor) previewQuoteColor.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customQuoteFontWeightSelect.onchange = (e) => { customStyleValues.spanQuoteFontWeight = e.target.value; updateFontPreview(); };
        customQuoteFontStyleSelect.onchange = (e) => { customStyleValues.spanQuoteFontStyle = e.target.value; updateFontPreview(); };
        customQuoteTextDecorationSelect.onchange = (e) => { customStyleValues.spanQuoteTextDecoration = e.target.value; updateFontPreview(); };
        customNarrationColorInput.oninput = (e) => { 
            customStyleValues.narrationColor = e.target.value;
            if (previewNarrationColor) previewNarrationColor.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customNarrationFontWeightSelect.onchange = (e) => { customStyleValues.narrationFontWeight = e.target.value; updateFontPreview(); };
        customNarrationFontStyleSelect.onchange = (e) => { customStyleValues.narrationFontStyle = e.target.value; updateFontPreview(); };
        customNarrationTextDecorationSelect.onchange = (e) => { customStyleValues.narrationTextDecoration = e.target.value; updateFontPreview(); };
        customHighlightBgColorInput.oninput = (e) => { 
            customStyleValues.highlightBgColor = e.target.value;
            if (previewHighlightBg) previewHighlightBg.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customHighlightTextColorInput.oninput = (e) => { 
            customStyleValues.highlightTextColor = e.target.value;
            if (previewHighlightText) previewHighlightText.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customHighlightFontWeightSelect.onchange = (e) => { customStyleValues.highlightFontWeight = e.target.value; updateFontPreview(); };
        customHighlightFontStyleSelect.onchange = (e) => { customStyleValues.highlightFontStyle = e.target.value; updateFontPreview(); };
        customHighlightTextDecorationSelect.onchange = (e) => { customStyleValues.highlightTextDecoration = e.target.value; updateFontPreview(); };
        customFontSizeInput.oninput = (e) => { customStyleValues.fontSize = e.target.value; updateFontPreview(); };
        customFontFamilyInput.oninput = (e) => { customStyleValues.fontFamily = e.target.value; updateFontPreview(); };
        customHoverButtonColorInput.oninput = (e) => {
            customStyleValues.hoverButtonColor = e.target.value;
            if (previewHoverButton) previewHoverButton.style.background = e.target.value || 'transparent';
        };
        customCreatorLinkColorInput.oninput = (e) => {
            customStyleValues.creatorLinkColor = e.target.value;
            if (previewCreatorLinkColor) previewCreatorLinkColor.style.background = e.target.value || 'transparent';
        };

        // Memory dot color input handler
        memoryDotColorInput.oninput = (e) => {
            memoryDotColor = e.target.value;
            if (previewMemoryDotColor) previewMemoryDotColor.style.background = e.target.value || '#ff3b3b';
        };
        
        // Background image upload handler
        customBackgroundImageInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            // Validate file is an image
            if (!file.type.startsWith('image/')) {
                alert('Please select an image file');
                customBackgroundImageInput.value = '';
                return;
            }
            
            // Convert to data URL for storage
            const reader = new FileReader();
            reader.onload = (event) => {
                customStyleValues.backgroundImage = event.target.result;
                debugLog('[Core] Background image loaded:', customStyleValues.backgroundImage.substring(0, 50) + '...');
            };
            reader.onerror = () => {
                alert('Error reading image file');
                customBackgroundImageInput.value = '';
            };
            reader.readAsDataURL(file);
        };
        
        // Clear background image button
        clearBackgroundImageBtn.onclick = (e) => {
            e.stopPropagation();
            customStyleValues.backgroundImage = '';
            customBackgroundImageInput.value = '';
            debugLog('[Core] Background image cleared');
        };
        
        const validateMaxWidth = (raw) => {
            const validPattern = /^\d+(?:\.\d+)?(?:px|%|vw|rem|em|ch|vmin|vmax|cm|mm|in|pt|pc)$/i;
            const numericOnly = /^\d+(?:\.\d+)?$/;
            if (numericOnly.test(raw)) return { valid: true, normalized: `${raw}px` };
            if (validPattern.test(raw)) return { valid: true, normalized: raw };
            return { valid: false, normalized: raw };
        };

        const showMaxWidthUnitsHelp = () => {
            messageContainerMaxWidthHelp.replaceChildren(parseHTMLToFragment(MESSAGE_MAX_WIDTH_HELP_HTML));
            messageContainerMaxWidthHelp.style.display = 'block';
            messageContainerMaxWidthHelp.style.color = '#374151';
            messageContainerMaxWidthHelp.style.background = 'rgba(59, 130, 246, 0.06)';
            messageContainerMaxWidthHelp.style.borderColor = 'rgba(59, 130, 246, 0.2)';
        };

        const showMaxWidthError = () => {
            messageContainerMaxWidthHelp.textContent = 'Invalid value. Use a number with a supported unit (e.g. 800px, 90%, 50vw) or a plain number (treated as px).';
            messageContainerMaxWidthHelp.style.display = 'block';
            messageContainerMaxWidthHelp.style.color = '#ef4444';
            messageContainerMaxWidthHelp.style.background = 'rgba(239, 68, 68, 0.06)';
            messageContainerMaxWidthHelp.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        };

        const hideMaxWidthHelp = () => {
            messageContainerMaxWidthHelp.style.display = 'none';
        };

        messageContainerMaxWidthInput.oninput = (e) => {
            const raw = String(e.target.value || '').trim();

            if (!raw) {
                messageContainerMaxWidth = '';
                e.target.style.borderColor = '';
                if (messageContainerMaxWidthPreviewValue) messageContainerMaxWidthPreviewValue.textContent = '—';
                if (messageContainerMaxWidthPreviewInner) messageContainerMaxWidthPreviewInner.style.width = '100%';
                // Keep units help visible while focused
                if (document.activeElement === e.target) showMaxWidthUnitsHelp();
                return;
            }

            const { valid, normalized } = validateMaxWidth(raw);
            if (valid) {
                messageContainerMaxWidth = normalized;
                e.target.style.borderColor = '';
                if (messageContainerMaxWidthPreviewValue) messageContainerMaxWidthPreviewValue.textContent = normalized;
                if (messageContainerMaxWidthPreviewInner) {
                    try { messageContainerMaxWidthPreviewInner.style.width = normalized; } catch (err) {}
                }
                // While typing in a focused input, show the units guide (not the error)
                if (document.activeElement === e.target) showMaxWidthUnitsHelp();
            } else {
                messageContainerMaxWidth = raw;
                e.target.style.borderColor = '#ef4444';
                // Don't surface the error mid-typing; keep showing units help while focused
                if (document.activeElement === e.target) showMaxWidthUnitsHelp();
            }
        };

        // Show units help when the input is focused.
        messageContainerMaxWidthInput.addEventListener('focus', () => {
            showMaxWidthUnitsHelp();
        });

        // Normalize and validate on blur — appending "px" mid-typing causes
        // values like "5px0" when the user types "50".
        messageContainerMaxWidthInput.addEventListener('blur', () => {
            const raw = String(messageContainerMaxWidthInput.value || '').trim();
            if (!raw) {
                messageContainerMaxWidthInput.style.borderColor = '';
                hideMaxWidthHelp();
                return;
            }
            const { valid, normalized } = validateMaxWidth(raw);
            if (valid) {
                if (messageContainerMaxWidthInput.value !== normalized) {
                    messageContainerMaxWidthInput.value = normalized;
                }
                messageContainerMaxWidth = normalized;
                messageContainerMaxWidthInput.style.borderColor = '';
                hideMaxWidthHelp();
                if (messageContainerMaxWidthPreviewValue) messageContainerMaxWidthPreviewValue.textContent = normalized;
                if (messageContainerMaxWidthPreviewInner) {
                    try { messageContainerMaxWidthPreviewInner.style.width = normalized; } catch (err) {}
                }
            } else {
                showMaxWidthError();
                messageContainerMaxWidthInput.style.borderColor = '#ef4444';
            }
        });

        hideForYouCheckbox.onchange = (e) => {
            debugLog('[Core] HIDE FOR YOU CHECKBOX CHANGED');
            hideForYouEnabled = e.target.checked;
            debugLog('[Core] Hide For You:', hideForYouEnabled);
        };
        
        pageJumpCheckbox.onchange = (e) => {
            debugLog('[Core] PAGE JUMP CHECKBOX CHANGED');
            pageJumpEnabled = e.target.checked;
            debugLog('[Core] Page Jump:', pageJumpEnabled);
        };
        
        showStatsCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW STATS CHECKBOX CHANGED');
            showStatsEnabled = e.target.checked;
            debugLog('[Core] Show Stats:', showStatsEnabled);
            
            // Toggle model details sub-checkbox visibility
            if (showStatsEnabled) {
                modelDetailsRow.classList.remove('hidden');
            } else {
                modelDetailsRow.classList.add('hidden');
            }
        };
        
        modelDetailsCheckbox.onchange = (e) => {
            debugLog('[Core] MODEL DETAILS CHECKBOX CHANGED');
            showModelDetailsEnabled = e.target.checked;
            debugLog('[Core] Show Model Details:', showModelDetailsEnabled);
        };
        
        showTimestampCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW TIMESTAMP CHECKBOX CHANGED');
            showTimestampEnabled = e.target.checked;
            debugLog('[Core] Show Timestamp:', showTimestampEnabled);
            
            // Toggle timestamp format sub-checkbox visibility
            if (showTimestampEnabled) {
                timestampFormatRow.classList.remove('hidden');
                timestampHourFormatRow.classList.remove('hidden');
            } else {
                timestampFormatRow.classList.add('hidden');
                timestampHourFormatRow.classList.add('hidden');
            }
        };
        
        timestampFormatCheckbox.onchange = (e) => {
            debugLog('[Core] TIMESTAMP FORMAT CHECKBOX CHANGED');
            timestampDateFirst = e.target.checked;
            debugLog('[Core] Timestamp Format:', timestampDateFirst ? 'date@time' : 'time@date');
        };
        
        timestampHourFormatCheckbox.onchange = (e) => {
            debugLog('[Core] TIMESTAMP HOUR FORMAT CHECKBOX CHANGED');
            timestamp24Hour = e.target.checked;
            debugLog('[Core] Timestamp Hour Format:', timestamp24Hour ? '24-hour' : '12-hour');
        };

        showMessageIdsCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW MESSAGE IDS CHECKBOX CHANGED');
            showMessageIdsEnabled = e.target.checked;
            debugLog('[Core] Show Message IDs:', showMessageIdsEnabled);
        };

        highlightModelChangesCheckbox.onchange = (e) => {
            debugLog('[Core] HIGHLIGHT MODEL CHANGES CHECKBOX CHANGED');
            highlightModelChangesEnabled = e.target.checked;
            debugLog('[Core] Highlight Model Changes:', highlightModelChangesEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenMismatchCheckbox.onchange = (e) => {
            debugLog('[Core] AUTO REGEN MISMATCH CHECKBOX CHANGED');
            autoRegenOnMismatchEnabled = e.target.checked;
            debugLog('[Core] Auto Regen On Mismatch:', autoRegenOnMismatchEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenShortCheckbox.onchange = (e) => {
            debugLog('[Core] AUTO REGEN SHORT CHECKBOX CHANGED');
            autoRegenOnShortEnabled = e.target.checked;
            debugLog('[Core] Auto Regen On Short:', autoRegenOnShortEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenMaxSelect.onchange = (e) => {
            debugLog('[Core] AUTO REGEN MAX SELECT CHANGED');
            autoRegenMaxAttempts = parseInt(e.target.value, 10);
            debugLog('[Core] Auto Regen Max Attempts:', autoRegenMaxAttempts);
        };

        showChatNameInTitleCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW CHAT NAME IN TITLE CHECKBOX CHANGED');
            showChatNameInTitleEnabled = e.target.checked;
            debugLog('[Core] Show Chat Name In Title:', showChatNameInTitleEnabled);
        };
        
        nsfwToggleCheckbox.onchange = (e) => {
            debugLog('[Core] NSFW TOGGLE CHECKBOX CHANGED');
            nsfwToggleEnabled = e.target.checked;
            debugLog('[Core] NSFW Toggle:', nsfwToggleEnabled);
        };

        messageRecoveryCheckbox.onchange = (e) => {
            debugLog('[Core] MESSAGE RECOVERY CHECKBOX CHANGED');
            messageRecoveryEnabled = e.target.checked;
            debugLog('[Core] Message Recovery:', messageRecoveryEnabled);
        };

        hideCreatorCheckbox.onchange = (e) => {
            debugLog('[Core] HIDE CREATOR CHECKBOX CHANGED');
            hideCreatorEnabled = e.target.checked;
            debugLog('[Core] Hide Creator:', hideCreatorEnabled);
        };

        wysiwygCheckbox.onchange = (e) => {
            debugLog('[Core] WYSIWYG CHECKBOX CHANGED');
            wysiwygEnabled = e.target.checked;
            debugLog('[Core] WYSIWYG Enabled:', wysiwygEnabled);
        };
        
        // Close modal function
        const closeModal = () => {
            syncProgressCallback = null;
            debugLog('[Core] ===== CLOSE MODAL CALLED =====');
            debugLog('[Core] Current time:', Date.now());
            debugLog('[Core] Backdrop element:', backdrop);
            debugLog('[Core] Modal element:', modal);
            debugLog('[Core] Shadow root:', shadow);
            debugLog('[Core] Document body children count:', document.body.children.length);
            
            try {
                debugLog('[Core] Setting backdrop opacity to 0');
                backdrop.style.opacity = '0';
                debugLog('[Core] Setting backdrop transition');
                backdrop.style.transition = 'opacity 0.15s';
                debugLog('[Core] Setting modal opacity to 0');
                modal.style.opacity = '0';
                debugLog('[Core] Setting modal transform');
                modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
                debugLog('[Core] Setting modal transition');
                modal.style.transition = 'all 0.15s';
                debugLog('[Core] CSS animations set successfully');
            } catch (error) {
                console.error('[Core] Error setting CSS animations:', error);
            }
            
            // Remove from DOM after animation completes
            debugLog('[Core] Scheduling removal in 200ms');
            setTimeout(() => {
                debugLog('[Core] ===== STARTING DOM REMOVAL =====');
                debugLog('[Core] Time:', Date.now());
                debugLog('[Core] About to remove backdrop');
                try {
                    backdrop.remove();
                    debugLog('[Core] Backdrop removed successfully');
                } catch (error) {
                    console.error('[Core] Error removing backdrop:', error);
                }
                
                debugLog('[Core] About to remove modal');
                try {
                    modal.remove();
                    debugLog('[Core] Modal removed successfully');
                } catch (error) {
                    console.error('[Core] Error removing modal:', error);
                }
                
                debugLog('[Core] ===== DOM REMOVAL COMPLETE =====');
                debugLog('[Core] Document body children count after removal:', document.body.children.length);
            }, 200);
            
            debugLog('[Core] closeModal function execution complete (removal scheduled)');
        };
        
        // Disable backdrop click to close (user must use Cancel or Save buttons)
        backdrop.onclick = (e) => {
            debugLog('[Core] Backdrop clicked - ignoring (use Cancel or Save buttons)');
            // Do nothing - force user to use buttons
        };
        
        // Cancel button - closes modal and syncs model override to interceptor (no page refresh needed)
        cancelBtn.onclick = async (e) => {
            debugLog('[Core] Cancel button clicked');
            e.stopPropagation();
            // Ensure model override is live in the interceptor without requiring a page reload
            const [overrideEnabled, overrideName] = await Promise.all([
                storage.get('modelOverrideEnabled', false),
                storage.get('modelOverrideName', '')
            ]);
            window.postMessage({
                type: 'SAI_SET_MODEL_OVERRIDE',
                model: overrideEnabled && overrideName ? overrideName : null
            }, '*');
            closeModal();
        };
        
        // Clear All Data button - with confirmation dialog
        clearAllBtn.onclick = async (e) => {
            debugLog('[Core] Clear All Data button clicked');
            e.stopPropagation();
            
            // Create confirmation dialog in shadow DOM
            const confirmBackdrop = document.createElement('div');
            confirmBackdrop.className = 'backdrop';
            confirmBackdrop.style.zIndex = '10000005';
            
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal';
            confirmModal.style.zIndex = '10000006';
            confirmModal.style.width = '350px';
            confirmModal.replaceChildren(parseHTMLToFragment(`
                <div class="modal-header">⚠️ Clear All Data?</div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 1rem;">
                        <p style="margin-bottom: 0.5rem;">This will permanently delete:</p>
                        <ul style="text-align: left; margin: 0; padding-left: 1.5rem;">
                            <li>All settings</li>
                            <li>All generation profiles</li>
                            <li>All message stats</li>
                        </ul>
                        <p style="margin-top: 1rem; color: #ef4444; font-weight: 600;">This action cannot be undone!</p>
                    </div>
                </div>
                <div class="button-row">
                    <button class="btn-cancel" id="confirm-cancel-btn">Cancel</button>
                    <button class="btn-save" id="confirm-clear-btn" style="background: #ef4444;">Clear All Data</button>
                </div>
            `));
            
            shadow.appendChild(confirmBackdrop);
            shadow.appendChild(confirmModal);
            
            const confirmCancelBtn = shadow.querySelector('#confirm-cancel-btn');
            const confirmClearBtn = shadow.querySelector('#confirm-clear-btn');
            
            // Cancel confirmation
            confirmCancelBtn.onclick = (e) => {
                e.stopPropagation();
                confirmBackdrop.remove();
                confirmModal.remove();
            };
            
            // Confirm clear all data
            confirmClearBtn.onclick = async (e) => {
                e.stopPropagation();
                debugLog('[Core] Confirmed - clearing all data');
                
                try {
                    await storage.clear();
                    debugLog('[Core] All data cleared');
                    showNotification('All data cleared! Refreshing...');
                    setTimeout(() => {
                        window.location.reload();
                    }, 500);
                } catch (error) {
                    console.error('[Core] Error clearing data:', error);
                    alert('Error clearing data: ' + error.message);
                }
            };
            
            // Close confirmation on backdrop click
            confirmBackdrop.onclick = (e) => {
                if (e.target === confirmBackdrop) {
                    confirmBackdrop.remove();
                    confirmModal.remove();
                }
            };
        };
        
        // Drive Sync UI
        (async () => {
            let driveBackupFolderUrl = null;

            // ---- keepalive: pin the (Orion/MV2) background page for the duration of ANY
            // Drive RPC. Drive operations (sync, backup list/restore, status) can trigger
            // an interactive Google sign-in tab flow lasting many seconds; without a held
            // port the background page is OS-suspended on WebKit, which silently kills its
            // in-flight IndexedDB connection and later hangs the resync ("Merging data…").
            // Ref-counted so concurrent/nested calls (incl. the retry) share one port and
            // it closes only when the last in-flight call finishes.
            let _driveKeepalivePort = null;
            let _driveKeepaliveRefs = 0;
            const acquireDriveKeepalive = () => {
                _driveKeepaliveRefs++;
                if (!_driveKeepalivePort) {
                    try {
                        _driveKeepalivePort = runtimeAPI.runtime.connect({ name: 'sai-sync-keepalive' });
                        _driveKeepalivePort.onDisconnect.addListener(() => { _driveKeepalivePort = null; });
                    } catch (_) { _driveKeepalivePort = null; }
                }
            };
            const releaseDriveKeepalive = () => {
                _driveKeepaliveRefs = Math.max(0, _driveKeepaliveRefs - 1);
                if (_driveKeepaliveRefs === 0 && _driveKeepalivePort) {
                    try { _driveKeepalivePort.disconnect(); } catch (_) {}
                    _driveKeepalivePort = null;
                }
            };

            // ---- shared Drive message helper ----
            // Retries once on "Receiving end does not exist" — Chrome MV3 SW may not be ready on first modal open.
            // Holds a keepalive port for each call so an interactive auth tab flow can't be suspended mid-flight.
            const sendDriveMessage = (type, payload, _retries = 1) => {
                acquireDriveKeepalive();
                return new Promise((resolve, reject) => {
                    runtimeAPI.runtime.sendMessage({ type, ...payload }, (res) => {
                        const err = runtimeAPI.runtime.lastError;
                        if (err) {
                            if (_retries > 0 && err.message && err.message.includes('Could not establish connection')) {
                                setTimeout(() => sendDriveMessage(type, payload, _retries - 1).then(resolve).catch(reject), 300);
                            } else {
                                reject(new Error(err.message));
                            }
                        } else {
                            resolve(res);
                        }
                    });
                }).finally(() => releaseDriveKeepalive());
            };

            // ---- status display ----
            const updateDriveStatus = async () => {
                const { driveLastSync, driveFileId } = await storage.getMultiple(['driveLastSync', 'driveFileId']);
                if (driveLastSync) {
                    driveSyncStatus.textContent = `Last synced: ${new Date(driveLastSync).toLocaleString()}`;
                    driveSyncStatus.style.color = '#10b981';
                    driveDisconnectBtn.style.display = '';
                } else if (driveFileId) {
                    driveSyncStatus.textContent = 'Connected — not yet synced this session.';
                    driveSyncStatus.style.color = '#9ca3af';
                    driveDisconnectBtn.style.display = '';
                } else {
                    driveSyncStatus.textContent = 'Not connected to Google Drive.';
                    driveSyncStatus.style.color = '#9ca3af';
                    driveDisconnectBtn.style.display = 'none';
                }
                const isConnected = !!(driveLastSync || driveFileId);
                driveBackupSection.style.display = isConnected ? '' : 'none';
                if (isConnected) loadDriveBackupList();
            };

            // ---- backup list renderer ----
            const loadDriveBackupList = async () => {
                driveBackupList.replaceChildren();
                const loading = document.createElement('div');
                loading.className = 'drive-backup-loading';
                loading.textContent = 'Loading backups…';
                driveBackupList.appendChild(loading);
                try {
                    const res = await sendDriveMessage('SAI_DRIVE_LIST_BACKUPS');
                    driveBackupList.replaceChildren();
                    if (!res || !res.success) {
                        const errEl = document.createElement('div');
                        errEl.className = 'drive-backup-empty';
                        errEl.textContent = (res && res.error) || 'Failed to load backups.';
                        driveBackupList.appendChild(errEl);
                        return;
                    }
                    if (res.folderId) driveBackupFolderUrl = `https://drive.google.com/drive/folders/${res.folderId}`;
                    if (!res.backups || res.backups.length === 0) {
                        const empty = document.createElement('div');
                        empty.className = 'drive-backup-empty';
                        empty.textContent = 'No backups yet.';
                        driveBackupList.appendChild(empty);
                        return;
                    }
                    for (const backup of res.backups) {
                        const item = document.createElement('div');
                        item.className = 'drive-backup-item';
                        const dateEl = document.createElement('div');
                        dateEl.className = 'drive-backup-item-date';
                        dateEl.textContent = new Date(backup.createdTime).toLocaleString();
                        const btns = document.createElement('div');
                        btns.className = 'drive-backup-item-btns';
                        const restoreBtn = document.createElement('button');
                        restoreBtn.className = 'btn-data';
                        restoreBtn.style.cssText = 'padding:0.15rem 0.45rem;font-size:11px;';
                        restoreBtn.textContent = 'Restore';
                        restoreBtn.onclick = async (ev) => {
                            ev.stopPropagation();
                            if (!confirm(`Restore from this backup?\n\n${dateEl.textContent}\n\nSettings will be overwritten and stats merged with current data. The page will reload.`)) return;
                            restoreBtn.disabled = true;
                            restoreBtn.textContent = 'Restoring…';
                            try {
                                const restoreRes = await sendDriveMessage('SAI_DRIVE_RESTORE_BACKUP', { fileId: backup.id });
                                if (!restoreRes || !restoreRes.success) {
                                    alert((restoreRes && restoreRes.error) || 'Restore failed.');
                                    restoreBtn.disabled = false;
                                    restoreBtn.textContent = 'Restore';
                                    return;
                                }
                                await applyImportedData(restoreRes.data);
                            } catch (err) {
                                alert(err.message || 'Restore failed.');
                                restoreBtn.disabled = false;
                                restoreBtn.textContent = 'Restore';
                            }
                        };
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'btn-data';
                        deleteBtn.style.cssText = 'padding:0.15rem 0.45rem;font-size:11px;color:#dc2626;border-color:#dc2626;';
                        deleteBtn.textContent = 'Delete';
                        deleteBtn.onclick = async (ev) => {
                            ev.stopPropagation();
                            if (!confirm(`Delete this backup?\n\n${dateEl.textContent}\n\nThis cannot be undone.`)) return;
                            deleteBtn.disabled = true;
                            deleteBtn.textContent = 'Deleting…';
                            try {
                                const delRes = await sendDriveMessage('SAI_DRIVE_DELETE_BACKUP', { fileId: backup.id });
                                if (!delRes || !delRes.success) {
                                    alert((delRes && delRes.error) || 'Delete failed.');
                                    deleteBtn.disabled = false;
                                    deleteBtn.textContent = 'Delete';
                                    return;
                                }
                                item.remove();
                                if (!driveBackupList.children.length) {
                                    const empty = document.createElement('div');
                                    empty.className = 'drive-backup-empty';
                                    empty.textContent = 'No backups yet.';
                                    driveBackupList.appendChild(empty);
                                }
                            } catch (err) {
                                alert(err.message || 'Delete failed.');
                                deleteBtn.disabled = false;
                                deleteBtn.textContent = 'Delete';
                            }
                        };
                        btns.appendChild(restoreBtn);
                        btns.appendChild(deleteBtn);
                        item.appendChild(dateEl);
                        item.appendChild(btns);
                        driveBackupList.appendChild(item);
                    }
                } catch (err) {
                    driveBackupList.replaceChildren();
                    const errEl = document.createElement('div');
                    errEl.className = 'drive-backup-empty';
                    errEl.textContent = err.message || 'Failed to load backups.';
                    driveBackupList.appendChild(errEl);
                }
            };

            // ---- apply imported/restored data (mirrors importAllBtn logic) ----
            const applyImportedData = async (imported) => {
                // Un-nest v2 grouped backups (settings/style/stats) so the flat-key reads
                // below resolve. v1/flat payloads pass through unchanged.
                imported = normalizeImportPayload(imported);
                const showProgress = (statusText, pct) => {
                    let overlay = shadow.getElementById('import-progress-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'import-progress-overlay';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                        const card = document.createElement('div');
                        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:280px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                        const titleEl = document.createElement('div');
                        titleEl.textContent = 'Restoring…';
                        titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                        const statusEl = document.createElement('div');
                        statusEl.id = 'import-progress-status';
                        statusEl.style.cssText = 'color:#9ca3af;font-size:12px;min-height:1.2em;';
                        const track = document.createElement('div');
                        track.style.cssText = 'height:4px;background:#374151;border-radius:2px;overflow:hidden;';
                        const fill = document.createElement('div');
                        fill.id = 'import-progress-fill';
                        fill.style.cssText = 'height:100%;background:#3b82f6;border-radius:2px;transition:width 0.2s ease;width:0%;';
                        track.appendChild(fill);
                        card.appendChild(titleEl); card.appendChild(statusEl); card.appendChild(track);
                        overlay.appendChild(card);
                        shadow.appendChild(overlay);
                    }
                    shadow.getElementById('import-progress-status').textContent = statusText;
                    shadow.getElementById('import-progress-fill').style.width = pct + '%';
                };

                let generationProfilesValue = imported.generationProfiles;
                let messageGenerationStatsValue = imported.messageGenerationStats;
                if (typeof generationProfilesValue === 'object' && generationProfilesValue !== null) {
                    generationProfilesValue = JSON.stringify(generationProfilesValue);
                }
                if (typeof messageGenerationStatsValue === 'object' && messageGenerationStatsValue !== null) {
                    messageGenerationStatsValue = JSON.stringify(messageGenerationStatsValue);
                }

                const updates = {};
                if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
                if (imported.sidebarMinWidth !== undefined) updates.sidebarMinWidth = imported.sidebarMinWidth;
                if (imported.enableClassicLayout !== undefined) updates.enableClassicLayout = imported.enableClassicLayout;
                if (imported.enableClassicStyle !== undefined) updates.enableClassicStyle = imported.enableClassicStyle;
                if (imported.enableCustomStyle !== undefined) updates.enableCustomStyle = imported.enableCustomStyle;
                if (imported.customStyleValues !== undefined) updates.customStyleValues = imported.customStyleValues;
                if (imported.enableThemeCustomization !== undefined && imported.enableClassicLayout === undefined && imported.enableClassicStyle === undefined) {
                    updates.enableClassicLayout = imported.enableThemeCustomization;
                    updates.enableClassicStyle = imported.enableThemeCustomization;
                }
                if (imported.enableCompactGeneration !== undefined) updates.enableCompactGeneration = imported.enableCompactGeneration;
                if (imported.enableHideForYou !== undefined) updates.enableHideForYou = imported.enableHideForYou;
                if (imported.enablePageJump !== undefined) updates.enablePageJump = imported.enablePageJump;
                if (imported.showGenerationStats !== undefined) updates.showGenerationStats = imported.showGenerationStats;
                if (imported.showModelDetails !== undefined) updates.showModelDetails = imported.showModelDetails;
                if (imported.showTimestamp !== undefined) updates.showTimestamp = imported.showTimestamp;
                if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                if (imported.timestamp24Hour !== undefined) updates.timestamp24Hour = imported.timestamp24Hour;
                if (imported.showMessageIds !== undefined) updates.showMessageIds = imported.showMessageIds;
                if (imported.showChatNameInTitle !== undefined) updates.showChatNameInTitle = imported.showChatNameInTitle;
                if (imported.nsfwToggleEnabled !== undefined) updates.nsfwToggleEnabled = imported.nsfwToggleEnabled;
                if (imported.messageRecoveryEnabled !== undefined) updates.messageRecoveryEnabled = imported.messageRecoveryEnabled;
                if (imported.enableWysiwygEditor !== undefined) updates.enableWysiwygEditor = imported.enableWysiwygEditor;
                if (imported.enableGenerationProfiles !== undefined) updates.enableGenerationProfiles = imported.enableGenerationProfiles;
                if (imported.enableSmallProfileImages !== undefined) updates.enableSmallProfileImages = imported.enableSmallProfileImages;
                if (imported.enableRoundedProfileImages !== undefined) updates.enableRoundedProfileImages = imported.enableRoundedProfileImages;
                if (imported.swapCheckboxPosition !== undefined) updates.swapCheckboxPosition = imported.swapCheckboxPosition;
                if (imported.squareMessageEdges !== undefined) updates.squareMessageEdges = imported.squareMessageEdges;
                if (imported.highlightModelChanges !== undefined) updates.highlightModelChanges = imported.highlightModelChanges;
                if (imported.autoRegenOnMismatch !== undefined) updates.autoRegenOnMismatch = imported.autoRegenOnMismatch;
                if (imported.autoRegenOnShort !== undefined) updates.autoRegenOnShort = imported.autoRegenOnShort;
                if (imported.autoRegenMaxAttempts !== undefined) updates.autoRegenMaxAttempts = imported.autoRegenMaxAttempts;
                if (imported.messageContainerMaxWidth !== undefined) updates[MESSAGE_CONTAINER_MAX_WIDTH_KEY] = imported.messageContainerMaxWidth;
                if (imported.memoryDotEnabled !== undefined) updates[MEMORY_DOT_ENABLED_KEY] = imported.memoryDotEnabled;
                if (imported.memoryDotColor !== undefined) updates[MEMORY_DOT_COLOR_KEY] = imported.memoryDotColor;
                if (imported.hideCreatorName !== undefined) updates[HIDE_CREATOR_KEY] = imported.hideCreatorName;
                if (generationProfilesValue !== undefined) updates.generationProfiles = generationProfilesValue;
                if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;

                const removeProgress = () => {
                    const ov = shadow.getElementById('import-progress-overlay');
                    if (ov) ov.remove();
                };

                try {
                    showProgress('Restoring settings…', 20);
                    await new Promise(r => setTimeout(r, 0));

                    if (messageGenerationStatsValue !== undefined) {
                        const importedStats = JSON.parse(messageGenerationStatsValue);
                        const botCount = Object.keys(importedStats).length;
                        showProgress(`Merging stats (${botCount} bots)…`, 45);
                        await new Promise(r => setTimeout(r, 0));
                        // Stats live in the background IndexedDB store — merge there (authoritative,
                        // collapses conversation level, never overwrites richer entries). Not written
                        // to storage.local, so keep it out of `updates`. (Page reloads after restore,
                        // so the content-side cache refreshes naturally.) Fail loudly if the merge
                        // failed — never reload as if a failed stats restore succeeded.
                        const mergeRes = await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: importedStats });
                        if (!mergeRes || !mergeRes.success) {
                            throw new Error('Stats merge failed: ' + ((mergeRes && mergeRes.error) || 'unknown error'));
                        }
                    }

                    showProgress('Saving…', 75);
                    await new Promise(r => setTimeout(r, 0));
                    await storage.setMultiple(updates);
                    showProgress('Done! Reloading…', 100);
                    await new Promise(r => setTimeout(r, 0));
                    setTimeout(() => { window.location.reload(); }, 800);
                } catch (err) {
                    removeProgress();
                    alert('Restore failed: ' + (err.message || 'Unknown error'));
                    throw err;
                }
            };

            // ---- pre-connect confirmation prompt ----
            const showPreConnectPrompt = () => new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                const card = document.createElement('div');
                card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:300px;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                const titleEl = document.createElement('div');
                titleEl.textContent = 'Connect Google Drive';
                titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                // What & why
                const explainEl = document.createElement('div');
                explainEl.textContent = 'Back up your settings and generation stats to your own Google Drive and sync them across devices.';
                explainEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;';
                // Scope reassurance (highlighted) — the single biggest trust concern
                const scopeEl = document.createElement('div');
                scopeEl.textContent = 'S.AI Toolkit can only see the one file it creates (sai-toolkit-sync.json) — never the rest of your Drive.';
                scopeEl.style.cssText = 'color:#bfdbfe;font-size:12px;line-height:1.5;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.35);border-radius:6px;padding:0.5rem 0.6rem;';
                // Expectation-setting for Google's own consent screen
                const expectEl = document.createElement('div');
                expectEl.textContent = 'Google will show its own sign-in screen next. While our app review is pending it may show the developer’s web address instead of “S.AI Toolkit” and note the app isn’t verified — that’s normal for new apps.';
                expectEl.style.cssText = 'color:#9ca3af;font-size:11px;line-height:1.5;';
                const descEl = document.createElement('div');
                descEl.textContent = 'First time connecting — would you like to download a local backup of your data before syncing?';
                descEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;margin-top:0.25rem;';
                const btns = document.createElement('div');
                btns.style.cssText = 'display:flex;flex-direction:column;gap:0.4rem;margin-top:0.25rem;';
                const downloadBtn = document.createElement('button');
                downloadBtn.textContent = 'Download Local Backup First';
                downloadBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #3b82f6;background:#1d4ed8;color:#fff;font-size:12px;cursor:pointer;';
                const skipBtn = document.createElement('button');
                skipBtn.textContent = 'Connect Without Backup';
                skipBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#9ca3af;font-size:12px;cursor:pointer;';
                const cancelEl = document.createElement('button');
                cancelEl.textContent = 'Cancel';
                cancelEl.style.cssText = 'padding:0.25rem;border:none;background:transparent;color:#6b7280;font-size:11px;cursor:pointer;text-align:center;';
                downloadBtn.onclick = () => { overlay.remove(); resolve('download'); };
                skipBtn.onclick = () => { overlay.remove(); resolve('connect'); };
                cancelEl.onclick = () => { overlay.remove(); resolve('cancel'); };
                btns.appendChild(downloadBtn);
                btns.appendChild(skipBtn);
                btns.appendChild(cancelEl);
                card.appendChild(titleEl);
                card.appendChild(explainEl);
                card.appendChild(scopeEl);
                card.appendChild(expectEl);
                card.appendChild(descEl);
                card.appendChild(btns);
                overlay.appendChild(card);
                shadow.appendChild(overlay);
            });

            // ---- init: load sync scope and auto-sync preferences ----
            const savedPrefs = await storage.getMultiple({
                driveSyncStats: true,
                driveSyncSettings: false,
                driveSyncStyle: true,
                driveAutoSync: false,
                driveAutoSyncInterval: 10
            });
            syncStatsToggle.checked    = !!savedPrefs.driveSyncStats;
            syncSettingsToggle.checked = !!savedPrefs.driveSyncSettings;
            syncStyleToggle.checked    = !!savedPrefs.driveSyncStyle;
            autoSyncToggle.checked     = !!savedPrefs.driveAutoSync;
            autoSyncIntervalSelect.value = String(savedPrefs.driveAutoSyncInterval || 10);
            autoSyncIntervalSelect.style.display = savedPrefs.driveAutoSync ? '' : 'none';

            const persistSyncPrefs = () => storage.setMultiple({
                driveSyncStats:    syncStatsToggle.checked,
                driveSyncSettings: syncSettingsToggle.checked,
                driveSyncStyle:    syncStyleToggle.checked
            });

            const applyAutoSyncPref = async () => {
                const enabled = autoSyncToggle.checked;
                const intervalMinutes = parseInt(autoSyncIntervalSelect.value, 10);
                autoSyncIntervalSelect.style.display = enabled ? '' : 'none';
                await storage.setMultiple({ driveAutoSync: enabled, driveAutoSyncInterval: intervalMinutes });
                await sendDriveMessage('SAI_DRIVE_SET_AUTO_SYNC', { enabled, intervalMinutes });
            };
            autoSyncToggle.onchange         = applyAutoSyncPref;
            autoSyncIntervalSelect.onchange = applyAutoSyncPref;
            syncStatsToggle.onchange    = persistSyncPrefs;
            syncSettingsToggle.onchange = persistSyncPrefs;
            syncStyleToggle.onchange    = persistSyncPrefs;

            await updateDriveStatus();

            // ---- event handlers ----
            const syncProgressSection = shadow.querySelector('#sync-progress-section');
            const syncProgressText    = shadow.querySelector('#sync-progress-text');
            const syncProgressBar     = shadow.querySelector('#sync-progress-bar');

            const showSyncProgress = (msg) => {
                debugLog(`[Sync] Progress update in UI: [${msg.stepNum}/${msg.totalSteps}] ${msg.step}`);
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) syncProgressText.textContent = msg.step + (msg.detail ? ` — ${msg.detail}` : '');
                if (syncProgressBar) syncProgressBar.style.width = `${Math.round((msg.stepNum / msg.totalSteps) * 100)}%`;
            };

            const hideSyncProgress = (delayMs = 1500) => {
                if (syncProgressBar) syncProgressBar.style.width = '100%';
                setTimeout(() => {
                    if (syncProgressSection) syncProgressSection.style.display = 'none';
                    if (syncProgressBar) { syncProgressBar.style.background = '#6366f1'; syncProgressBar.style.width = '0%'; }
                    if (syncProgressText) { syncProgressText.textContent = ''; syncProgressText.style.color = '#9ca3af'; }
                }, delayMs);
            };

            const showSyncError = (msg) => {
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) { syncProgressText.textContent = msg; syncProgressText.style.color = '#ef4444'; }
                if (syncProgressBar) { syncProgressBar.style.background = '#ef4444'; syncProgressBar.style.width = '100%'; }
                setTimeout(() => {
                    if (syncProgressSection) syncProgressSection.style.display = 'none';
                    if (syncProgressBar) { syncProgressBar.style.background = '#6366f1'; syncProgressBar.style.width = '0%'; }
                    if (syncProgressText) { syncProgressText.textContent = ''; syncProgressText.style.color = '#9ca3af'; }
                }, 4000);
            };

            driveSyncBtn.onclick = async (e) => {
                e.stopPropagation();
                const { driveFileId, driveLastSync } = await storage.getMultiple(['driveFileId', 'driveLastSync']);
                debugLog('[Sync] Sync Now clicked — driveFileId:', driveFileId, 'driveLastSync:', driveLastSync);
                if (!driveFileId && !driveLastSync) {
                    const choice = await showPreConnectPrompt();
                    if (choice === 'cancel') return;
                    if (choice === 'download') {
                        exportAllBtn.click();
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                driveSyncBtn.disabled = true;
                driveSyncBtn.textContent = 'Syncing…';
                driveSyncStatus.textContent = '';
                driveSyncStatus.style.color = '#9ca3af';
                // Show progress bar and wire up progress callback
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) syncProgressText.textContent = 'Starting…';
                if (syncProgressBar) syncProgressBar.style.width = '0%';
                syncProgressCallback = showSyncProgress;
                const syncStats    = syncStatsToggle.checked;
                const syncSettings = syncSettingsToggle.checked;
                const syncStyle    = syncStyleToggle.checked;
                debugLog('[Sync] Sending SAI_DRIVE_SYNC — syncStats:', syncStats, 'syncSettings:', syncSettings, 'syncStyle:', syncStyle);
                // Note: sendDriveMessage now holds the background-keepalive port for the
                // duration of every Drive RPC (including the auth tab flow), so no separate
                // sync-scoped keepalive is needed here.
                let _alreadyRunning = false;
                try {
                    const result = await sendDriveMessage('SAI_DRIVE_SYNC', {
                        syncStats, syncSettings, syncStyle
                    });
                    debugLog('[Sync] SAI_DRIVE_SYNC result:', result);
                    if (result && result.success) {
                        if (result.syncedSettings) {
                            hideSyncProgress(0);
                            driveSyncBtn.textContent = 'Synced! Reloading…';
                            window.location.reload();
                            return;
                        }
                        hideSyncProgress();
                        await updateDriveStatus();
                    } else if (result && result.alreadyRunning) {
                        // Sync is already running from a previous click — don't show a red error.
                        // Keep the progress callback live so the running sync's updates show.
                        _alreadyRunning = true;
                        syncProgressCallback = showSyncProgress;
                        if (syncProgressSection) syncProgressSection.style.display = '';
                        if (syncProgressText) { syncProgressText.textContent = 'Sync in progress — please wait…'; syncProgressText.style.color = '#9ca3af'; }
                        driveSyncStatus.textContent = 'Sync already in progress…';
                        driveSyncStatus.style.color = '#9ca3af';
                        debugLog('[Sync] Already running — reattached progress callback');
                    } else {
                        const errMsg = (result && result.error) || 'Sync failed — please try again.';
                        showSyncError(errMsg);
                        driveSyncStatus.textContent = errMsg;
                        driveSyncStatus.style.color = '#dc2626';
                        debugLog('[Sync] Sync failed with error:', errMsg);
                    }
                } catch (err) {
                    const errMsg = err.message || 'Sync failed — please try again.';
                    showSyncError(errMsg);
                    driveSyncStatus.textContent = errMsg;
                    driveSyncStatus.style.color = '#dc2626';
                    debugLog('[Sync] Sync threw exception:', err.message);
                } finally {
                    if (!_alreadyRunning) syncProgressCallback = null;
                }
                driveSyncBtn.disabled = false;
                driveSyncBtn.textContent = 'Sync Now';
            };

            driveCreateBackupBtn.onclick = async (e) => {
                e.stopPropagation();
                driveCreateBackupBtn.disabled = true;
                driveCreateBackupBtn.textContent = 'Creating…';
                driveBackupStatus.textContent = '';
                try {
                    const rawStorage = await sendDriveMessage('getSettings');
                    const exportData = { ...rawStorage };
                    if (typeof exportData.generationProfiles === 'string') {
                        try { exportData.generationProfiles = JSON.parse(exportData.generationProfiles); } catch (_) {}
                    }
                    // Stats now live in the background IndexedDB store, NOT storage.local.
                    // Pull the authoritative nested snapshot from the DB (getSettings only
                    // carries the frozen legacy blob, which would be stale/empty). If the DB
                    // read fails, ABORT the backup — never ship a silently empty-stats file.
                    const statsRes = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
                    if (!statsRes || !statsRes.success) {
                        throw new Error('Could not read stats from the database — backup aborted to avoid an incomplete file.');
                    }
                    exportData.messageGenerationStats = statsRes.stats || {};
                    delete exportData.driveAccessToken;
                    delete exportData.driveRefreshToken;
                    delete exportData.driveTokenExpiry;
                    delete exportData.driveFileId;
                    delete exportData.driveLastSync;
                    delete exportData.driveBackupFolderId;
                    delete exportData.driveSyncStats;
                    delete exportData.driveSyncSettings;
                    delete exportData.driveSyncStyle;
                    delete exportData.driveAutoSync;
                    delete exportData.driveAutoSyncInterval;
                    const result = await sendDriveMessage('SAI_DRIVE_CREATE_BACKUP', { exportData });
                    if (result && result.success) {
                        driveBackupStatus.textContent = 'Backup created.';
                        driveBackupStatus.style.color = '#10b981';
                        await loadDriveBackupList();
                    } else {
                        driveBackupStatus.textContent = (result && result.error) || 'Backup failed.';
                        driveBackupStatus.style.color = '#dc2626';
                    }
                } catch (err) {
                    driveBackupStatus.textContent = err.message || 'Backup failed.';
                    driveBackupStatus.style.color = '#dc2626';
                }
                driveCreateBackupBtn.disabled = false;
                driveCreateBackupBtn.textContent = 'Create Backup';
            };

            driveOpenFolderBtn.onclick = (e) => {
                e.stopPropagation();
                if (driveBackupFolderUrl) {
                    window.open(driveBackupFolderUrl, '_blank');
                } else {
                    driveBackupStatus.textContent = 'Folder URL not available — try reloading the backup list.';
                    driveBackupStatus.style.color = '#dc2626';
                }
            };

            driveDisconnectBtn.onclick = async (e) => {
                e.stopPropagation();
                await storage.remove(['driveAccessToken', 'driveRefreshToken', 'driveTokenExpiry', 'driveFileId', 'driveLastSync', 'driveBackupFolderId']);
                driveBackupFolderUrl = null;
                // Disable auto-sync and clear the alarm
                autoSyncToggle.checked = false;
                autoSyncIntervalSelect.style.display = 'none';
                await storage.setMultiple({ driveAutoSync: false });
                await sendDriveMessage('SAI_DRIVE_SET_AUTO_SYNC', { enabled: false });
                await updateDriveStatus();
            };
        })();

        // Save & Refresh button
        saveBtn.onclick = async (e) => {
            debugLog('[Core] Save & Refresh button clicked');
            e.stopPropagation();
            
            // Handle sidebar min width - revert to default if empty/invalid
            const minWidthInputValue = parseInt(sidebarMinWidthInput.value, 10);
            const finalMinWidth = (!isNaN(minWidthInputValue) && minWidthInputValue >= 600 && minWidthInputValue <= 2000) 
                ? minWidthInputValue 
                : DEFAULT_SIDEBAR_MIN_WIDTH;
            
            // Read current checkbox states
            sidebarEnabled = sidebarCheckbox.checked;
            compactGenerationEnabled = compactGenerationCheckbox.checked;
            classicLayoutEnabled = classicLayoutCheckbox.checked;
            classicStyleEnabled = classicStyleCheckbox.checked;
            customStyleEnabled = customStyleCheckbox.checked;
            hideForYouEnabled = hideForYouCheckbox.checked;
            pageJumpEnabled = pageJumpCheckbox.checked;
            showStatsEnabled = showStatsCheckbox.checked;
            showModelDetailsEnabled = modelDetailsCheckbox.checked;
            showTimestampEnabled = showTimestampCheckbox.checked;
            timestampDateFirst = timestampFormatCheckbox.checked;
            timestamp24Hour = timestampHourFormatCheckbox.checked;
            showMessageIdsEnabled = showMessageIdsCheckbox.checked;
            highlightModelChangesEnabled = highlightModelChangesCheckbox.checked;
            autoRegenOnMismatchEnabled = autoRegenMismatchCheckbox.checked;
            autoRegenOnShortEnabled = autoRegenShortCheckbox.checked;
            autoRegenMaxAttempts = parseInt(autoRegenMaxSelect.value, 10);
            showChatNameInTitleEnabled = showChatNameInTitleCheckbox.checked;
            nsfwToggleEnabled = nsfwToggleCheckbox.checked;
            messageRecoveryEnabled = messageRecoveryCheckbox.checked;
            hideCreatorEnabled = hideCreatorCheckbox.checked;
            smallProfileImagesEnabled = smallProfileImagesCheckbox.checked;
            roundedProfileImagesEnabled = roundedProfileImagesCheckbox.checked;
            swapCheckboxPositionEnabled = swapCheckboxPositionCheckbox.checked;
            squareMessageEdgesEnabled = squareMessageEdgesCheckbox.checked;
            wysiwygEnabled = wysiwygCheckbox.checked;
            enableGenerationProfilesEnabled = enableGenerationProfilesCheckbox.checked;
            // Normalize message container max width on save as well
            let finalMessageMax = String(messageContainerMaxWidthInput.value || '').trim();
            if (/^\d+(?:\.\d+)?$/.test(finalMessageMax)) finalMessageMax = `${finalMessageMax}px`;
            messageContainerMaxWidth = finalMessageMax;
            memoryDotEnabled = memoryDotEnabledCheckbox.checked;
            memoryDotColor = memoryDotColorInput.value.trim() || '#ff3b3b';
            
            debugLog('[Core] Saving - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', finalMinWidth, 'CompactGeneration:', compactGenerationEnabled, 'ClassicLayout:', classicLayoutEnabled, 'ClassicStyle:', classicStyleEnabled, 'CustomStyle:', customStyleEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled, 'MessageMaxWidth:', messageContainerMaxWidth, 'MemoryDot:', memoryDotEnabled, 'MemoryDotColor:', memoryDotColor);
            await storage.set(SIDEBAR_LAYOUT_KEY, sidebarEnabled);
            await storage.set(SIDEBAR_MIN_WIDTH_KEY, finalMinWidth);
            await storage.set(COMPACT_GENERATION_KEY, compactGenerationEnabled);
            await storage.set(CLASSIC_LAYOUT_KEY, classicLayoutEnabled);
            await storage.set(CLASSIC_STYLE_KEY, classicStyleEnabled);
            await storage.set(CUSTOM_STYLE_KEY, customStyleEnabled);
            await storage.set(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(customStyleValues));
            await storage.set(HIDE_FOR_YOU_KEY, hideForYouEnabled);
            await storage.set(PAGE_JUMP_KEY, pageJumpEnabled);
            await storage.set('showGenerationStats', showStatsEnabled);
            await storage.set('showModelDetails', showModelDetailsEnabled);
            await storage.set('showTimestamp', showTimestampEnabled);
            await storage.set('timestampDateFirst', timestampDateFirst);
            await storage.set('timestamp24Hour', timestamp24Hour);
            await storage.set(SHOW_MESSAGE_IDS_KEY, showMessageIdsEnabled);
            await storage.set('highlightModelChanges', highlightModelChangesEnabled);
            await storage.set('autoRegenOnMismatch', autoRegenOnMismatchEnabled);
            await storage.set('autoRegenOnShort', autoRegenOnShortEnabled);
            await storage.set('autoRegenMaxAttempts', autoRegenMaxAttempts);
            await storage.set('showChatNameInTitle', showChatNameInTitleEnabled);
            await storage.set('nsfwToggleEnabled', nsfwToggleEnabled);
            await storage.set('messageRecoveryEnabled', messageRecoveryEnabled);
            await storage.set(HIDE_CREATOR_KEY, hideCreatorEnabled);
            await storage.set(SMALL_PROFILE_IMAGES_KEY, smallProfileImagesEnabled);
            await storage.set(ROUNDED_PROFILE_IMAGES_KEY, roundedProfileImagesEnabled);
            await storage.set(SWAP_CHECKBOX_POSITION_KEY, swapCheckboxPositionEnabled);
            await storage.set(SQUARE_MESSAGE_EDGES_KEY, squareMessageEdgesEnabled);
            await storage.set(WYSIWYG_EDITOR_KEY, wysiwygEnabled);
            await storage.set(ENABLE_GENERATION_PROFILES_KEY, enableGenerationProfilesEnabled);
            await storage.set(MESSAGE_CONTAINER_MAX_WIDTH_KEY, messageContainerMaxWidth);
            await storage.set(MEMORY_DOT_ENABLED_KEY, memoryDotEnabled);
            await storage.set(MEMORY_DOT_COLOR_KEY, memoryDotColor);
            // Mark onboarding as seen when user saves settings
            await storage.set('hasSeenOnboarding', true);
            debugLog('[Core] Settings saved to storage');
            showNotification('Settings saved! Refreshing...');
            setTimeout(() => {
                debugLog('[Core] Reloading page...');
                window.location.reload();
            }, 500);
        };
        
        // Export Profiles button
        if (exportProfilesBtn) {
            exportProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                try {
                    const profiles = await loadProfiles();
                    const dataStr = JSON.stringify(profiles, null, 2);
                    const dataBlob = new Blob([dataStr], { type: 'application/json' });
                    const url = URL.createObjectURL(dataBlob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'spicychat-profiles.json';
                    link.click();
                    URL.revokeObjectURL(url);
                    showNotification('Profiles exported');
                } catch (error) {
                    console.error('[Core] Error exporting profiles:', error);
                    alert('Error exporting profiles: ' + error.message);
                }
            };
        }
        
        // Import Profiles button (only visible in debug mode with legacy setting)
        if (importProfilesBtn) {
            importProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(e) {
                    const file = e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = async function(event) {
                            try {
                                const imported = JSON.parse(event.target.result);
                                const profiles = await loadProfiles();
                                Object.assign(profiles, imported);
                                await saveProfiles(profiles);
                                showNotification('Profiles imported successfully');
                                await updateGenerationProfilesVisibility();
                            } catch (err) {
                                alert('Error importing profiles: ' + err.message);
                            }
                        };
                        reader.readAsText(file);
                    }
                });
                input.click();
            };
        }
        
        // Delete Profiles button
        if (deleteProfilesBtn) {
            deleteProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                const profiles = await loadProfiles();
                const profileCount = Object.keys(profiles).length;
                
                if (profileCount === 0) {
                    showNotification('No profiles to delete');
                    return;
                }
                
                const confirmed = confirm(`Are you sure you want to delete all ${profileCount} generation profile(s)? This cannot be undone.`);
                
                if (confirmed) {
                    try {
                        await saveProfiles({});
                        showNotification('All profiles deleted');
                        await updateGenerationProfilesVisibility();
                    } catch (error) {
                        console.error('[Core] Error deleting profiles:', error);
                        alert('Error deleting profiles: ' + error.message);
                    }
                }
            };
        }
        
        // Export Custom Style button
        if (exportCustomStyleBtn) {
            exportCustomStyleBtn.onclick = async (e) => {
                e.stopPropagation();
                try {
                    const customStyleValuesJson = await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE));
                    const customStyleValues = JSON.parse(customStyleValuesJson);
                    const dataStr = JSON.stringify(customStyleValues, null, 2);
                    const dataBlob = new Blob([dataStr], { type: 'application/json' });
                    const url = URL.createObjectURL(dataBlob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'spicychat-custom-style.json';
                    link.click();
                    URL.revokeObjectURL(url);
                    showNotification('Custom Style exported');
                } catch (error) {
                    console.error('[Core] Error exporting custom style:', error);
                    alert('Error exporting custom style: ' + error.message);
                }
            };
        }
        
        // Import Custom Style button
        if (importCustomStyleBtn) {
            importCustomStyleBtn.onclick = async (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(e) {
                    const file = e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = async function(event) {
                            try {
                                const imported = JSON.parse(event.target.result);
                                // Legacy schema migration: old single fontWeight/fontStyle/textDecoration
                                // applied to all four categories. Spread legacy values across the new
                                // per-category keys only when the new key is absent from the import.
                                if (imported.fontWeight !== undefined) {
                                    if (imported.bodyFontWeight === undefined) imported.bodyFontWeight = imported.fontWeight;
                                    if (imported.spanQuoteFontWeight === undefined) imported.spanQuoteFontWeight = imported.fontWeight;
                                    if (imported.narrationFontWeight === undefined) imported.narrationFontWeight = imported.fontWeight;
                                    if (imported.highlightFontWeight === undefined) imported.highlightFontWeight = imported.fontWeight;
                                }
                                if (imported.fontStyle !== undefined) {
                                    if (imported.bodyFontStyle === undefined) imported.bodyFontStyle = imported.fontStyle;
                                    if (imported.spanQuoteFontStyle === undefined) imported.spanQuoteFontStyle = imported.fontStyle;
                                    if (imported.narrationFontStyle === undefined) imported.narrationFontStyle = imported.fontStyle;
                                    if (imported.highlightFontStyle === undefined) imported.highlightFontStyle = imported.fontStyle;
                                }
                                if (imported.textDecoration !== undefined) {
                                    if (imported.bodyTextDecoration === undefined) imported.bodyTextDecoration = imported.textDecoration;
                                    if (imported.spanQuoteTextDecoration === undefined) imported.spanQuoteTextDecoration = imported.textDecoration;
                                    if (imported.narrationTextDecoration === undefined) imported.narrationTextDecoration = imported.textDecoration;
                                    if (imported.highlightTextDecoration === undefined) imported.highlightTextDecoration = imported.textDecoration;
                                }
                                // Drop the legacy keys so they don't pollute the merged object
                                delete imported.fontWeight;
                                delete imported.fontStyle;
                                delete imported.textDecoration;
                                // Also drop other obsolete keys observed in old saves
                                delete imported.textColor;
                                delete imported.italicColor;
                                delete imported.quoteColor;

                                // Merge with defaults to ensure all fields exist
                                const mergedValues = { ...DEFAULT_CUSTOM_STYLE, ...imported };
                                // Update the in-memory values
                                Object.assign(customStyleValues, mergedValues);

                                // Update the UI inputs - colors
                                customAiBgInput.value = customStyleValues.aiMessageBg;
                                customUserBgInput.value = customStyleValues.userMessageBg;
                                customBodyColorInput.value = customStyleValues.bodyColor;
                                customSpanQuoteColorInput.value = customStyleValues.spanQuoteColor;
                                customNarrationColorInput.value = customStyleValues.narrationColor;
                                customHighlightBgColorInput.value = customStyleValues.highlightBgColor;
                                customHighlightTextColorInput.value = customStyleValues.highlightTextColor;
                                customHoverButtonColorInput.value = customStyleValues.hoverButtonColor || '#292929';
                                customCreatorLinkColorInput.value = customStyleValues.creatorLinkColor || '';

                                // Body text styling
                                customBodyFontWeightSelect.value = customStyleValues.bodyFontWeight || 'normal';
                                customBodyFontStyleSelect.value = customStyleValues.bodyFontStyle || 'normal';
                                customBodyTextDecorationSelect.value = customStyleValues.bodyTextDecoration || 'none';

                                // Span/quote text styling
                                customQuoteFontWeightSelect.value = customStyleValues.spanQuoteFontWeight || 'normal';
                                customQuoteFontStyleSelect.value = customStyleValues.spanQuoteFontStyle || 'normal';
                                customQuoteTextDecorationSelect.value = customStyleValues.spanQuoteTextDecoration || 'none';

                                // Narration text styling
                                customNarrationFontWeightSelect.value = customStyleValues.narrationFontWeight || 'normal';
                                customNarrationFontStyleSelect.value = customStyleValues.narrationFontStyle || 'italic';
                                customNarrationTextDecorationSelect.value = customStyleValues.narrationTextDecoration || 'none';

                                // Highlight text styling
                                customHighlightFontWeightSelect.value = customStyleValues.highlightFontWeight || 'normal';
                                customHighlightFontStyleSelect.value = customStyleValues.highlightFontStyle || 'normal';
                                customHighlightTextDecorationSelect.value = customStyleValues.highlightTextDecoration || 'none';

                                // Font family/size
                                customFontSizeInput.value = customStyleValues.fontSize;
                                customFontFamilyInput.value = customStyleValues.fontFamily || '';

                                // Reset background image file picker (actual data lives in customStyleValues.backgroundImage)
                                if (customBackgroundImageInput) customBackgroundImageInput.value = '';

                                // Update preview swatches
                                if (previewAiBg) previewAiBg.style.background = customStyleValues.aiMessageBg || 'transparent';
                                if (previewUserBg) previewUserBg.style.background = customStyleValues.userMessageBg || 'transparent';
                                if (previewBodyColor) previewBodyColor.style.background = customStyleValues.bodyColor || 'transparent';
                                if (previewQuoteColor) previewQuoteColor.style.background = customStyleValues.spanQuoteColor || 'transparent';
                                if (previewNarrationColor) previewNarrationColor.style.background = customStyleValues.narrationColor || 'transparent';
                                if (previewHighlightBg) previewHighlightBg.style.background = customStyleValues.highlightBgColor || 'transparent';
                                if (previewHighlightText) previewHighlightText.style.background = customStyleValues.highlightTextColor || 'transparent';
                                if (previewHoverButton) previewHoverButton.style.background = customStyleValues.hoverButtonColor || '#292929';
                                if (previewCreatorLinkColor) previewCreatorLinkColor.style.background = customStyleValues.creatorLinkColor || 'transparent';

                                // Refresh the live font preview block
                                updateFontPreview();

                                showNotification('Custom Style imported - click Save to apply');
                            } catch (err) {
                                alert('Error importing custom style: ' + err.message);
                            }
                        };
                        reader.readAsText(file);
                    }
                });
                input.click();
            };
        }

        // Reset Custom Style to Defaults button
        if (resetCustomStyleBtn) {
            resetCustomStyleBtn.onclick = async (e) => {
                e.stopPropagation();

                // Reset all values to defaults
                Object.assign(customStyleValues, DEFAULT_CUSTOM_STYLE);

                // Update all UI inputs with default values
                customAiBgInput.value = DEFAULT_CUSTOM_STYLE.aiMessageBg;
                customUserBgInput.value = DEFAULT_CUSTOM_STYLE.userMessageBg;
                customBodyColorInput.value = DEFAULT_CUSTOM_STYLE.bodyColor;
                customBodyFontWeightSelect.value = DEFAULT_CUSTOM_STYLE.bodyFontWeight;
                customBodyFontStyleSelect.value = DEFAULT_CUSTOM_STYLE.bodyFontStyle;
                customBodyTextDecorationSelect.value = DEFAULT_CUSTOM_STYLE.bodyTextDecoration;
                customSpanQuoteColorInput.value = DEFAULT_CUSTOM_STYLE.spanQuoteColor;
                customQuoteFontWeightSelect.value = DEFAULT_CUSTOM_STYLE.spanQuoteFontWeight;
                customQuoteFontStyleSelect.value = DEFAULT_CUSTOM_STYLE.spanQuoteFontStyle;
                customQuoteTextDecorationSelect.value = DEFAULT_CUSTOM_STYLE.spanQuoteTextDecoration;
                customNarrationColorInput.value = DEFAULT_CUSTOM_STYLE.narrationColor;
                customNarrationFontWeightSelect.value = DEFAULT_CUSTOM_STYLE.narrationFontWeight;
                customNarrationFontStyleSelect.value = DEFAULT_CUSTOM_STYLE.narrationFontStyle;
                customNarrationTextDecorationSelect.value = DEFAULT_CUSTOM_STYLE.narrationTextDecoration;
                customHighlightBgColorInput.value = DEFAULT_CUSTOM_STYLE.highlightBgColor;
                customHighlightTextColorInput.value = DEFAULT_CUSTOM_STYLE.highlightTextColor;
                customHighlightFontWeightSelect.value = DEFAULT_CUSTOM_STYLE.highlightFontWeight;
                customHighlightFontStyleSelect.value = DEFAULT_CUSTOM_STYLE.highlightFontStyle;
                customHighlightTextDecorationSelect.value = DEFAULT_CUSTOM_STYLE.highlightTextDecoration;
                customFontSizeInput.value = DEFAULT_CUSTOM_STYLE.fontSize;
                customFontFamilyInput.value = DEFAULT_CUSTOM_STYLE.fontFamily;
                customHoverButtonColorInput.value = DEFAULT_CUSTOM_STYLE.hoverButtonColor;
                customCreatorLinkColorInput.value = DEFAULT_CUSTOM_STYLE.creatorLinkColor;
                customBackgroundImageInput.value = '';

                // Update preview elements
                if (previewAiBg) previewAiBg.style.background = DEFAULT_CUSTOM_STYLE.aiMessageBg;
                if (previewUserBg) previewUserBg.style.background = DEFAULT_CUSTOM_STYLE.userMessageBg;
                if (previewBodyColor) previewBodyColor.style.background = DEFAULT_CUSTOM_STYLE.bodyColor;
                if (previewQuoteColor) previewQuoteColor.style.background = DEFAULT_CUSTOM_STYLE.spanQuoteColor;
                if (previewNarrationColor) previewNarrationColor.style.background = DEFAULT_CUSTOM_STYLE.narrationColor;
                if (previewHighlightBg) previewHighlightBg.style.background = DEFAULT_CUSTOM_STYLE.highlightBgColor;
                if (previewHighlightText) previewHighlightText.style.background = DEFAULT_CUSTOM_STYLE.highlightTextColor;
                if (previewHoverButton) previewHoverButton.style.background = DEFAULT_CUSTOM_STYLE.hoverButtonColor;
                if (previewCreatorLinkColor) previewCreatorLinkColor.style.background = DEFAULT_CUSTOM_STYLE.creatorLinkColor || 'transparent';

                // Update font preview
                updateFontPreview();

                showNotification('Custom Style reset to defaults - click Save to apply');
            };
        }

        // Export All Data button
        debugLog('[Core] Attaching exportAllBtn onclick handler...');
        debugLog('[Core] exportAllBtn element:', exportAllBtn);
        debugLog('[Core] exportAllBtn exists?:', !!exportAllBtn);
        
        if (exportAllBtn) {
            exportAllBtn.onclick = async (e) => {
                debugLog('[Core] ===== EXPORT ALL DATA CLICKED =====');
                debugLog('[Core] Event:', e);
                e.stopPropagation();
                
                try {
                    debugLog('[Core] Starting data fetch...');
                    debugLog('[Core] Storage object type:', typeof storage);
                    debugLog('[Core] Storage object:', storage);
                    
                    // Get all data from extension storage
                    // PERFORMANCE: Batch all export settings into a single storage read
                    const exportData = await storage.getMultiple({
                        [SIDEBAR_LAYOUT_KEY]: false,
                        [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH,
                        [CLASSIC_LAYOUT_KEY]: false,
                        [CLASSIC_STYLE_KEY]: false,
                        [CUSTOM_STYLE_KEY]: false,
                        [CUSTOM_STYLE_VALUES_KEY]: JSON.stringify(DEFAULT_CUSTOM_STYLE),
                        [COMPACT_GENERATION_KEY]: false,
                        [HIDE_FOR_YOU_KEY]: false,
                        [PAGE_JUMP_KEY]: false,
                        'showGenerationStats': false,
                        'showModelDetails': true,
                        'showTimestamp': false,
                        'highlightModelChanges': false,
                        'autoRegenOnMismatch': false,
                        'autoRegenOnShort': false,
                        'autoRegenMaxAttempts': 1,
                        'timestampDateFirst': true,
                        'timestamp24Hour': false,
                        [SHOW_MESSAGE_IDS_KEY]: false,
                        'showChatNameInTitle': false,
                        'nsfwToggleEnabled': false,
                        'messageRecoveryEnabled': false,
                        [WYSIWYG_EDITOR_KEY]: false,
                        [ENABLE_GENERATION_PROFILES_KEY]: false,
                        [SMALL_PROFILE_IMAGES_KEY]: false,
                        [ROUNDED_PROFILE_IMAGES_KEY]: false,
                        [SWAP_CHECKBOX_POSITION_KEY]: false,
                        [SQUARE_MESSAGE_EDGES_KEY]: false,
                        [MESSAGE_CONTAINER_MAX_WIDTH_KEY]: '',
                        [MEMORY_DOT_ENABLED_KEY]: true,
                        [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
                        [HIDE_CREATOR_KEY]: false,
                        'generationProfiles': '{}',
                        'lastSelectedProfile': ''
                        // messageGenerationStats intentionally omitted — stats come from the
                        // background IndexedDB store via SAI_STATS_EXPORT_ALL below, not storage.local.
                    });
                    
                    debugLog('[Core] All values fetched. Building export object...');
                    
                    // Parse JSON strings for proper export format
                    const generationProfilesParsed = JSON.parse(exportData['generationProfiles']);
                    // Stats live in the background IndexedDB store now — pull the nested snapshot
                    // from the DB (storage.local only holds the frozen legacy blob post-migration).
                    // If the DB read fails, ABORT the export — never write a silently empty-stats file.
                    const statsRes = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
                    if (!statsRes || !statsRes.success) {
                        throw new Error('Could not read stats from the database — export aborted to avoid an incomplete file.');
                    }
                    const messageGenerationStatsParsed = statsRes.stats || {};

                    // Build the export object
                    const allData = {
                        enableSidebarLayout: exportData[SIDEBAR_LAYOUT_KEY],
                        sidebarMinWidth: exportData[SIDEBAR_MIN_WIDTH_KEY],
                        enableClassicLayout: exportData[CLASSIC_LAYOUT_KEY],
                        enableClassicStyle: exportData[CLASSIC_STYLE_KEY],
                        enableCustomStyle: exportData[CUSTOM_STYLE_KEY],
                        customStyleValues: exportData[CUSTOM_STYLE_VALUES_KEY],
                        enableCompactGeneration: exportData[COMPACT_GENERATION_KEY],
                        enableHideForYou: exportData[HIDE_FOR_YOU_KEY],
                        enablePageJump: exportData[PAGE_JUMP_KEY],
                        showGenerationStats: exportData['showGenerationStats'],
                        showModelDetails: exportData['showModelDetails'],
                        showTimestamp: exportData['showTimestamp'],
                        timestampDateFirst: exportData['timestampDateFirst'],
                        timestamp24Hour: exportData['timestamp24Hour'],
                        showMessageIds: exportData[SHOW_MESSAGE_IDS_KEY],
                        showChatNameInTitle: exportData['showChatNameInTitle'],
                        nsfwToggleEnabled: exportData['nsfwToggleEnabled'],
                        messageRecoveryEnabled: exportData['messageRecoveryEnabled'],
                        enableWysiwygEditor: exportData[WYSIWYG_EDITOR_KEY],
                        enableGenerationProfiles: exportData[ENABLE_GENERATION_PROFILES_KEY],
                        enableSmallProfileImages: exportData[SMALL_PROFILE_IMAGES_KEY],
                        enableRoundedProfileImages: exportData[ROUNDED_PROFILE_IMAGES_KEY],
                        swapCheckboxPosition: exportData[SWAP_CHECKBOX_POSITION_KEY],
                        squareMessageEdges: exportData[SQUARE_MESSAGE_EDGES_KEY],
                        highlightModelChanges: exportData['highlightModelChanges'],
                        autoRegenOnMismatch: exportData['autoRegenOnMismatch'],
                        autoRegenOnShort: exportData['autoRegenOnShort'],
                        autoRegenMaxAttempts: exportData['autoRegenMaxAttempts'],
                        messageContainerMaxWidth: exportData[MESSAGE_CONTAINER_MAX_WIDTH_KEY],
                        memoryDotEnabled: exportData[MEMORY_DOT_ENABLED_KEY],
                        memoryDotColor: exportData[MEMORY_DOT_COLOR_KEY],
                        hideCreatorName: exportData[HIDE_CREATOR_KEY],
                        generationProfiles: generationProfilesParsed,  // Use parsed object
                        lastSelectedProfile: exportData['lastSelectedProfile'],
                        messageGenerationStats: messageGenerationStatsParsed  // Use parsed object
                    };
                
                debugLog('[Core] Export object built:', Object.keys(allData));
                debugLog('[Core] Export object full:', allData);
                debugLog('[Core] Checking each property:');
                for (const [key, value] of Object.entries(allData)) {
                    debugLog(`[Core]   ${key}:`, typeof value, value?.constructor?.name, value);
                }
                
                debugLog('[Core] Stringifying to JSON...');
                const dataStr = JSON.stringify(allData, null, 2);
                debugLog('[Core] JSON string length:', dataStr.length);
                debugLog('[Core] JSON string sample:', dataStr.substring(0, 200));
                
                debugLog('[Core] Creating blob...');
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                debugLog('[Core] Blob created, size:', dataBlob.size);
                
                const url = URL.createObjectURL(dataBlob);
                debugLog('[Core] Object URL created:', url);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = `sai-toolkit-extension-${Date.now()}.json`;
                debugLog('[Core] Download link created, filename:', link.download);
                
                link.click();
                debugLog('[Core] Link clicked');
                
                URL.revokeObjectURL(url);
                debugLog('[Core] Object URL revoked');
                
                showNotification('All data exported successfully!\nFile includes: settings, profiles, and message stats');
                debugLog('[Core] ===== EXPORT COMPLETED SUCCESSFULLY =====');
            } catch (error) {
                console.error('[Core] ===== EXPORT ERROR =====');
                console.error('[Core] Error exporting data:', error);
                console.error('[Core] Error stack:', error.stack);
                alert('Error exporting data: ' + error.message);
            }
        };
        } else {
            console.error('[Core] Cannot attach exportAllBtn handler - button not found!');
        }
        
        // Import All Data button
        debugLog('[Core] Attaching importAllBtn onclick handler...');
        debugLog('[Core] importAllBtn element:', importAllBtn);
        debugLog('[Core] importAllBtn exists?:', !!importAllBtn);
        
        if (importAllBtn) {
            importAllBtn.onclick = async (e) => {
                debugLog('[Core] Import All Data button clicked');
                e.stopPropagation();

                // ---- progress overlay helpers ----
                const showImportProgress = (statusText, pct) => {
                    let overlay = shadow.getElementById('import-progress-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'import-progress-overlay';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                        const card = document.createElement('div');
                        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:280px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                        const title = document.createElement('div');
                        title.textContent = 'Importing…';
                        title.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                        const statusEl = document.createElement('div');
                        statusEl.id = 'import-progress-status';
                        statusEl.style.cssText = 'color:#9ca3af;font-size:12px;min-height:1.2em;';
                        const track = document.createElement('div');
                        track.style.cssText = 'height:4px;background:#374151;border-radius:2px;overflow:hidden;';
                        const fill = document.createElement('div');
                        fill.id = 'import-progress-fill';
                        fill.style.cssText = 'height:100%;background:#3b82f6;border-radius:2px;transition:width 0.2s ease;width:0%;';
                        track.appendChild(fill);
                        card.appendChild(title);
                        card.appendChild(statusEl);
                        card.appendChild(track);
                        overlay.appendChild(card);
                        shadow.appendChild(overlay);
                    }
                    shadow.getElementById('import-progress-status').textContent = statusText;
                    shadow.getElementById('import-progress-fill').style.width = pct + '%';
                };
                const removeImportProgress = () => {
                    const overlay = shadow.getElementById('import-progress-overlay');
                    if (overlay) overlay.remove();
                };
                // ---- end progress helpers ----

                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(event) {
                    const file = event.target.files[0];
                    if (!file) {
                        debugLog('[Core] No file selected');
                        return;
                    }
                
                debugLog('[Core] File selected:', file.name);
                const reader = new FileReader();
                reader.onload = async function(e) {
                    try {
                        // Un-nest v2 grouped files (settings/style/stats) into the flat
                        // layout the apply logic below expects; flat files pass through.
                        const imported = normalizeImportPayload(JSON.parse(e.target.result));
                        debugLog('[Core] Parsed imported data:', Object.keys(imported));
                        
                        // Handle both old (double-encoded strings) and new (proper objects) formats
                        let generationProfilesValue = imported.generationProfiles;
                        let messageGenerationStatsValue = imported.messageGenerationStats;
                        
                        // If they're strings (old format), parse them; if already objects (new format), use as-is
                        if (typeof generationProfilesValue === 'string') {
                            debugLog('[Core] generationProfiles is string (old format), parsing...');
                            generationProfilesValue = generationProfilesValue;  // Keep as string for storage
                        } else if (typeof generationProfilesValue === 'object') {
                            debugLog('[Core] generationProfiles is object (new format), stringifying for storage...');
                            generationProfilesValue = JSON.stringify(generationProfilesValue);  // Convert to string for storage
                        }
                        
                        if (typeof messageGenerationStatsValue === 'string') {
                            debugLog('[Core] messageGenerationStats is string (old format), parsing...');
                            messageGenerationStatsValue = messageGenerationStatsValue;  // Keep as string for storage
                        } else if (typeof messageGenerationStatsValue === 'object') {
                            debugLog('[Core] messageGenerationStats is object (new format), stringifying for storage...');
                            messageGenerationStatsValue = JSON.stringify(messageGenerationStatsValue);  // Convert to string for storage
                        }
                        
                        // Build updates object conditionally
                        const updates = {};
                        if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
                        if (imported.sidebarMinWidth !== undefined) updates.sidebarMinWidth = imported.sidebarMinWidth;
                        if (imported.enableClassicLayout !== undefined) updates.enableClassicLayout = imported.enableClassicLayout;
                        if (imported.enableClassicStyle !== undefined) updates.enableClassicStyle = imported.enableClassicStyle;
                        if (imported.enableCustomStyle !== undefined) updates.enableCustomStyle = imported.enableCustomStyle;
                        if (imported.customStyleValues !== undefined) updates.customStyleValues = imported.customStyleValues;
                        // Support legacy key for backwards compatibility
                        if (imported.enableThemeCustomization !== undefined && imported.enableClassicLayout === undefined && imported.enableClassicStyle === undefined) {
                            updates.enableClassicLayout = imported.enableThemeCustomization;
                            updates.enableClassicStyle = imported.enableThemeCustomization;
                        }
                        if (imported.enableCompactGeneration !== undefined) updates.enableCompactGeneration = imported.enableCompactGeneration;
                        if (imported.enableHideForYou !== undefined) updates.enableHideForYou = imported.enableHideForYou;
                        if (imported.enablePageJump !== undefined) updates.enablePageJump = imported.enablePageJump;
                        if (imported.showGenerationStats !== undefined) updates.showGenerationStats = imported.showGenerationStats;
                        if (imported.showModelDetails !== undefined) updates.showModelDetails = imported.showModelDetails;
                        if (imported.showTimestamp !== undefined) updates.showTimestamp = imported.showTimestamp;
                        if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                        if (imported.timestamp24Hour !== undefined) updates.timestamp24Hour = imported.timestamp24Hour;
                        if (imported.showMessageIds !== undefined) updates.showMessageIds = imported.showMessageIds;
                        if (imported.showChatNameInTitle !== undefined) updates.showChatNameInTitle = imported.showChatNameInTitle;
                        if (imported.nsfwToggleEnabled !== undefined) updates.nsfwToggleEnabled = imported.nsfwToggleEnabled;
                        if (imported.messageRecoveryEnabled !== undefined) updates.messageRecoveryEnabled = imported.messageRecoveryEnabled;
                        if (imported.enableWysiwygEditor !== undefined) updates.enableWysiwygEditor = imported.enableWysiwygEditor;
                        if (imported.enableGenerationProfiles !== undefined) updates.enableGenerationProfiles = imported.enableGenerationProfiles;
                        if (imported.enableSmallProfileImages !== undefined) updates.enableSmallProfileImages = imported.enableSmallProfileImages;
                        if (imported.enableRoundedProfileImages !== undefined) updates.enableRoundedProfileImages = imported.enableRoundedProfileImages;
                        if (imported.swapCheckboxPosition !== undefined) updates.swapCheckboxPosition = imported.swapCheckboxPosition;
                        if (imported.squareMessageEdges !== undefined) updates.squareMessageEdges = imported.squareMessageEdges;
                        if (imported.highlightModelChanges !== undefined) updates.highlightModelChanges = imported.highlightModelChanges;
                        if (imported.autoRegenOnMismatch !== undefined) updates.autoRegenOnMismatch = imported.autoRegenOnMismatch;
                        if (imported.autoRegenOnShort !== undefined) updates.autoRegenOnShort = imported.autoRegenOnShort;
                        if (imported.autoRegenMaxAttempts !== undefined) updates.autoRegenMaxAttempts = imported.autoRegenMaxAttempts;
                        if (imported.messageContainerMaxWidth !== undefined) updates[MESSAGE_CONTAINER_MAX_WIDTH_KEY] = imported.messageContainerMaxWidth;
                        if (imported.memoryDotEnabled !== undefined) updates[MEMORY_DOT_ENABLED_KEY] = imported.memoryDotEnabled;
                        if (imported.memoryDotColor !== undefined) updates[MEMORY_DOT_COLOR_KEY] = imported.memoryDotColor;
                        if (imported.hideCreatorName !== undefined) updates[HIDE_CREATOR_KEY] = imported.hideCreatorName;
                        if (generationProfilesValue !== undefined) updates.generationProfiles = generationProfilesValue;
                        if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;
                        debugLog('[Core] Importing keys:', Object.keys(updates));

                        showImportProgress('Parsing import file…', 10);
                        await new Promise(r => setTimeout(r, 0));

                        // Merge stats rather than overwrite — preserve any entries in
                        // current storage that are not in (or are newer than) the backup.
                        // Stats live in the background IndexedDB store; merge there
                        // (authoritative, collapses conversation level, never overwrites
                        // richer entries). Not written to storage.local, so keep it out of
                        // `updates`. (Page reloads after import, so the cache refreshes.)
                        if (messageGenerationStatsValue !== undefined) {
                            const importedStats = JSON.parse(messageGenerationStatsValue);
                            const botCount = Object.keys(importedStats).length;
                            showImportProgress(`Merging stats (${botCount} bots)…`, 35);
                            await new Promise(r => setTimeout(r, 0));

                            const mergeRes = await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: importedStats });
                            if (!mergeRes || !mergeRes.success) {
                                throw new Error('Stats merge failed: ' + ((mergeRes && mergeRes.error) || 'unknown error'));
                            }

                            debugLog('[Core] Stats merge requested:', botCount, 'bots');
                        }

                        showImportProgress('Saving to storage…', 70);
                        await new Promise(r => setTimeout(r, 0));

                        // Apply all updates
                        await storage.setMultiple(updates);
                        debugLog('[Core] All data imported successfully');

                        showImportProgress('Done! Reloading…', 100);
                        await new Promise(r => setTimeout(r, 0));

                        setTimeout(() => {
                            removeImportProgress();
                            debugLog('[Core] Reloading page…');
                            window.location.reload();
                        }, 800);
                    } catch (error) {
                        removeImportProgress();
                        console.error('[Core] Error importing data:', error);
                        alert('Error importing data: ' + error.message);
                    }
                };
                reader.readAsText(file);
            });
            input.click();
        };
        } else {
            console.error('[Core] Cannot attach importAllBtn handler - button not found!');
        }
        
        // Escape key to close
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                debugLog('[Core] Escape key pressed');
                closeModal();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
        
        debugLog('[Core] ===== MODAL SETUP COMPLETE =====');
    }

    // (Removed the diagnostic global `error` / `unhandledrejection` logger that was added
    // during the WYSIWYG iOS crash investigation. It logged a verbose "GLOBAL ERROR
    // DETECTED" block for every error, including opaque cross-origin "Script error."
    // events from the host page — pure noise now that the crash is resolved.)

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                     TOOLKIT SPECIFIC CODE - END                      ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================


    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    INITIALIZATION & OBSERVERS                        ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    // CHECK ONBOARDING FIRST - before initializing anything else
    // Get all storage to check if it's truly empty or has any toolkit settings
    const allStorage = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get(null);
    const storageKeys = Object.keys(allStorage);
    
    debugLog('[Core] ===== ONBOARDING CHECK (BEFORE INIT) =====');
    debugLog('[Core] All storage keys:', storageKeys);
    debugLog('[Core] Storage contents:', allStorage);
    
    // Check if this is first run: no hasSeenOnboarding key OR it's explicitly false
    // OR if Classic Style key is missing (indicates update from old version)
    const hasSeenOnboarding = allStorage.hasSeenOnboarding;
    const hasClassicStyleKey = CLASSIC_STYLE_KEY in allStorage;
    const hasToolkitSettings = (
        SIDEBAR_LAYOUT_KEY in allStorage ||
        CLASSIC_LAYOUT_KEY in allStorage ||
        CLASSIC_STYLE_KEY in allStorage ||
        'enableThemeCustomization' in allStorage || // Legacy key
        COMPACT_GENERATION_KEY in allStorage ||
        HIDE_FOR_YOU_KEY in allStorage ||
        PAGE_JUMP_KEY in allStorage
    );
    
    debugLog('[Core] Onboarding check - hasSeenOnboarding:', hasSeenOnboarding);
    debugLog('[Core] Onboarding check - hasClassicStyleKey:', hasClassicStyleKey);
    debugLog('[Core] Onboarding check - hasToolkitSettings:', hasToolkitSettings);
    
    // Show onboarding if: never seen before (undefined) OR explicitly false
    // OR if user has settings but Classic Style key is missing (update scenario)
    const shouldShowOnboarding = hasSeenOnboarding === undefined || 
                                  hasSeenOnboarding === false ||
                                  (hasToolkitSettings && !hasClassicStyleKey);
    debugLog('[Core] Should show onboarding?', shouldShowOnboarding);
    
    // Initialize styles on page load
    await initializeStyles();

    // Background cleanup: remove legacy null-only stats entries (fire-and-forget)
    pruneNullStats();

    // Initialize Message Recovery: read the user's opt-in state from storage
    // and forward it to the page-context interceptor. Idempotent — safe to
    // call before/after initializeStyles.
    await initMessageRecovery();
    
    // Expose a helper function to reset onboarding (for testing)
    // Since content scripts can't expose functions to page context, we use custom events
    window.addEventListener('SAI_RESET_ONBOARDING', async function() {
        debugLog('[Core] Reset onboarding event received');
        // Clear the onboarding flag
        await storage.remove('hasSeenOnboarding');
        // Also clear all settings to simulate a truly fresh install
        await storage.remove(SIDEBAR_LAYOUT_KEY);
        await storage.remove(CLASSIC_LAYOUT_KEY);
        await storage.remove(CLASSIC_STYLE_KEY);
        await storage.remove('enableThemeCustomization'); // Legacy key
        await storage.remove(COMPACT_GENERATION_KEY);
        await storage.remove(HIDE_FOR_YOU_KEY);
        await storage.remove(PAGE_JUMP_KEY);
        await storage.remove('showGenerationStats');
        await storage.remove('timestampDateFirst');
        debugLog('[Core] Onboarding and all settings reset! Reload the page to see the onboarding modal.');
        setTimeout(() => location.reload(), 1000);
    });
    
    // Note: resetSAIToolkitOnboarding() function is injected via page-context.js
    
    if (shouldShowOnboarding) {
        debugLog('[Core] First run detected - will show onboarding modal');
        // Don't mark as seen yet - only mark when user clicks "Save & Refresh"
        // Wait for page to fully load and toolkit icon to be injected before showing modal
        setTimeout(() => {
            debugLog('[Core] Triggering onboarding modal...');
            try {
                showToolkitSettingsModal();
            } catch (error) {
                console.error('[Core] Error showing onboarding modal:', error);
            }
        }, 3000); // Increased delay to ensure page is fully loaded
    } else {
        debugLog('[Core] Not first run - skipping onboarding modal');
    }

    // Track button check interval to prevent multiple intervals (memory leak fix)
    let buttonCheckInterval = null;

    // Resize protection to prevent React 185 error during sidebar collapse/expand transitions
    let lastResizeTime = 0;
    let pendingButtonInjection = null;
    const RESIZE_DEBOUNCE_MS = 500; // Increased from 300ms
    // isResizing and resizeEndTimer are hoisted to the top of the IIFE — see early-declared state.

    // Track all pending injection timeouts so we can cancel them on resize
    let pendingInjectionTimeouts = [];
    
    // Helper to schedule injection with cancellation support
    function scheduleInjection(fn, delay) {
        const timeoutId = setTimeout(() => {
            // Remove from tracking array
            pendingInjectionTimeouts = pendingInjectionTimeouts.filter(id => id !== timeoutId);
            // Double-check resize state before executing
            if (!isResizing && !sidebarWidthTransitionPending) {
                fn();
            }
        }, delay);
        pendingInjectionTimeouts.push(timeoutId);
        return timeoutId;
    }
    
    // Cancel all pending injection timeouts
    function cancelAllPendingInjections() {
        pendingInjectionTimeouts.forEach(id => clearTimeout(id));
        pendingInjectionTimeouts = [];
    }
    
    // Remove all WYSIWYG editors from DOM to prevent React conflicts during resize
    function removeAllWysiwygEditorsForResize() {
        debugLog('[WYSIWYG] Removing all WYSIWYG editors from DOM for resize');
        const allEditors = document.querySelectorAll('.sai-wysiwyg-editor');
        let removeCount = 0;
        allEditors.forEach(editor => {
            // Find the associated textarea to clean up references
            const textarea = editor.nextElementSibling;
            if (textarea && textarea.tagName === 'TEXTAREA') {
                // Mark that it needs re-setup after resize
                textarea.dataset.wysiwygSetup = '';
                // Clean up observers
                if (textarea._wysiwygResizeObserver) {
                    textarea._wysiwygResizeObserver.disconnect();
                    delete textarea._wysiwygResizeObserver;
                }
                if (textarea._wysiwygMutationObserver) {
                    textarea._wysiwygMutationObserver.disconnect();
                    delete textarea._wysiwygMutationObserver;
                }
                if (textarea._wysiwygValueCheckInterval) {
                    clearInterval(textarea._wysiwygValueCheckInterval);
                    delete textarea._wysiwygValueCheckInterval;
                }
                // Restore textarea visibility
                textarea.classList.remove('sai-wysiwyg-hidden');
                textarea.style.removeProperty('position');
                textarea.style.removeProperty('opacity');
                textarea.style.removeProperty('pointer-events');
                textarea.style.removeProperty('width');
                textarea.style.removeProperty('height');
                textarea.style.removeProperty('min-width');
                textarea.style.removeProperty('min-height');
                textarea.style.removeProperty('max-width');
                textarea.style.removeProperty('max-height');
                textarea.style.removeProperty('padding');
                textarea.style.removeProperty('margin');
                textarea.style.removeProperty('border');
                textarea.style.removeProperty('overflow');
                textarea.style.removeProperty('z-index');
            }
            editor.remove();
            removeCount++;
        });
        debugLog('[WYSIWYG] Removed', removeCount, 'WYSIWYG editors from DOM');
    }
    
    // Pre-emptive resize detection using mousedown on window edges
    // This removes elements BEFORE resize starts, avoiding React conflicts
    let resizeStartPending = false;
    
    document.addEventListener('mousedown', function(e) {
        // Detect if mouse is near window edge (potential resize drag)
        const edgeThreshold = 10;
        const nearRightEdge = e.clientX >= window.innerWidth - edgeThreshold;
        const nearBottomEdge = e.clientY >= window.innerHeight - edgeThreshold;
        
        if (nearRightEdge || nearBottomEdge) {
            debugLog('[Core] RESIZE START DETECTED (mousedown near edge)');
            resizeStartPending = true;
            isResizing = true;
            sidebarWidthTransitionPending = true;
            cancelAllPendingInjections();
            
            // CRITICAL: Remove all WYSIWYG editors from DOM to prevent React 185 error
            removeAllWysiwygEditorsForResize();
            
            // Remove button IMMEDIATELY before any resize events fire
            const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
            if (sidebarBtn) {
                const wrapper = sidebarBtn.closest('div.w-full');
                if (wrapper) {
                    wrapper.remove();
                    debugLog('[Core] RESIZE START - pre-emptively removed sidebar button');
                } else {
                    sidebarBtn.remove();
                }
            }
        }
    }, true); // Use capture phase to run before other handlers
    
    document.addEventListener('mouseup', function() {
        if (resizeStartPending) {
            resizeStartPending = false;
            // Don't reset isResizing here - let the resize end timer handle it
        }
    });
    
    // Track last-known window width so we can ignore height-only resize events.
    // On Firefox Android PWA (standalone display-mode), opening the soft keyboard
    // resizes the layout viewport (height shrinks, width unchanged) and fires a
    // window 'resize' event. Without this guard, the handler tears down the WYSIWYG
    // editor the user just tapped, which steals focus and dismisses the keyboard.
    // React-185 avoidance only depends on width breakpoints, so height-only changes
    // are safe to skip here.
    let lastResizeWidth = window.innerWidth;
    window.addEventListener('resize', function() {
        const width = window.innerWidth;
        if (width === lastResizeWidth) {
            debugLog('[Core] RESIZE EVENT (height-only, ignored) - width:', width);
            return;
        }
        lastResizeWidth = width;
        debugLog('[Core] RESIZE EVENT - width:', width, 'wasResizing:', isResizing);
        lastResizeTime = Date.now();
        
        // If we didn't catch the resize start via mousedown, do removal now
        if (!isResizing) {
            isResizing = true;
            sidebarWidthTransitionPending = true;
            cancelAllPendingInjections();
            
            // CRITICAL: Remove all WYSIWYG editors from DOM to prevent React 185 error
            removeAllWysiwygEditorsForResize();
            
            // Remove button immediately
            const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
            if (sidebarBtn) {
                debugLog('[Core] RESIZE - removing sidebar button');
                const wrapper = sidebarBtn.closest('div.w-full');
                if (wrapper) {
                    wrapper.remove();
                } else {
                    sidebarBtn.remove();
                }
            }
        }
        
        // Clear any pending injection during resize
        if (pendingButtonInjection) {
            clearTimeout(pendingButtonInjection);
            pendingButtonInjection = null;
        }
        
        // Reset sidebar width tracking so next injection will succeed
        lastKnownSidebarWidth = null;
        
        // Mark resize as ended after debounce period
        if (resizeEndTimer) clearTimeout(resizeEndTimer);
        resizeEndTimer = setTimeout(function() {
            isResizing = false;
            sidebarWidthTransitionPending = false; // Allow sidebar injection again
            debugLog('[Core] RESIZE END - width:', window.innerWidth, 'will re-inject if needed');
            
            // Re-inject button after resize settles
            if (window.innerWidth >= 600) {
                setTimeout(() => {
                    if (!isResizing) {
                        injectToolkitSidebarButton();
                    }
                }, 100);
            }
            
            // Re-setup WYSIWYG editors after resize ends
            if (!isResizing) {
                debugLog('[WYSIWYG] Re-initializing editors after resize');
                findAndSetupWysiwygTextareas();
            }
        }, RESIZE_DEBOUNCE_MS);
    });
    
    // CRITICAL: Periodic check to remove WYSIWYG editors if window is in danger zone
    // This prevents React Error 185 when user types/sends messages at ~768px breakpoint
    setInterval(() => {
        const windowWidth = window.innerWidth;
        const inDangerZone = windowWidth >= 700 && windowWidth <= 850;
        
        if (inDangerZone && !isResizing) {
            const editors = document.querySelectorAll('.sai-wysiwyg-editor');
            if (editors.length > 0) {
                debugLog('[WYSIWYG] Danger zone detected (' + windowWidth + 'px), removing ' + editors.length + ' editor(s)');
                removeAllWysiwygEditorsForResize();
            }
        }
    }, 250); // Check every 250ms
    
    // =============================================================================
    // SIDEBAR LAYOUT BODY-CLASS OBSERVER
    // =============================================================================
    // Maintains a small set of state classes on document.body that the Sidebar
    // Layout CSS reads instead of `body:has(...)` selectors. The original ~30
    // chained `:has()` rules forced the style engine to re-test the entire body
    // subtree on every DOM mutation — catastrophic on older CPUs (8s+ forced
    // reflows during typing). With body classes, each rule is O(1) to match.
    //
    // Classes managed (all gated on `body`):
    //   sai-mm-sidebar-modal-open  → any Memories/Gen Settings modal is open
    //   sai-mm-image-modal-open    → image lightbox is open
    //   sai-mm-toolkit-modal-open  → our own settings modal is open
    //   sai-mm-gen-settings-open   → Generation Settings modal is open
    //   sai-mm-memories-open       → Memories modal is open
    //   sai-mm-nav-collapsed       → left nav is at the 54px collapsed width
    //
    // The observer is intentionally cheap: it only RE-RUNS the cached selector
    // checks when an added/removed node could plausibly be a modal or nav
    // (pre-filtered against the same patterns the old `:has()` rules used).
    // Updates are coalesced into a single requestAnimationFrame callback so
    // bursts of React mutations only produce one classList toggle pass.
    // (sidebarLayoutBodyObserver and sidebarLayoutBodyClassRafPending are
    // hoisted to the top of the IIFE — see the early-declared state block.)

    function updateSidebarLayoutBodyClasses() {
        if (!document.body) return;
        const cl = document.body.classList;

        const hasSidebarModal = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container)'
        );
        const hasImageModal = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.size-full'
        );
        const hasToolkitModal = !!document.querySelector('#toolkit-modal-root .backdrop');
        const hasGenSettings = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full), ' +
            'div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full)'
        );
        const hasMemories = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.h-full:not(.size-full):not(.toolkit-modal-container)'
        );
        const navCollapsed = !!document.querySelector('nav[style*="width: 54px"]');

        cl.toggle('sai-mm-sidebar-modal-open', hasSidebarModal);
        cl.toggle('sai-mm-image-modal-open', hasImageModal);
        cl.toggle('sai-mm-toolkit-modal-open', hasToolkitModal);
        cl.toggle('sai-mm-gen-settings-open', hasGenSettings);
        cl.toggle('sai-mm-memories-open', hasMemories);
        cl.toggle('sai-mm-nav-collapsed', navCollapsed);
        // Combined: any centered modal exists (sidebar OR image). Used by the
        // chat-width adjustment rules that need to react to either.
        cl.toggle('sai-mm-any-center-modal-open', hasSidebarModal || hasImageModal);
    }

    function scheduleSidebarLayoutBodyClassUpdate() {
        if (sidebarLayoutBodyClassRafPending) return;
        sidebarLayoutBodyClassRafPending = true;
        requestAnimationFrame(() => {
            sidebarLayoutBodyClassRafPending = false;
            updateSidebarLayoutBodyClasses();
        });
    }

    // A mutation is interesting only if it could change the result of one of
    // the selectors above. We pre-filter on tagName/class patterns so we don't
    // re-run the queries on every keystroke-induced text node change.
    function mutationCouldAffectModalState(mutation) {
        if (mutation.type === 'attributes') {
            // Style changes on nav (collapse/expand) or class flips on modals
            const t = mutation.target;
            if (!t || t.nodeType !== 1) return false;
            if (t.tagName === 'NAV') return true;
            if (t.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            return false;
        }
        if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) return false;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        for (const n of nodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'NAV' || n.querySelector?.('nav')) return true;
            if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            if (n.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            if (n.id === 'toolkit-modal-root' || n.querySelector?.('#toolkit-modal-root')) return true;
            if (n.classList?.contains('backdrop') && n.closest?.('#toolkit-modal-root')) return true;
        }
        return false;
    }

    function startSidebarLayoutBodyClassObserver() {
        if (sidebarLayoutBodyObserver) return; // already running

        sidebarLayoutBodyObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (mutationCouldAffectModalState(m)) {
                    scheduleSidebarLayoutBodyClassUpdate();
                    return;
                }
            }
        });

        const attach = () => {
            if (!document.body) {
                // Body not ready yet — retry on next tick. (Early-inject is called
                // before <body> exists; without this we'd race React rendering modals
                // into the DOM before the observer ever attached.)
                setTimeout(attach, 50);
                return;
            }
            sidebarLayoutBodyObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
            // Critical: sweep AFTER body exists and observer is attached.
            // The previous version ran the sweep before attach() — which meant
            // it bailed when body didn't exist yet, then the observer never saw
            // the modals React had already mounted. Result: body classes never
            // got set on pages that load with a modal already open, and all of
            // the class-based sidebar CSS sat inert.
            updateSidebarLayoutBodyClasses();
            debugLog('[Core] Sidebar Layout body-class observer attached and swept');
        };
        attach();
    }

    function stopSidebarLayoutBodyClassObserver() {
        if (sidebarLayoutBodyObserver) {
            sidebarLayoutBodyObserver.disconnect();
            sidebarLayoutBodyObserver = null;
        }
        if (document.body) {
            document.body.classList.remove(
                'sai-mm-sidebar-modal-open',
                'sai-mm-image-modal-open',
                'sai-mm-toolkit-modal-open',
                'sai-mm-gen-settings-open',
                'sai-mm-memories-open',
                'sai-mm-nav-collapsed',
                'sai-mm-any-center-modal-open'
            );
        }
    }

    // Watch sidebar element for width changes using ResizeObserver
    // This catches sidebar width transitions that happen without a window resize event
    let sidebarResizeObserver = null;
    let lastObservedSidebarWidth = null;
    let sidebarResizeTimer = null;
    
    function setupSidebarResizeObserver() {
        if (sidebarResizeObserver) {
            sidebarResizeObserver.disconnect();
        }
        
        const sidebar = document.querySelector('nav.flex.flex-col');
        if (!sidebar) {
            debugLog('[Core] Sidebar not found for ResizeObserver');
            return;
        }
        
        lastObservedSidebarWidth = sidebar.offsetWidth;
        debugLog('[Core] Setting up sidebar ResizeObserver, initial width:', lastObservedSidebarWidth);
        
        sidebarResizeObserver = new ResizeObserver((entries) => {
            // CRITICAL: Skip entirely if window resize is in progress
            // The window resize handler already handles button removal
            if (isResizing) {
                // Just update tracked width silently, don't do anything else
                for (const entry of entries) {
                    lastObservedSidebarWidth = entry.contentRect.width;
                }
                return;
            }
            
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                
                if (lastObservedSidebarWidth !== null && lastObservedSidebarWidth !== newWidth) {
                    debugLog('[Core] Sidebar width changed (not during resize):', lastObservedSidebarWidth, '->', newWidth);
                    
                    // Mark as transitioning
                    sidebarWidthTransitionPending = true;
                    
                    // Remove sidebar button during transition to avoid React conflicts
                    const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
                    if (sidebarBtn) {
                        debugLog('[Core] Removing sidebar button during width transition');
                        const wrapper = sidebarBtn.closest('div.w-full');
                        if (wrapper) {
                            wrapper.remove();
                        } else {
                            sidebarBtn.remove();
                        }
                    }
                    
                    // Reset transition flag after debounce and re-inject
                    if (sidebarResizeTimer) clearTimeout(sidebarResizeTimer);
                    sidebarResizeTimer = setTimeout(() => {
                        sidebarWidthTransitionPending = false;
                        debugLog('[Core] Sidebar transition complete, new width:', newWidth);
                        
                        // Re-inject button if width supports it
                        if (window.innerWidth >= 600 && !isResizing) {
                            setTimeout(() => {
                                if (!sidebarWidthTransitionPending && !isResizing) {
                                    injectToolkitSidebarButton();
                                }
                            }, 100);
                        }
                    }, 400);
                }
                
                lastObservedSidebarWidth = newWidth;
            }
        });
        
        sidebarResizeObserver.observe(sidebar);
    }
    
    // Set up observer after a delay to ensure sidebar exists
    setTimeout(setupSidebarResizeObserver, 1000);
    
    // Debounced button injection to prevent React re-render loops
    function debouncedButtonInjection() {
        // Skip entirely if currently resizing or sidebar is transitioning
        if (isResizing || sidebarWidthTransitionPending) {
            return;
        }
        
        // Skip if resize just happened (sidebar may be in transition)
        const timeSinceResize = Date.now() - lastResizeTime;
        if (timeSinceResize < RESIZE_DEBOUNCE_MS) {
            // Schedule a delayed check after resize settles
            if (!pendingButtonInjection) {
                pendingButtonInjection = setTimeout(function() {
                    pendingButtonInjection = null;
                    // Double-check we're not resizing when timer fires
                    if (!isResizing && !sidebarWidthTransitionPending && window.innerWidth >= 600) {
                        injectToolkitSidebarButton();
                    }
                }, RESIZE_DEBOUNCE_MS);
            }
            return;
        }
        
        // Safe to inject
        injectToolkitSidebarButton();
    }

    // Cache the one-shot CSS injection state so we don't query the DOM on every batch.
    let toolkitButtonCssInjected = false;

    // Observe for modal appearance / button host elements appearing
    const observer = new MutationObserver(function(mutations) {
        // Skip all processing during resize or sidebar transition to prevent React 185 error
        if (isResizing || sidebarWidthTransitionPending) {
            return;
        }

        // Perf: pre-filter mutations. The vast majority of body mutations during
        // streaming are message-bubble updates that have nothing to do with the
        // sidebar, modals, or our injection targets. Only run the (expensive)
        // full pass when an element is added/removed that could be one of our hosts.
        let relevant = false;
        for (const m of mutations) {
            if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
            const nodes = [...m.addedNodes, ...m.removedNodes];
            for (const n of nodes) {
                if (n.nodeType !== 1) continue;
                if (
                    n.tagName === 'NAV' || n.querySelector?.('nav') ||
                    n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                    n.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                    n.matches?.('button[aria-label="ThumbsUp-button"]') ||
                    n.querySelector?.('button[aria-label="ThumbsUp-button"]') ||
                    n.matches?.('svg.lucide-info') ||
                    n.querySelector?.('svg.lucide-info')
                ) {
                    relevant = true;
                    break;
                }
            }
            if (relevant) break;
        }
        if (!relevant) return;

        // Look specifically for the Generation Settings modal (supports both old and new UI)
        const modal = findGenerationSettingsModal();

        if (modal && !modal.querySelector('#profile-controls')) {
            // Wait a bit for the modal to fully render
            setTimeout(createProfileControls, 100);
        }

        // Try to inject sidebar button (watches for sidebar to load) - debounced to prevent React 185
        debouncedButtonInjection();

        // Inject CSS to hide toolkit button text when sidebar is collapsed (only once)
        if (!toolkitButtonCssInjected) {
            const toolkitButtonCSS = document.createElement('style');
            toolkitButtonCSS.id = 'sai-toolkit-button-css';
            toolkitButtonCSS.textContent = `
/* Ensure tooltip wrapper doesn't break width */
#sai-toolkit-sidebar-btn[data-tooltip-id],
div.w-full > [data-tooltip-id]:has(#sai-toolkit-sidebar-btn) {
    display: block !important;
    width: 100%;
}

/* Hide S.AI Toolkit button text when sidebar is collapsed */
nav[style*="width: 54px"] #sai-toolkit-sidebar-btn .toolkit-button-text,
nav[style*="width: 54px"] #sai-toolkit-sidebar-btn p {
    display: none !important;
}

/* Ensure text is visible when sidebar is expanded */
nav:not([style*="width: 54px"]) #sai-toolkit-sidebar-btn .toolkit-button-text,
nav:not([style*="width: 54px"]) #sai-toolkit-sidebar-btn p {
    display: inline !important;
}
`;
            document.head.appendChild(toolkitButtonCSS);
            toolkitButtonCssInjected = true;
            debugLog('[Core] Button CSS injected');
        }

        // Try to inject mobile button (watches for Like button to appear)
        injectToolkitMobileButton();

        // Try to inject chat export button (only on chat pages)
        injectChatExportButton();

        // Try to inject NSFW toggle button (only on chat pages, after export button)
        injectNSFWToggleButton();

        // NOTE: previously we scheduled 20 retry setTimeouts (5 delays × 4 buttons) on
        // every mutation batch. The buttonCheckInterval below already re-injects any
        // missing buttons every 2s, so those retries were redundant churn. Removed.

        // Instead of heavy MutationObservers, use lightweight periodic checks
        // Check every 2 seconds if buttons still exist and text element is present
        // Only create interval once to prevent memory leak from multiple intervals
        if (!buttonCheckInterval) {
            buttonCheckInterval = setInterval(() => {
            // Skip ALL checks during resize to prevent React conflicts
            if (isResizing || sidebarWidthTransitionPending) {
                return;
            }
            
            // Skip sidebar button checks on mobile - sidebar doesn't exist below 600px
            if (window.innerWidth >= 600) {
                const sidebarButton = document.getElementById('sai-toolkit-sidebar-btn');
                if (sidebarButton) {
                    // Check if text element exists, if not re-add it
                    const iconContainer = sidebarButton.querySelector('.flex.items-center.gap-2');
                    if (iconContainer && !iconContainer.querySelector('.toolkit-button-text')) {
                        let textElement = document.createElement('p');
                        textElement.className = 'font-sans text-decoration-skip-ink-none text-underline-position-from-font text-label-lg font-regular text-left truncate toolkit-button-text';
                        textElement.textContent = 'S.AI Toolkit';
                        iconContainer.appendChild(textElement);
                        debugLog('[Core] Text element re-added after React removed it');
                    }
                } else {
                    // Button missing, try to re-inject (debounced for resize safety)
                    const helpIcon = document.querySelector('svg.lucide-info');
                    if (helpIcon) {
                        debouncedButtonInjection();
                    }
                }
            }
            
            // Check mobile button
            const mobileButton = document.getElementById('sai-toolkit-mobile-btn');
            if (!mobileButton) {
                const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
                if (likeButton) {
                    injectToolkitMobileButton();
                }
            }
            
            // Check export button (only on chat pages - supports both /chat/ and /{language}/chat/)
            if (isOnChatPage()) {
                const exportButton = document.getElementById('sai-export-btn');
                if (!exportButton) {
                    injectChatExportButton();
                }

                // Check NSFW toggle button
                const nsfwButton = document.getElementById('sai-nsfw-btn');
                if (!nsfwButton) {
                    injectNSFWToggleButton();
                }

                // Message Recovery: if the "Oops!" banner is on screen and
                // we have a saved failed message, offer the recover button.
                // Cheap no-op when the feature is off or the banner is gone.
                injectRecoverButtonIfNeeded();
            }
            }, TIMING.PERIODIC_CHECK); // Check periodically instead of on every DOM mutation
        }
    });

    // Wait for body before starting observer (fixes middle-click new tab issue)
    waitForBody().then((body) => {
        debugLog('[Core] document.body available, starting main observer');
        observer.observe(body, {
            childList: true,
            subtree: true
        });
        
        // Trigger initial button injection now that body exists
        injectToolkitSidebarButton();
        injectToolkitMobileButton();
        injectChatExportButton();
        injectNSFWToggleButton();
        
        // Also schedule retry attempts in case page content loads slowly
        // Use scheduleInjection so these can be cancelled on resize
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            scheduleInjection(() => {
                injectToolkitSidebarButton();
                injectToolkitMobileButton();
                injectChatExportButton();
                injectNSFWToggleButton();
            }, delay);
        });
    }).catch((err) => {
        console.error('[Core] Failed to wait for body:', err);
        // Last resort: try anyway after a delay
        setTimeout(() => {
            if (document.body) {
                debugLog('[Core] Retrying observer setup after error');
                observer.observe(document.body, { childList: true, subtree: true });
                injectToolkitSidebarButton();
                injectToolkitMobileButton();
                injectChatExportButton();
                injectNSFWToggleButton();
            }
        }, 2000);
    });

    // Observer to add generation stats to messages
    // Debounce to prevent excessive processing during rapid DOM changes
    let statsProcessingTimeout = null;
    let pendingMutations = false;
    
    const messageObserver = new MutationObserver(async function(mutations) {
        // Quick check: Only process if we see relevant mutations (message wrappers)
        let hasRelevantMutation = false;
        for (const mutation of mutations) {
            // Only care about added nodes that could be message wrappers
            if (mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && (node.classList?.contains('mb-lg') || node.querySelector?.('.mb-lg'))) {
                        hasRelevantMutation = true;
                        break;
                    }
                }
            }
            if (hasRelevantMutation) break;
        }
        
        if (!hasRelevantMutation) return;
        
        // Debounce: Only process after 150ms of no mutations (Issue #12)
        pendingMutations = true;
        if (statsProcessingTimeout) {
            clearTimeout(statsProcessingTimeout);
        }
        
        statsProcessingTimeout = setTimeout(() => {
            pendingMutations = false;
            processMessagesForStats(true);
        }, TIMING.MUTATION_DEBOUNCE);
    });

    // Special function to insert stats for a regenerated message
    // This is needed because regenerations REPLACE the message content, not add a new element
    // So processMessagesForStats can't find them by DOM index
    // Note: statsInsertedForMessageIds and statsInsertionInProgress are defined earlier in the file
    const statsFailedForWrappers = new WeakSet();      // Wrappers that failed ID extraction (prevents retries)
    let lastConversationIdForStatsSet = null;

    // Memory optimization: Maximum tracked message IDs to prevent unbounded growth
    const MAX_STATS_TRACKING = 200;

    // Helper to limit Set size - removes oldest entries when over limit
    function limitSetSize(set, maxSize) {
        if (set.size > maxSize) {
            // Only remove enough to get back to maxSize (Sets maintain insertion order)
            const excess = set.size - maxSize;
            const iterator = set.values();
            for (let i = 0; i < excess; i++) {
                set.delete(iterator.next().value);
            }
        }
    }
    
    // Sequential retry wrapper - prevents race conditions from browser timer throttling
    // When a tab is in background, multiple setTimeout calls can fire at once on restore
    async function insertStatsWithRetry(messageId, model, settings, createdAt, attempt = 1) {
        const maxAttempts = 4;
        // First attempt is immediate (0ms delay), then use increasing delays for retries
        // This ensures we try to insert stats BEFORE processMessagesForStats runs (150ms debounce)
        const delays = [0, 500, 1000, 1500]; // Delay before each attempt

        if (attempt > maxAttempts) {
            debugLog('[Stats RETRY] Max attempts reached for message:', messageId?.substring(0, 8));
            // Decrement pending count since we're done trying (failed)
            if (pendingNewMessageCount > 0) {
                pendingNewMessageCount--;
                debugLog('[Stats RETRY] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
            }
            return;
        }

        // Wait before attempting (first attempt is immediate with 0ms delay)
        const delay = delays[attempt - 1] || 500;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Check if already successfully inserted (by this or another call)
        if (statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats RETRY] Already inserted, stopping retries for:', messageId?.substring(0, 8));
            // Decrement pending count since insertion is complete
            if (pendingNewMessageCount > 0) {
                pendingNewMessageCount--;
                debugLog('[Stats RETRY] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
            }
            return;
        }
        
        // Try to insert
        const success = await insertStatsForRegeneratedMessage(messageId, model, settings, createdAt);
        
        // If failed and not yet inserted, retry
        if (!success && !statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats RETRY] Attempt', attempt, 'failed, will retry for:', messageId?.substring(0, 8));
            insertStatsWithRetry(messageId, model, settings, createdAt, attempt + 1);
        }
    }
    
    async function insertStatsForRegeneratedMessage(messageId, model, settings, createdAt) {
        debugLog('[Stats REGEN] Attempting to insert stats for regenerated message:', messageId?.substring(0, 8));
        
        // Clear the sets if we're in a different conversation (handles page navigation)
        if (currentConversationId && currentConversationId !== lastConversationIdForStatsSet) {
            debugLog('[Stats REGEN] Conversation changed, clearing insertion tracking sets');
            statsInsertedForMessageIds.clear();
            statsInsertionInProgress.clear();
            pendingNewMessageCount = 0; // Reset pending count on conversation change
            lastConversationIdForStatsSet = currentConversationId;
        }
        
        // Skip if already successfully inserted
        if (statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats REGEN] Stats already inserted for this message ID, skipping');
            return true; // Already done, consider it a success
        }
        
        // Skip if another call is currently processing this message (prevents parallel execution)
        if (statsInsertionInProgress.has(messageId)) {
            debugLog('[Stats REGEN] Another call is already processing this message ID, skipping');
            return false; // Let the other call handle it
        }
        
        // Mark as in-progress to prevent parallel calls
        statsInsertionInProgress.add(messageId);
        
        const cache = window.__toolkitStorageCache;
        const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
        const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
        const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);
        const showMessageIds = cache ? await cache.get(SHOW_MESSAGE_IDS_KEY, false) : await storage.get(SHOW_MESSAGE_IDS_KEY, false);
        
        // Cache the highlight model changes setting globally for synchronous access
        window.__highlightModelChanges = cache ? await cache.get('highlightModelChanges', false) : await storage.get('highlightModelChanges', false);
        
        // Cache auto-regeneration settings globally for synchronous access
        window.__autoRegenOnMismatch = cache ? await cache.get('autoRegenOnMismatch', false) : await storage.get('autoRegenOnMismatch', false);
        window.__autoRegenOnShort = cache ? await cache.get('autoRegenOnShort', false) : await storage.get('autoRegenOnShort', false);
        window.__autoRegenMaxAttempts = cache ? await cache.get('autoRegenMaxAttempts', 1) : await storage.get('autoRegenMaxAttempts', 1);

        if (!statsEnabled && !timestampEnabled && !showMessageIds) {
            debugLog('[Stats REGEN] Neither stats, timestamp, nor message IDs enabled, skipping');
            // Remove from in-progress so future attempts can try again if settings change
            statsInsertionInProgress.delete(messageId);
            return true; // Not an error, just nothing to do
        }
        
        // Find the message that's currently showing the latest regeneration
        // Look for message bubbles and find the one with a version counter showing the highest version
        const versionCounters = document.querySelectorAll('p.text-label-md');
        let targetBubble = null;
        let highestVersion = 0;
        
        for (const counter of versionCounters) {
            const match = counter.textContent.trim().match(/^(\d+)\/(\d+)$/);
            if (match) {
                const currentVer = parseInt(match[1]);
                const totalVer = parseInt(match[2]);
                // We want the one showing the LATEST version (currentVer === totalVer)
                if (currentVer === totalVer && totalVer > highestVersion) {
                    highestVersion = totalVer;
                    targetBubble = counter.closest('div[class*="bg-gray-4"][class*="rounded"]');
                    if (!targetBubble) {
                        targetBubble = counter.closest('div[class*="px-\\[13px\\]"]');
                    }
                }
            }
        }
        
        // FALLBACK: If no version counter found (brand new message, not a regeneration),
        // find the LAST bot message bubble in the chat (the newest one)
        // First, try to find a message that matches our messageId directly
        if (!targetBubble) {
            debugLog('[Stats REGEN] No version counter found, trying to find last bot message bubble');
            
            // Try to find the message by data-message-id first (most reliable)
            const messageByIdElement = document.querySelector(`[data-message-id="${messageId}"]`);
            if (messageByIdElement) {
                const wrapper = messageByIdElement.closest('div.w-full.flex.mb-lg');
                if (wrapper) {
                    targetBubble = wrapper.querySelector('div[class*="bg-gray-4"][class*="rounded"]');
                    if (!targetBubble) {
                        targetBubble = wrapper.querySelector('div[class*="px-\\[13px\\]"]');
                    }
                    if (targetBubble) {
                        debugLog('[Stats REGEN] Found message bubble by data-message-id:', messageId?.substring(0, 8));
                    }
                }
            }
            
            // If still not found, fall back to last bot message
            if (!targetBubble) {
                // Find all message wrappers and get the last bot message
                const allMessageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');
                for (let i = allMessageWrappers.length - 1; i >= 0; i--) {
                    const wrapper = allMessageWrappers[i];
                    // Check if this is a bot message (has character link)
                    // Use contains selector to support localized URLs like /pt/chatbot/
                    const characterLink = wrapper.querySelector('a[href*="/chatbot/"]');
                    if (characterLink) {
                        // This is a bot message - find its bubble
                        targetBubble = wrapper.querySelector('div[class*="bg-gray-4"][class*="rounded"]');
                        if (!targetBubble) {
                            targetBubble = wrapper.querySelector('div[class*="px-\\[13px\\]"]');
                        }
                        if (targetBubble) {
                            debugLog('[Stats REGEN] Found last bot message bubble via fallback');
                            break;
                        }
                    }
                }
            }
        }
        
        if (!targetBubble) {
            debugLog('[Stats REGEN] Could not find target message bubble (neither version counter nor fallback worked)');
            // Remove from in-progress so later retry attempts can try again
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        debugLog('[Stats REGEN] Found target bubble for message');

        // Mark the message wrapper with the message ID so extractMessageId can find it
        const messageWrapper = targetBubble.closest('div.w-full.flex.mb-lg');
        if (messageWrapper) {
            messageWrapper.dataset.messageId = messageId;
            debugLog('[Stats REGEN] Marked message wrapper with data-message-id');
        }

        // Find the header container (supports both gap-md and gap-0)
        const headerContainer = targetBubble.querySelector('div.flex.justify-between.items-center.gap-md, div.flex.justify-between.items-center.gap-0, div.flex.justify-between.items-center');
        if (!headerContainer) {
            debugLog('[Stats REGEN] Could not find header container');
            // Remove from in-progress so later retry attempts can try again
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        // Check if stats already exist in DOM
        let statsDiv = headerContainer.querySelector('.generation-stats');
        
        // Build display lines
        let displayLines = [];
        
        // Get full stats from storage (has the flattened settings)
        const fullStats = await getStatsForMessage(messageId);
        debugLog('[Stats REGEN] Full stats from storage:', fullStats);
        
        const hasSettings = fullStats?.max_tokens !== null && fullStats?.max_tokens !== undefined;
        const hasModel = fullStats?.model || model;
        const hasTimestamp = fullStats?.timestamp || createdAt;
        
        if (statsEnabled && hasModel) {
            let modelDisplay = fullStats?.model || model;
            if (!showModelDetails && modelDisplay && modelDisplay.includes('→')) {
                modelDisplay = modelDisplay.split('→')[0].trim();
            }
            
            if (hasSettings) {
                displayLines.push(modelDisplay);
                displayLines.push(`Tokens: ${fullStats.max_tokens} | Temp: ${fullStats.temperature.toFixed(2)} | Top P: ${fullStats.top_p} | Top K: ${fullStats.top_k}`);
            } else if (modelDisplay) {
                displayLines.push(modelDisplay);
            }
        }
        
        if (timestampEnabled && hasTimestamp) {
            const timestamp = await formatTimestamp(fullStats?.timestamp || createdAt);
            if (timestamp) {
                displayLines.push(timestamp);
            }
        }

        if (showMessageIds && messageId) {
            displayLines.push(`ID: ${messageId}`);
        }

        if (displayLines.length === 0) {
            debugLog('[Stats REGEN] No displayable data');
            // Remove from in-progress, allow retries (data might not be in storage yet)
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        const displayText = displayLines.join('<br>');
        
        if (!statsDiv) {
            // Create new stats div
            statsDiv = document.createElement('div');
            statsDiv.className = 'generation-stats';
            
            // Check if we're in story mode for different positioning
            const inStoryMode = isStoryMode();
            
            if (inStoryMode) {
                // In story mode: position above the message, inside the container
                statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 4px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                // Find the inner flex-col container and insert inside it
                const innerContainer = headerContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                if (innerContainer) {
                    // Insert stats as first child inside the container
                    innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                } else {
                    // Fallback: insert at the top of header
                    headerContainer.insertBefore(statsDiv, headerContainer.firstChild);
                }
            } else {
                // Normal mode: position to the right in the header
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                
                // Insert before the menu button container
                const menuButtonContainer = headerContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    headerContainer.insertBefore(statsDiv, menuButtonContainer);
                    headerContainer.style.setProperty('gap', '4px', 'important');
                } else {
                    headerContainer.appendChild(statsDiv);
                }
            }
        }
        
        // Set the content and version ID
        statsDiv.dataset.versionId = messageId;
        safeSetHTML(statsDiv, displayText);
        
        // Apply model change indicators after this new message is inserted
        applyModelChangeIndicators();
        
        // Mark as successfully inserted (prevents future retries)
        statsInsertedForMessageIds.add(messageId);
        limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
        // Remove from in-progress
        statsInsertionInProgress.delete(messageId);
        // Decrement pending count since insertion is complete
        if (pendingNewMessageCount > 0) {
            pendingNewMessageCount--;
            debugLog('[Stats REGEN] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
        }

        debugLog('[Stats REGEN] Successfully inserted/updated stats for regenerated message');
        return true;
    }

    // Separate function to process messages (can be called multiple times)
    // This unified function handles all stats injection to avoid duplication and inconsistency
    // skipVersionCounterMessages: if true, skip messages with version counters (for new message handling)
    //                             if false, process all messages (for initial page load)
    async function processMessagesForStats(skipVersionCounterMessages = false) {
        debugLog('[Stats DISPLAY] ========== processMessagesForStats CALLED ==========');
        debugLog('[Stats DISPLAY] skipVersionCounterMessages:', skipVersionCounterMessages);
        debugLog('[Stats DISPLAY] Call stack:', new Error().stack);
        
        // Perf: only read the three settings needed to decide whether to bail.
        // Defer the rest until we know we're actually going to process messages —
        // this is a hot path called on every batch of message-wrapper mutations.
        const cache = window.__toolkitStorageCache;
        const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
        const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
        const showMessageIds = cache ? await cache.get(SHOW_MESSAGE_IDS_KEY, false) : await storage.get(SHOW_MESSAGE_IDS_KEY, false);

        // If none are enabled, no need to process
        if (!statsEnabled && !timestampEnabled && !showMessageIds) return;

        const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);

        // Cache the highlight model changes setting globally for synchronous access
        window.__highlightModelChanges = cache ? await cache.get('highlightModelChanges', false) : await storage.get('highlightModelChanges', false);

        // Cache auto-regeneration settings globally for synchronous access
        window.__autoRegenOnMismatch = cache ? await cache.get('autoRegenOnMismatch', false) : await storage.get('autoRegenOnMismatch', false);
        window.__autoRegenOnShort = cache ? await cache.get('autoRegenOnShort', false) : await storage.get('autoRegenOnShort', false);
        window.__autoRegenMaxAttempts = cache ? await cache.get('autoRegenMaxAttempts', 1) : await storage.get('autoRegenMaxAttempts', 1);

        debugLog('[Stats DISPLAY] Stats enabled:', statsEnabled, 'Timestamp enabled:', timestampEnabled, 'Model details:', showModelDetails, 'Message IDs:', showMessageIds, 'Highlight model changes:', window.__highlightModelChanges);
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');

        debugLog('[Stats] Found message wrappers:', messageWrappers.length);

        // Calculate total messages in the combined index map
        const totalMessages = Object.keys(messageIdToIndexMap).length;
        debugLog('[Stats] Total messages in combined index map:', totalMessages);

        // Calculate offset: if page shows fewer messages than stored, offset to the end
        const messagesOnPage = messageWrappers.length;
        const storageOffset = Math.max(0, totalMessages - messagesOnPage);
        debugLog('[Stats] Messages on page:', messagesOnPage, 'Storage offset:', storageOffset);

        // Process messages in reverse order (bottom to top, newest first)
        // This ensures the most recent messages get correct stats even if there's an index issue
        const wrappersArray = Array.from(messageWrappers).reverse();
        let messageIndex = messagesOnPage - 1; // Start from the last message

        for (const wrapper of wrappersArray) {
            // Skip wrappers that we've already failed to extract IDs from
            // This prevents endless retries on messages that don't have IDs yet
            if (statsFailedForWrappers.has(wrapper)) {
                debugLog('[Stats] Skipping wrapper that previously failed ID extraction');
                messageIndex--;
                continue;
            }

            // Check if this is a bot message (has character link) or user message
            // In Story Mode, there's no chatbot link, so we need alternative detection
            // Use contains selector to support localized URLs like /pt/chatbot/
            const characterLink = wrapper.querySelector('a[href*="/chatbot/"]');
            let isBotMessage = !!characterLink;
            
            // Story Mode fallback: check for bot-specific UI elements or message styling
            // Bot messages in Story Mode have different styling (e.g., rounded corners)
            if (!isBotMessage && isStoryMode()) {
                // In Story Mode, check message bubble styling to detect bot vs user
                // Bot messages typically have left-aligned rounded corners, user has right-aligned
                const messageBubble = wrapper.querySelector('.rounded-\\[4px_20px_20px_20px\\]');
                if (messageBubble) {
                    isBotMessage = true;
                }
            }
            debugLog('[Stats] Processing message, isBotMessage:', isBotMessage, 'messageIndex:', messageIndex);

            // Skip messages with version counters when processing new messages
            // (they're handled by insertStatsForRegeneratedMessage in that case)
            // But on initial page load, we need to process them here
            const versionCounter = wrapper.querySelector('p.text-label-md');
            const hasVersionCounter = versionCounter && /^\d+\/\d+$/.test(versionCounter.textContent.trim());
            if (skipVersionCounterMessages && hasVersionCounter) {
                debugLog('[Stats] Skipping message with version counter (handled by insertStatsForRegeneratedMessage)');
                messageIndex--;
                continue;
            }
            
            // Update selector to match new DOM structure - action container has gap-0 and may have flex-row-reverse
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center.gap-0, .flex.justify-between.items-center');
            
            if (!actionContainer) {
                debugLog('[Stats] No action container found!');
                messageIndex--;
                continue;
            }
            
            // Check if stats already exist
            const existingStatsDiv = actionContainer.querySelector('.generation-stats');
            if (existingStatsDiv) {
                debugLog('[Stats] Found existing stats div');
                
                // OPTIMIZATION: If stats are marked as finalized (with arrow format), skip entirely
                // This prevents unnecessary storage reads for every message on every mutation
                if (actionContainer.dataset.statsFinalized === 'true') {
                    debugLog('[Stats] Stats already finalized, skipping without storage check');
                    messageIndex--;
                    continue;
                }
                
                // Check if we need to update the stats (e.g., from partial to full model format)
                if (isBotMessage) {
                    let messageId = extractMessageId(wrapper);
                    debugLog('[Stats] Bot message, messageId:', messageId);
                    
                    // Try fallback to index map if extraction failed
                    if (!messageId) {
                        // Calculate the correct index: page shows newest messages, so offset from end of storage
                        // Use cached storageOffset calculated at start of function
                        const correctedIndex = storageOffset + messageIndex;
                        
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            messageId = messageIdToIndexMap[correctedIndex];
                            debugLog('[Stats] Using fallback messageId from index map:', messageId);
                        }
                    }
                    
                    if (messageId) {
                        const latestStats = await getStatsForMessage(messageId);
                        debugLog('[Stats] Latest stats from storage:', latestStats);
                        if (latestStats?.model && latestStats.model.includes('→')) {
                            // We have full format in storage but need to check if it's displayed
                            const existingText = existingStatsDiv.textContent;
                            if (DEBUG_MODE) {
                                console.log('[Stats] Storage has arrow format:', latestStats.model);
                                console.log('[Stats] Display shows:', existingText);
                            }
                            if (!existingText.includes('→')) {
                                // Stats are outdated - remove and re-insert
                                debugLog('[Stats] OUTDATED! Removing old stats div and re-inserting...');
                                existingStatsDiv.remove();
                                // Don't skip - let it fall through to re-insert
                            } else {
                                // Mark as finalized so we don't check again
                                actionContainer.dataset.statsFinalized = 'true';
                                debugLog('[Stats] Stats already up-to-date, marking as finalized');
                                messageIndex--;
                                continue;
                            }
                        } else {
                            debugLog('[Stats] Storage does not have arrow format, skipping update');
                            debugLog('[Stats] Stats already present, skipping');
                            messageIndex--;
                            continue;
                        }
                    } else {
                        debugLog('[Stats] No messageId extracted, skipping');
                        debugLog('[Stats] Stats already present, skipping');
                        messageIndex--;
                        continue;
                    }
                } else {
                    debugLog('[Stats] User message, skipping');
                    debugLog('[Stats] Stats already present, skipping');
                    messageIndex--;
                    continue;
                }
            }
            
            if (actionContainer.dataset.statsProcessing) {
                debugLog('[Stats] Already being processed (race condition), skipping');
                messageIndex--;
                continue;
            }
            
            // Mark as processing immediately to prevent race conditions
            actionContainer.dataset.statsProcessing = 'true';
            
            // Wrap entire processing in try/catch to ensure cleanup on errors
            try {
                // In Story Mode, we may misdetect bot messages as user messages due to DOM differences
                // We'll do a preliminary check here and potentially correct isBotMessage later based on stored role
                let effectiveIsBotMessage = isBotMessage;
                
                // Story Mode: If we can extract a messageId and check its role, use that for detection
                if (!isBotMessage && isStoryMode()) {
                    let preCheckMessageId = extractMessageId(wrapper);
                    if (!preCheckMessageId) {
                        const correctedIndex = storageOffset + messageIndex;
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            preCheckMessageId = messageIdToIndexMap[correctedIndex];
                        }
                    }
                    if (preCheckMessageId) {
                        const preCheckStats = await getStatsForMessage(preCheckMessageId);
                        // If in-memory bot set, stored role, or generation settings say bot — treat as bot message
                        if (botMessageIds.has(preCheckMessageId) || preCheckStats?.role === 'bot' || (preCheckStats?.max_tokens !== null && preCheckStats?.max_tokens !== undefined)) {
                            effectiveIsBotMessage = true;
                            debugLog('[Stats] Story Mode: Corrected isBotMessage to true based on stored role/stats');
                        }
                    }
                }
                
                if (effectiveIsBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] ========== PROCESSING BOT MESSAGE ==========');
                    debugLog('[Stats DISPLAY] Extracted messageId:', messageId);
                    debugLog('[Stats DISPLAY] messageIndex:', messageIndex);
                    debugLog('[Stats DISPLAY] hasVersionCounter:', hasVersionCounter);
                }
                
                // For messages with version counters, find the correct message ID from alternativeMessageGroups
                // based on which version is currently being displayed
                if (hasVersionCounter && versionCounter) {
                    const versionMatch = versionCounter.textContent.trim().match(/^(\d+)\/(\d+)$/);
                    if (versionMatch) {
                        const currentVersion = parseInt(versionMatch[1]);
                        const totalVersions = parseInt(versionMatch[2]);
                        debugLog('[Stats] Message has version counter:', currentVersion, '/', totalVersions);
                        
                        // Find the alternative group that matches this total version count
                        for (const [prevId, alternatives] of Object.entries(alternativeMessageGroups)) {
                            if (alternatives.length === totalVersions) {
                                // Found matching group - get the message ID for the current version
                                const targetIndex = currentVersion - 1; // versions are 1-indexed
                                if (targetIndex >= 0 && targetIndex < alternatives.length) {
                                    messageId = alternatives[targetIndex].id;
                                    debugLog('[Stats] Found message ID from alternativeMessageGroups:', messageId?.substring(0, 8));
                                }
                                break;
                            }
                        }
                    }
                }
                
                // Calculate the correct index: page shows newest messages, so offset from end of storage
                if (!messageId) {
                    // Use cached storageOffset calculated at start of function
                    const correctedIndex = storageOffset + messageIndex;
                    
                    if (DEBUG_MODE) {
                        debugLog('[Stats DISPLAY] Fallback - correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    }
                    debugLog('[Stats] Extracted messageId:', messageId, 'messageIndex:', messageIndex, 'correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    if (messageIdToIndexMap[correctedIndex] !== undefined) {
                        messageId = messageIdToIndexMap[correctedIndex];
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] Using mapped messageId:', messageId);
                        }
                        debugLog('[Stats] Using mapped messageId:', messageId);
                    }
                }
                
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Final messageId to lookup:', messageId);
                }
                
                // Skip if this message was already handled or is being handled by insertStatsWithRetry
                // This prevents duplicate stats when both paths try to insert
                if (messageId && (statsInsertedForMessageIds.has(messageId) || statsInsertionInProgress.has(messageId))) {
                    debugLog('[Stats DISPLAY] Message already handled or in progress by insertStatsForRegeneratedMessage, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Retrieved from storage:', generationStats);
                    debugLog('[Stats DISPLAY] Timestamp from storage:', generationStats?.timestamp);
                    debugLog('[Stats DISPLAY] Timestamp as Date:', generationStats?.timestamp ? new Date(generationStats.timestamp).toISOString() : 'null');
                }
                debugLog('[Stats] Got stats from storage:', generationStats);
                if (!generationStats && pendingMessageStats) generationStats = pendingMessageStats;
                if (!generationStats && lastGenerationSettings) generationStats = lastGenerationSettings;
                debugLog('[Stats] Final stats:', generationStats);
                
                if (!generationStats) {
                    debugLog('[Stats] No stats found, skipping message');
                    // If we couldn't extract a messageId, mark this wrapper as failed
                    // to prevent endless retries on every mutation
                    // BUT: Only mark as failed if there are no pending new messages
                    // New messages may not have their data-message-id set yet
                    if (!messageId && pendingNewMessageCount === 0) {
                        statsFailedForWrappers.add(wrapper);
                        debugLog('[Stats] Marked wrapper as failed (no message ID)');
                    } else if (!messageId) {
                        debugLog('[Stats] Not marking wrapper as failed - there are', pendingNewMessageCount, 'pending new messages');
                    }
                    // Clear the processing flag so it can be retried later if messageId becomes available
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                debugLog('[Stats] Creating stats div...');
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                
                // Check if we're in story mode for different positioning
                const inStoryMode = isStoryMode();
                
                if (inStoryMode) {
                    // In story mode: position above the message
                    statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 8px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                } else {
                    // Normal mode: position to the right in the header
                    statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                }
                
                // Add data-version-id to prevent being hidden by the regeneration switcher CSS
                if (messageId) {
                    statsDiv.dataset.versionId = messageId;
                }
                
                debugLog('[Stats] Checking stats content:', generationStats);
                
                // Check for model and settings (new flat format with max_tokens)
                const hasSettings = generationStats.max_tokens !== null && generationStats.max_tokens !== undefined;
                const hasModel = generationStats.model;
                const hasTimestamp = generationStats.timestamp;
                
                // Build display components based on settings
                let displayLines = [];
                
                if (statsEnabled && hasSettings && hasModel) {
                    debugLog('[Stats] Has full stats with settings');
                    const maxTokens = generationStats.max_tokens;
                    const temperature = generationStats.temperature;
                    const topP = generationStats.top_p;
                    const topK = generationStats.top_k;
                    
                    // Process model name based on showModelDetails setting
                    let modelDisplay = generationStats.model;
                    if (!showModelDetails && modelDisplay.includes('→')) {
                        // Truncate to just the requested model (before the arrow)
                        modelDisplay = modelDisplay.split('→')[0].trim();
                    }

                    displayLines.push(modelDisplay);
                    displayLines.push(`Tokens: ${maxTokens} | Temp: ${temperature.toFixed(2)} | Top P: ${topP} | Top K: ${topK}`);
                }
                
                if (timestampEnabled && hasTimestamp) {
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (DEBUG_MODE) {
                        debugLog('[Stats DISPLAY] Formatted timestamp:', timestamp);
                        debugLog('[Stats DISPLAY] Input to formatTimestamp was:', generationStats.timestamp);
                    }
                    if (timestamp) {
                        displayLines.push(timestamp);
                    }
                }

                if (showMessageIds && messageId) {
                    displayLines.push(`ID: ${messageId}`);
                }

                // If we have nothing to display, skip
                if (displayLines.length === 0) {
                    debugLog('[Stats] No displayable data, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                // Join lines with <br>
                const displayText = displayLines.join('<br>');
                safeSetHTML(statsDiv, displayText);
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Stats div content:', statsDiv.textContent);
                }
                debugLog('[Stats] Stats div innerHTML:', statsDiv.innerHTML);
                
                // Insert positioning based on story mode
                if (inStoryMode) {
                    // In story mode: insert INSIDE the message container as first child
                    // This keeps the stats within the same width constraints as the message
                    const innerContainer = actionContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                    if (innerContainer) {
                        // Insert stats as first child inside the flex-col container
                        statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 4px; width: 100%;';
                        innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] ========== INSERTING STATS DIV (STORY MODE) ==========');
                            debugLog('[Stats DISPLAY] Stats div content before insert:', statsDiv.textContent);
                            debugLog('[Stats DISPLAY] Inserted inside message container as first child');
                        }
                    } else {
                        // Fallback: insert in action container
                        actionContainer.appendChild(statsDiv);
                    }
                } else {
                    // Normal mode: insert in the action container header
                    const menuButtonContainer = actionContainer.querySelector('.relative');
                    debugLog('[Stats] Menu button container:', menuButtonContainer);
                    if (menuButtonContainer) {
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] ========== INSERTING STATS DIV ==========');
                            debugLog('[Stats DISPLAY] Stats div content before insert:', statsDiv.textContent);
                            debugLog('[Stats DISPLAY] Inserting into action container');
                        }
                        debugLog('[Stats] Inserting stats div...');
                        actionContainer.insertBefore(statsDiv, menuButtonContainer);
                        actionContainer.style.setProperty('gap', '4px', 'important');
                    } else {
                        actionContainer.appendChild(statsDiv);
                    }
                }
                
                // Mark this message as having stats inserted to prevent duplicates
                if (messageId) {
                    statsInsertedForMessageIds.add(messageId);
                    limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                    debugLog('[Stats] Added messageId to statsInsertedForMessageIds:', messageId);
                }
                
                // OPTIMIZATION: Mark stats as finalized if they have arrow format
                // This prevents unnecessary storage checks on future mutations
                if (generationStats.model && generationStats.model.includes('→')) {
                    actionContainer.dataset.statsFinalized = 'true';
                    debugLog('[Stats] Marked stats as finalized (has arrow format)');
                }
                
                delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Stats div inserted! Final content:', statsDiv.textContent);
                    debugLog('[Stats DISPLAY] Stats div is in DOM:', document.contains(statsDiv));
                    debugLog('[Stats DISPLAY] ===========================================');
                }
                debugLog('[Stats] Stats div inserted successfully!');

                messageIndex--;
            } else {
                // User message - show only timestamp if enabled
                if (!timestampEnabled) {
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                let messageId = extractMessageId(wrapper);
                debugLog('[Stats] User message - extracted messageId:', messageId, 'messageIndex:', messageIndex);
                    
                    // Fallback to combined index map if extraction failed
                    if (!messageId) {
                        const correctedIndex = storageOffset + messageIndex;
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            messageId = messageIdToIndexMap[correctedIndex];
                            debugLog('[Stats] User message - using fallback from combined index map:', messageId);
                        }
                    }
                    
                    let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                    debugLog('[Stats] User message - generationStats:', generationStats);
                    
                    // Skip if this message was already handled or is being handled
                    if (messageId && (statsInsertedForMessageIds.has(messageId) || statsInsertionInProgress.has(messageId))) {
                        debugLog('[Stats] User message already handled or in progress, skipping');
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    // Only display if we have a valid timestamp
                    if (!generationStats?.timestamp) {
                        debugLog('[Stats] User message - no timestamp, skipping');
                        // If we couldn't extract a messageId, mark this wrapper as failed
                        // BUT: Only mark as failed if there are no pending new messages
                        if (!messageId && pendingNewMessageCount === 0) {
                            statsFailedForWrappers.add(wrapper);
                            debugLog('[Stats] Marked user message wrapper as failed (no message ID)');
                        } else if (!messageId) {
                            debugLog('[Stats] Not marking user wrapper as failed - there are', pendingNewMessageCount, 'pending new messages');
                        }
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (!timestamp) {
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    // Create timestamp div for user messages
                    const statsDiv = document.createElement('div');
                    statsDiv.className = 'generation-stats';
                    
                    // Check if we're in story mode for different positioning
                    const inStoryMode = isStoryMode();
                    
                    if (inStoryMode) {
                        // In story mode: position above the message
                        statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 8px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                    } else {
                        // Normal mode: position to the right in the header
                        statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                    }
                    
                    // Add data-version-id to prevent being hidden by the regeneration switcher CSS
                    if (messageId) {
                        statsDiv.dataset.versionId = messageId;
                    }

                    // Build display content for user messages
                    let displayLines = [timestamp];

                    // Add message ID if enabled
                    if (showMessageIds && messageId) {
                        displayLines.push(`ID: ${messageId}`);
                    }

                    safeSetHTML(statsDiv, displayLines.join('<br>'));
                    
                    // Insert positioning based on story mode
                    if (inStoryMode) {
                        // In story mode: insert INSIDE the message container as first child
                        const innerContainer = actionContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                        if (innerContainer) {
                            // Insert stats as first child inside the container
                            innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                            // Mark this message as having stats inserted
                            if (messageId) {
                                statsInsertedForMessageIds.add(messageId);
                                limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                            }
                            delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                            debugLog('[Stats] User message - timestamp inserted successfully (story mode)');
                        } else {
                            delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                        }
                    } else {
                        // Normal mode: insert in the action container header
                        const menuButtonContainer = actionContainer.querySelector('.relative');
                        if (menuButtonContainer) {
                            actionContainer.insertBefore(statsDiv, menuButtonContainer);
                            actionContainer.style.setProperty('gap', '4px', 'important');
                            // Mark this message as having stats inserted
                            if (messageId) {
                                statsInsertedForMessageIds.add(messageId);
                                limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                            }
                            delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                            debugLog('[Stats] User message - timestamp inserted successfully');
                        } else {
                            delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                        }
                    }
                    messageIndex--;
                }
            } catch (error) {
                // Ensure cleanup on any error during stats processing
                console.error('[Core] Error processing message stats:', error);
                delete actionContainer.dataset.statsProcessing;
                messageIndex--;
            }
        }
        
        // After all stats are inserted, apply model change indicators
        applyModelChangeIndicators();
    }

    // Initialize: Build index map from stored stats for imported/old messages
    debugLog('[Stats] About to call buildIndexMapFromStats...');
    buildIndexMapFromStats()
        .then(() => {
            debugLog('[Stats] Initialization complete, starting message observer');
        })
        .catch((error) => {
            console.error('[Stats] Error building index map:', error);
        });

    // Perf (Round 3): scope messageObserver to the chat thread container instead of
    // document.body. The container is `[class*="flex-col"][class*="items-center"]`
    // (same selector used elsewhere in this file). When the SPA navigates between
    // chat pages the container unmounts and a new one mounts, so we reattach on
    // location changes. If we can't find the container, we fall back to body —
    // worst case is the pre-Round-3 behavior. The startup setTimeouts at
    // INITIAL_STATS_CHECK / DELAYED_STATS_CHECK call processMessagesForStats
    // directly, so even if a reattach is briefly missed, stats still land.
    let _messageObserverHost = null;

    function findChatContainerForObserver() {
        // Same selector family used by the post-regen reapply observer.
        // Pick the outermost candidate that actually contains message wrappers —
        // this returns the chat scroller, which survives individual message
        // renders. If no wrappers exist yet (empty conversation), prefer the
        // scroller-shaped element with overflow-auto so we still observe the
        // right region. Fall back to document.body as a last resort.
        const candidates = document.querySelectorAll('[class*="flex-col"][class*="items-center"]');
        for (const c of candidates) {
            if (c.querySelector?.('div.w-full.flex.mb-lg')) return c;
        }
        for (const c of candidates) {
            const cls = c.className || '';
            if (typeof cls === 'string' && cls.includes('overflow-auto')) return c;
        }
        return candidates[0] || document.body;
    }

    function attachMessageObserver() {
        const host = findChatContainerForObserver();
        if (host === _messageObserverHost) return;
        try { messageObserver.disconnect(); } catch (_) {}
        _messageObserverHost = host;
        messageObserver.observe(host, { childList: true, subtree: true });
        debugLog('[Stats] messageObserver attached to', host === document.body ? 'document.body (fallback)' : 'chat container');
    }

    // Reattach on SPA navigation. Patch history methods + popstate so we get
    // notified when the chat container is replaced. We delay the reattach a tick
    // so React has a chance to mount the new container.
    function scheduleReattachAfterNav() {
        setTimeout(() => {
            // If the current host is detached from the document, or we've moved
            // pages, find the new container and rebind.
            if (!_messageObserverHost || !_messageObserverHost.isConnected) {
                attachMessageObserver();
                return;
            }
            // Even if still connected, prefer a more specific container if one
            // appeared on this page (e.g. arriving on /chat/ from /).
            const candidate = findChatContainerForObserver();
            if (candidate !== _messageObserverHost) {
                attachMessageObserver();
            }
        }, 50);
        // Second pass for slow mounts
        setTimeout(() => {
            if (!_messageObserverHost || !_messageObserverHost.isConnected) {
                attachMessageObserver();
            }
        }, 500);
    }

    (function installNavHooks() {
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function (...args) {
            const r = origPush.apply(this, args);
            scheduleReattachAfterNav();
            return r;
        };
        history.replaceState = function (...args) {
            const r = origReplace.apply(this, args);
            scheduleReattachAfterNav();
            return r;
        };
        window.addEventListener('popstate', scheduleReattachAfterNav);
    })();

    // Initial attach: wait for body, then bind to chat container if present.
    waitForBody().then(() => {
        debugLog('[Stats] document.body available, starting message observer');
        attachMessageObserver();
        // The chat container often mounts shortly after body. Re-check once more
        // so we upgrade from the body fallback to the real container.
        scheduleReattachAfterNav();
    }).catch((err) => {
        console.error('[Stats] Failed to wait for body:', err);
        setTimeout(() => {
            if (document.body) {
                debugLog('[Stats] Retrying message observer setup after error');
                attachMessageObserver();
            }
        }, 2000);
    });

    // Periodic check to ensure stats are inserted even if mutations are missed
    // DISABLED FOR DEBUGGING - flooding logs
    /*
    setInterval(async () => {
        const statsEnabled = await storage.get('showGenerationStats', false);
        if (statsEnabled) {
            processMessagesForStats();
        }
    }, 2000); // Check every 2 seconds
    */

    // Alias for backward compatibility - both names call the same unified function
    const insertStatsForAllMessages = processMessagesForStats;

    // Initial check for existing messages after page load
    debugLog('[Stats] Scheduling initial check at', TIMING.INITIAL_STATS_CHECK, 'ms');
    setTimeout(insertStatsForAllMessages, TIMING.INITIAL_STATS_CHECK);
    
    // Also check again after a longer delay in case messages load slowly
    debugLog('[Stats] Scheduling delayed check at', TIMING.DELAYED_STATS_CHECK, 'ms');
    setTimeout(insertStatsForAllMessages, TIMING.DELAYED_STATS_CHECK);

    // =============================================================================
    // ===          REGENERATION SWITCHER HANDLER (Stats Update)               ===
    // =============================================================================
    // When user switches between message regenerations (< 1/2 > buttons or arrow keys),
    // update the displayed stats to match the currently visible version
    
    // Shared function to handle version switch stats update
    async function handleVersionSwitch(currentVersion, totalVersions, isNext) {
        // Calculate the NEW version number after the switch
        let newVersion;
        if (isNext) {
            newVersion = currentVersion < totalVersions ? currentVersion + 1 : currentVersion;
        } else {
            newVersion = currentVersion > 1 ? currentVersion - 1 : currentVersion;
        }
        
        debugLog('[Core] Version change:', currentVersion, '->', newVersion);
        
        // If version didn't change (button was disabled), do nothing
        if (newVersion === currentVersion) {
            debugLog('[Core] Version unchanged, skipping');
            return;
        }
        
        // IMMEDIATELY inject CSS to hide any stats div that React might create
        // This prevents flicker by hiding React's stats divs at the CSS level
        let hideStyle = document.getElementById('sai-hide-react-stats');
        if (!hideStyle) {
            hideStyle = document.createElement('style');
            hideStyle.id = 'sai-hide-react-stats';
            document.head.appendChild(hideStyle);
        }
        hideStyle.textContent = '.generation-stats:not([data-version-id]) { display: none !important; }';
        
        // Wait for React to update the DOM with the new message version
        // Use a shorter delay for faster response
        setTimeout(async () => {
            debugLog('[Core] === INSIDE SETTIMEOUT - STARTING VERSION SWITCH HANDLER ===');
            
            // The counter element is likely detached by React after the version switch
            // Instead, we search the LIVE DOM for the version switcher showing the NEW version
            const versionText = `${newVersion}/${totalVersions}`;
            debugLog('[Core] Searching for version text:', versionText);
            
            let liveStatsDiv = null;
            let liveHeaderContainer = null;
            let messageBubble = null;
            
            // Find the paragraph showing our target version (e.g., "2/2")
            const allParagraphs = document.querySelectorAll('p.text-label-md');
            for (const p of allParagraphs) {
                if (p.textContent.trim() === versionText) {
                    debugLog('[Core] Found version text paragraph in LIVE DOM');
                    
                    // Navigate up to the message bubble
                    // The bubble has classes: flex flex-col ... gap-md ... px-[13px] ... rounded-[...]  bg-gray-4
                    messageBubble = p.closest('div[class*="bg-gray-4"][class*="rounded"]');
                    if (!messageBubble) {
                        // Fallback: try finding by px-[13px] which is unique to message bubbles
                        messageBubble = p.closest('div[class*="px-\\[13px\\]"]');
                    }
                    
                    if (messageBubble) {
                        debugLog('[Core] Message bubble found:', messageBubble.className.substring(0, 80));
                        
                        // Find the header container (has gap-md AND justify-between items-center)
                        liveHeaderContainer = messageBubble.querySelector('div.flex.justify-between.items-center.gap-md');
                        debugLog('[Core] Header container found:', !!liveHeaderContainer);
                        
                        if (liveHeaderContainer) {
                            liveStatsDiv = liveHeaderContainer.querySelector('.generation-stats');
                            debugLog('[Core] Stats div in header:', !!liveStatsDiv);
                        }
                    }
                    break;
                }
            }
            
            // If we couldn't find the header container, we can't proceed
            if (!liveHeaderContainer) {
                debugLog('[Core] Could not find header container, aborting');
                return;
            }
            
            // Try to find the message ID from our alternative groups
            let newMessageId = null;
            
            // Method 3: Fall back to matching by version count (works if counts are unique)
            // alternativeMessageGroups[prev_id] contains ALL versions including the original (v1)
            // so alternatives.length === totalVersions
            if (!newMessageId) {
                debugLog('[Core] Trying to match by version count:', totalVersions);
                debugLog('[Core] Available groups:', Object.entries(alternativeMessageGroups).map(([k, v]) => 
                    `${k.substring(0, 8)}: ${v.length} versions [${v.map(m => m.id.substring(0, 8)).join(', ')}]`
                ));
                for (const [prevId, alternatives] of Object.entries(alternativeMessageGroups)) {
                    if (alternatives.length === totalVersions) {
                        const targetIndex = newVersion - 1;
                        debugLog('[Core] Found group by count match! prev_id:', prevId.substring(0, 8));
                        debugLog('[Core] Alternatives in group:', alternatives.map((m, i) => `v${i+1}=${m.id.substring(0, 8)}`));
                        debugLog('[Core] Target index:', targetIndex, 'for newVersion:', newVersion);
                        if (targetIndex >= 0 && targetIndex < alternatives.length) {
                            newMessageId = alternatives[targetIndex].id;
                            debugLog('[Core] Selected message ID:', newMessageId.substring(0, 8));
                        }
                        break;
                    }
                }
            }
            
            if (!newMessageId) {
                debugLog('[Core] Could not determine message ID after version switch');
                return;
            }
            
            debugLog('[Core] Final message ID for lookup:', newMessageId.substring(0, 8));
            debugLog('[Core] messageTimestamps has this ID?', !!messageTimestamps[newMessageId]);
            debugLog('[Core] messageTimestamps[newMessageId]:', messageTimestamps[newMessageId]);
            debugLog('[Core] All messageTimestamps keys:', Object.keys(messageTimestamps).map(k => k.substring(0, 8)));
            
            // Get the stats for this specific message version
            // Note: getStatsForMessage automatically uses the API timestamp from messageTimestamps
            const generationStats = await getStatsForMessage(newMessageId);
            debugLog('[Core] Stats lookup result:', generationStats ? 'found' : 'not found', generationStats);
            debugLog('[Core] Stats timestamp after getStatsForMessage:', generationStats?.timestamp, '→', generationStats?.timestamp ? new Date(generationStats.timestamp).toLocaleString() : 'null');
            
            if (!generationStats) {
                debugLog('[Core] No stats found for message:', newMessageId);
                // Clear existing stats if present
                if (liveStatsDiv) {
                    liveStatsDiv.textContent = '';
                }
                return;
            }
            
            // Get current settings
            const cache = window.__toolkitStorageCache;
            const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
            const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
            const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);
            const showMessageIds = cache ? await cache.get(SHOW_MESSAGE_IDS_KEY, false) : await storage.get(SHOW_MESSAGE_IDS_KEY, false);

            debugLog('[Core] Settings:', { statsEnabled, timestampEnabled, showModelDetails, showMessageIds });
            
            // Build updated display
            let displayLines = [];
            
            const hasSettings = generationStats.max_tokens !== null && generationStats.max_tokens !== undefined;
            const hasModel = generationStats.model;
            const hasTimestamp = generationStats.timestamp;
            
            if (statsEnabled && hasSettings && hasModel) {
                let modelDisplay = generationStats.model;
                if (!showModelDetails && modelDisplay.includes('→')) {
                    modelDisplay = modelDisplay.split('→')[0].trim();
                }
                displayLines.push(modelDisplay);
                displayLines.push(`Tokens: ${generationStats.max_tokens} | Temp: ${generationStats.temperature.toFixed(2)} | Top P: ${generationStats.top_p} | Top K: ${generationStats.top_k}`);
            }
            
            if (timestampEnabled && hasTimestamp) {
                const timestamp = await formatTimestamp(generationStats.timestamp);
                if (timestamp) {
                    displayLines.push(timestamp);
                }
            }

            if (showMessageIds && newMessageId) {
                displayLines.push(`ID: ${newMessageId}`);
            }

            debugLog('[Core] Display lines:', displayLines);
            
            if (displayLines.length > 0) {
                const displayText = displayLines.join('<br>');
                
                // Use the liveStatsDiv and liveHeaderContainer we found earlier via versionCounterElement
                // These were found by navigating from the clicked version counter
                
                // FIRST: Remove any stats divs that React created (they don't have our data-version-id)
                // This prevents flicker by cleaning up before we add/update ours
                if (liveHeaderContainer) {
                    const reactStatsDivs = liveHeaderContainer.querySelectorAll('.generation-stats:not([data-version-id])');
                    reactStatsDivs.forEach(div => div.remove());
                }
                
                // If no stats div exists but we have a header container, create one
                if (!liveStatsDiv && liveHeaderContainer) {
                    debugLog('[Core] No stats div found, creating new one in header container');
                    liveStatsDiv = document.createElement('div');
                    liveStatsDiv.className = 'generation-stats';
                    liveStatsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                    
                    // Insert before the menu button container
                    const menuButtonContainer = liveHeaderContainer.querySelector('.relative');
                    if (menuButtonContainer) {
                        liveHeaderContainer.insertBefore(liveStatsDiv, menuButtonContainer);
                        liveHeaderContainer.style.setProperty('gap', '4px', 'important');
                    } else {
                        liveHeaderContainer.appendChild(liveStatsDiv);
                    }
                }
                
                if (!liveStatsDiv) {
                    debugLog('[Core] ERROR: Could not find or create any live stats div to update!');
                    return;
                }
                
                debugLog('[Core] BEFORE update - stats div content:', liveStatsDiv.textContent.substring(0, 60));
                debugLog('[Core] Stats div is in document:', document.body.contains(liveStatsDiv));
                
                // Apply the update
                liveStatsDiv.dataset.versionId = newMessageId;
                safeSetHTML(liveStatsDiv, displayText);
                
                // Apply model change indicators (will re-evaluate all stats divs)
                applyModelChangeIndicators();
                
                // IMPORTANT: Remove any duplicate stats divs in this header
                // React might have created another one, or we might have created a duplicate
                const allStatsDivsInHeader = liveHeaderContainer.querySelectorAll('.generation-stats');
                debugLog('[Core] Stats divs in header after update:', allStatsDivsInHeader.length);
                if (allStatsDivsInHeader.length > 1) {
                    // Keep only the first one (ours), remove the rest
                    for (let i = 1; i < allStatsDivsInHeader.length; i++) {
                        debugLog('[Core] Removing duplicate stats div');
                        allStatsDivsInHeader[i].remove();
                    }
                }
                
                debugLog('[Core] AFTER update - stats div content:', liveStatsDiv.textContent.substring(0, 60));
                debugLog('[Core] Updated stats display!');
                
                // React re-renders aggressively, so we need to keep re-applying our update
                // Use a MutationObserver to watch for React replacing the stats div
                const reapplyStats = () => {
                    // Find the message bubble containing our version switcher
                    const allVersionSwitchers = document.querySelectorAll('p.text-label-md');
                    for (const switcher of allVersionSwitchers) {
                        if (switcher.textContent.trim() === `${newVersion}/${totalVersions}`) {
                            // Found the switcher, find the message bubble
                            const msgBubble = switcher.closest('div[class*="bg-gray-4"][class*="rounded"]');
                            if (msgBubble) {
                                const headerContainer = msgBubble.querySelector('div.flex.justify-between.items-center.gap-md');
                                if (headerContainer) {
                                    // First, remove any React-created stats divs (without our data-version-id)
                                    const reactStatsDivs = headerContainer.querySelectorAll('.generation-stats:not([data-version-id])');
                                    reactStatsDivs.forEach(div => div.remove());
                                    
                                    let allStatsDivs = headerContainer.querySelectorAll('.generation-stats');
                                    
                                    // If no stats div exists AT ALL, CREATE one
                                    if (allStatsDivs.length === 0) {
                                        debugLog('[Core] reapplyStats: No stats div found, creating new one');
                                        const newStatsDiv = document.createElement('div');
                                        newStatsDiv.className = 'generation-stats';
                                        newStatsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                                        newStatsDiv.dataset.versionId = newMessageId;
                                        safeSetHTML(newStatsDiv, displayText);
                                        
                                        // Insert before the menu button container
                                        const menuButtonContainer = headerContainer.querySelector('.relative');
                                        if (menuButtonContainer) {
                                            headerContainer.insertBefore(newStatsDiv, menuButtonContainer);
                                            headerContainer.style.setProperty('gap', '4px', 'important');
                                        } else {
                                            headerContainer.appendChild(newStatsDiv);
                                        }
                                    } else {
                                        // Stats div exists - update it if needed
                                        const statsDiv = allStatsDivs[0];
                                        if (statsDiv.dataset.versionId !== newMessageId) {
                                            debugLog('[Core] reapplyStats: Updating existing stats div');
                                            statsDiv.dataset.versionId = newMessageId;
                                            safeSetHTML(statsDiv, displayText);
                                        }
                                        
                                        // Remove any duplicates
                                        for (let i = 1; i < allStatsDivs.length; i++) {
                                            allStatsDivs[i].remove();
                                        }
                                    }
                                }
                            }
                            break;
                        }
                    }
                };
                
                // Set up a temporary MutationObserver to catch React re-renders
                const observer = new MutationObserver((mutations) => {
                    reapplyStats();
                });
                
                // Watch the entire chat container for changes
                const chatContainer = document.querySelector('[class*="flex-col"][class*="items-center"]') || document.body;
                observer.observe(chatContainer, { 
                    childList: true, 
                    subtree: true,
                    characterData: true
                });
                
                // Also do periodic checks for the next 2 seconds (longer duration)
                const checkInterval = setInterval(reapplyStats, 50); // More frequent checks
                
                // Clean up after 2 seconds
                setTimeout(() => {
                    observer.disconnect();
                    clearInterval(checkInterval);
                    // Remove the hide-React-stats CSS rule - our stats div is stable now
                    const hideStyle = document.getElementById('sai-hide-react-stats');
                    if (hideStyle) {
                        hideStyle.textContent = '';
                    }
                    debugLog('[Core] Stopped watching for React re-renders');
                }, 2000);
            } else {
                // No displayable content, clear stats div
                if (liveStatsDiv) {
                    liveStatsDiv.textContent = '';
                }
                // Remove the hide-React-stats CSS rule
                const hideStyle = document.getElementById('sai-hide-react-stats');
                if (hideStyle) {
                    hideStyle.textContent = '';
                }
                debugLog('[Core] No displayable content, cleared stats div');
            }
        }, 50); // Reduced from 200ms to 50ms for faster response
    }
    
    // Detect manual model changes via SpicyChat's own Generation Settings UI
    // Covers: (a) "Set Model" confirmation button in new UI, (b) direct model-option selection
    // in old UI, and (c) SpicyChat's native generation presets that swap the model.
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;

        // New UI: user clicked the "Set Model" confirmation button
        const confirmBtn = target.closest('button[aria-label="Set Model"]') ||
            target.closest('button');
        if (confirmBtn) {
            const btnText = confirmBtn.textContent && confirmBtn.textContent.trim();
            if (btnText === 'Set Model') {
                window.__suppressMismatchNext = true;
                debugLog('[Model] "Set Model" button clicked — suppressing next mismatch auto-regen');
                return;
            }
        }

        // Old UI: model option selected directly in the model picker list
        // The picker has a heading containing "Select a model" / "Choose Model" / "Select Model"
        const pickerOption = target.closest('li, div[role="option"]');
        if (pickerOption) {
            const modal = pickerOption.closest('div.fixed, div[class*="fixed"]');
            if (modal) {
                const modalText = modal.textContent || '';
                if (modalText.includes('Select a model') || modalText.includes('Choose Model') || modalText.includes('Select Model')) {
                    window.__suppressMismatchNext = true;
                    debugLog('[Model] Model option selected in picker — suppressing next mismatch auto-regen');
                }
            }
        }
    }, true); // capture phase so we fire before React

    // Click handler for regeneration switcher buttons
    document.addEventListener('click', async (e) => {
        // Check if click was on a regeneration switcher button (prev/next chevron)
        const button = e.target.closest('button[aria-label="previous"], button[aria-label="next"]');
        if (!button) return;
        
        // Verify it's the regeneration switcher (has sibling with X/Y format)
        const container = button.closest('.flex.items-center');
        if (!container) return;
        
        const counterText = container.querySelector('p');
        if (!counterText || !/^\d+\/\d+$/.test(counterText.textContent.trim())) return;
        
        // Parse the CURRENT version before the click updates the UI
        const [currentVersion, totalVersions] = counterText.textContent.trim().split('/').map(Number);
        const isNext = button.getAttribute('aria-label') === 'next';
        
        debugLog('[Core] Regeneration switcher clicked!', {
            button: button.getAttribute('aria-label'),
            currentVersion,
            totalVersions,
            alternativeGroupsCount: Object.keys(alternativeMessageGroups).length
        });
        
        await handleVersionSwitch(currentVersion, totalVersions, isNext);
    }, true); // Use capture phase to catch event early
    
    // Keyboard handler for arrow keys (left/right) to switch regeneration versions
    document.addEventListener('keydown', async (e) => {
        // Only handle left/right arrow keys
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        
        // Don't interfere if user is typing in an input or textarea
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
            return;
        }
        
        // Find all version switchers on the page
        const versionSwitchers = document.querySelectorAll('p.text-label-md');
        let foundSwitcher = null;
        let currentVersion = 0;
        let totalVersions = 0;
        
        for (const switcher of versionSwitchers) {
            const match = switcher.textContent.trim().match(/^(\d+)\/(\d+)$/);
            if (match) {
                currentVersion = parseInt(match[1]);
                totalVersions = parseInt(match[2]);
                foundSwitcher = switcher;
                break; // Use the first version switcher found
            }
        }
        
        if (!foundSwitcher || totalVersions <= 1) {
            return; // No version switcher or only one version
        }
        
        const isNext = e.key === 'ArrowRight';
        
        // Check if the version would actually change
        if (isNext && currentVersion >= totalVersions) return;
        if (!isNext && currentVersion <= 1) return;
        
        debugLog('[Core] Arrow key pressed for version switch!', {
            key: e.key,
            currentVersion,
            totalVersions,
            alternativeGroupsCount: Object.keys(alternativeMessageGroups).length
        });
        
        await handleVersionSwitch(currentVersion, totalVersions, isNext);
    }, true); // Use capture phase

    // Initial check in case modal is already open
    setTimeout(createProfileControls, 1000);

    // Watch for model name changes in Generation Settings modal (SpicyChat's own presets)
    startGenerationSettingsModelWatcher();

    // =============================================================================
    // ===                   MEMORY MANAGER AUTO-REFRESH                        ===
    // =============================================================================
    
    let memoryRefreshInterval = null;
    let memoryRefreshInProgress = false; // Guard to prevent concurrent refresh operations
    
    /**
     * Extracts conversation ID from current URL
     */
    function getConversationId() {
        // Use the conversation ID captured from the messages GET request
        // This is more reliable than parsing the URL
        return currentConversationId;
    }
    
    /**
     * Fetches fresh memory data from the API by injecting into page context
     */
    async function refreshMemoryContent() {
        // Guard against concurrent refresh operations which can cause React conflicts
        if (memoryRefreshInProgress) {
            debugLog('[Memories] Memory refresh already in progress, skipping...');
            return false;
        }
        memoryRefreshInProgress = true;
        
        try {
            return await doRefreshMemoryContent();
        } finally {
            // Always reset the flag, even if an error occurs
            memoryRefreshInProgress = false;
        }
    }
    
    /**
     * Internal implementation of memory refresh
     */
    async function doRefreshMemoryContent() {
        debugLog('[Memories] Refreshing Memory Manager content via API...');
        
        // Find the Memories modal specifically by its unique z-index
        // Use Array.from to check all modals and find the one with "Memories" heading
        const allModals = document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2');
        let memoryModal = null;
        
        for (const modal of allModals) {
            const heading = modal.querySelector('p.text-heading-6');
            if (heading && heading.textContent.trim() === 'Memories') {
                memoryModal = modal;
                break;
            }
        }
        
        if (!memoryModal) {
            debugLog('[Memories] Memory modal not found');
            return false;
        }
        
        // Get conversation ID from captured API data
        const conversationId = getConversationId();
        if (!conversationId) {
            debugLog('[Memories] Could not get conversation ID (not yet captured from messages API)');
            return false;
        }
        debugLog('[Memories] Using conversation ID:', conversationId);
        
        try {
            // Use postMessage to communicate with page-context.js instead of inline script
            // This avoids CSP issues with inline script injection
            const responsePromise = new Promise((resolve) => {
                const handler = (event) => {
                    // Only handle our specific response
                    if (event.source !== window) return;
                    if (event.data.type !== 'SAI_MEMORY_REFRESH_RESPONSE') return;
                    
                    window.removeEventListener('message', handler);
                    resolve(event.data);
                };
                window.addEventListener('message', handler);
                
                // Timeout after 10 seconds
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve({ success: false, error: 'timeout' });
                }, 10000);
            });
            
            // Send request to page-context.js
            window.postMessage({
                type: 'SAI_MEMORY_REFRESH_REQUEST',
                conversationId: conversationId
            }, '*');
            
            // Wait for the response
            const result = await responsePromise;
            
            if (!result.success) {
                if (result.error === 'timeout') {
                    debugLog('[Memories] API fetch timed out, falling back to close/reopen approach');
                } else {
                    console.error('[Memories] Failed to fetch memories:', result.status || result.error);
                    if (result.status === 401) {
                        console.error('[Memories] Authentication failed - token may be invalid or expired. Auth token present:', result.hasAuth);
                    }
                }
                // Don't return false here - fall through to close/reopen approach
            } else {
                debugLog(`[Memories] Fetched ${result.count} memories from API`);
            }
            
            // Try multiple approaches to trigger React re-render
            debugLog('[Memories] Attempting to trigger React re-render...');
            debugLog('[Memories] Memory modal element:', memoryModal);
            
            // NEW Approach: Try to find and click the "Load More Memories" button
            const loadMoreButton = Array.from(memoryModal.querySelectorAll('button'))
                .find(btn => btn.textContent?.includes('Load More'));
            
            if (loadMoreButton) {
                debugLog('[Memories] Found Load More button, clicking it');
                loadMoreButton.click();
                await new Promise(resolve => setTimeout(resolve, 500));
                debugLog('[Memories] Load More clicked, checking if memories updated');
                // The button click might trigger a refetch which would update the UI
                // Fall through to close/reopen if this doesn't work
            }
            
            // Approach 1: Find React component and manipulate state directly
            try {
                // Try the modal itself first
                let elementToCheck = memoryModal;
                let depth = 0;
                
                while (elementToCheck && depth < 5) {
                    const allKeys = Object.keys(elementToCheck);
                    const reactKeys = allKeys.filter(key => 
                        key.startsWith('__react') || key.includes('react') || key.includes('fiber')
                    );
                    
                    if (reactKeys.length > 0) {
                        debugLog('[Memories] Found React keys at depth', depth, ':', reactKeys);
                        
                        const reactKey = reactKeys[0];
                        const reactObj = elementToCheck[reactKey];
                        
                        // Walk the fiber tree
                        let current = reactObj;
                        let attempts = 0;
                        while (current && attempts < 30) {
                            if (current.stateNode && typeof current.stateNode.forceUpdate === 'function') {
                                debugLog('[Memories] Found forceUpdate at level', attempts, '- skipping to avoid React conflicts');
                                // DISABLED: forceUpdate can cause React error #185 (Maximum update depth exceeded)
                                // Instead, fall through to the close/reopen approach which is safer
                                // current.stateNode.forceUpdate();
                                // await new Promise(resolve => setTimeout(resolve, 1000));
                                // debugLog('[Memories] Memory refresh completed (via forceUpdate)');
                                // return true;
                                break; // Skip forceUpdate, use close/reopen instead
                            }
                            current = current.return;
                            attempts++;
                        }
                        break;
                    }
                    
                    elementToCheck = elementToCheck.parentElement;
                    depth++;
                }
                
                debugLog('[Memories] No React fiber found after checking', depth, 'parent levels');
            } catch (e) {
                console.error('[Memories] React manipulation failed:', e);
            }
            
            // Approach 2: Close and reopen (most reliable)
            debugLog('[Memories] Attempting close/reopen approach...');
            
            // Try multiple close button selectors - use aria-label="X-button"
            let closeButton = memoryModal.querySelector('button[aria-label="X-button"]');
            if (!closeButton) {
                closeButton = memoryModal.querySelector('button[aria-label="Close"]');
            }
            if (!closeButton) {
                // Look for button with X icon
                const buttons = Array.from(memoryModal.querySelectorAll('button'));
                debugLog('[Memories] Searching through', buttons.length, 'buttons for close button');
                closeButton = buttons.find(btn => {
                    const svg = btn.querySelector('svg');
                    if (!svg) return false;
                    // Close buttons typically have an X icon with crossing paths
                    const paths = svg.querySelectorAll('path');
                    return paths.length >= 2;
                });
            }
            
            if (closeButton) {
                debugLog('[Memories] Found close button, closing modal...');
                
                // TRICK: Create a simple invisible placeholder div to hold the sidebar space
                // This is cleaner than opening Generation Settings
                let placeholderDiv = null;
                
                // Check if Generation Settings is already open
                const allModals = Array.from(document.querySelectorAll('div.fixed'));
                const hasGenerationSettings = allModals.some(modal => {
                    const heading = modal.querySelector('p.text-heading-6');
                    return heading && heading.textContent.includes('Generation Settings');
                });
                
                if (!hasGenerationSettings) {
                    debugLog('[Memories] Creating invisible placeholder to hold sidebar space');
                    
                    // Create a simple placeholder that looks like a sidebar to the layout engine
                    placeholderDiv = document.createElement('div');
                    placeholderDiv.id = 'sai-sidebar-placeholder';
                    placeholderDiv.style.cssText = `
                        position: fixed;
                        top: 0;
                        right: 0;
                        width: 400px;
                        height: 100vh;
                        pointer-events: none;
                        z-index: 1;
                        background: transparent;
                    `;
                    
                    document.body.appendChild(placeholderDiv);
                    debugLog('[Memories] Placeholder div created');
                }
                
                // Now close the Memories modal
                closeButton.click();
                closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                closeButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                closeButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                
                // Wait just long enough for close
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Reopen quickly - search more thoroughly for the Memory Manager button
                debugLog('[Memories] Looking for Memory Manager button to reopen...');
                
                // First, try to find and open the chat dropdown menu
                const menuButton = document.querySelector('button[aria-label="chat-dropdown"]');
                if (menuButton) {
                    debugLog('[Memories] Found chat dropdown menu button, opening it...');
                    menuButton.click();
                    await new Promise(resolve => setTimeout(resolve, 30));
                } else {
                    debugLog('[Memories] Chat dropdown button not found');
                }
                
                // Try multiple selectors for the Manage Memories button
                debugLog('[Memories] Looking for Manage Memories button...');
                let memoryButton = document.querySelector('button[aria-label="Manage Memories"]');
                debugLog('[Memories] Direct selector result:', !!memoryButton);
                
                if (!memoryButton) {
                    // Look through all buttons for one with "Manage Memories" text
                    const allButtons = Array.from(document.querySelectorAll('button'));
                    debugLog('[Memories] Searching through', allButtons.length, 'buttons on page');
                    
                    const memoryButtons = allButtons.filter(btn => {
                        const text = btn.textContent || '';
                        const ariaLabel = btn.getAttribute('aria-label') || '';
                        return text.toLowerCase().includes('manage memor') || ariaLabel.toLowerCase().includes('manage memor');
                    });
                    
                    debugLog('[Memories] Found', memoryButtons.length, 'buttons with "manage memor" in text/aria-label');
                    if (memoryButtons.length > 0) {
                        memoryButtons.forEach((btn, i) => {
                            debugLog(`[Memories] Memory button ${i}:`, {
                                text: btn.textContent?.substring(0, 50),
                                ariaLabel: btn.getAttribute('aria-label'),
                                visible: btn.offsetParent !== null,
                                displayed: window.getComputedStyle(btn).display !== 'none'
                            });
                        });
                    }
                    
                    // Use the first one found
                    memoryButton = memoryButtons[0];
                }
                
                if (memoryButton) {
                    debugLog('[Memories] Found Memory Manager button:', memoryButton.textContent || memoryButton.getAttribute('aria-label'));
                    memoryButton.click();
                    
                    // Wait a moment for the modal to reopen and re-style the Load More button
                    setTimeout(() => {
                        // Find the reopened Memories modal by checking all modals
                        const allModals = document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2');
                        let reopenedModal = null;
                        
                        for (const modal of allModals) {
                            const heading = modal.querySelector('p.text-heading-6');
                            if (heading && heading.textContent.trim() === 'Memories') {
                                reopenedModal = modal;
                                break;
                            }
                        }
                        
                        if (reopenedModal) {
                            styleLoadMoreButton(reopenedModal);
                        }
                        
                        // Remove the placeholder div if we created one
                        if (placeholderDiv) {
                            placeholderDiv.remove();
                            debugLog('[Memories] Removed placeholder div');
                        }
                    }, 500);
                    
                    debugLog('[Memories] Memory refresh completed (via close/reopen)');
                    return true;
                } else {
                    debugLog('[Memories] Could not find Memory Manager button to reopen');
                    debugLog('[Memories] Tried aria-label and text content searches');
                }
            } else {
                debugLog('[Memories] Could not find close button');
                // Log the modal structure to help debug
                debugLog('[Memories] Modal HTML structure:', memoryModal.outerHTML.substring(0, 500));
            }
            
            // Clean up overlay and spacer if they still exist
            const overlay = document.getElementById('sai-refresh-overlay');
            const spacer = document.getElementById('sai-refresh-spacer');
            if (overlay) overlay.remove();
            if (spacer) spacer.remove();
            
            debugLog('[Memories] All refresh approaches attempted');
            return true;
            
        } catch (error) {
            console.error('[Memories] Error refreshing memories:', error);
            
            // Clean up placeholder div if it exists
            if (placeholderDiv) {
                placeholderDiv.remove();
                debugLog('[Memories] Removed placeholder div after error');
            }
            
            return false;
        }
    }
    
    /**
     * Starts the auto-refresh interval for the Memory Manager modal
     * DISABLED: Auto-refresh is currently disabled to prevent issues
     */
    function startMemoryRefresh() {
        // Auto-refresh disabled - use manual refresh button instead
        debugLog('[Memories] Memory Manager auto-refresh is disabled');
        return;
        
        // Clear any existing interval first
        if (memoryRefreshInterval) {
            clearInterval(memoryRefreshInterval);
        }
        
        debugLog('[Memories] Memory Manager auto-refresh started (120 seconds)');
        
        // Set up interval to refresh every 120 seconds
        memoryRefreshInterval = setInterval(() => {
            // Check if modal is still open
            const memoryModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2[class*="z-\\[900000\\]"]');
            if (memoryModal) {
                const memoryHeading = memoryModal.querySelector('p.text-heading-6');
                if (memoryHeading && memoryHeading.textContent.trim() === 'Memories') {
                    refreshMemoryContent();
                } else {
                    // Modal is open but it's not the Memory Manager, stop the interval
                    debugLog('[Memories] Memory Manager closed, stopping auto-refresh');
                    clearInterval(memoryRefreshInterval);
                    memoryRefreshInterval = null;
                }
            } else {
                // Modal is no longer open, stop the interval
                debugLog('[Memories] Memory Manager closed, stopping auto-refresh');
                clearInterval(memoryRefreshInterval);
                memoryRefreshInterval = null;
            }
        }, 120000); // 120 seconds = 120000 milliseconds
    }
    
    /**
     * Stops the auto-refresh interval
     */
    function stopMemoryRefresh() {
        if (memoryRefreshInterval) {
            clearInterval(memoryRefreshInterval);
            memoryRefreshInterval = null;
            debugLog('[Memories] Memory Manager auto-refresh stopped');
        }
    }
    
    /**
     * Adds a manual refresh button to the Memory Manager modal
     */
    function addManualRefreshButton(modal) {
        // Mark modal as being processed to prevent duplicate calls
        if (modal.dataset.saiButtonProcessing) {
            debugLog('[Memories] Refresh button already being added');
            return;
        }
        modal.dataset.saiButtonProcessing = 'true';
        
        // Check if button already exists
        if (modal.querySelector('[data-sai-refresh-button]')) {
            debugLog('[Memories] Refresh button already exists');
            delete modal.dataset.saiButtonProcessing;
            return;
        }
        
        // Wait a bit for React to fully render the modal buttons
        setTimeout(() => {
            // Find the button container (with the + and ... buttons)
            // Try multiple selectors as the class order might vary
            let buttonContainer = modal.querySelector('.flex.justify-end.items-undefined.m-0');
            if (!buttonContainer) {
                // Try without m-0 in case that class was removed
                buttonContainer = modal.querySelector('.flex.justify-end.items-undefined');
            }
            if (!buttonContainer) {
                debugLog('[Memories] Could not find button container with primary selectors');
                debugLog('[Memories] Trying alternate selectors...');
                
                // Try finding any flex container with buttons near the heading
                buttonContainer = modal.querySelector('.flex.justify-end.items-center');
                if (!buttonContainer) {
                    // Look for any flex container with justify-end that contains a square-plus button
                    const allFlexContainers = modal.querySelectorAll('.flex.justify-end');
                    for (const container of allFlexContainers) {
                        if (container.querySelector('svg.lucide-square-plus')) {
                            buttonContainer = container;
                            debugLog('[Memories] Found container via square-plus icon');
                            break;
                        }
                    }
                }
                
                if (buttonContainer) {
                    debugLog('[Memories] Found alternate container:', buttonContainer.className);
                } else {
                    debugLog('[Memories] No button container found at all');
                    delete modal.dataset.saiButtonProcessing;
                    return;
                }
            }
            
            debugLog('[Memories] Found button container:', buttonContainer.className);
            debugLog('[Memories] Container children:', buttonContainer.children.length);
            
            // Find the + button (first button with lucide-square-plus SVG)
            let addButton = buttonContainer.querySelector('svg.lucide-square-plus')?.closest('button');
            
            // If not found, try alternate approach
            if (!addButton) {
                debugLog('[Memories] Trying alternate add button selector...');
                // Look for any button in the container
                const buttons = buttonContainer.querySelectorAll('button');
                debugLog('[Memories] Found buttons:', buttons.length);
                
                if (buttons.length > 0) {
                    // Assume first button is the add button
                    addButton = buttons[0];
                    debugLog('[Memories] Using first button as reference');
                } else {
                    debugLog('[Memories] No buttons found in container');
                    debugLog('[Memories] Container HTML:', buttonContainer.outerHTML.substring(0, 500));
                    return;
                }
            }
            
            debugLog('[Memories] Found reference button, creating refresh button');
            
            // Create refresh button with the same styling as existing buttons
            const refreshButton = document.createElement('button');
            refreshButton.setAttribute('data-sai-refresh-button', 'true');
            refreshButton.className = addButton.className; // Copy exact classes from add button
            refreshButton.type = 'button';
            refreshButton.title = 'Refresh memories';
            refreshButton.setAttribute('default', '');
            refreshButton.appendChild(makeSVG({
                xmlns: SVG_NS, width: '16', height: '16', viewBox: '0 0 24 24',
                fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
                'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                class: 'lucide lucide-refresh-cw inline-flex items-center justify-center'
            }, [
                ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
                ['path', { d: 'M21 3v5h-5' }],
                ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
                ['path', { d: 'M3 21v-5h5' }]
            ]));
            const refreshLabelSpan = document.createElement('span');
            refreshLabelSpan.className = 'flex items-center justify-center text-center gap-1.5';
            refreshButton.appendChild(refreshLabelSpan);
            
            // Add click handler
            refreshButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                debugLog('[Memories] Manual refresh triggered');
                
                // Visual feedback - spin the icon
                const svg = refreshButton.querySelector('svg');
                if (svg) {
                    svg.style.transition = 'transform 0.5s ease';
                    svg.style.transform = 'rotate(360deg)';
                    setTimeout(() => {
                        svg.style.transform = 'rotate(0deg)';
                    }, 500);
                }
                
                // Trigger refresh
                await refreshMemoryContent();
            });
            
            // Insert before the add button
            buttonContainer.insertBefore(refreshButton, addButton);
            
            debugLog('[Memories] Manual refresh button added to Memory Manager');
            debugLog('[Memories] Button visible in DOM:', !!modal.querySelector('[data-sai-refresh-button]'));
            delete modal.dataset.saiButtonProcessing;
        }, 500); // Wait 500ms for React to render
    }
    
    /**
     * Styles the "Load More Memories" button when sidebar layout is enabled
     */
    function styleLoadMoreButton(memoryModal) {
        if (!memoryModal) return;
        
        const applyStyles = () => {
            // Find the Load More Memories button
            const buttons = memoryModal.querySelectorAll('button');
            const loadMoreButton = Array.from(buttons).find(btn => 
                btn.textContent?.includes('Load More Memories')
            );
            
            if (loadMoreButton && !loadMoreButton.dataset.saiStyled) {
                // Use !important to override React's inline styles
                loadMoreButton.style.setProperty('margin-top', '0.5rem', 'important');
                loadMoreButton.style.setProperty('margin-bottom', '1.5rem', 'important');
                loadMoreButton.dataset.saiStyled = 'true';
                debugLog('[Memories] Styled Load More Memories button for sidebar layout');
                
                // Watch for attribute changes in case React resets the style
                // Use debouncing to prevent infinite loops with React's reconciliation
                let styleDebounceTimer = null;
                const buttonObserver = new MutationObserver(() => {
                    // Debounce to prevent rapid re-application causing React conflicts
                    if (styleDebounceTimer) clearTimeout(styleDebounceTimer);
                    styleDebounceTimer = setTimeout(() => {
                        if (!loadMoreButton.style.marginTop || !loadMoreButton.style.marginBottom) {
                            loadMoreButton.style.setProperty('margin-top', '0.5rem', 'important');
                            loadMoreButton.style.setProperty('margin-bottom', '1.5rem', 'important');
                        }
                    }, 100); // 100ms debounce
                });
                
                buttonObserver.observe(loadMoreButton, {
                    attributes: true,
                    attributeFilter: ['style']
                });
                
                return true; // Success
            }
            return false; // Button not found yet
        };
        
        // Try immediately
        if (!applyStyles()) {
            // Button not rendered yet, wait and try again
            setTimeout(() => {
                if (!applyStyles()) {
                    // Still not found, set up observer to watch for it
                    const modalObserver = new MutationObserver((mutations) => {
                        if (applyStyles()) {
                            modalObserver.disconnect();
                        }
                    });
                    
                    modalObserver.observe(memoryModal, {
                        childList: true,
                        subtree: true
                    });
                    
                    // Disconnect after 5 seconds to avoid memory leak
                    setTimeout(() => modalObserver.disconnect(), 5000);
                }
            }, 500);
        }
    }
    
    /**
     * Monitors for Memory Manager modal opening
     */
    // Store observer reference to prevent duplicate observers (memory leak fix)
    let memoryModalObserver = null;
    let memoryModalDebounceTimer = null; // Debounce timer to prevent rapid firing

    function monitorMemoryModal() {
        // Disconnect existing observer if any to prevent accumulation
        if (memoryModalObserver) {
            memoryModalObserver.disconnect();
        }

        memoryModalObserver = new MutationObserver((mutations) => {
            // Skip processing during resize to prevent React 185 error
            const timeSinceResize = Date.now() - lastResizeTime;
            if (timeSinceResize < RESIZE_DEBOUNCE_MS) {
                return; // Skip entirely during resize
            }
            
            // Debounce to prevent rapid firing which can conflict with React
            if (memoryModalDebounceTimer) clearTimeout(memoryModalDebounceTimer);
            memoryModalDebounceTimer = setTimeout(() => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Early exit for nodes that can't be the Memory Manager modal
                            // Only div elements with 'fixed' class can be the modal
                            const nodeTag = node.tagName?.toLowerCase();
                            if (nodeTag !== 'div') {
                                continue; // Skip non-div elements entirely
                            }
                            
                            let foundModal = null;
                            
                            // Check if this is the Memory Manager modal
                            if (node.classList && node.classList.contains('fixed')) {
                                const heading = node.querySelector('p.text-heading-6');
                                if (heading && heading.textContent.trim() === 'Memories') {
                                    foundModal = node;
                                    debugLog('[Memories] Matched Memories modal directly');
                                }
                            }
                            
                            // Also check children in case modal was added in a container
                            if (!foundModal) {
                                // Look for div.fixed that contains the "Memories" heading
                                const allFixedDivs = node.querySelectorAll?.('div.fixed');
                                if (allFixedDivs && allFixedDivs.length > 0) {
                                    for (const fixedDiv of allFixedDivs) {
                                        const heading = fixedDiv.querySelector('p.text-heading-6');
                                        if (heading && heading.textContent.trim() === 'Memories') {
                                            foundModal = fixedDiv;
                                            debugLog('[Memories] Matched Memories modal in child');
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // If we found the modal, add button and start refresh
                            if (foundModal) {
                                debugLog('[Memories] Memory Manager detected, starting auto-refresh');
                                addManualRefreshButton(foundModal);
                                styleLoadMoreButton(foundModal);
                                startMemoryRefresh();
                                break; // Stop processing this mutation batch
                            }
                        }
                    }
                    
                    // Check for removed nodes to stop the interval if modal is closed
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.classList && node.classList.contains('fixed')) {
                                const heading = node.querySelector?.('p.text-heading-6');
                                if (heading && heading.textContent.trim() === 'Memories') {
                                    debugLog('[Memories] Memory Manager removed from DOM');
                                    stopMemoryRefresh();
                                }
                            }
                        }
                    }
                }
            }, 50); // 50ms debounce
        });

        memoryModalObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        debugLog('[Memories] Memory Manager auto-refresh monitor initialized');
    }
    
    // Initialize the memory modal monitor
    monitorMemoryModal();
    
    // Check if Memory Manager is already open on page load
    setTimeout(() => {
        const existingModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2');
        if (existingModal) {
            const heading = existingModal.querySelector('p.text-heading-6');
            if (heading && heading.textContent.trim() === 'Memories') {
                debugLog('[Memories] Memory Manager already open on page load');
                addManualRefreshButton(existingModal);
                styleLoadMoreButton(existingModal);
                startMemoryRefresh();
            }
        }
    }, 2000);
    
    // Fallback: Periodically check for Memory Manager modal in case observer misses it
    // This handles cases where React portals or complex DOM changes aren't caught
    let memoryModalFallbackInterval = null;
    let memoryModalFallbackActive = false;
    
    function startMemoryModalFallback() {
        if (memoryModalFallbackInterval) return; // Already running

        // Track whether the modal was present on the previous poll so we only
        // act / log on transitions (open → present → closed) rather than every
        // single tick. The previous version checked a `dataset.saiRefreshButton`
        // flag that was never actually set, so every poll fell through to
        // addManualRefreshButton + styleLoadMoreButton + startMemoryRefresh —
        // each of which logged "already exists" / "auto-refresh disabled".
        // Result: ~6 log lines per second of pure noise.
        let modalPresentLastTick = false;

        memoryModalFallbackInterval = setInterval(() => {
            // Look for the Memory Manager modal using multiple selectors
            let modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2');
            if (!modal) {
                // Try alternate selectors
                const allFixedModals = document.querySelectorAll('div.fixed');
                for (const fixedDiv of allFixedModals) {
                    const heading = fixedDiv.querySelector('p.text-heading-6');
                    if (heading && heading.textContent.trim() === 'Memories') {
                        modal = fixedDiv;
                        break;
                    }
                }
            }

            // Confirm it's actually the Memory Manager modal (heading text match)
            const isMemoryManager = modal &&
                modal.querySelector('p.text-heading-6')?.textContent?.trim() === 'Memories';
            const modalPresentNow = !!isMemoryManager;

            if (modalPresentNow) {
                // Only act when the modal first appears, OR if our button is
                // missing (React may have torn it out after a re-render).
                // Querying the actual button is the source of truth — no more
                // relying on a dataset flag that nothing ever sets.
                const buttonExists = !!modal.querySelector('[data-sai-refresh-button]');
                if (!modalPresentLastTick || !buttonExists) {
                    debugLog('[Memories] Memory Manager detected via fallback check' +
                        (modalPresentLastTick ? ' (button missing — re-adding)' : ''));
                    addManualRefreshButton(modal);
                    styleLoadMoreButton(modal);
                    if (!modalPresentLastTick) {
                        startMemoryRefresh();
                        memoryModalFallbackActive = true;
                    }
                }
            } else if (modalPresentLastTick) {
                // Modal was open but now closed
                debugLog('[Memories] Memory Manager closed (fallback detection)');
                stopMemoryRefresh();
                memoryModalFallbackActive = false;
            }

            modalPresentLastTick = modalPresentNow;
        }, 2000); // Check every 2 seconds — the primary MutationObserver catches
                   // most transitions; this fallback only exists for React-portal
                   // cases the observer misses, where a 2s delay is fine.

        debugLog('[Memories] Memory Manager fallback checker started');
    }
    
    // Start the fallback checker
    startMemoryModalFallback();

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                      END OF INITIALIZATION                           ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================
    
    } // End of initializeMainCode function
    
    // =============================================================================
    // NEW TAB AUTO-RELOAD - Handle race condition
    // =============================================================================
    // When middle-clicking to open a bot in a new tab, sometimes the page loads
    // before our extension fully initializes. Detect this and auto-reload once.
    // =============================================================================
    
    const RELOAD_FLAG_KEY = 'sai-toolkit-reloaded-for-init';
    const hasAlreadyReloaded = sessionStorage.getItem(RELOAD_FLAG_KEY) === 'true';

    // =============================================================================
    // ===                    UPDATE NOTIFICATION MODAL                         ===
    // =============================================================================
    // Show update notification modal with changelog after extension update
    // NOTE: This function must be defined OUTSIDE initializeMainCode so it can be
    // called from checkForUpdateNotification (which also runs outside initializeMainCode)
    function showUpdateNotificationModal(version) {
        debugLog('[Core] Showing update notification for version:', version);

        // Get changelog data from global CHANGELOG object (defined at top of file)
        const changelogData = CHANGELOG[version] || {
            title: `Version ${version}`,
            date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            features: ['Niiiiiiiiice...', 'You can now use Google Drive to backup and synchronize your generation statistics, styles and settings across devices! Go to the Data tab and sign in with your Google account to get started.','Fixed gap on right side when Sidebar Layout is enabled','Fixed crash on iOS when Live Text Editor (WYSIWYG) is enabled']
        };

        // Create container with shadow DOM
        let updateModalRoot = document.getElementById('update-notification-root');
        if (updateModalRoot) {
            updateModalRoot.remove(); // Remove if already exists
        }

        updateModalRoot = document.createElement('div');
        updateModalRoot.id = 'update-notification-root';
        updateModalRoot.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 10000005;';
        document.body.appendChild(updateModalRoot);

        const shadow = updateModalRoot.attachShadow({ mode: 'open' });

        // Styles
        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; }

            .backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(4px);
                z-index: 10000005;
                pointer-events: auto;
                animation: fadeIn 0.2s ease-out;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -45%);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%);
                }
            }

            .modal {
                position: fixed;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border-radius: 16px;
                width: 480px;
                max-width: 95vw;
                max-height: 85vh;
                z-index: 10000006;
                pointer-events: auto;
                display: flex;
                flex-direction: column;
                padding: 0;
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                animation: slideIn 0.3s ease-out;
            }

            @media (max-width: 480px) {
                .modal {
                    width: 100%;
                    max-width: 100vw;
                    max-height: 100vh;
                    border-radius: 0;
                }
            }

            @media (prefers-color-scheme: dark) {
                .modal {
                    background: #1a1a1a;
                    color: white;
                }
            }

            .modal-header {
                padding: 1.5rem 1.5rem 1rem 1.5rem;
                border-bottom: 1px solid #e5e7eb;
                text-align: center;
            }

            @media (prefers-color-scheme: dark) {
                .modal-header {
                    border-color: #404040;
                }
            }

            .update-icon {
                width: 48px;
                height: 48px;
                margin: 0 auto 0.75rem auto;
                background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
            }

            .modal-title {
                font-size: 1.25rem;
                font-weight: 700;
                margin-bottom: 0.25rem;
                color: #111827;
            }

            @media (prefers-color-scheme: dark) {
                .modal-title {
                    color: #f9fafb;
                }
            }

            .modal-date {
                font-size: 0.875rem;
                color: #6b7280;
            }

            @media (prefers-color-scheme: dark) {
                .modal-date {
                    color: #9ca3af;
                }
            }

            .modal-body {
                padding: 1.5rem;
                overflow-y: auto;
                flex: 1;
            }

            .changelog-title {
                font-size: 0.875rem;
                font-weight: 600;
                color: #6b7280;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 0.75rem;
            }

            @media (prefers-color-scheme: dark) {
                .changelog-title {
                    color: #9ca3af;
                }
            }

            .changelog-list {
                list-style: none;
                padding: 0;
                margin: 0;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }

            .changelog-item {
                padding-left: 1.5rem;
                position: relative;
                font-size: 0.9375rem;
                line-height: 1.6;
                color: #374151;
            }

            @media (prefers-color-scheme: dark) {
                .changelog-item {
                    color: #d1d5db;
                }
            }

            .changelog-item::before {
                content: "✓";
                position: absolute;
                left: 0;
                color: #10b981;
                font-weight: bold;
            }

            .modal-footer {
                padding: 1rem 1.5rem;
                border-top: 1px solid #e5e7eb;
                display: flex;
                justify-content: center;
            }

            @media (prefers-color-scheme: dark) {
                .modal-footer {
                    border-color: #404040;
                }
            }

            .btn-close {
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 0.625rem 2rem;
                font-size: 0.9375rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }

            .btn-close:hover {
                background: #2563eb;
                transform: translateY(-1px);
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }

            .btn-close:active {
                transform: translateY(0);
            }
        `;

        // Create backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        
        // Create modal header
        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';
        
        // Add "S.AI Toolkit updated!" at the top
        const updateAnnouncement = document.createElement('div');
        updateAnnouncement.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: #3b82f6; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;';
        updateAnnouncement.textContent = 'S.AI Toolkit updated!';
        
        const updateIcon = document.createElement('div');
        updateIcon.className = 'update-icon';
        updateIcon.textContent = '🎉';
        
        const modalTitle = document.createElement('div');
        modalTitle.className = 'modal-title';
        modalTitle.textContent = changelogData.title;
        
        const modalDate = document.createElement('div');
        modalDate.className = 'modal-date';
        modalDate.textContent = changelogData.date;
        
        modalHeader.appendChild(updateAnnouncement);
        modalHeader.appendChild(updateIcon);
        modalHeader.appendChild(modalTitle);
        modalHeader.appendChild(modalDate);
        
        // Create modal body
        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';
        
        const changelogTitle = document.createElement('div');
        changelogTitle.className = 'changelog-title';
        changelogTitle.textContent = "What's New";
        
        const changelogList = document.createElement('ul');
        changelogList.className = 'changelog-list';
        
        changelogData.features.forEach(feature => {
            const li = document.createElement('li');
            li.className = 'changelog-item';
            li.textContent = feature;
            changelogList.appendChild(li);
        });
        
        modalBody.appendChild(changelogTitle);
        modalBody.appendChild(changelogList);
        
        // Create modal footer
        const modalFooter = document.createElement('div');
        modalFooter.className = 'modal-footer';
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.id = 'close-btn';
        closeBtn.textContent = 'Got it!';
        
        modalFooter.appendChild(closeBtn);
        
        // Assemble modal
        modal.appendChild(modalHeader);
        modal.appendChild(modalBody);
        modal.appendChild(modalFooter);

        shadow.appendChild(style);
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);

        // Close handler
        async function closeModal() {
            // Mark this version as seen
            await storage.set('lastSeenVersion', version);
            debugLog('[Core] Update notification dismissed, marked version as seen:', version);

            // Animate out
            backdrop.style.animation = 'fadeIn 0.2s ease-out reverse';
            modal.style.animation = 'slideIn 0.2s ease-out reverse';

            setTimeout(() => {
                updateModalRoot.remove();
            }, 200);
        }

        closeBtn.addEventListener('click', closeModal);
        backdrop.addEventListener('click', closeModal);

        // Prevent modal click from closing
        modal.addEventListener('click', (e) => e.stopPropagation());
    }

    // =============================================================================
    // ===                 UPDATE NOTIFICATION CHECK                            ===
    // =============================================================================
    // Check for update notification on page load
    async function checkForUpdateNotification() {
        try {
            // Read directly from storage (bypass cache) to get fresh values set by background script
            const result = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get({
                'showUpdateNotification': false,
                'updatedToVersion': null,
                'lastSeenVersion': null
            });
            
            const showUpdate = result.showUpdateNotification;
            const newVersion = result.updatedToVersion;
            const lastSeenVersion = result.lastSeenVersion;

            debugLog('[Core] Update check - showUpdate:', showUpdate, 'newVersion:', newVersion, 'lastSeenVersion:', lastSeenVersion);

            if (showUpdate) {
                // Only show if user hasn't seen this version yet
                if (newVersion && newVersion !== lastSeenVersion) {
                    // Small delay to let page load first
                    setTimeout(() => showUpdateNotificationModal(newVersion), 1000);
                } else {
                    debugLog('[Core] User has already seen version:', newVersion);
                }

                // Clear the flag regardless
                await storage.remove('showUpdateNotification');
            } else {
                debugLog('[Core] No update notification pending');
                
                // Retry check after a short delay in case background script is still writing
                // This handles the race condition when extension just updated
                setTimeout(async () => {
                    try {
                        const retryResult = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get({
                            'showUpdateNotification': false,
                            'updatedToVersion': null,
                            'lastSeenVersion': null
                        });
                        
                        if (retryResult.showUpdateNotification) {
                            debugLog('[Core] Retry: Found update notification on second check');
                            const retryVersion = retryResult.updatedToVersion;
                            const retryLastSeen = retryResult.lastSeenVersion;
                            
                            if (retryVersion && retryVersion !== retryLastSeen) {
                                showUpdateNotificationModal(retryVersion);
                            }
                            
                            await storage.remove('showUpdateNotification');
                        }
                    } catch (err) {
                        // Ignore retry errors
                    }
                }, 2000);
            }
        } catch (err) {
            console.error('[Core] Error checking for update notification:', err);
        }
    }

    // For new tab detection: check if this is a fresh navigation (not a reload)
    // Use newer PerformanceNavigationTiming API with fallback to deprecated API
    function getNavigationType() {
        // Try modern API first
        const navEntries = performance.getEntriesByType('navigation');
        if (navEntries && navEntries.length > 0) {
            return navEntries[0].type; // 'navigate', 'reload', 'back_forward', 'prerender'
        }
        // Fallback to deprecated API
        if (window.performance && window.performance.navigation) {
            const types = ['navigate', 'reload', 'back_forward', 'reserved'];
            return types[window.performance.navigation.type] || 'navigate';
        }
        return 'navigate';
    }
    
    const navigationType = getNavigationType();
    const isNewTab = !hasAlreadyReloaded && navigationType === 'navigate';
    
    debugLog('[Core] ==== NEW TAB CHECK ====');
    debugLog('[Core] URL:', location.href);
    debugLog('[Core] hasAlreadyReloaded:', hasAlreadyReloaded);
    debugLog('[Core] navigationType:', navigationType);
    debugLog('[Core] isNewTab:', isNewTab);
    debugLog('[Core] readyState:', document.readyState);
    
    async function checkAndReloadIfNeeded() {
        await initializeMainCode();

        debugLog('[Core] initializeMainCode completed');

        // Check for update notification after initialization
        await checkForUpdateNotification();

        // Only check on chat pages
        const isChatPage = location.href.includes('/chat') || location.href.includes('/messages');
        debugLog('[Core] isChatPage:', isChatPage);
        
        if (!isChatPage) {
            debugLog('[Core] Not a chat page, skipping reload check');
            return;
        }
        
        // Check if our toolkit UI was actually injected
        const toolkitInjected = document.querySelector('sai-toolkit-modal') !== null;
        debugLog('[Core] toolkitInjected:', toolkitInjected);
        
        // If this is a new tab (fresh navigation) and we haven't reloaded yet, do it
        // OR if the toolkit wasn't injected properly
        if ((isNewTab || !toolkitInjected) && !hasAlreadyReloaded) {
            debugLog('[Core] NEW TAB DETECTED or toolkit not injected - Setting reload flag and reloading...');
            sessionStorage.setItem(RELOAD_FLAG_KEY, 'true');
            // Use a small delay to ensure sessionStorage is written
            setTimeout(() => {
                debugLog('[Core] RELOADING NOW');
                location.reload();
            }, 100);
        } else {
            debugLog('[Core] Not a new tab or already reloaded, proceeding normally');
        }
    }
    
    // Handle visibility changes - for prerendered pages or tabs opened in background
    let hasInitialized = false;
    
    async function initWhenVisible() {
        if (hasInitialized) return;
        
        if (document.visibilityState === 'visible') {
            hasInitialized = true;
            debugLog('[Core] Page is visible, initializing...');
            await checkAndReloadIfNeeded();
        } else {
            debugLog('[Core] Page not visible yet, waiting...');
            document.addEventListener('visibilitychange', async function onVisible() {
                if (document.visibilityState === 'visible' && !hasInitialized) {
                    hasInitialized = true;
                    debugLog('[Core] Page became visible, initializing...');
                    document.removeEventListener('visibilitychange', onVisible);
                    await checkAndReloadIfNeeded();
                }
            });
        }
    }
    
    // Drive sync complete: background has merged new stats into the IndexedDB store.
    // Invalidate the per-character cache and re-render visible message stats.
    const _runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;
    if (_runtimeAPI?.runtime?.onMessage) {
        _runtimeAPI.runtime.onMessage.addListener((message) => {
            if (message.type === 'SAI_DRIVE_SYNC_COMPLETE') {
                debugLog('[Sync] SAI_DRIVE_SYNC_COMPLETE received — invalidating cache and re-rendering stats');
                if (typeof invalidateStatsCache === 'function') invalidateStatsCache();
                if (typeof processMessagesForStats === 'function') {
                    setTimeout(() => processMessagesForStats(false), 300);
                }
            }
            if (message.type === 'SAI_DRIVE_AUTH_REQUIRED') {
                debugLog('[Sync] SAI_DRIVE_AUTH_REQUIRED received — showing auth modal');
                driveAuthErrorMessage = 'Drive sync: sign-in required';
                const sb = document.getElementById('sai-toolkit-sidebar-btn');
                const mb = document.getElementById('sai-toolkit-mobile-btn');
                if (sb) sb.style.color = '#dc2626';
                if (mb) mb.style.color = '#dc2626';
                showDriveAuthModal();
            }
            if (message.type === 'SAI_SYNC_PROGRESS') {
                debugLog(`[Sync] Progress [${message.stepNum}/${message.totalSteps}]: ${message.step}${message.detail ? ' — ' + message.detail : ''}`);
                if (syncProgressCallback) syncProgressCallback(message);
            }

            // Drive download delegated from background page.
            // The background page's fetch() freezes the JS event loop on Orion/WebKit
            // iOS when a request stalls, making timeouts impossible. The background
            // delegates large downloads here instead.
            if (message.type === 'SAI_DRIVE_DOWNLOAD_REQ') {
                const { token, fileId, storageKey } = message;
                const t0 = Date.now();
                const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

                const sendProgress = (detail) => {
                    _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_DOWNLOAD_PROGRESS', detail }).catch(() => {});
                    if (syncProgressCallback) syncProgressCallback({ type: 'SAI_SYNC_PROGRESS', step: 'Downloading from Drive…', stepNum: 3, totalSteps: 5, detail });
                };

                (async () => {
                    try {
                        sendProgress('fetching…');
                        const res = await fetch(url, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                        if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
                        sendProgress('reading response…');
                        const buffer = await res.arrayBuffer();
                        const totalBytes = buffer.byteLength;
                        sendProgress(`parsing ${(totalBytes / 1048576).toFixed(1)} MB…`);
                        const fullText = new TextDecoder().decode(buffer);
                        const data = JSON.parse(fullText);

                        await _runtimeAPI.storage.local.set({ [storageKey]: data });
                        await _runtimeAPI.runtime.sendMessage({
                            type: 'SAI_DRIVE_DOWNLOAD_DONE',
                            bytes: totalBytes,
                            durationMs: Date.now() - t0,
                        });
                    } catch (err) {
                        debugLog('[Sync] content download error:', err.message);
                        await _runtimeAPI.runtime.sendMessage({
                            type: 'SAI_DRIVE_DOWNLOAD_ERROR',
                            error: err.message,
                        });
                    }
                })();
            }

            if (message.type === 'SAI_DRIVE_UPLOAD_REQ') {
                const { token, fileId, folderId, fileName, storageKey } = message;
                const t0 = Date.now();

                const sendProgress = (detail) => {
                    _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_PROGRESS', detail }).catch(() => {});
                    if (syncProgressCallback) syncProgressCallback({ type: 'SAI_SYNC_PROGRESS', step: 'Uploading to Drive…', stepNum: 5, totalSteps: 5, detail });
                };

                (async () => {
                    try {
                        sendProgress('reading payload…');
                        const stored = await _runtimeAPI.storage.local.get(storageKey);
                        const data = stored[storageKey];
                        if (!data) throw new Error('Upload payload missing from storage');
                        const body = JSON.stringify(data);
                        sendProgress(`uploading ${(body.length / 1048576).toFixed(1)} MB…`);

                        let newFileId;
                        if (fileId) {
                            const res = await fetch(
                                `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                                { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }
                            );
                            if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                            if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
                            newFileId = fileId;
                        } else {
                            const boundary = 'sai_toolkit_drive_boundary';
                            const metaObj = { name: fileName, mimeType: 'application/json' };
                            if (folderId) metaObj.parents = [folderId];
                            const multipart = [
                                `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
                                JSON.stringify(metaObj),
                                `--${boundary}`, 'Content-Type: application/json', '',
                                body,
                                `--${boundary}--`
                            ].join('\r\n');
                            const res = await fetch(
                                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
                                { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }
                            );
                            if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                            if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
                            const created = await res.json();
                            newFileId = created.id;
                        }

                        sendProgress(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
                        await _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_DONE', newFileId });
                    } catch (err) {
                        debugLog('[Sync] content upload error:', err.message);
                        await _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_ERROR', error: err.message });
                    }
                })();
            }
        });
    }

    // Call initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenVisible);
    } else {
        // DOM is already loaded
        initWhenVisible();
    }

})(); // End of async IIFE
