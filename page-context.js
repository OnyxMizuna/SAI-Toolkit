/**
 * Page context script - Runs in the actual page context (not isolated extension context)
 * This allows console functions to be accessible from the browser's developer console
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
                const filename = conversationId ? `stats-${conversationId}.json` : 'stats-all.json';
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                console.log(`✅ Stats exported to ${filename}`);
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

console.log('[S.AI Toolkit] Debug functions available: debugSAIToolkitStats(), clearSAIToolkitStats(), exportSAIToolkitStats([conversationId]), importSAIToolkitStats(jsonData)');

// Reset onboarding function
window.resetSAIToolkitOnboarding = function() {
    window.dispatchEvent(new CustomEvent('SAI_RESET_ONBOARDING'));
    return 'Resetting... Page will reload in 1 second.';
};
console.log('[Toolkit] Reset function available: resetSAIToolkitOnboarding()');
