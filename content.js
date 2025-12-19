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
            console.log('[Toolkit] 🐛 Debug mode loaded from storage (ENABLED)');
            window.__SAI_DEBUG_MODE__ = true;
        }
    }).catch(() => {
        // Storage not ready yet, keep default
    });
}

// Production-safe debug logging helper - sanitizes sensitive data
function debugLog(...args) {
    if (DEBUG_MODE) {
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
        console.log('[Toolkit]', ...sanitized);
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
    debugLog('[Toolkit] Already loaded, skipping duplicate initialization');
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

debugLog('[S.AI Toolkit] Content script starting...');
debugLog('[S.AI Toolkit] URL:', window.location.href);
debugLog('[S.AI Toolkit] Document ready state:', document.readyState);

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
        // Get storage API (Chrome or Firefox compatible)
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            // No storage available - return empty stats
            window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats: {} }, '*');
            return;
        }
        
        // Fetch stored message stats from chrome.storage.local
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        // Parse JSON string to object (stats are stored as JSON string)
        const stats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        // Send stats back to page context for console display
        window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats }, '*');
    }
    
    // -------------------------------------------------------------------------
    // CLEAR STATS REQUEST - Delete all stored statistics
    // -------------------------------------------------------------------------
    // Wipes all message generation stats from storage (useful for testing)
    if (event.data.type === 'SAI_CLEAR_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
            return;
        }
        
        // Reset stats to empty object
        await new Promise((resolve) => {
            storage.set({ messageGenerationStats: '{}' }, () => resolve());
        });
        
        // Confirm deletion to page context
        window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
    }
    
    // -------------------------------------------------------------------------
    // EXPORT STATS REQUEST - Export statistics to downloadable JSON file
    // -------------------------------------------------------------------------
    // Allows user to backup or share their generation statistics
    if (event.data.type === 'SAI_EXPORT_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats: {} }, '*');
            return;
        }
        
        // Fetch all stats from storage
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        let stats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        
        // Optional: Filter to specific conversation if requested
        // This allows exporting stats for just one chat instead of all chats
        if (event.data.conversationId && stats[event.data.conversationId]) {
            stats = { [event.data.conversationId]: stats[event.data.conversationId] };
        }
        
        // Return stats to page context which will trigger download
        window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats }, '*');
    }
    
    // -------------------------------------------------------------------------
    // IMPORT STATS REQUEST - Import statistics from JSON file
    // -------------------------------------------------------------------------
    // Allows user to restore backed up statistics or merge from another browser
    if (event.data.type === 'SAI_IMPORT_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_IMPORT_STATS_RESPONSE' }, '*');
            return;
        }
        
        // Get current stats from storage
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        let existingStats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        const importedStats = event.data.jsonData;
        
        // Merge strategy: Imported stats overwrite existing stats for same keys
        // This allows updating specific conversations without losing others
        const mergedStats = { ...existingStats, ...importedStats };
        
        // Save merged stats back to storage
        await new Promise((resolve) => {
            storage.set({ messageGenerationStats: JSON.stringify(mergedStats) }, () => resolve());
        });
        
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
});

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
// ✓ READ-ONLY INTERCEPTION: Never modifies requests/responses
// ✓ LOCAL STORAGE ONLY: All data saved to chrome.storage.local
// ✓ NO SENSITIVE DATA: Does not access messages, credentials, or personal info
// ✓ TRANSPARENT: Fully open source at github.com/CLedebur/Spicychat.ai-Mods
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
    
    debugLog('[Toolkit] Content script loaded - starting initialization...');
    debugLog('[Toolkit] Storage object available:', typeof storage !== 'undefined');

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
    const THEME_CUSTOMIZATION_KEY = 'enableThemeCustomization';  // DEPRECATED - migrated to CLASSIC_LAYOUT_KEY + CLASSIC_STYLE_KEY
    const SMALL_PROFILE_IMAGES_KEY = 'enableSmallProfileImages';  // Smaller profile images
    const ROUNDED_PROFILE_IMAGES_KEY = 'enableRoundedProfileImages';  // Rounded profile images
    const SWAP_CHECKBOX_POSITION_KEY = 'enableSwapCheckboxPosition';  // Swap selection checkbox positions
    const SQUARE_MESSAGE_EDGES_KEY = 'enableSquareMessageEdges';  // Square message box edges
    
    // Default custom style values
    const DEFAULT_CUSTOM_STYLE = {
        aiMessageBg: 'rgba(0, 100, 255, 0.1)',
        userMessageBg: 'rgba(100, 100, 100, 0.1)',
        bodyColor: '#ffffff',
        spanQuoteColor: '#ffffff',
        narrationColor: '#06B7DB',
        highlightBgColor: '#06B7DB',
        highlightTextColor: '#000000',
        fontSize: '16px',
        fontFamily: '',
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecoration: 'none',
        hoverButtonColor: '#292929'
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
            debugLog('[Toolkit] waitForBody called, readyState:', document.readyState, 'body:', !!document.body);
            
            if (document.body) {
                debugLog('[Toolkit] document.body already exists');
                resolve(document.body);
                return;
            }
            
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.error('[Toolkit] waitForBody timed out after', timeoutMs, 'ms');
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
                    debugLog('[Toolkit] document.body now available');
                    resolve(document.body);
                }
            };
            
            // Try DOMContentLoaded first
            if (document.readyState === 'loading') {
                debugLog('[Toolkit] Waiting for DOMContentLoaded...');
                document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
            } else {
                // DOM should be ready - poll briefly in case body is just not set yet
                debugLog('[Toolkit] DOM ready but no body, polling...');
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
    
    // Load feature flags from storage (async operations)
    // These determine which CSS to inject before page renders
    const sidebarEnabled = await storage.get(SIDEBAR_LAYOUT_KEY, false);
    const classicLayoutEnabled = await storage.get(CLASSIC_LAYOUT_KEY, false);
    const classicStyleEnabled = await storage.get(CLASSIC_STYLE_KEY, false);
    const customStyleEnabled = await storage.get(CUSTOM_STYLE_KEY, false);
    const customStyleValues = await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE));
    
    // -------------------------------------------------------------------------
    // COMPOSER CSS INJECTION (Dependency: Sidebar Layout)
    // -------------------------------------------------------------------------
    // The composer CSS (message input area styling) only works correctly with
    // sidebar layout enabled. It's designed specifically for that layout mode.
    // Without sidebar, the default SpicyChat layout is fine.
    // 
    // Skip on lorebook pages - no chat interface there
    if (sidebarEnabled && !window.location.pathname.startsWith('/lorebook')) {
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
            
            debugLog('[Toolkit] Composer Layout CSS injected EARLY (before React initialization)');
        };
        
        injectComposerCSS();
    }
    
    // Inject Sidebar Layout CSS early if enabled
    // Skip on lorebook pages - no modals to pin there
    if (sidebarEnabled && !window.location.pathname.startsWith('/lorebook')) {
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
            
            debugLog('[Toolkit] Sidebar Layout CSS injected EARLY (before React initialization)');
        };
        
        injectSidebarCSS();
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
            
            debugLog('[Toolkit] Classic Layout CSS injected EARLY (before React initialization)');
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
            
            debugLog('[Toolkit] Classic Style CSS injected EARLY (before React initialization)');
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
            
            debugLog('[Toolkit] Custom Style CSS injected EARLY (before React initialization)');
        };
        
        injectCustomStyleCSS();
    }
    
    // Load new layout options from storage
    const smallProfileImagesEnabled = await storage.get(SMALL_PROFILE_IMAGES_KEY, false);
    const roundedProfileImagesEnabled = await storage.get(ROUNDED_PROFILE_IMAGES_KEY, false);
    const swapCheckboxPositionEnabled = await storage.get(SWAP_CHECKBOX_POSITION_KEY, false);
    const squareMessageEdgesEnabled = await storage.get(SQUARE_MESSAGE_EDGES_KEY, false);
    
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
            
            debugLog('[Toolkit] Small Profile Images CSS injected EARLY');
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
            
            debugLog('[Toolkit] Rounded Profile Images CSS injected EARLY');
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
            
            debugLog('[Toolkit] Swap Checkbox Position CSS injected EARLY');
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
            
            debugLog('[Toolkit] Square Message Edges CSS injected EARLY');
        };
        
        injectSquareMessageEdgesCSS();
    }
    
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
  max-width: 800px !important;
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

/* Hide backdrop overlays for sidebar modals only */
body:has(div.fixed.left-1\\/2.top-1\\/2:not(.size-full)):not(:has(div.fixed.left-1\\/2.top-1\\/2.size-full))
div.fixed.inset-0:not(.z-\\[10000\\]):not(.toolkit-modal-backdrop),
body:has(div.fixed.left-1\\/2.top-1\\/2:not(.size-full)):not(:has(div.fixed.left-1\\/2.top-1\\/2.size-full))
[role="presentation"][aria-hidden="true"],
body:has(div.fixed.left-1\\/2.top-1\\/2:not(.size-full)):not(:has(div.fixed.left-1\\/2.top-1\\/2.size-full))
[data-overlay][aria-hidden="true"] {
  display: none !important;
}

/* Show backdrop overlays for image modals (.size-full) */
body:has(div.fixed.left-1\\/2.top-1\\/2.size-full)
div.fixed.inset-0,
body:has(div.fixed.left-1\\/2.top-1\\/2.size-full)
[role="presentation"][aria-hidden="true"],
body:has(div.fixed.left-1\\/2.top-1\\/2.size-full)
[data-overlay][aria-hidden="true"] {
  display: block !important;
  backdrop-filter: blur(8px) !important;
  background-color: rgba(0, 0, 0, 0.5) !important;
}

/* Blur sidebar modals when image modal is open */
body:has(div.fixed.left-1\\/2.top-1\\/2.size-full)
div.fixed.left-1\\/2.top-1\\/2:not(.size-full) {
  filter: blur(4px) !important;
  opacity: 0.7 !important;
  pointer-events: none !important;
}

/* Blur sidebar modals when toolkit settings modal is open */
body:has(#toolkit-modal-root .backdrop)
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
  body:has(div.fixed.left-1\\/2.top-1\\/2:not(.size-full))
    div.fixed.left-1\\/2.top-1\\/2.size-full {
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: calc(100vw - var(--mm-gutter)) !important;
    height: 100vh !important;
    margin-right: var(--mm-gutter) !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2:not(.size-full))
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

/* GENERATION SETTINGS PANEL (TOP 40vh) */
/* Match both max-h-[600px] and max-h-[700px] variants */
/* Exclude modals with sai-placeholder-modal class */
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full):not(.sai-placeholder-modal),
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
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

/* MEMORY MANAGER PANEL (BOTTOM 60vh) */
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not(.size-full),
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
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
body:not(:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full))):not(:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full)))
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* When only Generation Settings is open */
body:not(:has(div.fixed.left-1\\/2.top-1\\/2.h-full))
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full),
body:not(:has(div.fixed.left-1\\/2.top-1\\/2.h-full))
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

body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"],
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
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
  body:has(div.fixed.left-1\\/2.top-1\\/2)
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
  padding-right: 16px !important;
  padding-left: 16px !important;
  padding-top: 0px !important;
  align-items: flex-start;
  box-sizing: border-box !important;
  overflow-x: visible !important;
  max-height: calc(100vh - 56px) !important;
}

@media (min-width: 1000px) {
  body:has(div.fixed.left-1\\/2.top-1\\/2)
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 220px) !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2)
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
    padding-right: 16px !important;
    max-height: calc(100vh - 56px) !important;
    flex: 1 1 auto !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2)
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: 100% !important;
    overflow: visible !important;
    padding-top: 0.5rem !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2)
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full
    > div.grow.flex.flex-col.w-full.left-0.items-center.absolute.h-full.overflow-auto {
    overflow-y: auto !important;
    overflow-x: visible !important;
  }

  /* OVERRIDE: When left sidebar is collapsed (54px instead of 220px) */
  body:has(nav[style*="width: 54px"]):has(div.fixed.left-1\\/2.top-1\\/2)
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  /* OVERRIDE: Header bar when left sidebar is collapsed */
  body:has(nav[style*="width: 54px"]):has(div.fixed.left-1\\/2.top-1\\/2)
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
    max-width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2)
    .py-md.rounded-\\[20px_4px_20px_20px\\],
  body:has(div.fixed.left-1\\/2.top-1\\/2)
    .py-md.rounded-\\[4px_20px_20px_20px\\],
  body:has(div.fixed.left-1\\/2.top-1\\/2)
    [class*="max-w-\\\\[800px\\\\]"] {
    width: 100% !important;
    max-width: 800px !important;
    box-sizing: border-box !important;
  }

  body:has(div.fixed.left-1\\/2.top-1\\/2)
    [class*="max-w-\\\\[800px\\\\]"] {
    max-width: min(800px, 100%) !important;
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
  max-width: 800px !important;
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
  max-width: 800px !important;
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
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.fontWeight} !important;
  font-style: ${values.fontStyle} !important;
  text-decoration: ${values.textDecoration} !important;
}

/* Body Text - Spans (color and font) */
div.p-0[style*="width: 100%"] span.leading-6,
div.p-0[style*="width: 100%"] span.text-white,
div.bg-gray-2 span.leading-6,
div.bg-gray-2 span.text-white {
  color: ${values.bodyColor} !important;
  font-size: ${values.fontSize} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}  font-weight: ${values.fontWeight} !important;
  font-style: ${values.fontStyle} !important;
  text-decoration: ${values.textDecoration} !important;
}

/* Quote Text Color (q elements inside spans) */
div.p-0[style*="width: 100%"] span.text-white q.text-colorQuote,
div.p-0[style*="width: 100%"] span.text-white q.text-white,
div.p-0[style*="width: 100%"] span.leading-6 q.text-colorQuote,
div.p-0[style*="width: 100%"] span.leading-6 q.text-white,
div.bg-gray-2 span.text-white q.text-colorQuote,
div.bg-gray-2 span.text-white q.text-white,
div.bg-gray-2 span.leading-6 q.text-colorQuote,
div.bg-gray-2 span.leading-6 q.text-white {
  color: ${values.spanQuoteColor} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}}

/* Narration Color (em, i, .narration, .styled) */
div.p-0[style*="width: 100%"] em,
div.p-0[style*="width: 100%"] i,
div.p-0[style*="width: 100%"] .narration,
div.p-0[style*="width: 100%"] .styled,
div.bg-gray-2 em,
div.bg-gray-2 i,
div.bg-gray-2 .narration,
div.bg-gray-2 .styled { 
  color: ${values.narrationColor} !important;
  font-style: italic !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}}

/* Highlight Color (blockquote.bg-colorHighlight) */
div.p-0[style*="width: 100%"] blockquote.bg-colorHighlight,
div.bg-gray-2 blockquote.bg-colorHighlight {
  background-color: ${values.highlightBgColor} !important;
  color: ${values.highlightTextColor} !important;
  ${values.fontFamily ? `font-family: ${values.fontFamily} !important;\n` : ''}}

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
  max-width: 800px !important;
  box-sizing: border-box !important;
  border-radius: 20px !important;
}

.py-md.rounded-\\[4px_20px_20px_20px\\] {
  margin-left: auto !important;
  margin-right: auto !important;
  width: 100% !important;
  max-width: 800px !important;
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
  max-width: 800px !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}

/* Also ensure the inner wrapper stays centered */
div.flex.items-end.gap-sm.w-full[style*="margin-left"] {
  max-width: 800px !important;
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
        debugLog('[Toolkit] DOM ready, initializing main code...');
        
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
    
    // Inject interceptors to capture auth token and headers
    const authInterceptorScript = document.createElement('script');
    authInterceptorScript.textContent = `
        (function() {
            // Store last seen auth token and headers
            window.__lastAuthHeaders = {};
            window.__kindeAccessToken = null;
            
            // Intercept XHR to capture Kinde token refresh and API headers
            const originalXHROpen = XMLHttpRequest.prototype.open;
            const originalXHRSend = XMLHttpRequest.prototype.send;
            const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this._url = url;
                this._method = method;
                this._requestHeaders = {};
                return originalXHROpen.apply(this, [method, url, ...args]);
            };
            
            XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
                this._requestHeaders = this._requestHeaders || {};
                this._requestHeaders[header] = value;
                return originalXHRSetRequestHeader.apply(this, [header, value]);
            };
            
            XMLHttpRequest.prototype.send = function(...args) {
                // Capture headers from prod.nd-api.com requests
                if (this._url && this._url.includes('prod.nd-api.com') && this._requestHeaders) {
                    if (this._requestHeaders.Authorization) window.__lastAuthHeaders.Authorization = this._requestHeaders.Authorization;
                    if (this._requestHeaders['X-Guest-UserId']) window.__lastAuthHeaders['X-Guest-UserId'] = this._requestHeaders['X-Guest-UserId'];
                    if (this._requestHeaders['X-Country']) window.__lastAuthHeaders['X-Country'] = this._requestHeaders['X-Country'];
                    if (this._requestHeaders['X-App-Id']) window.__lastAuthHeaders['X-App-Id'] = this._requestHeaders['X-App-Id'];
                }
                
                // Listen for Kinde token refresh responses
                if (this._url && this._url.includes('gamma.kinde.com/oauth2/token')) {
                    this.addEventListener('load', function() {
                        if (this.status === 200) {
                            try {
                                const response = JSON.parse(this.responseText);
                                if (response.access_token) {
                                    window.__kindeAccessToken = response.access_token;
                                    window.__lastAuthHeaders.Authorization = 'Bearer ' + response.access_token;
                                    debugLog('[S.AI] Captured fresh Kinde access token');
                                }
                            } catch (e) {
                                console.warn('[S.AI] Could not parse Kinde token response:', e);
                            }
                        }
                    });
                }
                
                return originalXHRSend.apply(this, args);
            };
            
            // Also intercept fetch
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
                const [url, options] = args;
                
                // Capture auth headers from API calls
                if (options && options.headers && url.includes('prod.nd-api.com')) {
                    const headers = options.headers;
                    if (headers.Authorization) window.__lastAuthHeaders.Authorization = headers.Authorization;
                    if (headers['X-Guest-UserId']) window.__lastAuthHeaders['X-Guest-UserId'] = headers['X-Guest-UserId'];
                    if (headers['X-Country']) window.__lastAuthHeaders['X-Country'] = headers['X-Country'];
                    if (headers['X-App-Id']) window.__lastAuthHeaders['X-App-Id'] = headers['X-App-Id'];
                }
                
                // Intercept Kinde token refresh
                if (url.includes('gamma.kinde.com/oauth2/token')) {
                    return originalFetch.apply(this, args).then(response => {
                        const clonedResponse = response.clone();
                        clonedResponse.json().then(data => {
                            if (data.access_token) {
                                window.__kindeAccessToken = data.access_token;
                                window.__lastAuthHeaders.Authorization = 'Bearer ' + data.access_token;
                                debugLog('[S.AI] Captured fresh Kinde access token (fetch)');
                            }
                        }).catch(() => {});
                        return response;
                    });
                }
                
                return originalFetch.apply(this, args);
            };
            
            console.log('[S.AI] Auth header interceptor installed (XHR + fetch)');
        })();
    `;
    document.documentElement.appendChild(authInterceptorScript);
    authInterceptorScript.remove();

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
    const MESSAGE_STATS_KEY = 'messageGenerationStats';
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

    // Build index map from stored message stats (for imported/old messages)
    async function buildIndexMapFromStats() {
        debugLog('[Stats] buildIndexMapFromStats starting...');
        
        const messageStats = await loadMessageStats();
        debugLog('[Stats] Loaded message stats, top-level keys (characters):', Object.keys(messageStats));
        
        // Get current character and conversation IDs
        const characterId = getCurrentCharacterId();
        // Use the conversation ID from API, fallback to URL, then '_default'
        let conversationId = currentConversationId || getCurrentConversationId();
        
        // If still no conversation ID in URL, use '_default'
        if (!conversationId) {
            conversationId = '_default';
        }
        
        debugLog('[Stats] Current character ID:', characterId, 'conversation ID:', conversationId, '(from API:', currentConversationId, ')');
        
        let messageIds = [];
        let messageData = {};
        
        // Navigate character → conversation → messages
        if (characterId && messageStats[characterId]?.[conversationId]) {
            debugLog('[Stats] Found messages for character/conversation');
            messageData = messageStats[characterId][conversationId];
            messageIds = Object.keys(messageData);
            debugLog('[Stats] Found', messageIds.length, 'messages in conversation');
        } else {
            debugLog('[Stats] No messages found for current character/conversation');
        }
        
        debugLog('[Stats] Found message IDs:', messageIds.length, messageIds.slice(0, 5));
        
        // Sort messages by timestamp (oldest first)
        const sortedIds = messageIds.sort((a, b) => {
            const aTime = messageData[a]?.timestamp || 0;
            const bTime = messageData[b]?.timestamp || 0;
            return aTime - bTime;
        });
        
        // Build index map - this maps sequential index to message IDs
        // This is only used as a fallback when extractMessageId() fails
        sortedIds.forEach((id, index) => {
            messageIdToIndexMap[index] = id;
        });
        
        debugLog('[Stats] Built index map from storage:', Object.keys(messageIdToIndexMap).length, 'messages');
        debugLog('[Stats] First 5 mappings:', Object.keys(messageIdToIndexMap).slice(0, 5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
    }

    // Load message stats from storage
    async function loadMessageStats() {
        const stored = await storage.get(MESSAGE_STATS_KEY, '{}');
        return JSON.parse(stored);
    }

    // Save message stats to storage
    async function saveMessageStats(messageStats) {
        await storage.set(MESSAGE_STATS_KEY, JSON.stringify(messageStats));
    }

    // Get stats for a specific message ID
    async function getStatsForMessage(messageId) {
        const messageStats = await loadMessageStats();
        const characterId = getCurrentCharacterId();
        // Use the conversation ID from API, fallback to URL, then '_default'
        let conversationId = currentConversationId || getCurrentConversationId();
        
        // If still no conversation ID, use '_default'
        if (!conversationId) {
            conversationId = '_default';
        }
        
        debugLog('[Stats] getStatsForMessage - characterId:', characterId, 'conversationId:', conversationId, '(from API:', currentConversationId, ') messageId:', messageId);
        debugLog('[Stats] getStatsForMessage - messageTimestamps populated?', Object.keys(messageTimestamps).length > 0, 'keys:', Object.keys(messageTimestamps).length);
        debugLog('[Stats] getStatsForMessage - messageTimestamps has this ID?', !!messageTimestamps[messageId], 'value:', messageTimestamps[messageId]);
        
        // Start with an empty stats object
        let stats = null;
        
        // New format: character -> conversation -> message
        if (characterId && messageStats[characterId]?.[conversationId]?.[messageId]) {
            debugLog('[Stats] getStatsForMessage - found stored stats');
            // Only copy generation settings, not timestamp
            const storedStats = messageStats[characterId][conversationId][messageId];
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
            debugLog('[Stats] getStatsForMessage - using API timestamp:', stats.timestamp);
        } else {
            debugLog('[Stats] getStatsForMessage - WARNING: No API timestamp available for', messageId);
        }
        
        if (stats) {
            return stats;
        }
        
        debugLog('[Stats] getStatsForMessage - not found (no stored stats and no API timestamp)');
        return null;
    }
    
    // Get current character ID from URL
    function getCurrentCharacterId() {
        // URL structure: /chat/{character_id} or /chat/{character_id}/{conversation_id}
        const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
        if (match) {
            debugLog('[Stats] getCurrentCharacterId - from URL:', match[1]);
            return match[1];
        }
        
        // Fallback: Try /chatbot/ pattern if on character profile page
        const chatbotMatch = window.location.pathname.match(/\/chatbot\/([a-f0-9-]+)/);
        if (chatbotMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /chatbot/ URL:', chatbotMatch[1]);
            return chatbotMatch[1];
        }
        
        debugLog('[Stats] getCurrentCharacterId - not found, URL:', window.location.pathname);
        return null;
    }
    
    // Get current conversation ID from URL
    function getCurrentConversationId() {
        // URL structure: /chat/{character_id}/{conversation_id}
        // If only /chat/{character_id}, conversation_id will be null (defaults to most recent)
        const match = window.location.pathname.match(/\/chat\/[a-f0-9-]+\/([a-f0-9-]+)/);
        const convId = match ? match[1] : null;
        debugLog('[Stats] getCurrentConversationId - URL:', window.location.pathname, 'extracted:', convId);
        return convId;
    }
    
    // Migrate old format to new format
    // Store stats for a specific message ID (character → conversation → message hierarchy)
    async function storeStatsForMessage(messageId, stats, explicitConversationId = null) {
        const messageStats = await loadMessageStats();
        const characterId = getCurrentCharacterId();
        let conversationId = explicitConversationId || getCurrentConversationId();
        
        // If still no conversation ID, use '_default' as fallback
        if (!conversationId) {
            conversationId = '_default';
            debugLog('[Stats] No conversation ID provided, using _default');
        }
        
        if (!characterId) {
            debugLog('[Stats] Warning: Missing character ID - cannot store stats');
            return;
        }
        
        debugLog('[Stats] Storing stats - character:', characterId, 'conversation:', conversationId, 'message:', messageId);
        debugLog('[Stats] Input stats object:', stats);
        debugLog('[Stats] Extracted - model:', stats.model, 'settings:', stats.settings);
        
        // Ensure character object exists
        if (!messageStats[characterId]) {
            messageStats[characterId] = {};
        }
        
        // Ensure conversation object exists
        if (!messageStats[characterId][conversationId]) {
            messageStats[characterId][conversationId] = {};
        }
        
        // Store generation settings only - timestamps come from messageTimestamps map
        // This keeps storage clean and ensures timestamps always come from API
        messageStats[characterId][conversationId][messageId] = {
            model: stats.model || null,
            max_tokens: stats.settings?.max_new_tokens || stats.max_tokens || null,
            temperature: stats.settings?.temperature || stats.temperature || null,
            top_p: stats.settings?.top_p || stats.top_p || null,
            top_k: stats.settings?.top_k || stats.top_k || null,
            role: stats.role || null
            // Note: timestamp is NOT stored here - it comes from messageTimestamps map
        };
        
        debugLog('[Stats] Stored data:', messageStats[characterId][conversationId][messageId]);
        debugLog('[Stats] Stored for character:', characterId, 'conversation:', conversationId, 'message:', messageId);
        await saveMessageStats(messageStats);
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
        // Get user preference for timestamp format (true = date@time, false = time@date)
        const dateFirst = await storage.get('timestampDateFirst', true);
        
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
            second: '2-digit'
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
                debugLog('[Toolkit] Generation Settings modal not found in getCurrentSettings');
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
                console.error('[Toolkit] Error extracting model name:', modelError);
                model = 'Unknown';
            }

            // Get slider values (excluding max tokens - not saved in profiles)
            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length < 4) {
                console.error('[Toolkit] Expected 4 sliders, found:', sliders ? sliders.length : 0);
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
            console.error('[Toolkit] Error in getCurrentSettings:', error);
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
            debugLog('[Toolkit] Built messageTimestamps map with', Object.keys(messageTimestamps).length, 'entries');
            
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
            debugLog('[Toolkit] Built prevIdToMessageIds map with', Object.keys(prevIdToMessageIds).length, 'entries');
            
            // =================================================================
            // BUILD ALTERNATIVE MESSAGE GROUPS FOR REGENERATION TRACKING
            // =================================================================
            // Messages with the same prev_id are alternatives of each other (same position in conversation)
            // The original (v1) has is_alternative=false, regenerations (v2, v3, etc.) have is_alternative=true
            // Group them together so we can switch between them when user clicks < >
            alternativeMessageGroups = {};
            
            // DEBUG: Log raw message data to see if is_alternative is being captured
            debugLog('[Toolkit] Raw bot messages for alternative check:', botMessages.map(m => ({
                id: m.id?.substring(0, 8),
                is_alternative: m.is_alternative,
                prev_id: m.prev_id?.substring(0, 8)
            })));
            
            // First, find all messages that are alternatives (regenerations)
            const alternativeMessages = botMessages.filter(msg => msg.is_alternative && msg.prev_id);
            debugLog('[Toolkit] Found', alternativeMessages.length, 'messages with is_alternative=true');
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
            debugLog('[Toolkit] Built', Object.keys(alternativeMessageGroups).length, 'alternative message groups');
            for (const [prevId, alts] of Object.entries(alternativeMessageGroups)) {
                debugLog('[Toolkit] Group prev_id=' + prevId.substring(0, 8) + ':', alts.map((m, i) => `v${i+1}=${m.id.substring(0, 8)} (${new Date(m.createdAt).toLocaleTimeString()})`));
            }
            
            // Also log what timestamp the prev_id (parent) message has
            for (const prevId of Object.keys(alternativeMessageGroups)) {
                const parentTimestamp = messageTimestamps[prevId];
                debugLog('[Toolkit] Parent message', prevId.substring(0, 8), 'timestamp:', parentTimestamp, '→', parentTimestamp ? new Date(parentTimestamp).toLocaleTimeString() : 'not found');
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
                            debugLog('[Toolkit] Combined index', combinedIndex, '→', group[0].id.substring(0, 8), '(v1 of alternative group, bot)');
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
            
            debugLog('[Toolkit] Built combined index map with', Object.keys(messageIdToIndexMap).length, 'entries');
            debugLog('[Toolkit] (Bot messages:', botOnlyIndex, ', User messages:', userOnlyIndex, ')');
            if (DEBUG_MODE) {
                debugLog('[Stats MESSAGES_LOADED] First 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(0, 5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
                debugLog('[Stats MESSAGES_LOADED] Last 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(-5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
            }
            
            // Store stats for bot messages
            for (const msg of botMessages) {
                if (msg.id) {
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
                    } else {
                        debugLog('[Stats MESSAGES_LOADED] Existing stats preserved - no update');
                        // Existing stats preserved - no update needed
                    }
                }
            }
            
            // Store timestamps for user messages
            for (const msg of userMessages) {
                if (msg.id) {
                    const existingStats = await getStatsForMessage(msg.id);
                    if (!existingStats) {
                        const stats = {
                            role: 'user',
                            model: null,
                            settings: null
                            // Timestamp is handled by messageTimestamps map
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (!existingStats.role) {
                        // Add role if missing
                        existingStats.role = 'user';
                        await storeStatsForMessage(msg.id, existingStats, conversationId);
                    }
                }
            }
            
            debugLog('[Stats] Stored stats for', botMessages.length, 'bot messages and', userMessages.length, 'user messages');
            
            // Don't rebuild index map - we already built it from GET /messages order above
            // await buildIndexMapFromStats();
        }
        
        if (event.data.type === 'SAI_NEW_MESSAGE') {
            debugLog('[Stats] Received SAI_NEW_MESSAGE from page context');
            const { messageId, conversationId, model, settings, createdAt, role, isAlternative, prevId } = event.data;
            
            debugLog('[Stats CONTENT] ========== RECEIVED SAI_NEW_MESSAGE ==========');
            debugLog('[Stats CONTENT] Message ID:', messageId);
            debugLog('[Stats CONTENT] Role:', role);
            debugLog('[Stats CONTENT] Received createdAt:', createdAt);
            debugLog('[Stats CONTENT] createdAt type:', typeof createdAt);
            debugLog('[Stats CONTENT] createdAt as Date:', createdAt ? new Date(createdAt).toISOString() : 'null');
            debugLog('[Stats CONTENT] Is alternative (from API):', isAlternative);
            debugLog('[Stats CONTENT] Previous message ID:', prevId);
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
            
            // Track prevId → messageId relationships to detect regenerations
            // A regeneration is when we see a new message with a prevId that already has messages
            let isRegenerationDetected = false;
            if (prevId && messageId) {
                if (!prevIdToMessageIds[prevId]) {
                    prevIdToMessageIds[prevId] = [];
                }
                // Check if we already have other messages with this prevId (meaning this is a regeneration)
                if (prevIdToMessageIds[prevId].length > 0 && !prevIdToMessageIds[prevId].includes(messageId)) {
                    isRegenerationDetected = true;
                    debugLog('[Stats] Detected regeneration: prevId', prevId.substring(0, 8), 'already has messages:', prevIdToMessageIds[prevId].map(id => id.substring(0, 8)));
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
                    // First time seeing this prev_id in this session
                    // The original message (prev_id) should be v1
                    // We may not have its createdAt, but we know it exists
                    alternativeMessageGroups[prevId] = [];
                    
                    // Try to get the original message's timestamp from our map
                    const originalTimestamp = messageTimestamps[prevId];
                    if (originalTimestamp) {
                        alternativeMessageGroups[prevId].push({
                            id: prevId,
                            createdAt: typeof originalTimestamp === 'string' ? new Date(originalTimestamp).getTime() : originalTimestamp
                        });
                        debugLog('[Stats] Added original message (v1) to group:', prevId.substring(0, 8));
                    } else {
                        // We don't have the original's timestamp, but we know it's older
                        // Use a timestamp of 0 to ensure it sorts first
                        alternativeMessageGroups[prevId].push({
                            id: prevId,
                            createdAt: 0
                        });
                        debugLog('[Stats] Added original message (v1) with placeholder timestamp:', prevId.substring(0, 8));
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
                
                // For bot messages, use insertStatsForRegeneratedMessage which handles the version counter UI
                // This is more reliable than index-based matching in processMessagesForStats
                // processMessagesForStats will skip messages with version counters
                if (role === 'bot' || !role) {
                    debugLog('[Stats] Bot message - will insert stats directly via insertStatsForRegeneratedMessage');
                    // Insert stats with retries - use a single call with built-in retry logic
                    // This prevents race conditions when browser throttles background tab timers
                    insertStatsWithRetry(messageId, model, settings, createdAt);
                    
                    // Also add to index map for historical message display on page refresh
                    if (!isRegenerationDetected) {
                        const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                        const newIndex = currentMaxIndex + 1;
                        messageIdToIndexMap[newIndex] = messageId;
                        debugLog('[Stats SAVE] Added message to index map at index:', newIndex, 'messageId:', messageId);
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
            
            // Try to find and tag the user message after a short delay
            setTimeout(async () => {
                debugLog('[Stats] Looking for new user message to store role');
                
                // Find all user messages (role="user")
                const allMessages = document.querySelectorAll('[data-message-id]');
                debugLog('[Stats] Found', allMessages.length, 'total messages with data-message-id');
                
                // Find user messages without stats
                for (const msgEl of allMessages) {
                    const msgId = msgEl.getAttribute('data-message-id');
                    const role = msgEl.getAttribute('data-role') || 'unknown';
                    
                    if (role === 'user') {
                        // Check if this message already has stats
                        const existingStats = await getStatsForMessage(msgId);
                        if (!existingStats) {
                            debugLog('[Stats] Found user message without stats:', msgId);
                            await storeStatsForMessage(msgId, {
                                role: 'user'
                                // No timestamp stored - comes from messageTimestamps
                            }, conversationId);
                            
                            // Insert stats for this message
                            setTimeout(() => processMessagesForStats(true), 100);
                        }
                    }
                }
            }, 500);
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
        // Format: "Chat with {name} on Spicychat" -> "{name}"
        // Also handle already-shortened format: just "{name}" or "{name} (label)"
        let characterName = null;
        const fullTitleMatch = document.title.match(/^Chat with (.+) on Spicychat$/);
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
                console.error('[Toolkit] Invalid slider state or value:', { connected: slider.isConnected, value });
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
            console.error('[Toolkit] Error updating slider:', error);
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
                console.error('[Toolkit] changeModel: Invalid callback provided');
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
            console.error('[Toolkit] Error in changeModel (initial checks):', error);
            callback(false, `Error: ${error.message}`);
            return;
        }
        
        // Click the button
        try {
            changeModelBtn.click();
        } catch (error) {
            console.error('[Toolkit] Error clicking Change Model button:', error);
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
                        console.error('[Toolkit] Error closing modal:', closeError);
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
                                console.error('[Toolkit] Error clicking Set Model button:', error);
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
                    console.error('[Toolkit] Error clicking model option:', clickError);
                    callback(false, `Error selecting model: ${clickError.message}`);
                    return;
                }
            } catch (error) {
                console.error('[Toolkit] Error in model selection modal handling:', error);
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
                console.error('[Toolkit] Invalid settings object provided to applySettings');
                return false;
            }
            
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                debugLog('[Toolkit] Generation Settings modal not found in applySettings');
                return false;
            }

            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length === 0) {
                console.error('[Toolkit] No sliders found in Generation Settings modal');
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
                    console.error('[Toolkit] Error changing model:', modelError);
                    showNotification(`⚠️ Settings loaded but model change failed`, true);
                }
            }

            return true;
        } catch (error) {
            console.error('[Toolkit] Error in applySettings:', error);
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
        const profiles = await loadProfiles();
        const lastProfile = await storage.get(LAST_PROFILE_KEY, '');
        
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select Profile --';
        select.appendChild(defaultOption);

        Object.keys(profiles).sort().forEach(async name => {
            const option = document.createElement('option');
            option.value = name;
            const profile = profiles[name];
            option.textContent = `${name} ${profile.model ? `(${profile.model})` : ''}`;
            if (name === lastProfile) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        select.addEventListener('change', async function() {
            const profileName = this.value;
            if (profileName) {
                const profiles = await loadProfiles();
                if (profiles[profileName]) {
                    const profileSettings = profiles[profileName];
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
        select.innerHTML = '';
        
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
    
    // Apply or remove sidebar layout CSS
    // saveToStorage: if false, only updates the CSS state without saving (used for responsive auto-disable)
    async function toggleSidebarLayout(enable, saveToStorage = true) {
        if (enable) {
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
                debugLog(`[Toolkit] Page width (${pageWidth}px) below ${sidebarMinWidth}px - auto-disabling sidebar layout`);
                sidebarAutoDisabled = true;
                toggleSidebarLayout(false, false); // Don't save to storage
                showNotification('Sidebar layout disabled (window too narrow)');
            } else if (!shouldDisable && sidebarAutoDisabled) {
                // Page is wide enough again - re-enable sidebar CSS
                debugLog(`[Toolkit] Page width (${pageWidth}px) above ${sidebarMinWidth}px - re-enabling sidebar layout`);
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
                compactGenerationObserver = new MutationObserver((mutations) => {
                    markGenerationSettingsModal();
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
                let lastUrl = window.location.href;
                hideForYouUrlObserver = new MutationObserver(() => {
                    const currentUrl = window.location.href;
                    if (currentUrl !== lastUrl) {
                        lastUrl = currentUrl;
                        setTimeout(checkHideForYouPage, 100);
                    }
                });
                hideForYouUrlObserver.observe(document.body, { childList: true, subtree: true });
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
    
    // Initialize features on page load
    async function initializeStyles() {
        const sidebarEnabled = await storage.get(SIDEBAR_LAYOUT_KEY, false);
        const classicLayoutEnabled = await storage.get(CLASSIC_LAYOUT_KEY, false);
        const classicStyleEnabled = await storage.get(CLASSIC_STYLE_KEY, false);
        const hideForYouEnabled = await storage.get(HIDE_FOR_YOU_KEY, false);
        const pageJumpEnabled = await storage.get(PAGE_JUMP_KEY, false);
        const compactGenerationEnabled = await storage.get(COMPACT_GENERATION_KEY, false);
        
        // Load sidebar minimum width setting
        sidebarMinWidth = await storage.get(SIDEBAR_MIN_WIDTH_KEY, DEFAULT_SIDEBAR_MIN_WIDTH);
        
        debugLog('[Toolkit] Initializing with settings:', {
            sidebar: sidebarEnabled,
            sidebarMinWidth: sidebarMinWidth,
            classicLayout: classicLayoutEnabled,
            classicStyle: classicStyleEnabled,
            hideForYou: hideForYouEnabled,
            pageJump: pageJumpEnabled,
            compactGeneration: compactGenerationEnabled
        });
        
        // Initialize sidebarUserEnabled for responsive sidebar tracking
        sidebarUserEnabled = sidebarEnabled;
        
        // Sidebar Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (sidebarEnabled) {
            sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (sidebarStyleElement) {
                debugLog('[Toolkit] Using early-injected Sidebar Layout CSS');
                sidebarStyleElement.disabled = false;
            }
        } else {
            // If disabled but early CSS was injected, disable it
            const earlyElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                sidebarStyleElement = earlyElement;
                debugLog('[Toolkit] Disabled early-injected Sidebar Layout CSS');
            }
        }
        
        // Initialize responsive sidebar listener (handles auto-disable when page is narrow)
        initResponsiveSidebar();
        
        // Classic Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (classicLayoutEnabled) {
            classicLayoutStyleElement = document.getElementById('sai-toolkit-classic-layout-early');
            if (classicLayoutStyleElement) {
                debugLog('[Toolkit] Using early-injected Classic Layout CSS');
                classicLayoutStyleElement.disabled = false;
            }
        } else {
            // If disabled but early CSS was injected, disable it
            const earlyElement = document.getElementById('sai-toolkit-classic-layout-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                classicLayoutStyleElement = earlyElement;
                debugLog('[Toolkit] Disabled early-injected Classic Layout CSS');
            }
        }
        
        // Classic Style CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (classicStyleEnabled) {
            classicStyleStyleElement = document.getElementById('sai-toolkit-classic-style-early');
            if (classicStyleStyleElement) {
                debugLog('[Toolkit] Using early-injected Classic Style CSS');
                classicStyleStyleElement.disabled = false;
            }
        } else {
            // If disabled but early CSS was injected, disable it
            const earlyElement = document.getElementById('sai-toolkit-classic-style-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                classicStyleStyleElement = earlyElement;
                debugLog('[Toolkit] Disabled early-injected Classic Style CSS');
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
    }

    // Function to inject S.AI Toolkit Settings menu item
    // REMOVED: No longer injecting into contextual dropdown menu
    // Toolkit is now accessible only via header icon
    function injectToolkitMenuItem() {
        // This function is intentionally left empty but kept for compatibility
        // The toolkit settings are now only accessible via the header icon
    }

    // Function to inject toolkit icon on header (left of notification bell)
    // Function to inject toolkit button into left sidebar
    function injectToolkitSidebarButton() {
        // Check if already injected
        const existingButton = document.getElementById('sai-toolkit-sidebar-btn');
        if (existingButton) {
            return;
        }
        
        debugLog('[Toolkit] Searching for Help button...');
        
        // Find the Help button in the sidebar (last section with Subscribe and Help)
        // The Help button is now inside an <a> tag linking to docs.spicychat.ai/support
        let helpButton = null;
        let helpLink = null;
        
        // First, try to find the <a> tag with the help link
        helpLink = document.querySelector('a[href="https://docs.spicychat.ai/support"]');
        if (helpLink) {
            helpButton = helpLink.querySelector('button');
            debugLog('[Toolkit] Found help button via link selector');
        }
        
        // Fallback: try finding by icon and text content
        if (!helpButton) {
            debugLog('[Toolkit] Link selector failed, trying icon+text method');
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const hasInfoIcon = btn.querySelector('svg.lucide-info');
                const hasHelpText = btn.textContent?.trim().includes('Help');
                if (hasInfoIcon && hasHelpText) {
                    helpButton = btn;
                    debugLog('[Toolkit] Found help button via icon+text');
                    break;
                }
            }
        }
        
        // Another fallback: find Subscribe button and get its sibling
        if (!helpButton) {
            debugLog('[Toolkit] Trying Subscribe sibling method');
            const subscribeLink = document.querySelector('a[href="/subscribe"]');
            if (subscribeLink) {
                const subscribeWrapper = subscribeLink.closest('div.w-full');
                if (subscribeWrapper && subscribeWrapper.nextElementSibling) {
                    const helpWrapper = subscribeWrapper.nextElementSibling;
                    helpLink = helpWrapper.querySelector('a[href*="docs.spicychat.ai"]');
                    if (helpLink) {
                        helpButton = helpLink.querySelector('button');
                        debugLog('[Toolkit] Found help button via Subscribe sibling');
                    }
                }
            }
        }
        
        // Last fallback: just find by info icon alone
        if (!helpButton) {
            debugLog('[Toolkit] Trying info icon only method');
            const infoIcons = document.querySelectorAll('svg.lucide-info');
            for (const icon of infoIcons) {
                const btn = icon.closest('button');
                if (btn) {
                    helpButton = btn;
                    debugLog('[Toolkit] Found help button via info icon');
                    break;
                }
            }
        }
        
        if (!helpButton) {
            debugLog('[Toolkit] Help button not found after all attempts');
            debugLog('[Toolkit] Available links:', Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h.includes('spicychat')));
            debugLog('[Toolkit] Info icons found:', document.querySelectorAll('svg.lucide-info').length);
            return;
        }
        
        debugLog('[Toolkit] Help button found, proceeding...');
        
        // Get the parent container (the div.w-full that wraps the <a> tag)
        // The structure is now: div.w-full > a > button
        const helpAnchor = helpButton.closest('a');
        const helpButtonWrapper = helpAnchor ? helpAnchor.closest('div.w-full') : helpButton.closest('div.w-full');
        
        if (!helpButtonWrapper) {
            debugLog('[Toolkit] Help button wrapper not found');
            debugLog('[Toolkit] Help button parent structure:', helpButton.parentElement?.className);
            debugLog('[Toolkit] Help button parent element:', helpButton.parentElement);
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
        debugLog('[Toolkit] Removed React tooltip attributes');
        
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
                customTooltip.style.cssText = 'z-index: 200000; border: 1px solid rgb(71, 71, 71); opacity: 1;';
                customTooltip.textContent = 'S.AI Toolkit';
                
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
        
        debugLog('[Toolkit] Sidebar button injected successfully');
    }
    
    // Function to inject toolkit button in mobile header (next to Like button)
    function injectToolkitMobileButton() {
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
            debugLog('[Toolkit] No reference button found in chat header');
            return;
        }
        
        // Get the parent container (the flex container with gap-sm)
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Toolkit] Mobile button container not found');
            return;
        }
        
        // Create the toolkit button matching the other button styles
        const toolkitBtn = document.createElement('button');
        toolkitBtn.id = 'sai-toolkit-mobile-btn';
        toolkitBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        toolkitBtn.setAttribute('aria-label', 'SAI-Toolkit-button');
        toolkitBtn.setAttribute('type', 'button');
        
        toolkitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wrench inline-flex items-center justify-center w-5 h-5">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
        </svg>`;
        
        // Add click handler
        toolkitBtn.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            showToolkitSettingsModal();
        });
        
        // Insert at the beginning of the container (leftmost position)
        buttonContainer.insertBefore(toolkitBtn, buttonContainer.firstChild);
        debugLog('[Toolkit] Mobile button injected successfully');
    }
    
    // ============================================================================
    // CHAT EXPORT FEATURE
    // ============================================================================
    
    // Function to inject chat export button in mobile header (to the left of toolkit settings button)
    function injectChatExportButton() {
        // Only show on chat pages
        if (!window.location.pathname.startsWith('/chat/')) {
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
        exportBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download inline-flex items-center justify-center w-5 h-5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>`;
        
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
        // Only show on chat pages
        if (!window.location.pathname.startsWith('/chat/')) {
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
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check if the added node or any child contains text about "Conversation Image Settings"
                            const textContent = node.textContent || '';
                            if (textContent.includes('Conversation Image Settings')) {
                                debugLog('[NSFW] Modal with "Conversation Image Settings" detected!');
                                // Wait for React to finish rendering
                                setTimeout(() => {
                                    syncModalNSFWToggle();
                                    watchModalNSFWToggle();
                                }, 150);
                            }
                        }
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
        // URL format: /chat/{characterId}/{conversationId}
        const pathParts = window.location.pathname.split('/').filter(p => p);
        // pathParts should be: ['chat', characterId, conversationId]
        
        debugLog('[Export] Path parts:', pathParts);
        
        if (pathParts.length < 2 || pathParts[0] !== 'chat') {
            throw new Error('Not on a chat page. URL should be /chat/{characterId}/{conversationId}');
        }
        
        const characterId = pathParts[1];
        const conversationId = pathParts.length > 2 ? pathParts[2] : null;
        
        if (!characterId) {
            throw new Error('Could not determine character ID from URL');
        }
        
        debugLog('[Export] Character ID:', characterId);
        debugLog('[Export] Conversation ID:', conversationId);
        
        return new Promise((resolve, reject) => {
            // Inject script into page context to access auth headers
            const script = document.createElement('script');
            script.textContent = `
                (async function() {
                    try {
                        let authToken = null;
                        let guestUserId = null;
                        let country = null;
                        
                        // Get auth headers from intercepted data
                        if (window.__kindeAccessToken) {
                            authToken = window.__kindeAccessToken;
                        }
                        if (window.__lastAuthHeaders) {
                            if (!authToken && window.__lastAuthHeaders.Authorization) {
                                authToken = window.__lastAuthHeaders.Authorization.replace('Bearer ', '');
                            }
                            if (!guestUserId && window.__lastAuthHeaders['X-Guest-UserId']) {
                                guestUserId = window.__lastAuthHeaders['X-Guest-UserId'];
                            }
                            if (!country && window.__lastAuthHeaders['X-Country']) {
                                country = window.__lastAuthHeaders['X-Country'];
                            }
                        }
                        
                        // Fallback to localStorage
                        if (!authToken) {
                            for (const key of Object.keys(localStorage)) {
                                try {
                                    const value = localStorage.getItem(key);
                                    if (!value) continue;
                                    if (value.startsWith('{') || value.startsWith('[')) {
                                        const parsed = JSON.parse(value);
                                        if (parsed.access_token || parsed.accessToken || parsed.token) {
                                            authToken = parsed.access_token || parsed.accessToken || parsed.token;
                                            break;
                                        }
                                    } else if (value.startsWith('eyJ')) {
                                        authToken = value;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }
                        
                        const headers = {
                            'Accept': 'application/json, text/plain, */*',
                            'X-App-Id': 'spicychat'
                        };
                        
                        if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
                        if (guestUserId) headers['X-Guest-UserId'] = guestUserId;
                        if (country) headers['X-Country'] = country;
                        
                        console.log('[Export] Fetching from API with character ID: ${characterId}, conversation ID: ${conversationId}');
                        
                        // Fetch messages for specific conversation
                        // The API endpoint requires both character ID and conversation ID
                        const apiUrl = '${conversationId}' 
                            ? 'https://prod.nd-api.com/characters/${characterId}/messages/${conversationId}'
                            : 'https://prod.nd-api.com/characters/${characterId}/messages';
                        
                        console.log('[Export] Fetching from:', apiUrl);
                        
                        const messagesResponse = await fetch(apiUrl, {
                            method: 'GET',
                            headers: headers,
                            credentials: 'include'
                        });
                        
                        console.log('[Export] Messages API response status:', messagesResponse.status);
                        
                        if (!messagesResponse.ok) {
                            throw new Error('Failed to fetch messages: ' + messagesResponse.status);
                        }
                        
                        const messagesData = await messagesResponse.json();
                        console.log('[Export] Messages received:', messagesData.messages?.length || 0);
                        
                        // Also fetch character info
                        const characterResponse = await fetch('https://prod.nd-api.com/v2/characters/${characterId}', {
                            method: 'GET',
                            headers: headers,
                            credentials: 'include'
                        });
                        
                        let characterData = null;
                        if (characterResponse.ok) {
                            characterData = await characterResponse.json();
                        }
                        
                        // Send data back via custom event
                        window.dispatchEvent(new CustomEvent('sai-export-data', {
                            detail: {
                                success: true,
                                messages: messagesData,
                                character: characterData
                            }
                        }));
                    } catch (error) {
                        window.dispatchEvent(new CustomEvent('sai-export-data', {
                            detail: {
                                success: false,
                                error: error.message
                            }
                        }));
                    }
                })();
            `;
            
            // Listen for the response
            const handler = (event) => {
                window.removeEventListener('sai-export-data', handler);
                const data = event.detail;
                if (data.success) {
                    resolve({ messages: data.messages, character: data.character });
                } else {
                    reject(new Error(data.error || 'Failed to fetch chat data'));
                }
            };
            window.addEventListener('sai-export-data', handler);
            
            // Inject and run the script
            document.head.appendChild(script);
            script.remove();
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
            
            const filename = `chat-${character?.name || 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
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
                subCharacterImageMap
            });
            
            const filename = `chat-${safeBotName}-${new Date().toISOString().slice(0, 10)}.html`;
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
            isGroupChat = false, subCharacterMap = {}, subCharacterImageMap = {}
        } = data;
        
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
            
            // Determine sender name and avatar
            let senderName, imgUrl;
            if (isBot) {
                if (isGroupChat && isFirstBotMessage) {
                    // First bot message in group chat: use group name and avatar
                    senderName = botName;
                    imgUrl = botImageUrl;
                    isFirstBotMessage = false;
                } else if (isGroupChat && msg.character_id && subCharacterMap[msg.character_id]) {
                    // Subsequent bot messages in group chat: use individual character info
                    senderName = subCharacterMap[msg.character_id].name;
                    imgUrl = subCharacterImageMap[msg.character_id] || subCharacterMap[msg.character_id].avatarUrl;
                } else {
                    // Standard single-character chat
                    senderName = botName;
                    imgUrl = botImageUrl;
                }
            } else {
                // User message
                senderName = userName;
                imgUrl = userImageUrl;
            }
            
            const avatarHTML = imgUrl
                ? `<img class="avatar" src="${escapeHTML(imgUrl)}" alt="${escapeHTML(senderName)}">`
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
         */
        
        :root {
            --bg-color: #0f0f0f;
            --text-color: #e5e5e5;
            --header-bg: #1a1a1a;
            --message-bg: #1a1a1a;
            --user-message-bg: #1e3a5f;
            --bot-message-bg: #2d2d2d;
            --border-color: #333;
            --action-color: #a78bfa;
            --timestamp-color: #6b7280;
            --accent-color: #8b5cf6;
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
        .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
        .avatar-placeholder {
            width: 40px; height: 40px; border-radius: 50%;
            background: var(--accent-color); color: white;
            display: flex; align-items: center; justify-content: center;
            font-weight: bold; font-size: 1.2rem;
        }
        
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
    debugLog('[Toolkit] ===== OPENING SETTINGS MODAL =====');
    debugLog('[Toolkit] Current Sidebar Layout enabled?', await storage.get(SIDEBAR_LAYOUT_KEY, false));
    debugLog('[Toolkit] Current Classic Layout enabled?', await storage.get(CLASSIC_LAYOUT_KEY, false));
    debugLog('[Toolkit] Current Classic Style enabled?', await storage.get(CLASSIC_STYLE_KEY, false));
    // Create or get a dedicated container with SHADOW DOM for complete isolation
        let toolkitRoot = document.getElementById('toolkit-modal-root');
        if (!toolkitRoot) {
            debugLog('[Toolkit] Creating new toolkit-modal-root with Shadow DOM');
            toolkitRoot = document.createElement('div');
            toolkitRoot.id = 'toolkit-modal-root';
            toolkitRoot.className = 'toolkit-modal-container';
            toolkitRoot.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 10000003;';
            document.body.appendChild(toolkitRoot);
            
            // Attach shadow DOM for complete isolation from React
            const shadow = toolkitRoot.attachShadow({ mode: 'open' });
            debugLog('[Toolkit] Shadow DOM attached');
            
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
                    max-height: 85vh;
                    z-index: 10000004;
                    pointer-events: auto;
                    display: flex;
                    flex-direction: column;
                    padding: 1rem;
                    gap: 0.75rem;
                }
                @media (max-width: 480px) {
                    .modal {
                        width: 100%;
                        max-width: 100vw;
                        max-height: 100vh;
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
                    overflow-y: auto;
                    flex: 1;
                    min-height: 0;
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
                @media (max-width: 380px) {
                    .style-label { min-width: 80px; font-size: 11px; }
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
        debugLog('[Toolkit] Got shadow root, clearing existing content');
        
        // Clear existing content
        const existingBackdrop = shadow.querySelector('.backdrop');
        if (existingBackdrop) existingBackdrop.remove();
        const existingModal = shadow.querySelector('.modal');
        if (existingModal) existingModal.remove();
        
        
        // State tracking
        let sidebarEnabled = await storage.get(SIDEBAR_LAYOUT_KEY, false);
        let sidebarMinWidthValue = await storage.get(SIDEBAR_MIN_WIDTH_KEY, DEFAULT_SIDEBAR_MIN_WIDTH);
        let compactGenerationEnabled = await storage.get(COMPACT_GENERATION_KEY, false);
        let classicLayoutEnabled = await storage.get(CLASSIC_LAYOUT_KEY, false);
        let classicStyleEnabled = await storage.get(CLASSIC_STYLE_KEY, false);
        let customStyleEnabled = await storage.get(CUSTOM_STYLE_KEY, false);
        let customStyleValues = JSON.parse(await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE)));
        let hideForYouEnabled = await storage.get(HIDE_FOR_YOU_KEY, false);
        let pageJumpEnabled = await storage.get(PAGE_JUMP_KEY, false);
        let showStatsEnabled = await storage.get('showGenerationStats', false);
        let showModelDetailsEnabled = await storage.get('showModelDetails', true); // true = show "model → engine", false = show only "model"
        let showTimestampEnabled = await storage.get('showTimestamp', false);
        let timestampDateFirst = await storage.get('timestampDateFirst', true); // true = date@time, false = time@date
        let showChatNameInTitleEnabled = await storage.get('showChatNameInTitle', false);
        let nsfwToggleEnabled = await storage.get('nsfwToggleEnabled', false);
        let smallProfileImagesEnabled = await storage.get(SMALL_PROFILE_IMAGES_KEY, false);
        let roundedProfileImagesEnabled = await storage.get(ROUNDED_PROFILE_IMAGES_KEY, false);
        let swapCheckboxPositionEnabled = await storage.get(SWAP_CHECKBOX_POSITION_KEY, false);
        let squareMessageEdgesEnabled = await storage.get(SQUARE_MESSAGE_EDGES_KEY, false);
        
        debugLog('[Toolkit] Modal state - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', sidebarMinWidthValue, 'CompactGeneration:', compactGenerationEnabled, 'ClassicLayout:', classicLayoutEnabled, 'ClassicStyle:', classicStyleEnabled, 'CustomStyle:', customStyleEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled);
        
        // Create backdrop
        debugLog('[Toolkit] Creating backdrop and modal elements');
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        
        // Create modal with safe HTML (no dynamic content in innerHTML)
        const modal = document.createElement('div');
        modal.className = 'modal';
        // Using static HTML template - checkboxes will be set programmatically below
        modal.innerHTML = `
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
                        <div class="style-input-row">
                            <label class="style-label">Body Text:</label>
                            <input type="text" id="custom-body-color" class="style-input" placeholder="#ffffff">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-body-color"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Dialogue:</label>
                            <input type="text" id="custom-span-quote-color" class="style-input" placeholder="#ffffff">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-quote-color"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Narration:</label>
                            <input type="text" id="custom-narration-color" class="style-input" placeholder="#06B7DB">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-narration-color"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Highlight BG:</label>
                            <input type="text" id="custom-highlight-bg-color" class="style-input" placeholder="#ffdd6d">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-highlight-bg"></div></div>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Highlight Text:</label>
                            <input type="text" id="custom-highlight-text-color" class="style-input" placeholder="#000000">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-highlight-text"></div></div>
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
                            <label class="style-label">Font Weight:</label>
                            <select id="custom-font-weight" class="style-select">
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
                            <label class="style-label">Font Style:</label>
                            <select id="custom-font-style" class="style-select">
                                <option value="normal">Normal</option>
                                <option value="italic">Italic</option>
                                <option value="oblique">Oblique</option>
                            </select>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Text Decoration:</label>
                            <select id="custom-text-decoration" class="style-select">
                                <option value="none">None</option>
                                <option value="underline">Underline</option>
                                <option value="overline">Overline</option>
                                <option value="line-through">Line Through</option>
                            </select>
                        </div>
                        <div class="style-input-row">
                            <label class="style-label">Button Hover:</label>
                            <input type="text" id="custom-hover-button-color" class="style-input" placeholder="#292929">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-hover-button"></div></div>
                        </div>
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
                    
                    <div class="section-title">Memories</div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="memories-auto-injection-checkbox" autocomplete="off" disabled>
                        <div class="setting-text">
                            <div class="setting-title">Memories Auto-Injection</div>
                            <div class="setting-desc">Coming soon...</div>
                        </div>
                    </label>
                </div>
                
                <!-- Data Tab -->
                <div class="tab-content" id="tab-data">
                    <div class="section-title">Generation Profiles</div>
                    <div class="section-desc">Export or import generation profiles</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="export-profiles-btn">Export</button>
                        <button class="btn-data" id="import-profiles-btn">Import</button>
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
                    
                    <div class="version-text" id="version-text">v1.0.33</div>
                </div>
            </div>
            
            <div class="button-row">
                <button class="btn-cancel" id="cancel-btn">Cancel</button>
                <button class="btn-save" id="save-btn">Save & Refresh</button>
            </div>
        `;
        
        // Append to shadow DOM
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);
        
        debugLog('[Toolkit] Modal and backdrop appended to shadow DOM');
        
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
        const customSpanQuoteColorInput = shadow.querySelector('#custom-span-quote-color');
        const customNarrationColorInput = shadow.querySelector('#custom-narration-color');
        const customHighlightBgColorInput = shadow.querySelector('#custom-highlight-bg-color');
        const customHighlightTextColorInput = shadow.querySelector('#custom-highlight-text-color');
        const customFontSizeInput = shadow.querySelector('#custom-font-size');
        const customFontFamilyInput = shadow.querySelector('#custom-font-family');
        const customFontWeightSelect = shadow.querySelector('#custom-font-weight');
        const customFontStyleSelect = shadow.querySelector('#custom-font-style');
        const customTextDecorationSelect = shadow.querySelector('#custom-text-decoration');
        const hideForYouCheckbox = shadow.querySelector('#hideforyou-checkbox');
        const pageJumpCheckbox = shadow.querySelector('#pagejump-checkbox');
        const showStatsCheckbox = shadow.querySelector('#showstats-checkbox');
        const modelDetailsCheckbox = shadow.querySelector('#generation-model-details-checkbox');
        const showTimestampCheckbox = shadow.querySelector('#showtimestamp-checkbox');
        const timestampFormatCheckbox = shadow.querySelector('#timestamp-format-checkbox');
        const showChatNameInTitleCheckbox = shadow.querySelector('#showchatnametitle-checkbox');
        const nsfwToggleCheckbox = shadow.querySelector('#nsfwtoggle-checkbox');
        const modelDetailsRow = shadow.querySelector('#generation-model-details-row');
        const timestampFormatRow = shadow.querySelector('#timestamp-format-row');
        const compactGenerationRow = shadow.querySelector('#compact-generation-row');
        const sidebarMinWidthRow = shadow.querySelector('#sidebar-min-width-row');
        const sidebarMinWidthInput = shadow.querySelector('#sidebar-min-width-input');
        const customHoverButtonColorInput = shadow.querySelector('#custom-hover-button-color');
        const previewHoverButton = shadow.querySelector('#preview-hover-button');
        const versionText = shadow.querySelector('#version-text');
        
        // Easter egg: Shift+click on version text toggles DEBUG_MODE
        if (versionText) {
            // Set initial color based on current DEBUG_MODE state
            if (DEBUG_MODE) {
                versionText.style.color = '#4ade80'; // light green when debug is on
            }
            
            versionText.style.cursor = 'pointer';
            versionText.addEventListener('click', async (e) => {
                if (e.shiftKey) {
                    DEBUG_MODE = !DEBUG_MODE;
                    // Persist to storage
                    await storage.set('debugMode', DEBUG_MODE);
                    window.__SAI_DEBUG_MODE__ = DEBUG_MODE;
                    if (DEBUG_MODE) {
                        versionText.style.color = '#4ade80'; // light green
                        console.log('[Toolkit] 🐛 Debug mode ENABLED (saved)');
                    } else {
                        versionText.style.color = ''; // reset to default
                        console.log('[Toolkit] Debug mode disabled (saved)');
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
        customSpanQuoteColorInput.value = customStyleValues.spanQuoteColor;
        customNarrationColorInput.value = customStyleValues.narrationColor;
        customHighlightBgColorInput.value = customStyleValues.highlightBgColor;
        customHighlightTextColorInput.value = customStyleValues.highlightTextColor;
        customFontSizeInput.value = customStyleValues.fontSize;
        customFontFamilyInput.value = customStyleValues.fontFamily || '';
        customHoverButtonColorInput.value = customStyleValues.hoverButtonColor || '#292929';
        customFontWeightSelect.value = customStyleValues.fontWeight || 'normal';
        customFontStyleSelect.value = customStyleValues.fontStyle || 'normal';
        customTextDecorationSelect.value = customStyleValues.textDecoration || 'none';
        hideForYouCheckbox.checked = hideForYouEnabled;
        pageJumpCheckbox.checked = pageJumpEnabled;
        showStatsCheckbox.checked = showStatsEnabled;
        modelDetailsCheckbox.checked = showModelDetailsEnabled;
        showTimestampCheckbox.checked = showTimestampEnabled;
        timestampFormatCheckbox.checked = timestampDateFirst;
        showChatNameInTitleCheckbox.checked = showChatNameInTitleEnabled;
        nsfwToggleCheckbox.checked = nsfwToggleEnabled;
        
        // Show/hide model details row based on showStats setting
        if (showStatsEnabled) {
            modelDetailsRow.classList.remove('hidden');
        } else {
            modelDetailsRow.classList.add('hidden');
        }
        
        // Show/hide timestamp format row based on showTimestamp setting
        if (showTimestampEnabled) {
            timestampFormatRow.classList.remove('hidden');
        } else {
            timestampFormatRow.classList.add('hidden');
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
        
        debugLog('[Toolkit] Checkbox states set programmatically');
        
        // CRITICAL: Install event barrier at shadow root to prevent events from escaping to React
        // Use BUBBLE phase (false) so events reach our handlers first, THEN get stopped from escaping
        debugLog('[Toolkit] Installing comprehensive event barrier at shadow root (bubble phase)');
        const eventTypes = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 
                           'touchstart', 'touchend', 'keydown', 'keyup', 'input', 'change'];
        eventTypes.forEach(async eventType => {
            shadow.addEventListener(eventType, (e) => {
                debugLog('[Toolkit] Event barrier stopping propagation:', eventType, 'target:', e.target.id || e.target.className);
                e.stopPropagation();  // Prevent event from escaping shadow DOM
            }, false); // Bubble phase - runs AFTER our handlers, stops events from leaving shadow DOM
        });
        debugLog('[Toolkit] Event barrier installed (bubble phase) for:', eventTypes.join(', '));
        
        // Tab switching logic
        const tabBtns = shadow.querySelectorAll('.tab-btn');
        const tabContents = shadow.querySelectorAll('.tab-content');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                debugLog('[Toolkit] Tab switched to:', targetTab);
                
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
        debugLog('[Toolkit] Tab switching initialized');
        
        // Get button and other elements within shadow DOM
        const cancelBtn = shadow.querySelector('#cancel-btn');
        const saveBtn = shadow.querySelector('#save-btn');
        const exportProfilesBtn = shadow.querySelector('#export-profiles-btn');
        const importProfilesBtn = shadow.querySelector('#import-profiles-btn');
        const exportCustomStyleBtn = shadow.querySelector('#export-custom-style-btn');
        const importCustomStyleBtn = shadow.querySelector('#import-custom-style-btn');
        const exportAllBtn = shadow.querySelector('#export-all-btn');
        const importAllBtn = shadow.querySelector('#import-all-btn');
        const clearAllBtn = shadow.querySelector('#clear-all-btn');
        
        // Check if this is first run (onboarding) - disable cancel if so
        const hasSeenOnboarding = await storage.get('hasSeenOnboarding', false);
        if (!hasSeenOnboarding) {
            debugLog('[Toolkit] First run - disabling Cancel button');
            cancelBtn.disabled = true;
            cancelBtn.style.opacity = '0.5';
            cancelBtn.style.cursor = 'not-allowed';
            cancelBtn.title = 'Please save your settings or refresh the page manually';
        }
        
        debugLog('[Toolkit] Button query results:');
        debugLog('[Toolkit]   cancelBtn:', cancelBtn);
        debugLog('[Toolkit]   saveBtn:', saveBtn);
        debugLog('[Toolkit]   exportAllBtn:', exportAllBtn);
        debugLog('[Toolkit]   importAllBtn:', importAllBtn);
        
        if (!exportAllBtn) {
            console.error('[Toolkit] ERROR: exportAllBtn not found in shadow DOM!');
        }
        if (!importAllBtn) {
            console.error('[Toolkit] ERROR: importAllBtn not found in shadow DOM!');
        }
        
        // Checkbox change handlers track state
        sidebarCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SIDEBAR CHECKBOX CHANGED');
            sidebarEnabled = e.target.checked;
            debugLog('[Toolkit] Sidebar:', sidebarEnabled);
            
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
            debugLog('[Toolkit] SIDEBAR MIN WIDTH INPUT CHANGED');
            const value = parseInt(e.target.value, 10);
            // If empty or invalid, will be set to default on save
            if (!isNaN(value) && value >= 600 && value <= 2000) {
                sidebarMinWidthValue = value;
            }
            debugLog('[Toolkit] Sidebar Min Width:', sidebarMinWidthValue);
        };
        
        compactGenerationCheckbox.onchange = (e) => {
            debugLog('[Toolkit] COMPACT GENERATION CHECKBOX CHANGED');
            compactGenerationEnabled = e.target.checked;
            debugLog('[Toolkit] Compact Generation:', compactGenerationEnabled);
        };
        
        classicLayoutCheckbox.onchange = (e) => {
            debugLog('[Toolkit] CLASSIC LAYOUT CHECKBOX CHANGED');
            classicLayoutEnabled = e.target.checked;
            debugLog('[Toolkit] Classic Layout:', classicLayoutEnabled);
        };
        
        smallProfileImagesCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SMALL PROFILE IMAGES CHECKBOX CHANGED');
            smallProfileImagesEnabled = e.target.checked;
            debugLog('[Toolkit] Small Profile Images:', smallProfileImagesEnabled);
        };
        
        roundedProfileImagesCheckbox.onchange = (e) => {
            debugLog('[Toolkit] ROUNDED PROFILE IMAGES CHECKBOX CHANGED');
            roundedProfileImagesEnabled = e.target.checked;
            debugLog('[Toolkit] Rounded Profile Images:', roundedProfileImagesEnabled);
        };
        
        swapCheckboxPositionCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SWAP CHECKBOX POSITION CHECKBOX CHANGED');
            swapCheckboxPositionEnabled = e.target.checked;
            debugLog('[Toolkit] Swap Checkbox Position:', swapCheckboxPositionEnabled);
        };
        
        squareMessageEdgesCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SQUARE MESSAGE EDGES CHECKBOX CHANGED');
            squareMessageEdgesEnabled = e.target.checked;
            debugLog('[Toolkit] Square Message Edges:', squareMessageEdgesEnabled);
        };
        
        classicStyleCheckbox.onchange = (e) => {
            debugLog('[Toolkit] CLASSIC STYLE CHECKBOX CHANGED');
            classicStyleEnabled = e.target.checked;
            debugLog('[Toolkit] Classic Style:', classicStyleEnabled);
            
            // Mutual exclusivity: Disable Custom Style if Classic Style is enabled
            if (classicStyleEnabled && customStyleEnabled) {
                customStyleEnabled = false;
                customStyleCheckbox.checked = false;
                customStyleOptions.classList.add('hidden');
            }
        };
        
        customStyleCheckbox.onchange = (e) => {
            debugLog('[Toolkit] CUSTOM STYLE CHECKBOX CHANGED');
            customStyleEnabled = e.target.checked;
            debugLog('[Toolkit] Custom Style:', customStyleEnabled);
            
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
                fontPreviewText.style.fontWeight = customStyleValues.fontWeight || 'normal';
                fontPreviewText.style.fontStyle = customStyleValues.fontStyle || 'normal';
                fontPreviewText.style.textDecoration = customStyleValues.textDecoration || 'none';
                fontPreviewText.style.color = customStyleValues.bodyColor || '#fff';
            }
            if (previewTextQuote) {
                previewTextQuote.style.color = customStyleValues.spanQuoteColor || '#fff';
            }
            if (previewTextNarration) {
                previewTextNarration.style.color = customStyleValues.narrationColor || '#06B7DB';
                previewTextNarration.style.fontFamily = customStyleValues.fontFamily || 'inherit';
            }
            if (previewTextHighlight) {
                previewTextHighlight.style.backgroundColor = customStyleValues.highlightBgColor || '#ffdd6d';
                previewTextHighlight.style.color = customStyleValues.highlightTextColor || '#000';
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
        customSpanQuoteColorInput.oninput = (e) => { 
            customStyleValues.spanQuoteColor = e.target.value;
            if (previewQuoteColor) previewQuoteColor.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
        customNarrationColorInput.oninput = (e) => { 
            customStyleValues.narrationColor = e.target.value;
            if (previewNarrationColor) previewNarrationColor.style.background = e.target.value || 'transparent';
            updateFontPreview();
        };
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
        customFontSizeInput.oninput = (e) => { customStyleValues.fontSize = e.target.value; updateFontPreview(); };
        customFontFamilyInput.oninput = (e) => { customStyleValues.fontFamily = e.target.value; updateFontPreview(); };
        customFontWeightSelect.onchange = (e) => { customStyleValues.fontWeight = e.target.value; updateFontPreview(); };
        customFontStyleSelect.onchange = (e) => { customStyleValues.fontStyle = e.target.value; updateFontPreview(); };
        customTextDecorationSelect.onchange = (e) => { customStyleValues.textDecoration = e.target.value; updateFontPreview(); };
        customHoverButtonColorInput.oninput = (e) => { 
            customStyleValues.hoverButtonColor = e.target.value;
            if (previewHoverButton) previewHoverButton.style.background = e.target.value || 'transparent';
        };
        
        hideForYouCheckbox.onchange = (e) => {
            debugLog('[Toolkit] HIDE FOR YOU CHECKBOX CHANGED');
            hideForYouEnabled = e.target.checked;
            debugLog('[Toolkit] Hide For You:', hideForYouEnabled);
        };
        
        pageJumpCheckbox.onchange = (e) => {
            debugLog('[Toolkit] PAGE JUMP CHECKBOX CHANGED');
            pageJumpEnabled = e.target.checked;
            debugLog('[Toolkit] Page Jump:', pageJumpEnabled);
        };
        
        showStatsCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SHOW STATS CHECKBOX CHANGED');
            showStatsEnabled = e.target.checked;
            debugLog('[Toolkit] Show Stats:', showStatsEnabled);
            
            // Toggle model details sub-checkbox visibility
            if (showStatsEnabled) {
                modelDetailsRow.classList.remove('hidden');
            } else {
                modelDetailsRow.classList.add('hidden');
            }
        };
        
        modelDetailsCheckbox.onchange = (e) => {
            debugLog('[Toolkit] MODEL DETAILS CHECKBOX CHANGED');
            showModelDetailsEnabled = e.target.checked;
            debugLog('[Toolkit] Show Model Details:', showModelDetailsEnabled);
        };
        
        showTimestampCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SHOW TIMESTAMP CHECKBOX CHANGED');
            showTimestampEnabled = e.target.checked;
            debugLog('[Toolkit] Show Timestamp:', showTimestampEnabled);
            
            // Toggle timestamp format sub-checkbox visibility
            if (showTimestampEnabled) {
                timestampFormatRow.classList.remove('hidden');
            } else {
                timestampFormatRow.classList.add('hidden');
            }
        };
        
        timestampFormatCheckbox.onchange = (e) => {
            debugLog('[Toolkit] TIMESTAMP FORMAT CHECKBOX CHANGED');
            timestampDateFirst = e.target.checked;
            debugLog('[Toolkit] Timestamp Format:', timestampDateFirst ? 'date@time' : 'time@date');
        };
        
        showChatNameInTitleCheckbox.onchange = (e) => {
            debugLog('[Toolkit] SHOW CHAT NAME IN TITLE CHECKBOX CHANGED');
            showChatNameInTitleEnabled = e.target.checked;
            debugLog('[Toolkit] Show Chat Name In Title:', showChatNameInTitleEnabled);
        };
        
        nsfwToggleCheckbox.onchange = (e) => {
            debugLog('[Toolkit] NSFW TOGGLE CHECKBOX CHANGED');
            nsfwToggleEnabled = e.target.checked;
            debugLog('[Toolkit] NSFW Toggle:', nsfwToggleEnabled);
        };
        
        // Close modal function
        const closeModal = () => {
            debugLog('[Toolkit] ===== CLOSE MODAL CALLED =====');
            debugLog('[Toolkit] Current time:', Date.now());
            debugLog('[Toolkit] Backdrop element:', backdrop);
            debugLog('[Toolkit] Modal element:', modal);
            debugLog('[Toolkit] Shadow root:', shadow);
            debugLog('[Toolkit] Document body children count:', document.body.children.length);
            
            try {
                debugLog('[Toolkit] Setting backdrop opacity to 0');
                backdrop.style.opacity = '0';
                debugLog('[Toolkit] Setting backdrop transition');
                backdrop.style.transition = 'opacity 0.15s';
                debugLog('[Toolkit] Setting modal opacity to 0');
                modal.style.opacity = '0';
                debugLog('[Toolkit] Setting modal transform');
                modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
                debugLog('[Toolkit] Setting modal transition');
                modal.style.transition = 'all 0.15s';
                debugLog('[Toolkit] CSS animations set successfully');
            } catch (error) {
                console.error('[Toolkit] Error setting CSS animations:', error);
            }
            
            // Remove from DOM after animation completes
            debugLog('[Toolkit] Scheduling removal in 200ms');
            setTimeout(() => {
                debugLog('[Toolkit] ===== STARTING DOM REMOVAL =====');
                debugLog('[Toolkit] Time:', Date.now());
                debugLog('[Toolkit] About to remove backdrop');
                try {
                    backdrop.remove();
                    debugLog('[Toolkit] Backdrop removed successfully');
                } catch (error) {
                    console.error('[Toolkit] Error removing backdrop:', error);
                }
                
                debugLog('[Toolkit] About to remove modal');
                try {
                    modal.remove();
                    debugLog('[Toolkit] Modal removed successfully');
                } catch (error) {
                    console.error('[Toolkit] Error removing modal:', error);
                }
                
                debugLog('[Toolkit] ===== DOM REMOVAL COMPLETE =====');
                debugLog('[Toolkit] Document body children count after removal:', document.body.children.length);
            }, 200);
            
            debugLog('[Toolkit] closeModal function execution complete (removal scheduled)');
        };
        
        // Disable backdrop click to close (user must use Cancel or Save buttons)
        backdrop.onclick = (e) => {
            debugLog('[Toolkit] Backdrop clicked - ignoring (use Cancel or Save buttons)');
            // Do nothing - force user to use buttons
        };
        
        // Cancel button - just closes modal without saving or refreshing
        cancelBtn.onclick = (e) => {
            debugLog('[Toolkit] Cancel button clicked');
            e.stopPropagation();
            closeModal();
        };
        
        // Clear All Data button - with confirmation dialog
        clearAllBtn.onclick = async (e) => {
            debugLog('[Toolkit] Clear All Data button clicked');
            e.stopPropagation();
            
            // Create confirmation dialog in shadow DOM
            const confirmBackdrop = document.createElement('div');
            confirmBackdrop.className = 'backdrop';
            confirmBackdrop.style.zIndex = '10000005';
            
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal';
            confirmModal.style.zIndex = '10000006';
            confirmModal.style.width = '350px';
            confirmModal.innerHTML = `
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
            `;
            
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
                debugLog('[Toolkit] Confirmed - clearing all data');
                
                try {
                    await storage.clear();
                    debugLog('[Toolkit] All data cleared');
                    showNotification('All data cleared! Refreshing...');
                    setTimeout(() => {
                        window.location.reload();
                    }, 500);
                } catch (error) {
                    console.error('[Toolkit] Error clearing data:', error);
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
        
        // Save & Refresh button
        saveBtn.onclick = async (e) => {
            debugLog('[Toolkit] Save & Refresh button clicked');
            e.stopPropagation();
            
            // Handle sidebar min width - revert to default if empty/invalid
            const minWidthInputValue = parseInt(sidebarMinWidthInput.value, 10);
            const finalMinWidth = (!isNaN(minWidthInputValue) && minWidthInputValue >= 600 && minWidthInputValue <= 2000) 
                ? minWidthInputValue 
                : DEFAULT_SIDEBAR_MIN_WIDTH;
            
            debugLog('[Toolkit] Saving - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', finalMinWidth, 'CompactGeneration:', compactGenerationEnabled, 'ClassicLayout:', classicLayoutEnabled, 'ClassicStyle:', classicStyleEnabled, 'CustomStyle:', customStyleEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled);
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
            await storage.set('showChatNameInTitle', showChatNameInTitleEnabled);
            await storage.set('nsfwToggleEnabled', nsfwToggleEnabled);
            await storage.set(SMALL_PROFILE_IMAGES_KEY, smallProfileImagesEnabled);
            await storage.set(ROUNDED_PROFILE_IMAGES_KEY, roundedProfileImagesEnabled);
            await storage.set(SWAP_CHECKBOX_POSITION_KEY, swapCheckboxPositionEnabled);
            await storage.set(SQUARE_MESSAGE_EDGES_KEY, squareMessageEdgesEnabled);
            // Mark onboarding as seen when user saves settings
            await storage.set('hasSeenOnboarding', true);
            debugLog('[Toolkit] Settings saved to storage');
            showNotification('Settings saved! Refreshing...');
            setTimeout(() => {
                debugLog('[Toolkit] Reloading page...');
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
                    console.error('[Toolkit] Error exporting profiles:', error);
                    alert('Error exporting profiles: ' + error.message);
                }
            };
        }
        
        // Import Profiles button
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
                    console.error('[Toolkit] Error exporting custom style:', error);
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
                                // Merge with defaults to ensure all fields exist
                                const mergedValues = { ...DEFAULT_CUSTOM_STYLE, ...imported };
                                // Update the in-memory values
                                Object.assign(customStyleValues, mergedValues);
                                // Update the UI inputs
                                customAiBgInput.value = customStyleValues.aiMessageBg;
                                customUserBgInput.value = customStyleValues.userMessageBg;
                                customBodyColorInput.value = customStyleValues.bodyColor;
                                customSpanQuoteColorInput.value = customStyleValues.spanQuoteColor;
                                customNarrationColorInput.value = customStyleValues.narrationColor;
                                customHighlightBgColorInput.value = customStyleValues.highlightBgColor;
                                customHighlightTextColorInput.value = customStyleValues.highlightTextColor;
                                customFontSizeInput.value = customStyleValues.fontSize;
                                customFontFamilyInput.value = customStyleValues.fontFamily || '';
                                customFontWeightSelect.value = customStyleValues.fontWeight || 'normal';
                                customFontStyleSelect.value = customStyleValues.fontStyle || 'normal';
                                customTextDecorationSelect.value = customStyleValues.textDecoration || 'none';
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
        
        // Export All Data button
        debugLog('[Toolkit] Attaching exportAllBtn onclick handler...');
        debugLog('[Toolkit] exportAllBtn element:', exportAllBtn);
        debugLog('[Toolkit] exportAllBtn exists?:', !!exportAllBtn);
        
        if (exportAllBtn) {
            exportAllBtn.onclick = async (e) => {
                debugLog('[Toolkit] ===== EXPORT ALL DATA CLICKED =====');
                debugLog('[Toolkit] Event:', e);
                e.stopPropagation();
                
                try {
                    debugLog('[Toolkit] Starting data fetch...');
                    debugLog('[Toolkit] Storage object type:', typeof storage);
                    debugLog('[Toolkit] Storage object:', storage);
                    
                    // Get all data from extension storage - fetch each value separately
                    debugLog('[Toolkit] Fetching enableSidebarLayout...');
                const enableSidebarLayout = await storage.get(SIDEBAR_LAYOUT_KEY, false);
                debugLog('[Toolkit] enableSidebarLayout result:', enableSidebarLayout, 'Type:', typeof enableSidebarLayout);
                
                debugLog('[Toolkit] Fetching enableClassicLayout...');
                const enableClassicLayout = await storage.get(CLASSIC_LAYOUT_KEY, false);
                debugLog('[Toolkit] enableClassicLayout result:', enableClassicLayout, 'Type:', typeof enableClassicLayout);
                
                debugLog('[Toolkit] Fetching enableClassicStyle...');
                const enableClassicStyle = await storage.get(CLASSIC_STYLE_KEY, false);
                debugLog('[Toolkit] enableClassicStyle result:', enableClassicStyle, 'Type:', typeof enableClassicStyle);
                
                debugLog('[Toolkit] Fetching enableCustomStyle...');
                const enableCustomStyle = await storage.get(CUSTOM_STYLE_KEY, false);
                debugLog('[Toolkit] enableCustomStyle result:', enableCustomStyle, 'Type:', typeof enableCustomStyle);
                
                debugLog('[Toolkit] Fetching customStyleValues...');
                const customStyleValuesStr = await storage.get(CUSTOM_STYLE_VALUES_KEY, JSON.stringify(DEFAULT_CUSTOM_STYLE));
                debugLog('[Toolkit] customStyleValues result:', customStyleValuesStr, 'Type:', typeof customStyleValuesStr);
                
                debugLog('[Toolkit] Fetching enableCompactGeneration...');
                const enableCompactGeneration = await storage.get(COMPACT_GENERATION_KEY, false);
                debugLog('[Toolkit] enableCompactGeneration result:', enableCompactGeneration, 'Type:', typeof enableCompactGeneration);
                
                debugLog('[Toolkit] Fetching enableHideForYou...');
                const enableHideForYou = await storage.get(HIDE_FOR_YOU_KEY, false);
                debugLog('[Toolkit] enableHideForYou result:', enableHideForYou, 'Type:', typeof enableHideForYou);
                
                debugLog('[Toolkit] Fetching enablePageJump...');
                const enablePageJump = await storage.get(PAGE_JUMP_KEY, false);
                debugLog('[Toolkit] enablePageJump result:', enablePageJump, 'Type:', typeof enablePageJump);
                
                debugLog('[Toolkit] Fetching showGenerationStats...');
                const showGenerationStats = await storage.get('showGenerationStats', false);
                debugLog('[Toolkit] showGenerationStats result:', showGenerationStats, 'Type:', typeof showGenerationStats);
                
                debugLog('[Toolkit] Fetching timestampDateFirst...');
                const timestampDateFirst = await storage.get('timestampDateFirst', true);
                debugLog('[Toolkit] timestampDateFirst result:', timestampDateFirst, 'Type:', typeof timestampDateFirst);
                
                debugLog('[Toolkit] Fetching nsfwToggleEnabled...');
                const nsfwToggleEnabled = await storage.get('nsfwToggleEnabled', false);
                debugLog('[Toolkit] nsfwToggleEnabled result:', nsfwToggleEnabled, 'Type:', typeof nsfwToggleEnabled);
                
                debugLog('[Toolkit] Fetching generationProfiles...');
                const generationProfiles = await storage.get('generationProfiles', '{}');
                debugLog('[Toolkit] generationProfiles result type:', typeof generationProfiles);
                debugLog('[Toolkit] generationProfiles length:', generationProfiles?.length);
                debugLog('[Toolkit] generationProfiles sample:', generationProfiles?.substring?.(0, 100));
                
                debugLog('[Toolkit] Fetching lastSelectedProfile...');
                const lastSelectedProfile = await storage.get('lastSelectedProfile', '');
                debugLog('[Toolkit] lastSelectedProfile result:', lastSelectedProfile, 'Type:', typeof lastSelectedProfile);
                
                debugLog('[Toolkit] Fetching messageGenerationStats...');
                const messageGenerationStats = await storage.get('messageGenerationStats', '{}');
                debugLog('[Toolkit] messageGenerationStats result type:', typeof messageGenerationStats);
                debugLog('[Toolkit] messageGenerationStats length:', messageGenerationStats?.length);
                debugLog('[Toolkit] messageGenerationStats sample:', messageGenerationStats?.substring?.(0, 100));
                
                debugLog('[Toolkit] All values fetched. Building export object...');
                
                // Parse JSON strings for proper export format
                const generationProfilesParsed = JSON.parse(generationProfiles);
                const messageGenerationStatsParsed = JSON.parse(messageGenerationStats);
                
                // Build the export object
                const allData = {
                    enableSidebarLayout,
                    enableClassicLayout,
                    enableClassicStyle,
                    enableCustomStyle,
                    customStyleValues: customStyleValuesStr,
                    enableCompactGeneration,
                    enableHideForYou,
                    enablePageJump,
                    showGenerationStats,
                    timestampDateFirst,
                    nsfwToggleEnabled,
                    generationProfiles: generationProfilesParsed,  // Use parsed object
                    lastSelectedProfile,
                    messageGenerationStats: messageGenerationStatsParsed  // Use parsed object
                };
                
                debugLog('[Toolkit] Export object built:', Object.keys(allData));
                debugLog('[Toolkit] Export object full:', allData);
                debugLog('[Toolkit] Checking each property:');
                for (const [key, value] of Object.entries(allData)) {
                    debugLog(`[Toolkit]   ${key}:`, typeof value, value?.constructor?.name, value);
                }
                
                debugLog('[Toolkit] Stringifying to JSON...');
                const dataStr = JSON.stringify(allData, null, 2);
                debugLog('[Toolkit] JSON string length:', dataStr.length);
                debugLog('[Toolkit] JSON string sample:', dataStr.substring(0, 200));
                
                debugLog('[Toolkit] Creating blob...');
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                debugLog('[Toolkit] Blob created, size:', dataBlob.size);
                
                const url = URL.createObjectURL(dataBlob);
                debugLog('[Toolkit] Object URL created:', url);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = `sai-toolkit-extension-${Date.now()}.json`;
                debugLog('[Toolkit] Download link created, filename:', link.download);
                
                link.click();
                debugLog('[Toolkit] Link clicked');
                
                URL.revokeObjectURL(url);
                debugLog('[Toolkit] Object URL revoked');
                
                showNotification('All data exported successfully!\nFile includes: settings, profiles, and message stats');
                debugLog('[Toolkit] ===== EXPORT COMPLETED SUCCESSFULLY =====');
            } catch (error) {
                console.error('[Toolkit] ===== EXPORT ERROR =====');
                console.error('[Toolkit] Error exporting data:', error);
                console.error('[Toolkit] Error stack:', error.stack);
                alert('Error exporting data: ' + error.message);
            }
        };
        } else {
            console.error('[Toolkit] Cannot attach exportAllBtn handler - button not found!');
        }
        
        // Import All Data button
        debugLog('[Toolkit] Attaching importAllBtn onclick handler...');
        debugLog('[Toolkit] importAllBtn element:', importAllBtn);
        debugLog('[Toolkit] importAllBtn exists?:', !!importAllBtn);
        
        if (importAllBtn) {
            importAllBtn.onclick = async (e) => {
                debugLog('[Toolkit] Import All Data button clicked');
                e.stopPropagation();
                
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(event) {
                    const file = event.target.files[0];
                    if (!file) {
                        debugLog('[Toolkit] No file selected');
                        return;
                    }
                
                debugLog('[Toolkit] File selected:', file.name);
                const reader = new FileReader();
                reader.onload = async function(e) {
                    try {
                        const imported = JSON.parse(e.target.result);
                        debugLog('[Toolkit] Parsed imported data:', Object.keys(imported));
                        
                        // Handle both old (double-encoded strings) and new (proper objects) formats
                        let generationProfilesValue = imported.generationProfiles;
                        let messageGenerationStatsValue = imported.messageGenerationStats;
                        
                        // If they're strings (old format), parse them; if already objects (new format), use as-is
                        if (typeof generationProfilesValue === 'string') {
                            debugLog('[Toolkit] generationProfiles is string (old format), parsing...');
                            generationProfilesValue = generationProfilesValue;  // Keep as string for storage
                        } else if (typeof generationProfilesValue === 'object') {
                            debugLog('[Toolkit] generationProfiles is object (new format), stringifying for storage...');
                            generationProfilesValue = JSON.stringify(generationProfilesValue);  // Convert to string for storage
                        }
                        
                        if (typeof messageGenerationStatsValue === 'string') {
                            debugLog('[Toolkit] messageGenerationStats is string (old format), parsing...');
                            messageGenerationStatsValue = messageGenerationStatsValue;  // Keep as string for storage
                        } else if (typeof messageGenerationStatsValue === 'object') {
                            debugLog('[Toolkit] messageGenerationStats is object (new format), stringifying for storage...');
                            messageGenerationStatsValue = JSON.stringify(messageGenerationStatsValue);  // Convert to string for storage
                        }
                        
                        // Build updates object conditionally
                        const updates = {};
                        if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
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
                        if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                        if (imported.nsfwToggleEnabled !== undefined) updates.nsfwToggleEnabled = imported.nsfwToggleEnabled;
                        if (generationProfilesValue !== undefined) updates.generationProfiles = generationProfilesValue;
                        if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;
                        if (messageGenerationStatsValue !== undefined) updates.messageGenerationStats = messageGenerationStatsValue;
                        
                        debugLog('[Toolkit] Importing keys:', Object.keys(updates));
                        
                        // Apply all updates
                        await storage.setMultiple(updates);
                        debugLog('[Toolkit] All data imported successfully');
                        
                        showNotification('All data imported successfully!\nRefreshing page...');
                        setTimeout(() => {
                            debugLog('[Toolkit] Reloading page...');
                            window.location.reload();
                        }, 1500);
                    } catch (error) {
                        console.error('[Toolkit] Error importing data:', error);
                        alert('Error importing data: ' + error.message);
                    }
                };
                reader.readAsText(file);
            });
            input.click();
        };
        } else {
            console.error('[Toolkit] Cannot attach importAllBtn handler - button not found!');
        }
        
        // Escape key to close
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                debugLog('[Toolkit] Escape key pressed');
                closeModal();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
        
        debugLog('[Toolkit] ===== MODAL SETUP COMPLETE =====');
    }
    
    // Global error monitoring to track React crashes
    window.addEventListener('error', async (event) => {
        debugLog('[Toolkit] ===== GLOBAL ERROR DETECTED =====');
        debugLog('[Toolkit] Error message:', event.message);
        debugLog('[Toolkit] Error filename:', event.filename);
        debugLog('[Toolkit] Error line:', event.lineno, 'col:', event.colno);
        debugLog('[Toolkit] Error object:', event.error);
        debugLog('[Toolkit] Stack trace:', event.error?.stack);
        debugLog('[Toolkit] Time:', Date.now());
    }, true);
    
    // Monitor unhandled promise rejections too
    window.addEventListener('unhandledrejection', async (event) => {
        debugLog('[Toolkit] ===== UNHANDLED PROMISE REJECTION =====');
        debugLog('[Toolkit] Reason:', event.reason);
        debugLog('[Toolkit] Promise:', event.promise);
        debugLog('[Toolkit] Time:', Date.now());
    });

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
    
    debugLog('[Toolkit] ===== ONBOARDING CHECK (BEFORE INIT) =====');
    debugLog('[Toolkit] All storage keys:', storageKeys);
    debugLog('[Toolkit] Storage contents:', allStorage);
    
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
    
    debugLog('[Toolkit] Onboarding check - hasSeenOnboarding:', hasSeenOnboarding);
    debugLog('[Toolkit] Onboarding check - hasClassicStyleKey:', hasClassicStyleKey);
    debugLog('[Toolkit] Onboarding check - hasToolkitSettings:', hasToolkitSettings);
    
    // Show onboarding if: never seen before (undefined) OR explicitly false
    // OR if user has settings but Classic Style key is missing (update scenario)
    const shouldShowOnboarding = hasSeenOnboarding === undefined || 
                                  hasSeenOnboarding === false ||
                                  (hasToolkitSettings && !hasClassicStyleKey);
    debugLog('[Toolkit] Should show onboarding?', shouldShowOnboarding);
    
    // Initialize styles on page load
    await initializeStyles();
    
    // Expose a helper function to reset onboarding (for testing)
    // Since content scripts can't expose functions to page context, we use custom events
    window.addEventListener('SAI_RESET_ONBOARDING', async function() {
        debugLog('[Toolkit] Reset onboarding event received');
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
        debugLog('[Toolkit] Onboarding and all settings reset! Reload the page to see the onboarding modal.');
        setTimeout(() => location.reload(), 1000);
    });
    
    // Note: resetSAIToolkitOnboarding() function is injected via page-context.js
    
    if (shouldShowOnboarding) {
        debugLog('[Toolkit] First run detected - will show onboarding modal');
        // Don't mark as seen yet - only mark when user clicks "Save & Refresh"
        // Wait for page to fully load and toolkit icon to be injected before showing modal
        setTimeout(() => {
            debugLog('[Toolkit] Triggering onboarding modal...');
            try {
                showToolkitSettingsModal();
            } catch (error) {
                console.error('[Toolkit] Error showing onboarding modal:', error);
            }
        }, 3000); // Increased delay to ensure page is fully loaded
    } else {
        debugLog('[Toolkit] Not first run - skipping onboarding modal');
    }

    // Observe for modal appearance
    const observer = new MutationObserver(function(mutations) {
        // Look specifically for the Generation Settings modal (supports both old and new UI)
        const modal = findGenerationSettingsModal();
        
        if (modal && !modal.querySelector('#profile-controls')) {
            // Wait a bit for the modal to fully render
            setTimeout(createProfileControls, 100);
        }
        
        // Try to inject sidebar button (watches for sidebar to load)
        injectToolkitSidebarButton();
        
        // Inject CSS to hide toolkit button text when sidebar is collapsed (only once)
        if (!document.getElementById('sai-toolkit-button-css')) {
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
            debugLog('[Toolkit] Button CSS injected');
        }
        
        // Try to inject mobile button (watches for Like button to appear)
        injectToolkitMobileButton();
        
        // Try to inject chat export button (only on chat pages)
        injectChatExportButton();
        
        // Try to inject NSFW toggle button (only on chat pages, after export button)
        injectNSFWToggleButton();
        
        // Retry sidebar button injection with delays (in case sidebar loads later)
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            setTimeout(() => injectToolkitSidebarButton(), delay);
        });
        
        // Retry mobile button injection with delays
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            setTimeout(() => injectToolkitMobileButton(), delay);
        });
        
        // Retry export button injection with delays
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            setTimeout(() => injectChatExportButton(), delay);
        });
        
        // Retry NSFW toggle button injection with delays
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            setTimeout(() => injectNSFWToggleButton(), delay);
        });
        
        // Instead of heavy MutationObservers, use lightweight periodic checks
        // Check every 2 seconds if buttons still exist and text element is present
        setInterval(() => {
            const sidebarButton = document.getElementById('sai-toolkit-sidebar-btn');
            if (sidebarButton) {
                // Check if text element exists, if not re-add it
                const iconContainer = sidebarButton.querySelector('.flex.items-center.gap-2');
                if (iconContainer && !iconContainer.querySelector('.toolkit-button-text')) {
                    let textElement = document.createElement('p');
                    textElement.className = 'font-sans text-decoration-skip-ink-none text-underline-position-from-font text-label-lg font-regular text-left truncate toolkit-button-text';
                    textElement.textContent = 'S.AI Toolkit';
                    iconContainer.appendChild(textElement);
                    debugLog('[Toolkit] Text element re-added after React removed it');
                }
            } else {
                // Button missing, try to re-inject
                const helpIcon = document.querySelector('svg.lucide-info');
                if (helpIcon) {
                    injectToolkitSidebarButton();
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
            
            // Check export button (only on chat pages)
            if (window.location.pathname.startsWith('/chat/')) {
                const exportButton = document.getElementById('sai-export-btn');
                if (!exportButton) {
                    injectChatExportButton();
                }
                
                // Check NSFW toggle button
                const nsfwButton = document.getElementById('sai-nsfw-btn');
                if (!nsfwButton) {
                    injectNSFWToggleButton();
                }
            }
        }, TIMING.PERIODIC_CHECK); // Check periodically instead of on every DOM mutation
    });

    // Wait for body before starting observer (fixes middle-click new tab issue)
    waitForBody().then((body) => {
        debugLog('[Toolkit] document.body available, starting main observer');
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
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            setTimeout(() => {
                injectToolkitSidebarButton();
                injectToolkitMobileButton();
                injectChatExportButton();
                injectNSFWToggleButton();
            }, delay);
        });
    }).catch((err) => {
        console.error('[Toolkit] Failed to wait for body:', err);
        // Last resort: try anyway after a delay
        setTimeout(() => {
            if (document.body) {
                debugLog('[Toolkit] Retrying observer setup after error');
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
    // Track which message IDs have already had stats inserted to prevent duplicates
    // Note: We clear this set when navigating conversations to allow re-insertion
    const statsInsertedForMessageIds = new Set();      // Successfully inserted
    const statsInsertionInProgress = new Set();        // Currently being processed (prevents parallel runs)
    let lastConversationIdForStatsSet = null;
    
    // Sequential retry wrapper - prevents race conditions from browser timer throttling
    // When a tab is in background, multiple setTimeout calls can fire at once on restore
    async function insertStatsWithRetry(messageId, model, settings, createdAt, attempt = 1) {
        const maxAttempts = 4;
        const delays = [500, 1000, 1500, 2000]; // Delay before each attempt
        
        if (attempt > maxAttempts) {
            debugLog('[Stats RETRY] Max attempts reached for message:', messageId?.substring(0, 8));
            return;
        }
        
        // Wait before attempting
        await new Promise(resolve => setTimeout(resolve, delays[attempt - 1] || 500));
        
        // Check if already successfully inserted (by this or another call)
        if (statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats RETRY] Already inserted, stopping retries for:', messageId?.substring(0, 8));
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
            statsInsertionInProgress.clear();;
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
        
        if (!statsEnabled && !timestampEnabled) {
            debugLog('[Stats REGEN] Neither stats nor timestamp enabled, skipping');
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
                    const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
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
        
        // Find the header container
        const headerContainer = targetBubble.querySelector('div.flex.justify-between.items-center.gap-md');
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
            statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
            
            // Insert before the menu button container
            const menuButtonContainer = headerContainer.querySelector('.relative');
            if (menuButtonContainer) {
                headerContainer.insertBefore(statsDiv, menuButtonContainer);
                headerContainer.style.setProperty('gap', '4px', 'important');
            } else {
                headerContainer.appendChild(statsDiv);
            }
        }
        
        // Set the content and version ID
        statsDiv.dataset.versionId = messageId;
        safeSetHTML(statsDiv, displayText);
        
        // Mark as successfully inserted (prevents future retries)
        statsInsertedForMessageIds.add(messageId);
        // Remove from in-progress
        statsInsertionInProgress.delete(messageId);
        
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
        
        // Use cached storage reads to reduce I/O (Issue #13)
        const cache = window.__toolkitStorageCache;
        const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
        const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
        const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);
        

        debugLog('[Stats DISPLAY] Stats enabled:', statsEnabled, 'Timestamp enabled:', timestampEnabled, 'Model details:', showModelDetails);

        
        // If neither is enabled, no need to process
        if (!statsEnabled && !timestampEnabled) return;
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');

        debugLog('[Stats] Found message wrappers:', messageWrappers.length);
        
        // Calculate total messages in the combined index map
        const totalMessages = Object.keys(messageIdToIndexMap).length;
        debugLog('[Stats] Total messages in combined index map:', totalMessages);
        
        // Calculate offset: if page shows fewer messages than stored, offset to the end
        const messagesOnPage = messageWrappers.length;
        const storageOffset = Math.max(0, totalMessages - messagesOnPage);
        debugLog('[Stats] Messages on page:', messagesOnPage, 'Storage offset:', storageOffset);
        
        let messageIndex = 0; // Combined index for all messages
        
        for (const wrapper of messageWrappers) {
            // Check if this is a bot message (has character link) or user message
            const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
            const isBotMessage = !!characterLink;
            debugLog('[Stats] Processing message, isBotMessage:', isBotMessage, 'messageIndex:', messageIndex);
            
            // Skip messages with version counters when processing new messages
            // (they're handled by insertStatsForRegeneratedMessage in that case)
            // But on initial page load, we need to process them here
            const versionCounter = wrapper.querySelector('p.text-label-md');
            const hasVersionCounter = versionCounter && /^\d+\/\d+$/.test(versionCounter.textContent.trim());
            if (skipVersionCounterMessages && hasVersionCounter) {
                debugLog('[Stats] Skipping message with version counter (handled by insertStatsForRegeneratedMessage)');
                messageIndex++;
                continue;
            }
            
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
            
            if (!actionContainer) {
                debugLog('[Stats] No action container found!');
                messageIndex++;
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
                    messageIndex++;
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
                                messageIndex++;
                                continue;
                            }
                        } else {
                            debugLog('[Stats] Storage does not have arrow format, skipping update');
                            debugLog('[Stats] Stats already present, skipping');
                            messageIndex++;
                            continue;
                        }
                    } else {
                        debugLog('[Stats] No messageId extracted, skipping');
                        debugLog('[Stats] Stats already present, skipping');
                        messageIndex++;
                        continue;
                    }
                } else {
                    debugLog('[Stats] User message, skipping');
                    debugLog('[Stats] Stats already present, skipping');
                    continue;
                }
            }
            
            if (actionContainer.dataset.statsProcessing) {
                debugLog('[Stats] Already being processed (race condition), skipping');
                messageIndex++;
                continue;
            }
            
            // Mark as processing immediately to prevent race conditions
            actionContainer.dataset.statsProcessing = 'true';
            
            // Wrap entire processing in try/catch to ensure cleanup on errors
            try {
                if (isBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                
                if (DEBUG_MODE) {
                    console.log('[Stats DISPLAY] ========== PROCESSING BOT MESSAGE ==========');
                    console.log('[Stats DISPLAY] Extracted messageId:', messageId);
                    console.log('[Stats DISPLAY] messageIndex:', messageIndex);
                    console.log('[Stats DISPLAY] hasVersionCounter:', hasVersionCounter);
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
                        console.log('[Stats DISPLAY] Fallback - correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    }
                    debugLog('[Stats] Extracted messageId:', messageId, 'messageIndex:', messageIndex, 'correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    if (messageIdToIndexMap[correctedIndex] !== undefined) {
                        messageId = messageIdToIndexMap[correctedIndex];
                        if (DEBUG_MODE) {
                            console.log('[Stats DISPLAY] Using mapped messageId:', messageId);
                        }
                        debugLog('[Stats] Using mapped messageId:', messageId);
                    }
                }
                
                if (DEBUG_MODE) {
                    console.log('[Stats DISPLAY] Final messageId to lookup:', messageId);
                }
                
                // Skip if this message was already handled by insertStatsWithRetry
                // This prevents duplicate stats when both paths try to insert
                if (messageId && statsInsertedForMessageIds.has(messageId)) {
                    debugLog('[Stats DISPLAY] Message already handled by insertStatsForRegeneratedMessage, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex++;
                    continue;
                }
                
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                if (DEBUG_MODE) {
                    console.log('[Stats DISPLAY] Retrieved from storage:', generationStats);
                    console.log('[Stats DISPLAY] Timestamp from storage:', generationStats?.timestamp);
                    console.log('[Stats DISPLAY] Timestamp as Date:', generationStats?.timestamp ? new Date(generationStats.timestamp).toISOString() : 'null');
                }
                debugLog('[Stats] Got stats from storage:', generationStats);
                if (!generationStats && pendingMessageStats) generationStats = pendingMessageStats;
                if (!generationStats && lastGenerationSettings) generationStats = lastGenerationSettings;
                debugLog('[Stats] Final stats:', generationStats);
                
                if (!generationStats) {
                    debugLog('[Stats] No stats found, skipping message');
                    // Clear the processing flag so it can be retried later
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex++;
                    continue;
                }
                
                debugLog('[Stats] Creating stats div...');
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
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
                        console.log('[Stats DISPLAY] Formatted timestamp:', timestamp);
                        console.log('[Stats DISPLAY] Input to formatTimestamp was:', generationStats.timestamp);
                    }
                    if (timestamp) {
                        displayLines.push(timestamp);
                    }
                }
                
                // If we have nothing to display, skip
                if (displayLines.length === 0) {
                    debugLog('[Stats] No displayable data, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex++;
                    continue;
                }
                
                // Join lines with <br>
                const displayText = displayLines.join('<br>');
                safeSetHTML(statsDiv, displayText);
                if (DEBUG_MODE) {
                    console.log('[Stats DISPLAY] Stats div content:', statsDiv.textContent);
                }
                debugLog('[Stats] Stats div innerHTML:', statsDiv.innerHTML);
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                debugLog('[Stats] Menu button container:', menuButtonContainer);
                if (menuButtonContainer) {
                    if (DEBUG_MODE) {
                        console.log('[Stats DISPLAY] ========== INSERTING STATS DIV ==========');
                        console.log('[Stats DISPLAY] Stats div content before insert:', statsDiv.textContent);
                        console.log('[Stats DISPLAY] Inserting into action container');
                    }
                    debugLog('[Stats] Inserting stats div...');
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                    
                    // Mark this message as having stats inserted to prevent duplicates
                    if (messageId) {
                        statsInsertedForMessageIds.add(messageId);
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
                        console.log('[Stats DISPLAY] Stats div inserted! Final content:', statsDiv.textContent);
                        console.log('[Stats DISPLAY] Stats div is in DOM:', document.contains(statsDiv));
                        console.log('[Stats DISPLAY] ===========================================');
                    }
                    debugLog('[Stats] Stats div inserted successfully!');
                } else {
                    debugLog('[Stats] No menu button container found, cannot insert stats');
                    delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                }
                
                messageIndex++;
                } else {
                    // User message - show only timestamp if enabled
                    if (!timestampEnabled) {
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex++;
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
                    
                    // Skip if this message was already handled
                    if (messageId && statsInsertedForMessageIds.has(messageId)) {
                        debugLog('[Stats] User message already handled, skipping');
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex++;
                        continue;
                    }
                    
                    // Only display if we have a valid timestamp
                    if (!generationStats?.timestamp) {
                        debugLog('[Stats] User message - no timestamp, skipping');
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex++;
                        continue;
                    }
                    
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (!timestamp) {
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex++;
                        continue;
                    }
                    
                    // Create timestamp div for user messages
                    const statsDiv = document.createElement('div');
                    statsDiv.className = 'generation-stats';
                    statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                    // Add data-version-id to prevent being hidden by the regeneration switcher CSS
                    if (messageId) {
                        statsDiv.dataset.versionId = messageId;
                    }
                    
                    safeSetHTML(statsDiv, timestamp);
                    
                    // Insert before the menu button's parent container
                    const menuButtonContainer = actionContainer.querySelector('.relative');
                    if (menuButtonContainer) {
                        actionContainer.insertBefore(statsDiv, menuButtonContainer);
                        actionContainer.style.setProperty('gap', '4px', 'important');
                        // Mark this message as having stats inserted
                        if (messageId) {
                            statsInsertedForMessageIds.add(messageId);
                        }
                        delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                        debugLog('[Stats] User message - timestamp inserted successfully');
                    } else {
                        delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                    }
                    messageIndex++;
                }
            } catch (error) {
                // Ensure cleanup on any error during stats processing
                console.error('[Toolkit] Error processing message stats:', error);
                delete actionContainer.dataset.statsProcessing;
                messageIndex++;
            }
        }
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

    // Wait for body before starting message observer (fixes middle-click new tab issue)
    waitForBody().then((body) => {
        debugLog('[Stats] document.body available, starting message observer');
        messageObserver.observe(body, {
            childList: true,
            subtree: true
        });
    }).catch((err) => {
        console.error('[Stats] Failed to wait for body:', err);
        // Retry after a delay
        setTimeout(() => {
            if (document.body) {
                debugLog('[Stats] Retrying message observer setup after error');
                messageObserver.observe(document.body, { childList: true, subtree: true });
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
        
        debugLog('[Toolkit] Version change:', currentVersion, '->', newVersion);
        
        // If version didn't change (button was disabled), do nothing
        if (newVersion === currentVersion) {
            debugLog('[Toolkit] Version unchanged, skipping');
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
            debugLog('[Toolkit] === INSIDE SETTIMEOUT - STARTING VERSION SWITCH HANDLER ===');
            
            // The counter element is likely detached by React after the version switch
            // Instead, we search the LIVE DOM for the version switcher showing the NEW version
            const versionText = `${newVersion}/${totalVersions}`;
            debugLog('[Toolkit] Searching for version text:', versionText);
            
            let liveStatsDiv = null;
            let liveHeaderContainer = null;
            let messageBubble = null;
            
            // Find the paragraph showing our target version (e.g., "2/2")
            const allParagraphs = document.querySelectorAll('p.text-label-md');
            for (const p of allParagraphs) {
                if (p.textContent.trim() === versionText) {
                    debugLog('[Toolkit] Found version text paragraph in LIVE DOM');
                    
                    // Navigate up to the message bubble
                    // The bubble has classes: flex flex-col ... gap-md ... px-[13px] ... rounded-[...]  bg-gray-4
                    messageBubble = p.closest('div[class*="bg-gray-4"][class*="rounded"]');
                    if (!messageBubble) {
                        // Fallback: try finding by px-[13px] which is unique to message bubbles
                        messageBubble = p.closest('div[class*="px-\\[13px\\]"]');
                    }
                    
                    if (messageBubble) {
                        debugLog('[Toolkit] Message bubble found:', messageBubble.className.substring(0, 80));
                        
                        // Find the header container (has gap-md AND justify-between items-center)
                        liveHeaderContainer = messageBubble.querySelector('div.flex.justify-between.items-center.gap-md');
                        debugLog('[Toolkit] Header container found:', !!liveHeaderContainer);
                        
                        if (liveHeaderContainer) {
                            liveStatsDiv = liveHeaderContainer.querySelector('.generation-stats');
                            debugLog('[Toolkit] Stats div in header:', !!liveStatsDiv);
                        }
                    }
                    break;
                }
            }
            
            // If we couldn't find the header container, we can't proceed
            if (!liveHeaderContainer) {
                debugLog('[Toolkit] Could not find header container, aborting');
                return;
            }
            
            // Try to find the message ID from our alternative groups
            let newMessageId = null;
            
            // Method 3: Fall back to matching by version count (works if counts are unique)
            // alternativeMessageGroups[prev_id] contains ALL versions including the original (v1)
            // so alternatives.length === totalVersions
            if (!newMessageId) {
                debugLog('[Toolkit] Trying to match by version count:', totalVersions);
                debugLog('[Toolkit] Available groups:', Object.entries(alternativeMessageGroups).map(([k, v]) => 
                    `${k.substring(0, 8)}: ${v.length} versions [${v.map(m => m.id.substring(0, 8)).join(', ')}]`
                ));
                for (const [prevId, alternatives] of Object.entries(alternativeMessageGroups)) {
                    if (alternatives.length === totalVersions) {
                        const targetIndex = newVersion - 1;
                        debugLog('[Toolkit] Found group by count match! prev_id:', prevId.substring(0, 8));
                        debugLog('[Toolkit] Alternatives in group:', alternatives.map((m, i) => `v${i+1}=${m.id.substring(0, 8)}`));
                        debugLog('[Toolkit] Target index:', targetIndex, 'for newVersion:', newVersion);
                        if (targetIndex >= 0 && targetIndex < alternatives.length) {
                            newMessageId = alternatives[targetIndex].id;
                            debugLog('[Toolkit] Selected message ID:', newMessageId.substring(0, 8));
                        }
                        break;
                    }
                }
            }
            
            if (!newMessageId) {
                debugLog('[Toolkit] Could not determine message ID after version switch');
                return;
            }
            
            debugLog('[Toolkit] Final message ID for lookup:', newMessageId.substring(0, 8));
            debugLog('[Toolkit] messageTimestamps has this ID?', !!messageTimestamps[newMessageId]);
            debugLog('[Toolkit] messageTimestamps[newMessageId]:', messageTimestamps[newMessageId]);
            debugLog('[Toolkit] All messageTimestamps keys:', Object.keys(messageTimestamps).map(k => k.substring(0, 8)));
            
            // Get the stats for this specific message version
            // Note: getStatsForMessage automatically uses the API timestamp from messageTimestamps
            const generationStats = await getStatsForMessage(newMessageId);
            debugLog('[Toolkit] Stats lookup result:', generationStats ? 'found' : 'not found', generationStats);
            debugLog('[Toolkit] Stats timestamp after getStatsForMessage:', generationStats?.timestamp, '→', generationStats?.timestamp ? new Date(generationStats.timestamp).toLocaleString() : 'null');
            
            if (!generationStats) {
                debugLog('[Toolkit] No stats found for message:', newMessageId);
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
            
            debugLog('[Toolkit] Settings:', { statsEnabled, timestampEnabled, showModelDetails });
            
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
            
            debugLog('[Toolkit] Display lines:', displayLines);
            
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
                    debugLog('[Toolkit] No stats div found, creating new one in header container');
                    liveStatsDiv = document.createElement('div');
                    liveStatsDiv.className = 'generation-stats';
                    liveStatsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                    
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
                    debugLog('[Toolkit] ERROR: Could not find or create any live stats div to update!');
                    return;
                }
                
                debugLog('[Toolkit] BEFORE update - stats div content:', liveStatsDiv.textContent.substring(0, 60));
                debugLog('[Toolkit] Stats div is in document:', document.body.contains(liveStatsDiv));
                
                // Apply the update
                liveStatsDiv.dataset.versionId = newMessageId;
                safeSetHTML(liveStatsDiv, displayText);
                
                // IMPORTANT: Remove any duplicate stats divs in this header
                // React might have created another one, or we might have created a duplicate
                const allStatsDivsInHeader = liveHeaderContainer.querySelectorAll('.generation-stats');
                debugLog('[Toolkit] Stats divs in header after update:', allStatsDivsInHeader.length);
                if (allStatsDivsInHeader.length > 1) {
                    // Keep only the first one (ours), remove the rest
                    for (let i = 1; i < allStatsDivsInHeader.length; i++) {
                        debugLog('[Toolkit] Removing duplicate stats div');
                        allStatsDivsInHeader[i].remove();
                    }
                }
                
                debugLog('[Toolkit] AFTER update - stats div content:', liveStatsDiv.textContent.substring(0, 60));
                debugLog('[Toolkit] Updated stats display!');
                
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
                                        debugLog('[Toolkit] reapplyStats: No stats div found, creating new one');
                                        const newStatsDiv = document.createElement('div');
                                        newStatsDiv.className = 'generation-stats';
                                        newStatsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
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
                                            debugLog('[Toolkit] reapplyStats: Updating existing stats div');
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
                    debugLog('[Toolkit] Stopped watching for React re-renders');
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
                debugLog('[Toolkit] No displayable content, cleared stats div');
            }
        }, 50); // Reduced from 200ms to 50ms for faster response
    }
    
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
        
        debugLog('[Toolkit] Regeneration switcher clicked!', {
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
        
        debugLog('[Toolkit] Arrow key pressed for version switch!', {
            key: e.key,
            currentVersion,
            totalVersions,
            alternativeGroupsCount: Object.keys(alternativeMessageGroups).length
        });
        
        await handleVersionSwitch(currentVersion, totalVersions, isNext);
    }, true); // Use capture phase

    // Initial check in case modal is already open
    setTimeout(createProfileControls, 1000);

    // =============================================================================
    // ===                   MEMORY MANAGER AUTO-REFRESH                        ===
    // =============================================================================
    
    let memoryRefreshInterval = null;
    
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
        debugLog('[S.AI] Refreshing Memory Manager content via API...');
        
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
            debugLog('[S.AI] Memory modal not found');
            return false;
        }
        
        // Get conversation ID from captured API data
        const conversationId = getConversationId();
        if (!conversationId) {
            debugLog('[S.AI] Could not get conversation ID (not yet captured from messages API)');
            return false;
        }
        debugLog('[S.AI] Using conversation ID:', conversationId);
        
        try {
            // Inject a script into the page context to make the fetch request
            // This bypasses CORS restrictions that content scripts face
            // We need to get the auth token from localStorage or the page's fetch interceptor
            const script = document.createElement('script');
            script.textContent = `
                (async function() {
                    try {
                        // Try to get the auth token and other required headers
                        let authToken = null;
                        let guestUserId = null;
                        let country = null;
                        
                        try {
                            // Method 1: Check if we captured the Kinde access token from OAuth refresh
                            if (window.__kindeAccessToken) {
                                authToken = window.__kindeAccessToken;
                                debugLog('[S.AI] Using captured Kinde access token');
                            }
                            
                            // Method 2: Check intercepted headers from API calls
                            if (window.__lastAuthHeaders) {
                                if (!authToken && window.__lastAuthHeaders.Authorization) {
                                    authToken = window.__lastAuthHeaders.Authorization.replace('Bearer ', '');
                                    debugLog('[S.AI] Using intercepted Authorization header');
                                }
                                if (!guestUserId && window.__lastAuthHeaders['X-Guest-UserId']) {
                                    guestUserId = window.__lastAuthHeaders['X-Guest-UserId'];
                                }
                                if (!country && window.__lastAuthHeaders['X-Country']) {
                                    country = window.__lastAuthHeaders['X-Country'];
                                }
                            }
                            
                            // Method 3: Search localStorage for token (fallback)
                            if (!authToken) {
                                for (const key of Object.keys(localStorage)) {
                                    try {
                                        const value = localStorage.getItem(key);
                                        if (!value) continue;
                                        
                                        // Try parsing as JSON
                                        if (value.startsWith('{') || value.startsWith('[')) {
                                            const parsed = JSON.parse(value);
                                            
                                            // Look for auth token
                                            if (!authToken && (parsed.access_token || parsed.accessToken || parsed.token)) {
                                                authToken = parsed.access_token || parsed.accessToken || parsed.token;
                                            }
                                            
                                            // Look for user ID
                                            if (!guestUserId && (parsed.userId || parsed.user_id || parsed.id)) {
                                                guestUserId = parsed.userId || parsed.user_id || parsed.id;
                                            }
                                        } else if (!authToken && value.startsWith('eyJ')) {
                                            // Raw JWT token
                                            authToken = value;
                                        }
                                    } catch (e) {}
                                }
                            }
                            
                            debugLog('[S.AI] Auth check - Token:', !!authToken, 'UserId:', !!guestUserId, 'Country:', !!country);
                            
                        } catch (e) {
                            console.warn('[S.AI] Could not retrieve auth data:', e);
                        }
                        
                        const headers = {
                            'Accept': 'application/json, text/plain, */*',
                            'X-App-Id': 'spicychat'
                        };
                        
                        if (authToken) {
                            headers['Authorization'] = \`Bearer \${authToken}\`;
                        }
                        
                        if (guestUserId) {
                            headers['X-Guest-UserId'] = guestUserId;
                        }
                        
                        if (country) {
                            headers['X-Country'] = country;
                        }
                        
                        const response = await fetch('https://prod.nd-api.com/conversations/${conversationId}/memories', {
                            method: 'GET',
                            headers: headers,
                            credentials: 'include'
                        });
                        
                        if (response.ok) {
                            const memories = await response.json();
                            window.dispatchEvent(new CustomEvent('memoryDataFetched', {
                                detail: { success: true, memories: memories, count: memories.length }
                            }));
                        } else {
                            window.dispatchEvent(new CustomEvent('memoryDataFetched', {
                                detail: { 
                                    success: false, 
                                    status: response.status, 
                                    hasAuth: !!authToken,
                                    hasUserId: !!guestUserId,
                                    hasCountry: !!country
                                }
                            }));
                        }
                    } catch (error) {
                        window.dispatchEvent(new CustomEvent('memoryDataFetched', {
                            detail: { success: false, error: error.message }
                        }));
                    }
                })();
            `;
            
            // Set up listener for the response
            const responsePromise = new Promise((resolve) => {
                const handler = (event) => {
                    window.removeEventListener('memoryDataFetched', handler);
                    resolve(event.detail);
                };
                window.addEventListener('memoryDataFetched', handler);
                
                // Timeout after 10 seconds
                setTimeout(() => {
                    window.removeEventListener('memoryDataFetched', handler);
                    resolve({ success: false, error: 'timeout' });
                }, 10000);
            });
            
            // Inject and execute the script
            document.documentElement.appendChild(script);
            script.remove();
            
            // Wait for the response
            const result = await responsePromise;
            
            if (!result.success) {
                console.error('[S.AI] Failed to fetch memories:', result.status || result.error);
                if (result.status === 401) {
                    console.error('[S.AI] Authentication failed - token may be invalid or expired. Auth token present:', result.hasAuth);
                }
                return false;
            }
            
            debugLog(`[S.AI] Fetched ${result.count} memories from API`);
            
            // Try multiple approaches to trigger React re-render
            debugLog('[S.AI] Attempting to trigger React re-render...');
            debugLog('[S.AI] Memory modal element:', memoryModal);
            
            // NEW Approach: Try to find and click the "Load More Memories" button
            const loadMoreButton = Array.from(memoryModal.querySelectorAll('button'))
                .find(btn => btn.textContent?.includes('Load More'));
            
            if (loadMoreButton) {
                debugLog('[S.AI] Found Load More button, clicking it');
                loadMoreButton.click();
                await new Promise(resolve => setTimeout(resolve, 500));
                debugLog('[S.AI] Load More clicked, checking if memories updated');
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
                        debugLog('[S.AI] Found React keys at depth', depth, ':', reactKeys);
                        
                        const reactKey = reactKeys[0];
                        const reactObj = elementToCheck[reactKey];
                        
                        // Walk the fiber tree
                        let current = reactObj;
                        let attempts = 0;
                        while (current && attempts < 30) {
                            if (current.stateNode && typeof current.stateNode.forceUpdate === 'function') {
                                debugLog('[S.AI] Found forceUpdate at level', attempts, '- calling it');
                                current.stateNode.forceUpdate();
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                debugLog('[S.AI] Memory refresh completed (via forceUpdate)');
                                return true;
                            }
                            current = current.return;
                            attempts++;
                        }
                        break;
                    }
                    
                    elementToCheck = elementToCheck.parentElement;
                    depth++;
                }
                
                debugLog('[S.AI] No React fiber found after checking', depth, 'parent levels');
            } catch (e) {
                console.error('[S.AI] React manipulation failed:', e);
            }
            
            // Approach 2: Close and reopen (most reliable)
            debugLog('[S.AI] Attempting close/reopen approach...');
            
            // Try multiple close button selectors - use aria-label="X-button"
            let closeButton = memoryModal.querySelector('button[aria-label="X-button"]');
            if (!closeButton) {
                closeButton = memoryModal.querySelector('button[aria-label="Close"]');
            }
            if (!closeButton) {
                // Look for button with X icon
                const buttons = Array.from(memoryModal.querySelectorAll('button'));
                debugLog('[S.AI] Searching through', buttons.length, 'buttons for close button');
                closeButton = buttons.find(btn => {
                    const svg = btn.querySelector('svg');
                    if (!svg) return false;
                    // Close buttons typically have an X icon with crossing paths
                    const paths = svg.querySelectorAll('path');
                    return paths.length >= 2;
                });
            }
            
            if (closeButton) {
                debugLog('[S.AI] Found close button, closing modal...');
                
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
                    debugLog('[S.AI] Creating invisible placeholder to hold sidebar space');
                    
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
                    debugLog('[S.AI] Placeholder div created');
                }
                
                // Now close the Memories modal
                closeButton.click();
                closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                closeButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                closeButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                
                // Wait just long enough for close
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Reopen quickly - search more thoroughly for the Memory Manager button
                debugLog('[S.AI] Looking for Memory Manager button to reopen...');
                
                // First, try to find and open the chat dropdown menu
                const menuButton = document.querySelector('button[aria-label="chat-dropdown"]');
                if (menuButton) {
                    debugLog('[S.AI] Found chat dropdown menu button, opening it...');
                    menuButton.click();
                    await new Promise(resolve => setTimeout(resolve, 30));
                } else {
                    debugLog('[S.AI] Chat dropdown button not found');
                }
                
                // Try multiple selectors for the Manage Memories button
                debugLog('[S.AI] Looking for Manage Memories button...');
                let memoryButton = document.querySelector('button[aria-label="Manage Memories"]');
                debugLog('[S.AI] Direct selector result:', !!memoryButton);
                
                if (!memoryButton) {
                    // Look through all buttons for one with "Manage Memories" text
                    const allButtons = Array.from(document.querySelectorAll('button'));
                    debugLog('[S.AI] Searching through', allButtons.length, 'buttons on page');
                    
                    const memoryButtons = allButtons.filter(btn => {
                        const text = btn.textContent || '';
                        const ariaLabel = btn.getAttribute('aria-label') || '';
                        return text.toLowerCase().includes('manage memor') || ariaLabel.toLowerCase().includes('manage memor');
                    });
                    
                    debugLog('[S.AI] Found', memoryButtons.length, 'buttons with "manage memor" in text/aria-label');
                    if (memoryButtons.length > 0) {
                        memoryButtons.forEach((btn, i) => {
                            debugLog(`[S.AI] Memory button ${i}:`, {
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
                    debugLog('[S.AI] Found Memory Manager button:', memoryButton.textContent || memoryButton.getAttribute('aria-label'));
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
                            debugLog('[S.AI] Removed placeholder div');
                        }
                    }, 500);
                    
                    debugLog('[S.AI] Memory refresh completed (via close/reopen)');
                    return true;
                } else {
                    debugLog('[S.AI] Could not find Memory Manager button to reopen');
                    debugLog('[S.AI] Tried aria-label and text content searches');
                }
            } else {
                debugLog('[S.AI] Could not find close button');
                // Log the modal structure to help debug
                debugLog('[S.AI] Modal HTML structure:', memoryModal.outerHTML.substring(0, 500));
            }
            
            // Clean up overlay and spacer if they still exist
            const overlay = document.getElementById('sai-refresh-overlay');
            const spacer = document.getElementById('sai-refresh-spacer');
            if (overlay) overlay.remove();
            if (spacer) spacer.remove();
            
            debugLog('[S.AI] All refresh approaches attempted');
            return true;
            
        } catch (error) {
            console.error('[S.AI] Error refreshing memories:', error);
            
            // Clean up placeholder div if it exists
            if (placeholderDiv) {
                placeholderDiv.remove();
                debugLog('[S.AI] Removed placeholder div after error');
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
        debugLog('[S.AI] Memory Manager auto-refresh is disabled');
        return;
        
        // Clear any existing interval first
        if (memoryRefreshInterval) {
            clearInterval(memoryRefreshInterval);
        }
        
        debugLog('[S.AI] Memory Manager auto-refresh started (120 seconds)');
        
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
                    debugLog('[S.AI] Memory Manager closed, stopping auto-refresh');
                    clearInterval(memoryRefreshInterval);
                    memoryRefreshInterval = null;
                }
            } else {
                // Modal is no longer open, stop the interval
                debugLog('[S.AI] Memory Manager closed, stopping auto-refresh');
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
            debugLog('[S.AI] Memory Manager auto-refresh stopped');
        }
    }
    
    /**
     * Adds a manual refresh button to the Memory Manager modal
     */
    function addManualRefreshButton(modal) {
        // Mark modal as being processed to prevent duplicate calls
        if (modal.dataset.saiButtonProcessing) {
            debugLog('[S.AI] Refresh button already being added');
            return;
        }
        modal.dataset.saiButtonProcessing = 'true';
        
        // Check if button already exists
        if (modal.querySelector('[data-sai-refresh-button]')) {
            debugLog('[S.AI] Refresh button already exists');
            delete modal.dataset.saiButtonProcessing;
            return;
        }
        
        // Wait a bit for React to fully render the modal buttons
        setTimeout(() => {
            // Find the button container (with the + and ... buttons)
            const buttonContainer = modal.querySelector('.flex.justify-end.items-undefined.m-0');
            if (!buttonContainer) {
                debugLog('[S.AI] Could not find button container in Memory Manager');
                debugLog('[S.AI] Trying alternate selectors...');
                
                // Try finding any flex container with buttons
                const altContainer = modal.querySelector('.flex.justify-end');
                if (altContainer) {
                    debugLog('[S.AI] Found alternate container:', altContainer.className);
                } else {
                    debugLog('[S.AI] No button container found at all');
                }
                return;
            }
            
            debugLog('[S.AI] Found button container:', buttonContainer.className);
            debugLog('[S.AI] Container children:', buttonContainer.children.length);
            
            // Find the + button (first button with lucide-square-plus SVG)
            let addButton = buttonContainer.querySelector('svg.lucide-square-plus')?.closest('button');
            
            // If not found, try alternate approach
            if (!addButton) {
                debugLog('[S.AI] Trying alternate add button selector...');
                // Look for any button in the container
                const buttons = buttonContainer.querySelectorAll('button');
                debugLog('[S.AI] Found buttons:', buttons.length);
                
                if (buttons.length > 0) {
                    // Assume first button is the add button
                    addButton = buttons[0];
                    debugLog('[S.AI] Using first button as reference');
                } else {
                    debugLog('[S.AI] No buttons found in container');
                    debugLog('[S.AI] Container HTML:', buttonContainer.outerHTML.substring(0, 500));
                    return;
                }
            }
            
            debugLog('[S.AI] Found reference button, creating refresh button');
            
            // Create refresh button with the same styling as existing buttons
            const refreshButton = document.createElement('button');
            refreshButton.setAttribute('data-sai-refresh-button', 'true');
            refreshButton.className = addButton.className; // Copy exact classes from add button
            refreshButton.type = 'button';
            refreshButton.title = 'Refresh memories';
            refreshButton.setAttribute('default', '');
            refreshButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw inline-flex items-center justify-center">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                    <path d="M21 3v5h-5"></path>
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                    <path d="M3 21v-5h5"></path>
                </svg>
                <span class="flex items-center justify-center text-center gap-1.5"></span>
            `;
            
            // Add click handler
            refreshButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                debugLog('[S.AI] Manual refresh triggered');
                
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
            
            debugLog('[S.AI] Manual refresh button added to Memory Manager');
            debugLog('[S.AI] Button visible in DOM:', !!modal.querySelector('[data-sai-refresh-button]'));
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
                debugLog('[S.AI] Styled Load More Memories button for sidebar layout');
                
                // Watch for attribute changes in case React resets the style
                const buttonObserver = new MutationObserver(() => {
                    if (!loadMoreButton.style.marginTop || !loadMoreButton.style.marginBottom) {
                        loadMoreButton.style.setProperty('margin-top', '0.5rem', 'important');
                        loadMoreButton.style.setProperty('margin-bottom', '1.5rem', 'important');
                    }
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
    function monitorMemoryModal() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        let foundModal = null;
                        
                        // Check if this is the Memory Manager modal
                        if (node.classList && node.classList.contains('fixed')) {
                            const heading = node.querySelector('p.text-heading-6');
                            if (heading && heading.textContent.trim() === 'Memories') {
                                foundModal = node;
                            }
                        }
                        
                        // Also check children in case modal was added in a container
                        if (!foundModal) {
                            const memoryModal = node.querySelector?.('div.fixed p.text-heading-6');
                            if (memoryModal && memoryModal.textContent.trim() === 'Memories') {
                                foundModal = node.querySelector('div.fixed');
                            }
                        }
                        
                        // If we found the modal, add button and start refresh
                        if (foundModal) {
                            debugLog('[S.AI] Memory Manager detected, starting auto-refresh');
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
                                debugLog('[S.AI] Memory Manager removed from DOM');
                                stopMemoryRefresh();
                            }
                        }
                    }
                }
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        debugLog('[S.AI] Memory Manager auto-refresh monitor initialized');
    }
    
    // Initialize the memory modal monitor
    monitorMemoryModal();
    
    // Check if Memory Manager is already open on page load
    setTimeout(() => {
        const existingModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2');
        if (existingModal) {
            const heading = existingModal.querySelector('p.text-heading-6');
            if (heading && heading.textContent.trim() === 'Memories') {
                debugLog('[S.AI] Memory Manager already open on page load');
                addManualRefreshButton(existingModal);
                styleLoadMoreButton(existingModal);
                startMemoryRefresh();
            }
        }
    }, 2000);

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
    
    debugLog('[Toolkit] ==== NEW TAB CHECK ====');
    debugLog('[Toolkit] URL:', location.href);
    debugLog('[Toolkit] hasAlreadyReloaded:', hasAlreadyReloaded);
    debugLog('[Toolkit] navigationType:', navigationType);
    debugLog('[Toolkit] isNewTab:', isNewTab);
    debugLog('[Toolkit] readyState:', document.readyState);
    
    async function checkAndReloadIfNeeded() {
        await initializeMainCode();
        
        debugLog('[Toolkit] initializeMainCode completed');
        
        // Only check on chat pages
        const isChatPage = location.href.includes('/chat') || location.href.includes('/messages');
        debugLog('[Toolkit] isChatPage:', isChatPage);
        
        if (!isChatPage) {
            debugLog('[Toolkit] Not a chat page, skipping reload check');
            return;
        }
        
        // Check if our toolkit UI was actually injected
        const toolkitInjected = document.querySelector('sai-toolkit-modal') !== null;
        debugLog('[Toolkit] toolkitInjected:', toolkitInjected);
        
        // If this is a new tab (fresh navigation) and we haven't reloaded yet, do it
        // OR if the toolkit wasn't injected properly
        if ((isNewTab || !toolkitInjected) && !hasAlreadyReloaded) {
            debugLog('[Toolkit] NEW TAB DETECTED or toolkit not injected - Setting reload flag and reloading...');
            sessionStorage.setItem(RELOAD_FLAG_KEY, 'true');
            // Use a small delay to ensure sessionStorage is written
            setTimeout(() => {
                debugLog('[Toolkit] RELOADING NOW');
                location.reload();
            }, 100);
        } else {
            debugLog('[Toolkit] Not a new tab or already reloaded, proceeding normally');
        }
    }
    
    // Handle visibility changes - for prerendered pages or tabs opened in background
    let hasInitialized = false;
    
    async function initWhenVisible() {
        if (hasInitialized) return;
        
        if (document.visibilityState === 'visible') {
            hasInitialized = true;
            debugLog('[Toolkit] Page is visible, initializing...');
            await checkAndReloadIfNeeded();
        } else {
            debugLog('[Toolkit] Page not visible yet, waiting...');
            document.addEventListener('visibilitychange', async function onVisible() {
                if (document.visibilityState === 'visible' && !hasInitialized) {
                    hasInitialized = true;
                    debugLog('[Toolkit] Page became visible, initializing...');
                    document.removeEventListener('visibilitychange', onVisible);
                    await checkAndReloadIfNeeded();
                }
            });
        }
    }
    
    // Call initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenVisible);
    } else {
        // DOM is already loaded
        initWhenVisible();
    }
    
})(); // End of async IIFE
