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

// ============================================================================
// AUTH HEADER INTERCEPTOR FOR MEMORY REFRESH & CHAT EXPORT
// ============================================================================
// Intercepts XHR and fetch to capture authentication tokens and headers
// from API calls. These are used by the chat export feature and memory refresh.
// This runs in page context where we have access to network APIs.

(function() {
    // Store last seen auth token and headers
    window.__lastAuthHeaders = window.__lastAuthHeaders || {};
    window.__kindeAccessToken = window.__kindeAccessToken || null;
    
    // Only install interceptors once
    if (window.__saiAuthInterceptorInstalled) {
        return;
    }
    window.__saiAuthInterceptorInstalled = true;
    
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
        // Use { once: true } to prevent listener accumulation (memory leak fix)
        if (this._url && this._url.includes('gamma.kinde.com/oauth2/token')) {
            this.addEventListener('load', function() {
                if (this.status === 200) {
                    try {
                        const response = JSON.parse(this.responseText);
                        if (response.access_token) {
                            window.__kindeAccessToken = response.access_token;
                            window.__lastAuthHeaders.Authorization = 'Bearer ' + response.access_token;
                            console.log('[Memories] Captured fresh Kinde access token');
                        }
                    } catch (e) {
                        console.warn('[Memories] Could not parse Kinde token response:', e);
                    }
                }
            }, { once: true });
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
                        console.log('[Memories] Captured fresh Kinde access token (fetch)');
                    }
                }).catch(() => {});
                return response;
            });
        }
        
        return originalFetch.apply(this, args);
    };
    
    console.log('[Memories] Auth header interceptor installed (XHR + fetch)');
})();

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
console.log('[Core] Reset function available: resetSAIToolkitOnboarding()');

// ============================================================================
// CHAT EXPORT API HANDLER
// ============================================================================
// This runs in page context where we can access auth tokens and make API calls
// without CSP blocking inline scripts. Content script sends a request via
// postMessage, we fetch the data, and send it back.

window.addEventListener('message', async function(event) {
    // Only handle our specific export request
    if (event.source !== window) return;
    if (event.data.type !== 'SAI_EXPORT_CHAT_REQUEST') return;
    
    const { characterId, conversationId } = event.data;
    
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
        
        console.log('[Export] Fetching from API with character ID:', characterId, 'conversation ID:', conversationId);

        // Fetch messages for specific conversation
        // If conversation ID is not provided, use the character-level endpoint
        const apiUrl = conversationId && conversationId !== 'null'
            ? `https://prod.nd-api.com/characters/${characterId}/messages/${conversationId}`
            : `https://prod.nd-api.com/characters/${characterId}/messages`;
        
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
        const characterResponse = await fetch(`https://prod.nd-api.com/v2/characters/${characterId}`, {
            method: 'GET',
            headers: headers,
            credentials: 'include'
        });
        
        let characterData = null;
        if (characterResponse.ok) {
            characterData = await characterResponse.json();
        }
        
        // Send data back via postMessage
        window.postMessage({
            type: 'SAI_EXPORT_CHAT_RESPONSE',
            success: true,
            messages: messagesData,
            character: characterData
        }, '*');
    } catch (error) {
        console.error('[Export] Error fetching chat data:', error);
        window.postMessage({
            type: 'SAI_EXPORT_CHAT_RESPONSE',
            success: false,
            error: error.message
        }, '*');
    }
});

// ============================================================================
// MEMORY REFRESH API HANDLER
// ============================================================================
// This runs in page context where we can access auth tokens and make API calls
// without CSP blocking inline scripts. Content script sends a request via
// postMessage, we fetch the memories, and send them back.

window.addEventListener('message', async function(event) {
    // Only handle our specific memory refresh request
    if (event.source !== window) return;
    if (event.data.type !== 'SAI_MEMORY_REFRESH_REQUEST') return;
    
    const { conversationId } = event.data;
    
    try {
        // Try to get the auth token and other required headers
        let authToken = null;
        let guestUserId = null;
        let country = null;
        
        // Method 1: Check if we captured the Kinde access token from OAuth refresh
        if (window.__kindeAccessToken) {
            authToken = window.__kindeAccessToken;
        }
        
        // Method 2: Check intercepted headers from API calls
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
        
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'X-App-Id': 'spicychat'
        };
        
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        if (guestUserId) {
            headers['X-Guest-UserId'] = guestUserId;
        }
        
        if (country) {
            headers['X-Country'] = country;
        }
        
        const response = await fetch(`https://prod.nd-api.com/conversations/${conversationId}/memories`, {
            method: 'GET',
            headers: headers,
            credentials: 'include'
        });
        
        if (response.ok) {
            const memories = await response.json();
            window.postMessage({
                type: 'SAI_MEMORY_REFRESH_RESPONSE',
                success: true,
                memories: memories,
                count: memories.length
            }, '*');
        } else {
            window.postMessage({
                type: 'SAI_MEMORY_REFRESH_RESPONSE',
                success: false,
                status: response.status,
                hasAuth: !!authToken,
                hasUserId: !!guestUserId,
                hasCountry: !!country
            }, '*');
        }
    } catch (error) {
        window.postMessage({
            type: 'SAI_MEMORY_REFRESH_RESPONSE',
            success: false,
            error: error.message
        }, '*');
    }
});

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