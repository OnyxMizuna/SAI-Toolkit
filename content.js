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
const DEBUG_MODE = false;

// Debug logging helper
function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[S.AI Toolkit]', ...args);
    }
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
debugScript.remove();

// Listen for debug requests from page context
window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    
    if (event.data.type === 'SAI_DEBUG_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats: {} }, '*');
            return;
        }
        
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        const stats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats }, '*');
    }
    
    if (event.data.type === 'SAI_CLEAR_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
            return;
        }
        
        await new Promise((resolve) => {
            storage.set({ messageGenerationStats: '{}' }, () => resolve());
        });
        
        window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
    }
    
    if (event.data.type === 'SAI_EXPORT_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats: {} }, '*');
            return;
        }
        
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        let stats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        
        // If conversationId specified, export only that conversation
        if (event.data.conversationId && stats[event.data.conversationId]) {
            stats = { [event.data.conversationId]: stats[event.data.conversationId] };
        }
        
        window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats }, '*');
    }
    
    if (event.data.type === 'SAI_IMPORT_STATS_REQUEST') {
        const storage = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
        if (!storage) {
            window.postMessage({ type: 'SAI_IMPORT_STATS_RESPONSE' }, '*');
            return;
        }
        
        // Get existing stats
        const result = await new Promise((resolve) => {
            storage.get(['messageGenerationStats'], (items) => resolve(items));
        });
        
        let existingStats = result.messageGenerationStats ? JSON.parse(result.messageGenerationStats) : {};
        const importedStats = event.data.jsonData;
        
        // Merge imported stats with existing (imported takes precedence)
        const mergedStats = { ...existingStats, ...importedStats };
        
        await new Promise((resolve) => {
            storage.set({ messageGenerationStats: JSON.stringify(mergedStats) }, () => resolve());
        });
        
        window.postMessage({ type: 'SAI_IMPORT_STATS_RESPONSE' }, '*');
    }
});

'use strict';

// =============================================================================
// INJECT XHR/FETCH INTERCEPTION INTO PAGE CONTEXT - IMMEDIATELY
// This MUST happen at document_start to catch the initial GET /messages call
// =============================================================================

debugLog('[Stats] Injecting XHR/Fetch interception into page context (EARLY)...');

// Pass DEBUG_MODE to the page context
window.__SAI_DEBUG_MODE__ = DEBUG_MODE;

// Inject the intercept script as external file (MV3 compatible - no inline scripts)
const interceptScript = document.createElement('script');
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    interceptScript.src = chrome.runtime.getURL('xhr-intercept.js');
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
    interceptScript.src = browser.runtime.getURL('xhr-intercept.js');
} else {
    interceptScript.src = 'xhr-intercept.js';
}

// Inject the script into the page IMMEDIATELY
(document.head || document.documentElement).appendChild(interceptScript);
interceptScript.remove(); // Clean up after injection
debugLog('[Stats] Injection script added to page context (EARLY)');

// Storage API wrapper (uses browser.storage.local via storage-wrapper.js)
// The storage-wrapper.js is loaded first via manifest.json and provides:
// - storage.get(key, defaultValue)
// - storage.set(key, value)  
// - await storage.get(key, defaultValue) - compatibility wrapper
// - await storage.set(key, value) - compatibility wrapper

(async function() {
    'use strict';
    
    debugLog('[Toolkit] Content script loaded - starting initialization...');
    debugLog('[Toolkit] Storage object available:', typeof storage !== 'undefined');

    // =============================================================================
    // Note: Automatic migration from Tampermonkey is not possible due to isolated worlds
    // Users can manually export/import data via the popup UI instead
    // =============================================================================

    // =============================================================================
    // CRITICAL: Early CSS Injection (before React loads)
    // =============================================================================
    // This must happen first, before ANY React code runs, to avoid DOM conflicts
    
    const SIDEBAR_LAYOUT_KEY = 'enableSidebarLayout';
    const THEME_CUSTOMIZATION_KEY = 'enableThemeCustomization';
    
    // Get settings with async storage
    const sidebarEnabled = await storage.get(SIDEBAR_LAYOUT_KEY, false);
    const themeEnabled = await storage.get(THEME_CUSTOMIZATION_KEY, false);
    
    // Inject shared composer CSS if EITHER feature is enabled
    if (sidebarEnabled || themeEnabled) {
        const injectComposerCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectComposerCSS, { once: true });
                } else {
                    setTimeout(injectComposerCSS, 10);
                }
                return;
            }
            
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
    if (sidebarEnabled) {
        const injectSidebarCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSidebarCSS, { once: true });
                } else {
                    setTimeout(injectSidebarCSS, 10);
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
    
    // Inject Theme Customization CSS early if enabled
    if (themeEnabled) {
        const injectThemeCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectThemeCSS, { once: true });
                } else {
                    setTimeout(injectThemeCSS, 10);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-theme-customization-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-theme-customization-early';
            style.textContent = getThemeCustomizationCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Toolkit] Theme Customization CSS injected EARLY (before React initialization)');
        };
        
        injectThemeCSS();
    }
    
    // Define shared composer layout CSS (used by both Sidebar and Theme features)
    function getComposerLayoutCSSEarly() {
        return `/* ===== Composer layout & icon placement ===== */
/* Target ONLY the composer input row, NOT persona grid containers */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-end !important;  /* Align icons to bottom of textarea */
  flex-wrap: nowrap !important;
  gap: 0.5rem !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
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
  z-index: 9000000 !important;
  display: block !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
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

/* Settings popover: keep above the sidebar */
div[style*="position: absolute"][style*="z-index: 10000000"] {
  z-index: 10000001 !important;
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
  z-index: 10000002 !important;
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
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full) {
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
body:not(:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)))
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* When only Generation Settings is open */
body:not(:has(div.fixed.left-1\\/2.top-1\\/2.h-full))
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full) {
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

div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full) {
  display: flex !important;
  flex-direction: column !important;
}

div.fixed.left-1\\/2.top-1\\/2:not(:has(.flex.flex-col.gap-sm.px-lg)) [class*="overflow-y-auto"] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
}

body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"] {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
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
  padding-right: 0 !important;
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
    padding-right: 0 !important;
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
    padding-right: 0 !important;
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

    function getThemeCustomizationCSSEarly() {
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

/* Message Boxes */

.py-md.rounded-\\[20px_4px_20px_20px\\] {
  margin-left: auto !important;
  margin-right: auto !important;
  width: 100% !important;
  max-width: 800px !important;
  background-color: rgba(0, 100, 255, .1) !important;
  box-sizing: border-box !important;
  border-radius: 20px !important;
}

.py-md.rounded-\\[4px_20px_20px_20px\\] {
  margin-left: auto !important;
  margin-right: auto !important;
  width: 100% !important;
  max-width: 800px !important;
  background-color: rgba(100, 100, 100, .1) !important;
  box-sizing: border-box !important;
  border-radius: 20px !important;
}

.px-\\[13px\\] {
  padding-left: 16px !important;
  padding-right: 16px !important;
}

.flex-row-reverse { 
  flex-direction: row; 
}

.items-end {
  align-items: flex-start !important;
}

/* ===== Composer layout & icon placement ===== */
/* Target ONLY the composer input row, NOT persona grid containers */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) {
  display: flex !important;
  flex-direction: row !important;
  align-items: flex-end !important;  /* Align icons to bottom of textarea */
  flex-wrap: nowrap !important;
  gap: 0.5rem !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
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

/* Fix chat width when left sidebar is collapsed */
@media (min-width: 1000px) {
  /* When left sidebar collapsed AND right sidebar modal is open */
  body:has(nav[style*="width: 54px"]):has(div.fixed.left-1\\/2.top-1\\/2)
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - var(--left-sidebar-collapsed-width)) !important;
    max-width: calc(100vw - var(--mm-gutter) - var(--left-sidebar-collapsed-width)) !important;
  }
  
  body:has(nav[style*="width: 54px"]):has(div.fixed.left-1\\/2.top-1\\/2)
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - var(--left-sidebar-collapsed-width)) !important;
  }
  
  /* When left sidebar collapsed AND NO right sidebar modal */
  body:has(nav[style*="width: 54px"]):not(:has(div.fixed.left-1\\/2.top-1\\/2))
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--left-sidebar-collapsed-width)) !important;
    max-width: calc(100vw - var(--left-sidebar-collapsed-width)) !important;
  }
  
  body:has(nav[style*="width: 54px"]):not(:has(div.fixed.left-1\\/2.top-1\\/2))
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--left-sidebar-collapsed-width)) !important;
  }
}
`;
    }

    // =============================================================================
    // Wait for DOM to be ready before running main code
    // =============================================================================
    
    async function initializeMainCode() {
        debugLog('[Toolkit] DOM ready, initializing main code...');

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
    let messageIdToIndexMap = {}; // Map message IDs to their order in the conversation
    let currentConversationId = null; // Store the actual conversation ID from API

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
        
        // New format: character -> conversation -> message
        if (characterId && messageStats[characterId]?.[conversationId]?.[messageId]) {
            debugLog('[Stats] getStatsForMessage - found in new format');
            return messageStats[characterId][conversationId][messageId];
        }
        
        debugLog('[Stats] getStatsForMessage - not found');
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
        
        // Store with new field names and flattened structure
        messageStats[characterId][conversationId][messageId] = {
            model: stats.model || null,
            max_tokens: stats.settings?.max_new_tokens || stats.max_tokens || null,
            temperature: stats.settings?.temperature || stats.temperature || null,
            top_p: stats.settings?.top_p || stats.top_p || null,
            top_k: stats.settings?.top_k || stats.top_k || null,
            timestamp: stats.createdAt || stats.timestamp || null
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

    // Format timestamp according to system's locale settings
    async function formatTimestamp(timestamp) {
        if (!timestamp) return null; // Return null instead of current time
        
        // Handle both Unix timestamp (number) and ISO string
        const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
        debugLog('[Stats] formatTimestamp input:', timestamp, 'UTC date:', date.toISOString());
        const formatted = await formatDate(date);
        debugLog('[Stats] formatTimestamp output:', formatted);
        return formatted;
    }
    
    async function formatDate(date) {
        // Get user preference for timestamp format (true = date@time, false = time@date)
        const dateFirst = await storage.get('timestampDateFirst', true);
        
        // Use UTC methods to get correct time (timestamps are stored as UTC milliseconds)
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        
        debugLog('[Stats] formatDate components - year:', year, 'month:', month, 'day:', day, 'hours:', hours, 'minutes:', minutes, 'seconds:', seconds);
        
        const dateStr = `${month}/${day}/${year}`;
        const timeStr = `${hours}:${minutes}:${seconds}`;
        
        debugLog('[Stats] formatDate - dateFirst:', dateFirst, 'dateStr:', dateStr, 'timeStr:', timeStr);
        
        // Return format based on user preference
        return dateFirst ? `${dateStr} @ ${timeStr}` : `${timeStr} @ ${dateStr}`;
    }

    // Get current settings from the modal
    async function getCurrentSettings() {
        const modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2:has(button[aria-label="X-button"])');
        if (!modal) return null;

        // Find the model name
        const modelElement = modal.querySelector('.text-\\[14px\\].font-medium');
        const model = modelElement ? modelElement.textContent.trim() : 'Unknown';

        // Get slider values
        const sliders = modal.querySelectorAll('input[type="range"]');
        const settings = {
            model: model,
            responseMaxTokens: sliders[0] ? parseFloat(sliders[0].value) : 300,
            temperature: sliders[1] ? parseFloat(sliders[1].value) : 1,
            topP: sliders[2] ? parseFloat(sliders[2].value) : 0.7,
            topK: sliders[3] ? parseFloat(sliders[3].value) : 80
        };

        return settings;
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
            const { conversationId, botMessages, userMessages } = event.data;
            
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
            
            // Store stats for bot messages
            for (const msg of botMessages) {
                if (msg.id) {
                    // Check if stats already exist in storage (to preserve POST data)
                    const existingStats = await getStatsForMessage(msg.id);
                    
                    // Only update if we don't have stats yet, or if we're adding NEW data
                    // GET /messages never includes inference_model or inference_settings, so don't overwrite!
                    if (!existingStats) {
                        // No stats yet - store whatever we have (likely just timestamp)
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model || null,
                            settings: msg.inference_settings || null,
                            createdAt: msg.createdAt || null
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (msg.inference_model && msg.inference_settings) {
                        // We have full inference data (from POST) - update everything
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model,
                            settings: msg.inference_settings,
                            createdAt: msg.createdAt || existingStats.createdAt
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (!existingStats.role) {
                        // Add role if missing
                        existingStats.role = 'bot';
                        await storeStatsForMessage(msg.id, existingStats, conversationId);
                    }
                    // else: existingStats exist and we have no new model/settings - don't overwrite!
                }
            }
            
            // Store timestamps for user messages
            for (const msg of userMessages) {
                if (msg.id) {
                    const existingStats = await getStatsForMessage(msg.id);
                    if (!existingStats || !existingStats.createdAt) {
                        const stats = {
                            role: 'user',
                            model: null,
                            settings: null,
                            createdAt: msg.createdAt || null
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
            
            // Rebuild index map now that we have the conversation ID
            await buildIndexMapFromStats();
        }
        
        if (event.data.type === 'SAI_NEW_MESSAGE') {
            debugLog('[Stats] Received SAI_NEW_MESSAGE from page context');
            const { messageId, conversationId, model, settings, createdAt } = event.data;
            
            // Store/update the conversation ID
            if (conversationId) {
                currentConversationId = conversationId;
            }
            
            debugLog('[Stats] New message - ID:', messageId, 'conversation:', conversationId);
            
            if (messageId) {
                const statsWithTimestamp = {
                    role: 'bot', // New messages from POST /chat are always bot responses
                    model: model,
                    settings: settings,
                    createdAt: createdAt
                };
                await storeStatsForMessage(messageId, statsWithTimestamp, conversationId);
                debugLog('[Stats] Stored stats for new message:', messageId);
                
                // Rebuild index map with the new message
                await buildIndexMapFromStats();
                
                // Trigger stats insertion after delays to let DOM update
                setTimeout(() => insertStatsForAllMessages(), 500);
                setTimeout(() => insertStatsForAllMessages(), 1500);
            }
        }
    });

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
        // First, click the "Change Model" button
        const modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)');
        if (!modal) {
            callback(false, 'Settings modal not found');
            return;
        }
        
        const changeModelBtn = Array.from(modal.querySelectorAll('button')).find(btn => 
            btn.textContent.includes('Change Model')
        );
        
        if (!changeModelBtn) {
            callback(false, 'Change Model button not found');
            return;
        }
        
        // Click the button
        changeModelBtn.click();
        
        // Wait for the model selection modal to appear
        setTimeout(() => {
            // Find the model selection modal
            const modelModal = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2')).find(el =>
                el.textContent.includes('Choose Model')
            );
            
            if (!modelModal) {
                callback(false, 'Model selection modal did not appear');
                return;
            }
            
            // Find the model option by matching the text content (using includes for flexibility)
            const modelOptions = Array.from(modelModal.querySelectorAll('li'));
            const modelOption = modelOptions.find(li => {
                const text = li.textContent.trim();
                // Try exact match first, then check if the model name is contained in the text
                return text === modelName || text.includes(modelName);
            });
            
            if (!modelOption) {
                // Close the modal
                const closeBtn = modelModal.querySelector('button[aria-label="X-button"]') ||
                                Array.from(modelModal.querySelectorAll('button')).find(btn => 
                                    btn.textContent.includes('Close')
                                );
                if (closeBtn) closeBtn.click();
                callback(false, `Model "${modelName}" not found in list`);
                return;
            }
            
            // Click the model option
            modelOption.click();
            
            // Wait for React to process
            setTimeout(() => {
                // Close the modal
                const closeBtn = modelModal.querySelector('button[aria-label="X-button"]') ||
                                Array.from(modelModal.querySelectorAll('button')).find(btn => 
                                    btn.textContent.includes('Close')
                                );
                if (closeBtn) {
                    closeBtn.click();
                }
                
                // Wait for modals to settle, then check if the model actually changed in the settings modal
                setTimeout(() => {
                    const settingsModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)');
                    if (settingsModal) {
                        const modelElement = settingsModal.querySelector('.text-\\[14px\\].font-medium');
                        const currentModel = modelElement ? modelElement.textContent.trim() : null;
                        
                        // Check if it matches our target
                        const success = currentModel === modelName;
                        callback(success, success ? 'Model changed successfully' : 'Selection did not register');
                    } else {
                        callback(false, 'Could not verify model change');
                    }
                }, 500);
            }, 800);
        }, 500);
    }

    // Apply settings to the modal
    async function applySettings(settings, autoChangeModel = false) {
        const modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2:has(button[aria-label="X-button"])');
        if (!modal) return false;

        const sliders = modal.querySelectorAll('input[type="range"]');
        
        // Helper function to properly update slider with React-style events
        function updateSlider(slider, value) {
            if (!slider || value === undefined) return;
            
            // Set the value
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
        }
        
        // Apply slider settings
        if (sliders[0] && settings.responseMaxTokens !== undefined) {
            updateSlider(sliders[0], settings.responseMaxTokens);
        }
        
        if (sliders[1] && settings.temperature !== undefined) {
            updateSlider(sliders[1], settings.temperature);
        }
        
        if (sliders[2] && settings.topP !== undefined) {
            updateSlider(sliders[2], settings.topP);
        }
        
        if (sliders[3] && settings.topK !== undefined) {
            updateSlider(sliders[3], settings.topK);
        }
        
        // Change model if requested and available
        if (autoChangeModel && settings.model) {
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
        }

        return true;
    }

    // Flag to prevent duplicate profile controls
    let isCreatingProfileControls = false;

    // Create profile controls UI
    async function createProfileControls() {
        debugLog('[Profile Controls] Function called. Flag:', isCreatingProfileControls);
        
        // Find the Generation Settings modal specifically (not Memory Manager)
        const modals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2'));
        const modal = modals.find(m => {
            const heading = m.querySelector('p.text-heading-6');
            return heading && heading.textContent.includes('Generation Settings');
        });
        
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

        // Export button
        const exportBtn = document.createElement('button');
        exportBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-green-500 hover:bg-green-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', async function() {
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
        });

        // Import button
        const importBtn = document.createElement('button');
        importBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-purple-500 hover:bg-purple-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        importBtn.textContent = 'Import';
        importBtn.addEventListener('click', async function() {
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
                            updateProfileDropdown();
                            showNotification('Profiles imported successfully');
                        } catch (err) {
                            alert('Error importing profiles: ' + err.message);
                        }
                    };
                    reader.readAsText(file);
                }
            });
            input.click();
        });

        buttonsRow.appendChild(saveBtn);
        buttonsRow.appendChild(deleteBtn);
        
        // Second button row for export/import
        const buttonsRow2 = document.createElement('div');
        buttonsRow2.className = 'flex justify-undefined items-center gap-2';
        buttonsRow2.appendChild(exportBtn);
        buttonsRow2.appendChild(importBtn);

        controlsDiv.appendChild(selectorRow);
        controlsDiv.appendChild(buttonsRow);
        controlsDiv.appendChild(buttonsRow2);

        // Insert at the end of the scrollable settings container
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
    // Note: All storage key constants (SIDEBAR_LAYOUT_KEY, THEME_CUSTOMIZATION_KEY, etc.) 
    // are defined at the top of the file for early injection and shared use
    const HIDE_FOR_YOU_KEY = 'enableHideForYou';
    const PAGE_JUMP_KEY = 'enablePageJump';
    
    let sidebarStyleElement = null;
    let themeStyleElement = null;
    let hideForYouObserver = null;
    let hideForYouUrlObserver = null;
    let hideForYouActive = false;
    let pageJumpObserver = null;
    
    // Apply or remove sidebar layout CSS
    async function toggleSidebarLayout(enable) {
        if (enable) {
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
            sidebarStyleElement.disabled = false;
        } else {
            if (sidebarStyleElement) {
                // Don't remove the element, just disable it to avoid React re-render issues
                sidebarStyleElement.disabled = true;
            }
        }
        await storage.set(SIDEBAR_LAYOUT_KEY, enable);
    }
    
    // Apply or remove theme customization CSS
    async function toggleThemeCustomization(enable) {
        if (enable) {
            if (!themeStyleElement) {
                themeStyleElement = document.createElement('style');
                themeStyleElement.id = 'sai-toolkit-theme-customization';
                themeStyleElement.textContent = getThemeCustomizationCSSEarly();
                document.head.appendChild(themeStyleElement);
            }
        } else {
            if (themeStyleElement) {
                themeStyleElement.remove();
                themeStyleElement = null;
            }
        }
        await storage.set(THEME_CUSTOMIZATION_KEY, enable);
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
        
        setTimeout(hideForYouCharacters, 500);
        setTimeout(hideForYouCharacters, 1000);
        setTimeout(hideForYouCharacters, 2000);
        
        hideForYouObserver = new MutationObserver((mutations) => {
            if (!isPageOne()) {
                stopHideForYou();
                return;
            }
            // Early return if mutations are not in relevant areas
            let hasRelevantMutation = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    // Check if mutation is in character grid area
                    const target = mutation.target;
                    if (target.classList && (target.classList.contains('grid') || 
                        target.classList.contains('gap-4') || 
                        target.closest('.grid.gap-4'))) {
                        hasRelevantMutation = true;
                        break;
                    }
                }
            }
            if (!hasRelevantMutation) return;
            
            let needsHiding = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
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
        
        modal.innerHTML = `
            <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 16px; color: ${isDark ? '#fff' : '#000'};">Jump to Page</h2>
            <p style="font-size: 14px; margin-bottom: 16px; color: ${isDark ? '#a1a1aa' : '#666'};">Enter a page number between 1 and ${totalPages}</p>
            <input type="number" id="page-jump-input" min="1" max="${totalPages}" value="${currentPage}" placeholder="Page number" style="width: 100%; padding: 10px 12px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; border-radius: 8px; font-size: 16px; margin-bottom: 20px; background: ${isDark ? '#27272a' : '#fff'}; color: ${isDark ? '#fff' : '#000'};" />
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="page-jump-cancel" style="padding: 8px 16px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; background: transparent; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; color: ${isDark ? '#fff' : '#000'}; transition: all 0.2s;">Cancel</button>
                <button id="page-jump-ok" style="padding: 8px 16px; border: none; background: #0072F5; color: white; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;">Go to Page</button>
            </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        const input = document.getElementById('page-jump-input');
        setTimeout(() => { input.focus(); input.select(); }, 100);
        
        const okButton = document.getElementById('page-jump-ok');
        const cancelButton = document.getElementById('page-jump-cancel');
        
        function closeModal() { overlay.remove(); }
        
        function handleSubmit() {
            const pageNumber = parseInt(input.value);
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
        input.addEventListener('keypress', async (e) => { if (e.key === 'Enter') handleSubmit(); });
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
        const themeEnabled = await storage.get(THEME_CUSTOMIZATION_KEY, false);
        const hideForYouEnabled = await storage.get(HIDE_FOR_YOU_KEY, false);
        const pageJumpEnabled = await storage.get(PAGE_JUMP_KEY, false);
        
        debugLog('[Toolkit] Initializing with settings:', {
            sidebar: sidebarEnabled,
            theme: themeEnabled,
            hideForYou: hideForYouEnabled,
            pageJump: pageJumpEnabled
        });
        
        // Sidebar Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (sidebarEnabled) {
            sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (sidebarStyleElement) {
                debugLog('[Toolkit] Using early-injected Sidebar Layout CSS');
            }
        }
        
        // Theme Customization CSS is already injected early if enabled
        // Just get a reference to the existing element
        if (themeEnabled) {
            themeStyleElement = document.getElementById('sai-toolkit-theme-customization-early');
            if (themeStyleElement) {
                debugLog('[Toolkit] Using early-injected Theme Customization CSS');
            }
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
        if (existingButton) return;
        
        // Find the Help button in the sidebar (last section with Subscribe and Help)
        // Try multiple approaches to find it
        let helpButton = Array.from(document.querySelectorAll('button')).find(btn => {
            const text = btn.textContent?.trim();
            return text === 'S.AI Toolkit Settings' && btn.querySelector('svg.lucide-info');
        });
        
        // If not found by text, try finding by icon only (for collapsed state)
        if (!helpButton) {
            const infoIcons = document.querySelectorAll('svg.lucide-info');
            for (const icon of infoIcons) {
                const btn = icon.closest('button');
                if (btn) {
                    helpButton = btn;
                    break;
                }
            }
        }
        
        if (!helpButton) {
            debugLog('[Toolkit] Help button not found, retrying...');
            return;
        }
        
        // Get the parent container (the div.w-full that wraps the Help button)
        const helpButtonWrapper = helpButton.closest('div.w-full');
        if (!helpButtonWrapper) {
            debugLog('[Toolkit] Help button wrapper not found');
            return;
        }
        
        // Clone the Help button structure to match styling exactly
        const buttonWrapper = helpButtonWrapper.cloneNode(true);
        const clonedButton = buttonWrapper.querySelector('button');
        
        // Update the cloned button
        clonedButton.id = 'sai-toolkit-sidebar-btn';
        
        // Find or create tooltip wrapper
        let tooltipWrapper = buttonWrapper.querySelector('[data-tooltip-id]');
        
        if (tooltipWrapper) {
            // Update existing tooltip wrapper
            tooltipWrapper.setAttribute('data-tooltip-content', 'S.AI Toolkit');
            debugLog('[Toolkit] Updated existing tooltip wrapper');
        } else {
            // Create tooltip wrapper if it doesn't exist
            tooltipWrapper = document.createElement('div');
            tooltipWrapper.setAttribute('data-tooltip-id', ':ra:');
            tooltipWrapper.setAttribute('data-tooltip-content', 'S.AI Toolkit');
            tooltipWrapper.setAttribute('data-tooltip-place', 'right');
            tooltipWrapper.setAttribute('data-tooltip-float', 'false');
            tooltipWrapper.className = 'inline-flex';
            
            // Wrap the button
            const button = buttonWrapper.querySelector('button');
            buttonWrapper.insertBefore(tooltipWrapper, button);
            tooltipWrapper.appendChild(button);
            debugLog('[Toolkit] Created tooltip wrapper');
        }
        
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
        
        // Add click handler
        clonedButton.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            showToolkitSettingsModal();
        });
        
        // Add custom tooltip as fallback (React Tooltip may not register dynamically added elements)
        let customTooltip = null;
        
        clonedButton.addEventListener('mouseenter', function(e) {
            // Check if sidebar is collapsed
            const nav = clonedButton.closest('nav');
            const isCollapsed = nav && nav.style.width === '54px';
            
            if (isCollapsed && !customTooltip) {
                // Wait a moment to see if React Tooltip shows up
                setTimeout(() => {
                    // Check if React Tooltip is showing
                    const reactTooltips = document.querySelectorAll('[role="tooltip"]');
                    let hasReactTooltip = false;
                    for (const tip of reactTooltips) {
                        if (tip.textContent.includes('S.AI Toolkit') && tip.style.opacity !== '0') {
                            hasReactTooltip = true;
                            break;
                        }
                    }
                    
                    // If no React Tooltip, show custom one
                    if (!hasReactTooltip && !customTooltip) {
                        customTooltip = document.createElement('div');
                        customTooltip.className = 'sai-toolkit-custom-tooltip';
                        customTooltip.textContent = 'S.AI Toolkit';
                        customTooltip.style.cssText = `
                            position: fixed;
                            background: rgb(30, 30, 32);
                            color: rgb(255, 255, 255);
                            padding: 8px 12px;
                            border-radius: 8px;
                            font-size: 13px;
                            font-weight: 500;
                            pointer-events: none;
                            z-index: 9999;
                            white-space: nowrap;
                            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                        `;
                        
                        // Position tooltip to the right of the button
                        const rect = clonedButton.getBoundingClientRect();
                        customTooltip.style.left = (rect.right + 12) + 'px';
                        customTooltip.style.top = (rect.top + rect.height / 2) + 'px';
                        customTooltip.style.transform = 'translateY(-50%)';
                        
                        document.body.appendChild(customTooltip);
                    }
                }, 50);
            }
        });
        
        clonedButton.addEventListener('mouseleave', function() {
            if (customTooltip) {
                customTooltip.remove();
                customTooltip = null;
            }
        });
        
        clonedButton.addEventListener('click', function() {
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
        
        // Find the Like button (ThumbsUp-button) in the mobile header
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        if (!likeButton) {
            debugLog('[Toolkit] Like button not found in mobile view');
            return;
        }
        
        // Get the parent container (the flex container with gap-sm)
        const buttonContainer = likeButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Toolkit] Mobile button container not found');
            return;
        }
        
        // Create the toolkit button matching the Like button style
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
        
        // Insert before the Like button (so it appears to the left)
        buttonContainer.insertBefore(toolkitBtn, likeButton);
        debugLog('[Toolkit] Mobile button injected successfully');
    }
    
    // Function to show toolkit settings modal
    async function showToolkitSettingsModal() {
    debugLog('[Toolkit] ===== OPENING SETTINGS MODAL =====');
    debugLog('[Toolkit] Current Sidebar Layout enabled?', await storage.get(SIDEBAR_LAYOUT_KEY, false));
    debugLog('[Toolkit] Current Theme Customization enabled?', await storage.get(THEME_CUSTOMIZATION_KEY, false));        // Create or get a dedicated container with SHADOW DOM for complete isolation
        let toolkitRoot = document.getElementById('toolkit-modal-root');
        if (!toolkitRoot) {
            debugLog('[Toolkit] Creating new toolkit-modal-root with Shadow DOM');
            toolkitRoot = document.createElement('div');
            toolkitRoot.id = 'toolkit-modal-root';
            toolkitRoot.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 900000;';
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
                    z-index: 900000;
                    pointer-events: auto;
                }
                .modal {
                    position: fixed;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 12px;
                    width: 400px;
                    max-width: 90vw;
                    max-height: 600px;
                    z-index: 900001;
                    pointer-events: auto;
                    display: flex;
                    flex-direction: column;
                    padding: 1.5rem;
                    gap: 1.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .modal { background: #1a1a1a; color: white; }
                }
                .modal-header {
                    text-align: center;
                    font-size: 1.25rem;
                    font-weight: bold;
                }
                .modal-body {
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }
                .setting-row {
                    background: #f3f4f6;
                    padding: 1rem;
                    border-radius: 1rem;
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
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
                    width: 20px;
                    height: 20px;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .setting-text {
                    flex: 1;
                    cursor: pointer;
                }
                .setting-title {
                    font-size: 14px;
                    font-weight: 500;
                    margin-bottom: 4px;
                }
                .setting-desc {
                    font-size: 12px;
                    color: #6b7280;
                }
                .sub-setting-row {
                    background: #e5e7eb;
                    padding: 0.75rem;
                    padding-left: 2.5rem;
                    border-radius: 0.5rem;
                    margin-top: 0.5rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
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
                    font-size: 13px;
                    font-weight: 400;
                }
                .hidden {
                    display: none !important;
                }
                .data-management-section {
                    margin-top: 1.5rem;
                    padding-top: 1rem;
                }
                .section-divider {
                    height: 1px;
                    background: #e5e7eb;
                    margin-bottom: 1rem;
                }
                @media (prefers-color-scheme: dark) {
                    .section-divider { background: #404040; }
                }
                .section-title {
                    font-size: 13px;
                    font-weight: 600;
                    margin-bottom: 0.25rem;
                    color: #374151;
                }
                @media (prefers-color-scheme: dark) {
                    .section-title { color: #d1d5db; }
                }
                .section-desc {
                    font-size: 11px;
                    color: #6b7280;
                    margin-bottom: 0.75rem;
                }
                .data-buttons {
                    display: flex;
                    gap: 0.5rem;
                }
                .version-text {
                    margin-top: 1rem;
                    text-align: center;
                    font-size: 12px;
                    color: #9ca3af;
                    font-weight: 400;
                }
                @media (prefers-color-scheme: dark) {
                    .version-text {
                        color: #6b7280;
                    }
                }
                .btn-data {
                    flex: 1;
                    padding: 0.5rem 0.75rem;
                    border-radius: 6px;
                    border: 1px solid #d1d5db;
                    background: #f9fafb;
                    color: #374151;
                    cursor: pointer;
                    font-size: 12px;
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
                    font-size: 14px;
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
        let themeEnabled = await storage.get(THEME_CUSTOMIZATION_KEY, false);
        let hideForYouEnabled = await storage.get(HIDE_FOR_YOU_KEY, false);
        let pageJumpEnabled = await storage.get(PAGE_JUMP_KEY, false);
        let showStatsEnabled = await storage.get('showGenerationStats', false);
        let timestampDateFirst = await storage.get('timestampDateFirst', true); // true = date@time, false = time@date
        
        debugLog('[Toolkit] Modal state - Sidebar:', sidebarEnabled, 'Theme:', themeEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date');
        
        // Create backdrop
        debugLog('[Toolkit] Creating backdrop and modal elements');
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-header">S.AI Toolkit Settings</div>
            <div class="modal-body">
                <label class="setting-row">
                    <input type="checkbox" class="setting-checkbox" id="sidebar-checkbox" autocomplete="off" ${sidebarEnabled ? 'checked' : ''}>
                    <div class="setting-text">
                        <div class="setting-title">Sidebar Layout</div>
                        <div class="setting-desc">Pin the Generation Settings and Memories modals to sidebar.</div>
                    </div>
                </label>
                <label class="setting-row">
                    <input type="checkbox" class="setting-checkbox" id="theme-checkbox" autocomplete="off" ${themeEnabled ? 'checked' : ''}>
                    <div class="setting-text">
                        <div class="setting-title">Classic Theme</div>
                        <div class="setting-desc">Applies the classic colors and message box styling. Credit goes to <strong>MssAcc</strong> on Discord.</div>
                    </div>
                </label>
                <label class="setting-row">
                    <input type="checkbox" class="setting-checkbox" id="hideforyou-checkbox" autocomplete="off" ${hideForYouEnabled ? 'checked' : ''}>
                    <div class="setting-text">
                        <div class="setting-title">Hide "For You" Characters</div>
                        <div class="setting-desc">Hide character tiles with purple "For You" badge on page 1</div>
                    </div>
                </label>
                <label class="setting-row">
                    <input type="checkbox" class="setting-checkbox" id="pagejump-checkbox" autocomplete="off" ${pageJumpEnabled ? 'checked' : ''}>
                    <div class="setting-text">
                        <div class="setting-title">Page Jump Modal</div>
                        <div class="setting-desc">Click "..." pagination button to jump to any page</div>
                    </div>
                </label>
                <label class="setting-row">
                    <input type="checkbox" class="setting-checkbox" id="showstats-checkbox" autocomplete="off" ${showStatsEnabled ? 'checked' : ''}>
                    <div class="setting-text">
                        <div class="setting-title">Show generation model stats and timestamp in messages</div>
                        <div class="setting-desc">Display model info and timestamps below bot messages (only for new messages)</div>
                    </div>
                </label>
                <label class="sub-setting-row ${showStatsEnabled ? '' : 'hidden'}" id="timestamp-format-row">
                    <input type="checkbox" class="setting-checkbox" id="timestamp-format-checkbox" autocomplete="off" ${timestampDateFirst ? 'checked' : ''}>
                    <div class="sub-setting-text">
                        <div class="sub-setting-title">Show date first</div>
                        <div class="setting-desc">Reverses the order of the timestamp so that the date comes before the time</div>

                    </div>
                </label>
                
                <div class="data-management-section">
                    <div class="section-divider"></div>
                    <div class="section-title">Data Management</div>
                    <div class="section-desc">Export or import all settings, profiles, and message stats</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="export-all-btn">Export All Data</button>
                        <button class="btn-data" id="import-all-btn">Import All Data</button>
                        <button class="btn-data" id="clear-all-btn">Clear All Data</button>
                    </div>
                    <div class="version-text">v1.0.10</div>
                </div>
            </div>
            <div class="button-row">
                <button class="btn-cancel" id="cancel-btn">Cancel & Refresh</button>
                <button class="btn-save" id="save-btn">Save & Refresh</button>
            </div>
        `;
        
        // Append to shadow DOM
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);
        
        debugLog('[Toolkit] Modal and backdrop appended to shadow DOM');
        
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
        
        // Get checkbox elements within shadow DOM
        const sidebarCheckbox = shadow.querySelector('#sidebar-checkbox');
        const themeCheckbox = shadow.querySelector('#theme-checkbox');
        const hideForYouCheckbox = shadow.querySelector('#hideforyou-checkbox');
        const pageJumpCheckbox = shadow.querySelector('#pagejump-checkbox');
        const showStatsCheckbox = shadow.querySelector('#showstats-checkbox');
        const timestampFormatCheckbox = shadow.querySelector('#timestamp-format-checkbox');
        const timestampFormatRow = shadow.querySelector('#timestamp-format-row');
        const cancelBtn = shadow.querySelector('#cancel-btn');
        const saveBtn = shadow.querySelector('#save-btn');
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
        };
        
        themeCheckbox.onchange = (e) => {
            debugLog('[Toolkit] THEME CHECKBOX CHANGED');
            themeEnabled = e.target.checked;
            debugLog('[Toolkit] Theme:', themeEnabled);
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
            
            // Toggle timestamp format sub-checkbox visibility
            if (showStatsEnabled) {
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
        
        // Cancel button - now refreshes page to avoid React conflicts
        cancelBtn.onclick = (e) => {
            debugLog('[Toolkit] Cancel & Refresh button clicked');
            e.stopPropagation();
            showNotification('Refreshing page...');
            setTimeout(() => {
                debugLog('[Toolkit] Reloading page...');
                window.location.reload();
            }, 300);
        };
        
        // Clear All Data button - with confirmation dialog
        clearAllBtn.onclick = async (e) => {
            debugLog('[Toolkit] Clear All Data button clicked');
            e.stopPropagation();
            
            // Create confirmation dialog in shadow DOM
            const confirmBackdrop = document.createElement('div');
            confirmBackdrop.className = 'backdrop';
            confirmBackdrop.style.zIndex = '900002';
            
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal';
            confirmModal.style.zIndex = '900003';
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
            debugLog('[Toolkit] Saving - Sidebar:', sidebarEnabled, 'Theme:', themeEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date');
            await storage.set(SIDEBAR_LAYOUT_KEY, sidebarEnabled);
            await storage.set(THEME_CUSTOMIZATION_KEY, themeEnabled);
            await storage.set(HIDE_FOR_YOU_KEY, hideForYouEnabled);
            await storage.set(PAGE_JUMP_KEY, pageJumpEnabled);
            await storage.set('showGenerationStats', showStatsEnabled);
            await storage.set('timestampDateFirst', timestampDateFirst);
            // Mark onboarding as seen when user saves settings
            await storage.set('hasSeenOnboarding', true);
            debugLog('[Toolkit] Settings saved to storage');
            showNotification('Settings saved! Refreshing...');
            setTimeout(() => {
                debugLog('[Toolkit] Reloading page...');
                window.location.reload();
            }, 500);
        };
        
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
                
                debugLog('[Toolkit] Fetching enableThemeCustomization...');
                const enableThemeCustomization = await storage.get(THEME_CUSTOMIZATION_KEY, false);
                debugLog('[Toolkit] enableThemeCustomization result:', enableThemeCustomization, 'Type:', typeof enableThemeCustomization);
                
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
                
                // Build the export object
                const allData = {
                    enableSidebarLayout,
                    enableThemeCustomization,
                    enableHideForYou,
                    enablePageJump,
                    showGenerationStats,
                    timestampDateFirst,
                    generationProfiles,
                    lastSelectedProfile,
                    messageGenerationStats
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
                        
                        // Build updates object conditionally
                        const updates = {};
                        if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
                        if (imported.enableThemeCustomization !== undefined) updates.enableThemeCustomization = imported.enableThemeCustomization;
                        if (imported.enableHideForYou !== undefined) updates.enableHideForYou = imported.enableHideForYou;
                        if (imported.enablePageJump !== undefined) updates.enablePageJump = imported.enablePageJump;
                        if (imported.showGenerationStats !== undefined) updates.showGenerationStats = imported.showGenerationStats;
                        if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                        if (imported.generationProfiles !== undefined) updates.generationProfiles = imported.generationProfiles;
                        if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;
                        if (imported.messageGenerationStats !== undefined) updates.messageGenerationStats = imported.messageGenerationStats;
                        
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
    const hasSeenOnboarding = allStorage.hasSeenOnboarding;
    const hasToolkitSettings = (
        SIDEBAR_LAYOUT_KEY in allStorage ||
        THEME_CUSTOMIZATION_KEY in allStorage ||
        HIDE_FOR_YOU_KEY in allStorage ||
        PAGE_JUMP_KEY in allStorage
    );
    
    debugLog('[Toolkit] Onboarding check - hasSeenOnboarding:', hasSeenOnboarding);
    debugLog('[Toolkit] Onboarding check - hasToolkitSettings:', hasToolkitSettings);
    
    // Show onboarding if: never seen before (undefined) OR explicitly false
    const shouldShowOnboarding = hasSeenOnboarding === undefined || hasSeenOnboarding === false;
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
        await storage.remove(THEME_CUSTOMIZATION_KEY);
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
        // Look specifically for the Generation Settings modal
        const modals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2'));
        const modal = modals.find(m => {
            const heading = m.querySelector('p.text-heading-6');
            return heading && heading.textContent.includes('Generation Settings');
        });
        
        if (modal && !modal.querySelector('#profile-controls')) {
            // Wait a bit for the modal to fully render
            setTimeout(createProfileControls, 100);
        }
        
        // Try to inject sidebar button (watches for sidebar to load)
        injectToolkitSidebarButton();
        
        // Inject CSS to hide toolkit button text when sidebar is collapsed
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
        
        // Try to inject mobile button (watches for Like button to appear)
        injectToolkitMobileButton();
        
        // Retry sidebar button injection with delays (in case sidebar loads later)
        setTimeout(() => injectToolkitSidebarButton(), 500);
        setTimeout(() => injectToolkitSidebarButton(), 1000);
        setTimeout(() => injectToolkitSidebarButton(), 2000);
        setTimeout(() => injectToolkitSidebarButton(), 3000);
        setTimeout(() => injectToolkitSidebarButton(), 5000);
        
        // Retry mobile button injection with delays
        setTimeout(() => injectToolkitMobileButton(), 500);
        setTimeout(() => injectToolkitMobileButton(), 1000);
        setTimeout(() => injectToolkitMobileButton(), 2000);
        setTimeout(() => injectToolkitMobileButton(), 3000);
        setTimeout(() => injectToolkitMobileButton(), 5000);
        
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
        }, 2000); // Check every 2 seconds instead of on every DOM mutation
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Observer to add generation stats to messages
    const messageObserver = new MutationObserver(async function(mutations) {
        const statsEnabled = await storage.get('showGenerationStats', false);
        
        if (!statsEnabled) return;
        
        // Only process if we see relevant mutations
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
        
        // Debounce: wait a bit for DOM to settle before processing
        clearTimeout(messageObserver.debounceTimer);
        messageObserver.debounceTimer = setTimeout(() => {
            processMessagesForStats();
        }, 100);
    });

    // Separate function to process messages (can be called multiple times)
    async function processMessagesForStats() {
        const statsEnabled = await storage.get('showGenerationStats', false);
        debugLog('[Stats] processMessagesForStats - statsEnabled:', statsEnabled);
        if (!statsEnabled) return;
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');
        debugLog('[Stats] Found message wrappers:', messageWrappers.length);
        
        // Calculate total messages in the index map
        const totalMessages = Object.keys(messageIdToIndexMap).length;
        debugLog('[Stats] Total messages in index map:', totalMessages);
        
        let botMessageIndex = 0;
        
        for (const wrapper of messageWrappers) {
            // Check if this is a bot message (has character link) or user message
            const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
            const isBotMessage = !!characterLink;
            debugLog('[Stats] Processing message, isBotMessage:', isBotMessage, 'botMessageIndex:', botMessageIndex);
            
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
            
            if (!actionContainer) {
                debugLog('[Stats] No action container found!');
                if (isBotMessage) botMessageIndex++;
                continue;
            }
            
            // Check if stats already exist OR if we're already processing this message
            const hasExistingStats = actionContainer.querySelector('.generation-stats');
            if (hasExistingStats) {
                debugLog('[Stats] Stats already present, skipping');
                if (isBotMessage) botMessageIndex++;
                continue;
            }
            
            if (actionContainer.dataset.statsProcessing) {
                debugLog('[Stats] Already being processed (race condition), skipping');
                if (isBotMessage) botMessageIndex++;
                continue;
            }
            
            // Mark as processing immediately to prevent race conditions
            actionContainer.dataset.statsProcessing = 'true';
            
            if (isBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                
                // Calculate the correct index: page shows newest messages, so offset from end of storage
                // Count bot messages on page first, then calculate offset
                const botMessagesOnPage = Array.from(messageWrappers).filter(w => !!w.querySelector('a[href^="/chatbot/"]')).length;
                const storageOffset = totalMessages - botMessagesOnPage;
                const correctedIndex = storageOffset + botMessageIndex;
                
                debugLog('[Stats] Extracted messageId:', messageId, 'botMessageIndex:', botMessageIndex, 'correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                if (!messageId && messageIdToIndexMap[correctedIndex] !== undefined) {
                    messageId = messageIdToIndexMap[correctedIndex];
                    debugLog('[Stats] Using mapped messageId:', messageId);
                }
                
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                debugLog('[Stats] Got stats from storage:', generationStats);
                if (!generationStats && pendingMessageStats) generationStats = pendingMessageStats;
                if (!generationStats && lastGenerationSettings) generationStats = lastGenerationSettings;
                debugLog('[Stats] Final stats:', generationStats);
                
                if (!generationStats) {
                    debugLog('[Stats] No stats found, skipping message');
                    // Clear the processing flag so it can be retried later
                    delete actionContainer.dataset.statsProcessing;
                    botMessageIndex++;
                    continue;
                }
                
                debugLog('[Stats] Creating stats div...');
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                debugLog('[Stats] Checking stats content:', generationStats);
                
                // Check for model and settings (new flat format with max_tokens)
                const hasSettings = generationStats.max_tokens !== null && generationStats.max_tokens !== undefined;
                const hasModel = generationStats.model;
                
                if (hasSettings && hasModel) {
                    debugLog('[Stats] Has full stats with settings');
                    const maxTokens = generationStats.max_tokens;
                    const temperature = generationStats.temperature;
                    const topP = generationStats.top_p;
                    const topK = generationStats.top_k;
                    
                    const statsText = `${generationStats.model}<br>tks: ${maxTokens} | tmp: ${temperature.toFixed(2)} | p: ${topP} | k: ${topK}`;
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (timestamp) {
                        statsDiv.innerHTML = `${statsText}<br>${timestamp}`;
                    } else {
                        statsDiv.innerHTML = statsText;
                    }
                    debugLog('[Stats] Stats div innerHTML:', statsDiv.innerHTML);
                } else if (generationStats.timestamp) {
                    debugLog('[Stats] Has timestamp only');
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (timestamp) {
                        statsDiv.innerHTML = timestamp;
                        debugLog('[Stats] Stats div innerHTML:', statsDiv.innerHTML);
                    } else {
                        debugLog('[Stats] No valid timestamp, skipping');
                        delete actionContainer.dataset.statsProcessing; // Remove flag if we skip
                        botMessageIndex++;
                        continue;
                    }
                } else {
                    debugLog('[Stats] No usable data, skipping');
                    delete actionContainer.dataset.statsProcessing; // Remove flag if we skip
                    botMessageIndex++;
                    continue;
                }
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                debugLog('[Stats] Menu button container:', menuButtonContainer);
                if (menuButtonContainer) {
                    debugLog('[Stats] Inserting stats div...');
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                    delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                    debugLog('[Stats] Stats div inserted successfully!');
                } else {
                    debugLog('[Stats] No menu button container found, cannot insert stats');
                    delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                }
                
                botMessageIndex++;
            } else {
                // User message - show only timestamp
                let messageId = extractMessageId(wrapper);
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                
                // Only display if we have a valid timestamp
                if (!generationStats?.timestamp) {
                    delete actionContainer.dataset.statsProcessing;
                    continue;
                }
                
                const timestamp = await formatTimestamp(generationStats.timestamp);
                if (!timestamp) {
                    delete actionContainer.dataset.statsProcessing;
                    continue;
                }
                
                // Create timestamp div for user messages
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                statsDiv.innerHTML = timestamp;
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                    delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                } else {
                    delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                }
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

    messageObserver.observe(document.body, {
        childList: true,
        subtree: true
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

    // Function to manually trigger stats insertion for all visible messages
    async function insertStatsForAllMessages() {
        const statsEnabled = await storage.get('showGenerationStats', false);
        if (!statsEnabled) return;
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');
        let botMessageIndex = 0;
        
        for (const wrapper of messageWrappers) {
            // Check if this is a bot message (has character link) or user message
            const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
            const isBotMessage = !!characterLink;
            
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
            
            // Check if stats already exist OR if we're already processing this message
            if (!actionContainer || actionContainer.querySelector('.generation-stats') || actionContainer.dataset.statsProcessing) {
                if (isBotMessage) botMessageIndex++;
                continue;
            }
            
            // Mark as processing immediately to prevent race conditions
            actionContainer.dataset.statsProcessing = 'true';
            
            if (isBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                if (!messageId && messageIdToIndexMap[botMessageIndex] !== undefined) {
                    messageId = messageIdToIndexMap[botMessageIndex];
                }
                
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                if (!generationStats && lastGenerationSettings) {
                    generationStats = lastGenerationSettings;
                }
                
                if (!generationStats) {
                    delete actionContainer.dataset.statsProcessing; // Remove flag if we skip
                    botMessageIndex++;
                    continue;
                }
                
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                if (generationStats.max_tokens && generationStats.model) {
                    const statsText = `${generationStats.model} | tks: ${generationStats.max_tokens} | tmp: ${generationStats.temperature.toFixed(2)} | p: ${generationStats.top_p} | k: ${generationStats.top_k}`;
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    statsDiv.innerHTML = `${statsText}<br>${timestamp}`;
                } else if (generationStats.timestamp) {
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    statsDiv.innerHTML = timestamp;
                } else {
                    delete actionContainer.dataset.statsProcessing; // Remove flag if we skip
                    botMessageIndex++;
                    continue;
                }
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                    delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                } else {
                    delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                }
                
                botMessageIndex++;
            } else {
                // User message - show only timestamp
                let messageId = extractMessageId(wrapper);
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                
                // Only display if we have a valid timestamp
                if (!generationStats?.timestamp) {
                    delete actionContainer.dataset.statsProcessing;
                    continue;
                }
                
                const timestamp = await formatTimestamp(generationStats.timestamp);
                if (!timestamp) {
                    delete actionContainer.dataset.statsProcessing;
                    continue;
                }
                
                // Create timestamp div for user messages
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                statsDiv.innerHTML = timestamp;
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                    delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                } else {
                    delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                }
            }
        }
    }

    // Initial check for existing messages after page load
    setTimeout(insertStatsForAllMessages, 2000);
    
    // Also check again after a longer delay in case messages load slowly
    setTimeout(insertStatsForAllMessages, 5000);

    // Initial check in case modal is already open
    setTimeout(createProfileControls, 1000);

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
    
    // Call initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeMainCode);
    } else {
        // DOM is already loaded
        initializeMainCode();
    }
    
})(); // End of async IIFE
