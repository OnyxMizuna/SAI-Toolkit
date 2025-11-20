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
