// ==UserScript==
// @name         SpicyChat - Toolkit Generation Settings Profiles
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Save and load generation settings profiles
// @author       OnyxMizuna
// @match        https://spicychat.ai/*
// @match        https://www.spicychat.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-start
// ==/UserScript==

// Testing the onboarding flow:
// Run in browser console: resetSAIToolkitOnboarding()
// Then reload the page to see the onboarding modal again.

// Debug mode - set to false to disable verbose logging
const DEBUG_MODE = false;

// Debug logging helper
function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log(...args);
    }
}

(function() {
    'use strict';

    // =============================================================================
    // CRITICAL: Early CSS Injection (before React loads)
    // =============================================================================
    // This must happen first, before ANY React code runs, to avoid DOM conflicts
    
    const SIDEBAR_LAYOUT_KEY = 'enableSidebarLayout';
    const THEME_CUSTOMIZATION_KEY = 'enableThemeCustomization';
    
    const sidebarEnabled = GM_getValue(SIDEBAR_LAYOUT_KEY, false);
    const themeEnabled = GM_getValue(THEME_CUSTOMIZATION_KEY, false);
    
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
/* Match both max-h-[600px] and max-h-[700px] variants */
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full),
body:has(div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full)):has(div.fixed.left-1\\/2.top-1\\/2.h-full)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full) {
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
    
    function initializeMainCode() {
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

    // Load message stats from storage
    function loadMessageStats() {
        const stored = GM_getValue(MESSAGE_STATS_KEY, '{}');
        return JSON.parse(stored);
    }

    // Save message stats to storage
    function saveMessageStats(messageStats) {
        GM_setValue(MESSAGE_STATS_KEY, JSON.stringify(messageStats));
    }

    // Store stats for a specific message ID
    function storeStatsForMessage(messageId, stats) {
        const messageStats = loadMessageStats();
        messageStats[messageId] = stats;
        saveMessageStats(messageStats);
    }

    // Get stats for a specific message ID
    function getStatsForMessage(messageId) {
        const messageStats = loadMessageStats();
        return messageStats[messageId] || null;
    }

    // Extract message ID from DOM element
    function extractMessageId(container) {
        // Method 1: Check for data-message-id attribute
        let messageElement = container.closest('[data-message-id]');
        if (messageElement) {
            return messageElement.getAttribute('data-message-id');
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
                if (props?.message?.id) return props.message.id;
                if (props?.children?.props?.message?.id) return props.children.props.message.id;
                if (props?.memoizedProps?.message?.id) return props.memoizedProps.message.id;
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
                if (uuidMatch) return uuidMatch[0];
            }
        }
        
        return null;
    }

    // Format timestamp according to system's locale settings
    function formatTimestamp(timestamp) {
        if (!timestamp) return null; // Return null instead of current time
        
        // Handle both Unix timestamp (number) and ISO string
        const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
        return formatDate(date);
    }
    
    function formatDate(date) {
        // Get user preference for timestamp format (true = date@time, false = time@date)
        const dateFirst = GM_getValue('timestampDateFirst', true);
        
        // Use UTC methods to get correct time (timestamps are stored as UTC milliseconds)
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        
        const dateStr = `${month}/${day}/${year}`;
        const timeStr = `${hours}:${minutes}:${seconds}`;
        
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

    // Intercept XMLHttpRequest to capture generation settings
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._method = method;
        this._url = url;
        return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
        // Check if this is a messages GET request (loading message history)
        if (this._method === 'GET' && this._url && this._url.includes('/messages')) {
            this.addEventListener('load', function() {
                try {
                    const response = JSON.parse(this.responseText);
                    
                    if (response.messages && Array.isArray(response.messages)) {
                        const botMessages = response.messages.filter(msg => msg.role === 'bot');
                        const userMessages = response.messages.filter(msg => msg.role === 'user');
                        
                        // Store stats for each bot message - always store timestamps
                        botMessages.forEach((msg) => {
                            if (msg.id) {
                                // Check if stats already exist in storage (to preserve POST data)
                                const existingStats = getStatsForMessage(msg.id);
                                
                                // Always store timestamps, even if inference settings are missing
                                const stats = {
                                    model: msg.inference_model || existingStats?.model || null,
                                    settings: msg.inference_settings || existingStats?.settings || null,
                                    createdAt: msg.createdAt || existingStats?.createdAt || null
                                };
                                
                                // Only store if we have new data or if nothing exists yet
                                if (!existingStats || msg.inference_model || msg.inference_settings) {
                                    storeStatsForMessage(msg.id, stats);
                                }
                            }
                        });
                        
                        // Store timestamps for user messages
                        userMessages.forEach((msg) => {
                            if (msg.id) {
                                const existingStats = getStatsForMessage(msg.id);
                                if (!existingStats || !existingStats.createdAt) {
                                    const stats = {
                                        model: null,
                                        settings: null,
                                        createdAt: msg.createdAt || null
                                    };
                                    storeStatsForMessage(msg.id, stats);
                                }
                            }
                        });
                        
                        loadedMessageIds = botMessages.map(msg => msg.id).reverse();
                        
                        // Create index map for order-based matching
                        messageIdToIndexMap = {};
                        loadedMessageIds.forEach((id, index) => {
                            messageIdToIndexMap[index] = id;
                        });
                    }
                } catch (e) {
                    console.error('[Stats] Error parsing messages response:', e);
                }
            });
        }
        
        // Check if this is a chat generation request
        if (this._method === 'POST' && this._url && this._url.includes('/chat')) {
            try {
                const parsedBody = JSON.parse(body);
                
                if (parsedBody.inference_model && parsedBody.inference_settings) {
                    lastGenerationSettings = {
                        model: parsedBody.inference_model,
                        settings: parsedBody.inference_settings
                    };
                    
                    // Store as pending until we see the message in DOM
                    pendingMessageStats = lastGenerationSettings;
                    
                    // Listen for the response to get the message ID
                    this.addEventListener('load', function() {
                        try {
                            const response = JSON.parse(this.responseText);
                            
                            if (response.message && response.message.id) {
                                const messageId = response.message.id;
                                const createdAt = response.message.createdAt || response.message.created_at || null;
                                
                                const statsWithTimestamp = {
                                    ...lastGenerationSettings,
                                    createdAt: createdAt
                                };
                                storeStatsForMessage(messageId, statsWithTimestamp);
                                
                                // Add to loaded IDs at the END (newest message goes last in DOM order)
                                loadedMessageIds.push(messageId);
                                messageIdToIndexMap = {};
                                loadedMessageIds.forEach((id, index) => {
                                    messageIdToIndexMap[index] = id;
                                });
                                
                                // Trigger stats insertion after delays to let DOM update
                                setTimeout(() => insertStatsForAllMessages(), 500);
                                setTimeout(() => insertStatsForAllMessages(), 1500);
                            }
                        } catch (e) {
                            console.error('[Stats] Error parsing chat response:', e);
                        }
                    });
                }
            } catch (e) {
                console.error('[Stats] Error parsing chat body:', e);
            }
        }
        
        return originalXHRSend.apply(this, [body]);
    };
    
    // Also keep fetch interceptor as backup
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const [url, options] = args;
        
        // Check if this is a chat generation request
        if (url && typeof url === 'string' && url.includes('/chat') && options && options.method === 'POST') {
            try {
                const body = JSON.parse(options.body);
                if (body.inference_model && body.inference_settings) {
                    lastGenerationSettings = {
                        model: body.inference_model,
                        settings: body.inference_settings
                    };
                }
            } catch (e) {
                console.error('[Stats] Error parsing fetch body:', e);
            }
        }
        
        return originalFetch.apply(this, args);
    };

    // Load profiles from storage
    function loadProfiles() {
        const stored = GM_getValue(PROFILES_KEY, '{}');
        return JSON.parse(stored);
    }

    // Save profiles to storage
    function saveProfiles(profiles) {
        GM_setValue(PROFILES_KEY, JSON.stringify(profiles));
    }

    // Change the model by clicking on it in the model selection modal
    function changeModel(modelName, callback) {
        // First, click the "Change Model" button
        const modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full)');
        if (!modal) {
            callback(false, 'Generation Settings modal not found');
            return;
        }
        
        const changeModelBtn = Array.from(modal.querySelectorAll('button')).find(btn => 
            btn.textContent.includes('Change Model')
        );
        
        if (!changeModelBtn) {
            callback(false, '"Change Model" button not found');
            return;
        }
        
        // Click the button
        changeModelBtn.click();
        
        // Wait for the model selection modal to appear
        setTimeout(() => {
            // Find the model selection modal - it's the one with "Select a model" text
            const selectionModal = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2')).find(m => 
                m.textContent.includes('Select a model')
            );
            
            if (!selectionModal) {
                callback(false, 'Model selection modal not found');
                return;
            }
            
            // Find all model buttons in the selection modal
            const modelButtons = Array.from(selectionModal.querySelectorAll('button'));
            
            // Find the button with the matching model name
            const targetModelBtn = modelButtons.find(btn => {
                const modelNameElement = btn.querySelector('.text-\\[14px\\].font-medium');
                if (modelNameElement) {
                    return modelNameElement.textContent.trim() === modelName;
                }
                return false;
            });
            
            if (!targetModelBtn) {
                callback(false, `Model "${modelName}" not found in selection list`);
                return;
            }
            
            // Click the model button to select it
            targetModelBtn.click();
            
            // Wait for the selection to register and "Set Model" button to appear
            setTimeout(() => {
                // Find the "Set Model" button in the selection modal
                const setModelBtn = Array.from(selectionModal.querySelectorAll('button')).find(btn => 
                    btn.textContent.includes('Set Model')
                );
                
                if (!setModelBtn) {
                    callback(false, '"Set Model" button not found');
                    return;
                }
                
                // Click "Set Model" to confirm the selection
                setModelBtn.click();
                
                // Success - "Set Model" already persists the changes
                callback(true, 'Model changed successfully');
            }, 300);
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
        const lastProfile = GM_getValue(LAST_PROFILE_KEY, '');
        
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
                    GM_setValue(LAST_PROFILE_KEY, profileName);
                    
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
                    GM_setValue(LAST_PROFILE_KEY, profileName.trim());
                    
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

        Object.keys(profiles).sort().forEach(name => {
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
    function toggleSidebarLayout(enable) {
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
        GM_setValue(SIDEBAR_LAYOUT_KEY, enable);
    }
    
    // Apply or remove theme customization CSS
    function toggleThemeCustomization(enable) {
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
        GM_setValue(THEME_CUSTOMIZATION_KEY, enable);
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
        characterTiles.forEach(tile => {
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
        hiddenWrappers.forEach(wrapper => {
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
    
    function toggleHideForYou(enable) {
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
        GM_setValue(HIDE_FOR_YOU_KEY, enable);
    }
    
    // Page Jump functionality
    function getTotalPages() {
        const pageButtons = document.querySelectorAll('button[aria-label^="page-"]');
        let maxPage = 1;
        pageButtons.forEach(button => {
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
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        okButton.addEventListener('click', handleSubmit);
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSubmit(); });
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
        
        ellipsisButtons.forEach(ellipsisButton => {
            if (ellipsisButton.dataset.enhanced === 'true') return;
            ellipsisButton.dataset.enhanced = 'true';
            ellipsisButton.classList.remove('cursor-default');
            ellipsisButton.classList.add('cursor-pointer');
            ellipsisButton.classList.remove('undefined');
            
            ellipsisButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPageJumpModal();
            });
        });
    }
    
    function togglePageJump(enable) {
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
        GM_setValue(PAGE_JUMP_KEY, enable);
    }
    
    // Initialize features on page load
    function initializeStyles() {
        const sidebarEnabled = GM_getValue(SIDEBAR_LAYOUT_KEY, false);
        const themeEnabled = GM_getValue(THEME_CUSTOMIZATION_KEY, false);
        const hideForYouEnabled = GM_getValue(HIDE_FOR_YOU_KEY, false);
        const pageJumpEnabled = GM_getValue(PAGE_JUMP_KEY, false);
        
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
            toggleHideForYou(true);
        } else {
            // Ensure any previously hidden characters are restored on page load
            setTimeout(() => {
                restoreForYouCharacters();
            }, 1000);
        }
        if (pageJumpEnabled) {
            togglePageJump(true);
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
        clonedButton.addEventListener('click', function(e) {
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
        toolkitBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showToolkitSettingsModal();
        });
        
        // Insert before the Like button (so it appears to the left)
        buttonContainer.insertBefore(toolkitBtn, likeButton);
        debugLog('[Toolkit] Mobile button injected successfully');
    }
    
    // Function to show toolkit settings modal
    function showToolkitSettingsModal() {
    debugLog('[Toolkit] ===== OPENING SETTINGS MODAL =====');
    debugLog('[Toolkit] Current Sidebar Layout enabled?', GM_getValue(SIDEBAR_LAYOUT_KEY, false));
    debugLog('[Toolkit] Current Theme Customization enabled?', GM_getValue(THEME_CUSTOMIZATION_KEY, false));        // Create or get a dedicated container with SHADOW DOM for complete isolation
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
        let sidebarEnabled = GM_getValue(SIDEBAR_LAYOUT_KEY, false);
        let themeEnabled = GM_getValue(THEME_CUSTOMIZATION_KEY, false);
        let hideForYouEnabled = GM_getValue(HIDE_FOR_YOU_KEY, false);
        let pageJumpEnabled = GM_getValue(PAGE_JUMP_KEY, false);
        let showStatsEnabled = GM_getValue('showGenerationStats', false);
        let timestampDateFirst = GM_getValue('timestampDateFirst', true); // true = date@time, false = time@date
        
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
                    </div>
                    <div class="version-text">v1.0.11</div>
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
        eventTypes.forEach(eventType => {
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
        
        // Check if this is first run (onboarding) - disable cancel if so
        const hasSeenOnboarding = GM_getValue('hasSeenOnboarding', false);
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
        
        // Save & Refresh button
        saveBtn.onclick = (e) => {
            debugLog('[Toolkit] Save & Refresh button clicked');
            e.stopPropagation();
            debugLog('[Toolkit] Saving - Sidebar:', sidebarEnabled, 'Theme:', themeEnabled, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date');
            GM_setValue(SIDEBAR_LAYOUT_KEY, sidebarEnabled);
            GM_setValue(THEME_CUSTOMIZATION_KEY, themeEnabled);
            GM_setValue(HIDE_FOR_YOU_KEY, hideForYouEnabled);
            GM_setValue(PAGE_JUMP_KEY, pageJumpEnabled);
            GM_setValue('showGenerationStats', showStatsEnabled);
            GM_setValue('timestampDateFirst', timestampDateFirst);
            // Mark onboarding as seen when user saves settings
            GM_setValue('hasSeenOnboarding', true);
            debugLog('[Toolkit] Settings saved to storage');
            showNotification('Settings saved! Refreshing...');
            setTimeout(() => {
                debugLog('[Toolkit] Reloading page...');
                window.location.reload();
            }, 500);
        };
        
        // Export All Data button - exports all settings, profiles, and message stats
        debugLog('[Toolkit] Attaching exportAllBtn onclick handler...');
        debugLog('[Toolkit] exportAllBtn element:', exportAllBtn);
        debugLog('[Toolkit] exportAllBtn exists?:', !!exportAllBtn);
        
        if (exportAllBtn) {
            exportAllBtn.onclick = (e) => {
                debugLog('[Toolkit] ===== EXPORT ALL DATA CLICKED =====');
                debugLog('[Toolkit] Event:', e);
                e.stopPropagation();
                
                try {
                    debugLog('[Toolkit] Starting data collection from GM storage...');
                    
                    // Collect all toolkit data from GM storage
                    const allData = {
                        enableSidebarLayout: GM_getValue(SIDEBAR_LAYOUT_KEY, false),
                        enableThemeCustomization: GM_getValue(THEME_CUSTOMIZATION_KEY, false),
                        enableHideForYou: GM_getValue(HIDE_FOR_YOU_KEY, false),
                        enablePageJump: GM_getValue(PAGE_JUMP_KEY, false),
                        showGenerationStats: GM_getValue('showGenerationStats', false),
                        timestampDateFirst: GM_getValue('timestampDateFirst', true),
                        generationProfiles: GM_getValue(PROFILES_KEY, '{}'),
                        lastSelectedProfile: GM_getValue(LAST_PROFILE_KEY, ''),
                        messageGenerationStats: GM_getValue(MESSAGE_STATS_KEY, '{}')
                    };
                    
                    debugLog('[Toolkit] Data collected:', Object.keys(allData));
                    debugLog('[Toolkit] Checking each property:');
                    for (const [key, value] of Object.entries(allData)) {
                        debugLog(`[Toolkit]   ${key}:`, typeof value, value?.constructor?.name);
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
                    link.download = `sai-toolkit-userscript-${Date.now()}.json`;
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
        
        // Import All Data button - imports settings, profiles, and message stats
        debugLog('[Toolkit] Attaching importAllBtn onclick handler...');
        debugLog('[Toolkit] importAllBtn element:', importAllBtn);
        debugLog('[Toolkit] importAllBtn exists?:', !!importAllBtn);
        
        if (importAllBtn) {
            importAllBtn.onclick = (e) => {
                debugLog('[Toolkit] Import All Data button clicked');
                e.stopPropagation();
                
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', function(event) {
                    const file = event.target.files[0];
                    if (!file) return;
                    
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const imported = JSON.parse(e.target.result);
                            
                            // Import all data to GM storage
                            if (imported.enableSidebarLayout !== undefined) GM_setValue(SIDEBAR_LAYOUT_KEY, imported.enableSidebarLayout);
                            if (imported.enableThemeCustomization !== undefined) GM_setValue(THEME_CUSTOMIZATION_KEY, imported.enableThemeCustomization);
                            if (imported.enableHideForYou !== undefined) GM_setValue(HIDE_FOR_YOU_KEY, imported.enableHideForYou);
                            if (imported.enablePageJump !== undefined) GM_setValue(PAGE_JUMP_KEY, imported.enablePageJump);
                            if (imported.showGenerationStats !== undefined) GM_setValue('showGenerationStats', imported.showGenerationStats);
                            if (imported.timestampDateFirst !== undefined) GM_setValue('timestampDateFirst', imported.timestampDateFirst);
                            if (imported.generationProfiles !== undefined) GM_setValue(PROFILES_KEY, imported.generationProfiles);
                            if (imported.lastSelectedProfile !== undefined) GM_setValue(LAST_PROFILE_KEY, imported.lastSelectedProfile);
                            if (imported.messageGenerationStats !== undefined) GM_setValue(MESSAGE_STATS_KEY, imported.messageGenerationStats);
                            
                            showNotification('All data imported successfully!\nRefreshing page...');
                            setTimeout(() => {
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
    window.addEventListener('error', (event) => {
        debugLog('[Toolkit] ===== GLOBAL ERROR DETECTED =====');
        debugLog('[Toolkit] Error message:', event.message);
        debugLog('[Toolkit] Error filename:', event.filename);
        debugLog('[Toolkit] Error line:', event.lineno, 'col:', event.colno);
        debugLog('[Toolkit] Error object:', event.error);
        debugLog('[Toolkit] Stack trace:', event.error?.stack);
        debugLog('[Toolkit] Time:', Date.now());
    }, true);
    
    // Monitor unhandled promise rejections too
    window.addEventListener('unhandledrejection', (event) => {
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

    // Initialize styles on page load
    initializeStyles();
    
    // Expose a helper function to reset onboarding (for testing)
    window.resetSAIToolkitOnboarding = function() {
        // Clear the onboarding flag
        GM_setValue('hasSeenOnboarding', false);
        // Also clear all settings to simulate a truly fresh install
        GM_deleteValue(SIDEBAR_LAYOUT_KEY);
        GM_deleteValue(THEME_CUSTOMIZATION_KEY);
        GM_deleteValue(HIDE_FOR_YOU_KEY);
        GM_deleteValue(PAGE_JUMP_KEY);
        debugLog('[Toolkit] Onboarding and all settings reset! Reload the page to see the onboarding modal.');
        return 'Onboarding reset! Reload the page.';
    };
    
    // Check if this is the first run (onboarding flow)
    // For Tampermonkey, we check if keys exist using GM_listValues
    const allStorageKeys = GM_listValues ? GM_listValues() : [];
    
    debugLog('[Toolkit] All storage keys:', allStorageKeys);
    
    // Check if hasSeenOnboarding exists in the list
    const hasSeenOnboardingExists = allStorageKeys.includes('hasSeenOnboarding');
    const hasSeenOnboarding = hasSeenOnboardingExists ? GM_getValue('hasSeenOnboarding') : undefined;
    
    const hasToolkitSettings = (
        allStorageKeys.includes(SIDEBAR_LAYOUT_KEY) ||
        allStorageKeys.includes(THEME_CUSTOMIZATION_KEY) ||
        allStorageKeys.includes(HIDE_FOR_YOU_KEY) ||
        allStorageKeys.includes(PAGE_JUMP_KEY)
    );
    
    debugLog('[Toolkit] Onboarding check - hasSeenOnboarding:', hasSeenOnboarding);
    debugLog('[Toolkit] Onboarding check - hasToolkitSettings:', hasToolkitSettings);
    
    // Show onboarding if: never seen before (undefined) OR explicitly false
    const shouldShowOnboarding = hasSeenOnboarding === undefined || hasSeenOnboarding === false;
    
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
    
    // Try to inject sidebar button with multiple retry attempts (sidebar loads with navigation)
    injectToolkitSidebarButton();
    setTimeout(injectToolkitSidebarButton, 500);
    setTimeout(injectToolkitSidebarButton, 1000);
    setTimeout(injectToolkitSidebarButton, 2000);
    setTimeout(injectToolkitSidebarButton, 3000);
    setTimeout(injectToolkitSidebarButton, 5000);
    
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
    
    // Try to inject mobile button with multiple retry attempts (mobile header loads on narrow view)
    injectToolkitMobileButton();
    setTimeout(injectToolkitMobileButton, 500);
    setTimeout(injectToolkitMobileButton, 1000);
    setTimeout(injectToolkitMobileButton, 2000);
    setTimeout(injectToolkitMobileButton, 3000);
    setTimeout(injectToolkitMobileButton, 5000);
    
    // Add observer specifically for sidebar button persistence
    const sidebarButtonObserver = new MutationObserver(function() {
        const existingButton = document.getElementById('sai-toolkit-sidebar-btn');
        // If button doesn't exist but Help button does, re-inject
        if (!existingButton) {
            const helpIcon = document.querySelector('svg.lucide-info');
            if (helpIcon) {
                injectToolkitSidebarButton();
            }
        }
    });
    
    // Add observer specifically for mobile button persistence
    const mobileButtonObserver = new MutationObserver(function() {
        const existingMobileButton = document.getElementById('sai-toolkit-mobile-btn');
        // If button doesn't exist but Like button does, re-inject
        if (!existingMobileButton) {
            const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
            if (likeButton) {
                injectToolkitMobileButton();
            }
        }
    });
    
    // Observe the entire body for sidebar and mobile changes
    sidebarButtonObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
    
    mobileButtonObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

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
        
        // Try to inject header icon on main page (watches for header to load)
        injectToolkitIconOnMainPage();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Observer to add generation stats to messages
    const messageObserver = new MutationObserver(function(mutations) {
        const statsEnabled = GM_getValue('showGenerationStats', false);
        
        if (!statsEnabled) return;
        
        // Debounce: wait a bit for DOM to settle before processing
        clearTimeout(messageObserver.debounceTimer);
        messageObserver.debounceTimer = setTimeout(() => {
            processMessagesForStats();
        }, 100);
    });

    // Separate function to process messages (can be called multiple times)
    function processMessagesForStats() {
        const statsEnabled = GM_getValue('showGenerationStats', false);
        if (!statsEnabled) return;
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');
        let botMessageIndex = 0;
        
        messageWrappers.forEach(wrapper => {
            // Check if this is a bot message (has character link) or user message
            const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
            const isBotMessage = !!characterLink;
            
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
            if (!actionContainer || actionContainer.querySelector('.generation-stats')) {
                if (isBotMessage) botMessageIndex++;
                return;
            }
            
            if (isBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                if (!messageId && messageIdToIndexMap[botMessageIndex] !== undefined) {
                    messageId = messageIdToIndexMap[botMessageIndex];
                }
                
                let generationStats = messageId ? getStatsForMessage(messageId) : null;
                if (!generationStats && pendingMessageStats) generationStats = pendingMessageStats;
                if (!generationStats && lastGenerationSettings) generationStats = lastGenerationSettings;
                
                if (!generationStats) {
                    botMessageIndex++;
                    return;
                }
                
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                if (generationStats.settings && generationStats.model) {
                    const settings = generationStats.settings;
                    const statsText = `${generationStats.model} <br> Tokens: ${settings.max_new_tokens} | Temp: ${settings.temperature.toFixed(2)} | Top-P: ${settings.top_p} | Top-K: ${settings.top_k}`;
                    const timestamp = formatTimestamp(generationStats.createdAt);
                    statsDiv.innerHTML = `${statsText}<br>${timestamp}`;
                } else if (generationStats.createdAt) {
                    const timestamp = formatTimestamp(generationStats.createdAt);
                    statsDiv.innerHTML = timestamp;
                } else {
                    botMessageIndex++;
                    return;
                }
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                }
                
                botMessageIndex++;
            } else {
                // User message - show only timestamp
                let messageId = extractMessageId(wrapper);
                let generationStats = messageId ? getStatsForMessage(messageId) : null;
                
                // Create timestamp div for user messages
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                const timestamp = formatTimestamp(generationStats?.createdAt);
                statsDiv.innerHTML = timestamp;
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                }
            }
        });
    }

    messageObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Periodic check to ensure stats are inserted even if mutations are missed
    setInterval(() => {
        const statsEnabled = GM_getValue('showGenerationStats', false);
        if (statsEnabled) {
            processMessagesForStats();
        }
    }, 2000); // Check every 2 seconds

    // Function to manually trigger stats insertion for all visible messages
    function insertStatsForAllMessages() {
        const statsEnabled = GM_getValue('showGenerationStats', false);
        if (!statsEnabled) return;
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');
        let botMessageIndex = 0;
        
        messageWrappers.forEach((wrapper) => {
            // Check if this is a bot message (has character link) or user message
            const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
            const isBotMessage = !!characterLink;
            
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
            if (!actionContainer || actionContainer.querySelector('.generation-stats')) {
                if (isBotMessage) botMessageIndex++;
                return;
            }
            
            if (isBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                if (!messageId && messageIdToIndexMap[botMessageIndex] !== undefined) {
                    messageId = messageIdToIndexMap[botMessageIndex];
                }
                
                let generationStats = messageId ? getStatsForMessage(messageId) : null;
                if (!generationStats && lastGenerationSettings) {
                    generationStats = lastGenerationSettings;
                }
                
                if (!generationStats) {
                    botMessageIndex++;
                    return;
                }
                
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                if (generationStats.settings && generationStats.model) {
                    const settings = generationStats.settings;
                    const statsText = `${generationStats.model} | tks: ${settings.max_new_tokens} | tmp: ${settings.temperature.toFixed(2)} | p: ${settings.top_p} | k: ${settings.top_k}`;
                    const timestamp = formatTimestamp(generationStats.createdAt);
                    statsDiv.innerHTML = `${statsText}<br>${timestamp}`;
                } else if (generationStats.createdAt) {
                    const timestamp = formatTimestamp(generationStats.createdAt);
                    statsDiv.innerHTML = timestamp;
                } else {
                    botMessageIndex++;
                    return;
                }
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                }
                
                botMessageIndex++;
            } else {
                // User message - show only timestamp
                let messageId = extractMessageId(wrapper);
                let generationStats = messageId ? getStatsForMessage(messageId) : null;
                
                // Create timestamp div for user messages
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';
                
                const timestamp = formatTimestamp(generationStats?.createdAt);
                statsDiv.innerHTML = timestamp;
                
                // Insert before the menu button's parent container
                const menuButtonContainer = actionContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    actionContainer.insertBefore(statsDiv, menuButtonContainer);
                    actionContainer.style.setProperty('gap', '4px', 'important');
                }
            }
        });
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
    
})();
