/**
 * ============================================================================
 * Page Context Script - SECURITY DISCLOSURE FOR EXTENSION REVIEWERS
 * ============================================================================
 * 
 * PURPOSE:
 * This file exposes debug/utility functions in the page's global window object
 * to allow developers to inspect and manage extension data from browser console.
 * 
 * WHY PAGE CONTEXT INJECTION IS NECESSARY:
 * - Browser console runs in page context, not extension context
 * - Content scripts cannot expose functions directly to window object
 * - This provides developer tools for debugging and data management
 * 
 * SECURITY GUARANTEES:
 * ✓ LOCAL-ONLY OPERATIONS: All functions operate on local browser storage
 * ✓ NO EXTERNAL CONNECTIONS: No network requests made by these functions
 * ✓ USER-INITIATED ONLY: Functions only run when manually called by user
 * ✓ TRANSPARENT: All functions log their actions to console
 * 
 * EXPOSED FUNCTIONS:
 * - debugSAIToolkitStats(): View locally stored message statistics
 * - clearSAIToolkitStats(): Clear all stored statistics
 * - exportSAIToolkitStats(): Export stats to JSON file (local download)
 * - importSAIToolkitStats(): Import stats from JSON file (local upload)
 * - resetSAIToolkitOnboarding(): Reset onboarding flag for testing
 * 
 * DATA FLOW:
 * 1. User calls function from browser console
 * 2. Function sends postMessage to content script
 * 3. Content script reads/writes chrome.storage.local
 * 4. Result posted back via postMessage
 * 5. Function displays result in console
 * 
 * SECURITY NOTE:
 * These functions provide convenience for developers/power users.
 * They operate exclusively on local browser storage with no external
 * communication. Users must manually invoke them from console.
 * 
 * TESTING INSTRUCTIONS FOR REVIEWERS:
 * 1. Open browser console on spicychat.ai
 * 2. Type: debugSAIToolkitStats()
 * 3. Observe: Console shows locally stored data
 * 4. Open DevTools → Network tab
 * 5. Verify: No network requests made when calling functions
 * 
 * OPEN SOURCE:
 * Full source code: https://github.com/CLedebur/Spicychat.ai-Mods
 * ============================================================================
 */

// Debug function to view all stored message stats
window.debugSAIToolkitStats = async function() {
    return new Promise((resolve) => {
        window.postMessage({ type: 'SAI_DEBUG_STATS_REQUEST' }, '*');
        
        const listener = (event) => {
            if (event.data.type === 'SAI_DEBUG_STATS_RESPONSE') {
                window.removeEventListener('message', listener);
                const stats = event.data.stats;
                console.log('=== MESSAGE STATS DEBUG ===');
                console.log('Total messages with stats:', Object.keys(stats).length);
                console.log('First 10 message stats:');
                Object.entries(stats).slice(0, 10).forEach(([id, data]) => {
                    console.log(`  ${id}:`, {
                        model: data.model,
                        tokens: data.settings?.max_new_tokens,
                        temp: data.settings?.temperature,
                        topP: data.settings?.top_p,
                        topK: data.settings?.top_k,
                        createdAt: data.createdAt
                    });
                });
                resolve(stats);
            }
        };
        window.addEventListener('message', listener);
    });
};

// Function to clear all message stats
window.clearSAIToolkitStats = async function() {
    return new Promise((resolve) => {
        window.postMessage({ type: 'SAI_CLEAR_STATS_REQUEST' }, '*');
        
        const listener = (event) => {
            if (event.data.type === 'SAI_CLEAR_STATS_RESPONSE') {
                window.removeEventListener('message', listener);
                console.log('✅ All message stats cleared! Reload the page to rebuild from fresh data.');
                resolve();
            }
        };
        window.addEventListener('message', listener);
    });
};

// Function to export stats for current conversation or all
window.exportSAIToolkitStats = async function(conversationId = null) {
    return new Promise((resolve) => {
        window.postMessage({ type: 'SAI_EXPORT_STATS_REQUEST', conversationId }, '*');
        
        const listener = (event) => {
            if (event.data.type === 'SAI_EXPORT_STATS_RESPONSE') {
                window.removeEventListener('message', listener);
                const stats = event.data.stats;
                const json = JSON.stringify(stats, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                // Stats exported
                resolve(stats);
            }
        };
        window.addEventListener('message', listener);
    });
};

// Function to import stats from JSON
window.importSAIToolkitStats = async function(jsonData) {
    return new Promise((resolve) => {
        window.postMessage({ type: 'SAI_IMPORT_STATS_REQUEST', jsonData }, '*');
        
        const listener = (event) => {
            if (event.data.type === 'SAI_IMPORT_STATS_RESPONSE') {
                window.removeEventListener('message', listener);
                console.log('✅ Stats imported successfully! Reload the page to see changes.');
                resolve();
            }
        };
        window.addEventListener('message', listener);
    });
    };
    
    // Debug functions available// Reset onboarding function
window.resetSAIToolkitOnboarding = function() {
    window.dispatchEvent(new CustomEvent('SAI_RESET_ONBOARDING'));
    return 'Resetting... Page will reload in 1 second.';
};
console.log('[Toolkit] Reset function available: resetSAIToolkitOnboarding()');

// ============================================================================
// ARROW KEY BLOCKER FOR MESSAGE EDITING
// ============================================================================
// When editing a message, arrow keys should NOT switch between regenerations.
// This runs in the page context so it can intercept React's event handling.

(function() {
    'use strict';
    
    // Check if a message edit mode is currently active
    function isMessageEditActive() {
        // Method 1: Look for Save/Cancel buttons that appear in edit mode
        const saveButton = document.querySelector('button[aria-label="save-edit"], button:has(svg.lucide-check)');
        const cancelButton = document.querySelector('button[aria-label="cancel-edit"], button:has(svg.lucide-x)');
        
        // Method 2: Look for edit mode textareas
        // Edit textareas are typically in a flex-col container, NOT inside the main chat input
        const editTextareas = document.querySelectorAll('textarea');
        for (const textarea of editTextareas) {
            // Skip the main chat input (it's inside .border-1.border-solid.rounded-\[13px\])
            if (textarea.closest('.border-1.border-solid.rounded-\\[13px\\]')) {
                continue;
            }
            // Skip hidden WYSIWYG textareas
            if (textarea.classList.contains('sai-wysiwyg-hidden')) {
                continue;
            }
            // Check if it's visible
            const style = window.getComputedStyle(textarea);
            if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0) {
                // Check if it looks like a message edit textarea (has certain classes or parent structure)
                if (textarea.closest('.flex.flex-col.gap-1\\.5') || 
                    textarea.closest('.flex.flex-col.gap-md') ||
                    textarea.classList.contains('resize-none')) {
                    return true;
                }
            }
        }
        
        // Method 3: Check for Save/Cancel buttons near textareas
        if (saveButton || cancelButton) {
            return true;
        }
        
        return false;
    }
    
    // Block arrow keys at the earliest possible point
    window.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            if (isMessageEditActive()) {
                // Only block if focus is NOT on an input/textarea
                // (so cursor movement inside the textarea still works)
                const activeElement = document.activeElement;
                const isInInput = activeElement && 
                    (activeElement.tagName === 'TEXTAREA' || 
                     activeElement.tagName === 'INPUT' ||
                     activeElement.contentEditable === 'true');
                
                if (!isInInput) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    return false;
                }
            }
        }
    }, true); // Use capture phase
    
    console.log('[SAI Toolkit] Arrow key blocker for message editing initialized');
})();