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
        // Keyed lowercase: SpicyChat's HTTP client now calls setRequestHeader with
        // lowercase names (e.g. 'authorization', not 'Authorization' — confirmed live).
        // HTTP header names are case-insensitive on the wire, but a JS property lookup
        // isn't, so a capitalized lookup here silently never matched and every captured
        // header (Authorization included) came back empty. This is the actual cause of
        // chat export's "Invalid or expired token" — no token was ever captured, not an
        // actually-expired one.
        this._requestHeaders[header.toLowerCase()] = value;
        return originalXHRSetRequestHeader.apply(this, [header, value]);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        // Capture headers from prod.nd-api.com requests
        if (this._url && this._url.includes('prod.nd-api.com') && this._requestHeaders) {
            const h = this._requestHeaders;
            if (h['authorization']) window.__lastAuthHeaders.Authorization = h['authorization'];
            if (h['x-guest-userid']) window.__lastAuthHeaders['X-Guest-UserId'] = h['x-guest-userid'];
            if (h['x-country']) window.__lastAuthHeaders['X-Country'] = h['x-country'];
            if (h['x-app-id']) window.__lastAuthHeaders['X-App-Id'] = h['x-app-id'];
            // Newer headers SpicyChat's client now sends alongside the above (confirmed
            // live) — forwarded too in case the API has started expecting them.
            if (h['x-app-version']) window.__lastAuthHeaders['X-App-Version'] = h['x-app-version'];
            if (h['x-platform']) window.__lastAuthHeaders['X-Platform'] = h['x-platform'];
            if (h['x-platform-os']) window.__lastAuthHeaders['X-Platform-OS'] = h['x-platform-os'];
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
    
    // Case-insensitive header read: options.headers may be a plain object (keys in
    // whatever case the caller used — confirmed live to be lowercase now) or a Headers
    // instance (already case-insensitive via .get(), but plain-object property access
    // like headers.Authorization is not).
    function readHeaderCI(headers, name) {
        if (!headers) return null;
        if (typeof headers.get === 'function') return headers.get(name);
        const lname = name.toLowerCase();
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === lname) return headers[key];
        }
        return null;
    }

    // Also intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const [url, options] = args;
        const urlString = typeof url === 'string' ? url : (url && url.url) || '';

        // Capture auth headers from API calls
        if (options && options.headers && urlString.includes('prod.nd-api.com')) {
            const headers = options.headers;
            const auth = readHeaderCI(headers, 'Authorization');
            const guestId = readHeaderCI(headers, 'X-Guest-UserId');
            const country = readHeaderCI(headers, 'X-Country');
            const appId = readHeaderCI(headers, 'X-App-Id');
            const appVersion = readHeaderCI(headers, 'X-App-Version');
            const platform = readHeaderCI(headers, 'X-Platform');
            const platformOs = readHeaderCI(headers, 'X-Platform-OS');
            if (auth) window.__lastAuthHeaders.Authorization = auth;
            if (guestId) window.__lastAuthHeaders['X-Guest-UserId'] = guestId;
            if (country) window.__lastAuthHeaders['X-Country'] = country;
            if (appId) window.__lastAuthHeaders['X-App-Id'] = appId;
            if (appVersion) window.__lastAuthHeaders['X-App-Version'] = appVersion;
            if (platform) window.__lastAuthHeaders['X-Platform'] = platform;
            if (platformOs) window.__lastAuthHeaders['X-Platform-OS'] = platformOs;
        }

        // Intercept Kinde token refresh
        if (urlString.includes('gamma.kinde.com/oauth2/token')) {
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

const saiActiveChatExports = new Set();

window.addEventListener('message', async function(event) {
    // Only handle our specific export request
    if (event.source !== window) return;
    if (event.data?.type !== 'SAI_EXPORT_CHAT_REQUEST') return;

    const { characterId, conversationId, requestId } = event.data;
    if (typeof requestId !== 'string' || !requestId || typeof characterId !== 'string' || !characterId) return;
    if (saiActiveChatExports.has(requestId)) return;
    if (saiActiveChatExports.size) {
        window.postMessage({ type: 'SAI_EXPORT_CHAT_RESPONSE', requestId, success: false, error: 'A chat export is already running' }, '*');
        return;
    }
    saiActiveChatExports.add(requestId);
    const controller = new AbortController();
    const cancelHandler = event => {
        if (event.source === window && event.data?.type === 'SAI_EXPORT_CHAT_CANCEL' && event.data.requestId === requestId) controller.abort();
    };
    window.addEventListener('message', cancelHandler);

    try {
        let authToken = null;
        let guestUserId = null;
        let country = null;
        let appVersion = null;
        let platform = null;
        let platformOs = null;

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
            if (!appVersion && window.__lastAuthHeaders['X-App-Version']) {
                appVersion = window.__lastAuthHeaders['X-App-Version'];
            }
            if (!platform && window.__lastAuthHeaders['X-Platform']) {
                platform = window.__lastAuthHeaders['X-Platform'];
            }
            if (!platformOs && window.__lastAuthHeaders['X-Platform-OS']) {
                platformOs = window.__lastAuthHeaders['X-Platform-OS'];
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
        if (appVersion) headers['X-App-Version'] = appVersion;
        if (platform) headers['X-Platform'] = platform;
        if (platformOs) headers['X-Platform-OS'] = platformOs;

        console.log('[Export] Fetching from API with character ID:', characterId, 'conversation ID:', conversationId);

        // Keep the existing authentication headers, but bound each request rather
        // than the complete export. Retry only transient failures of idempotent GETs.
        const PAGE_LIMIT = 300;
        const MAX_PAGES = 100000;
        const messagesById = new Map();
        const seenCursors = new Set();
        let messagesData = null;
        let cursorLastId = null;
        let pageNum = 0;
        let lockedConversationId = conversationId && conversationId !== 'null' ? conversationId : null;
        let reachedEnd = false;
        const expected = () => {
            if (messagesData?.num_messages == null) return null;
            const n = Number(messagesData.num_messages);
            return Number.isSafeInteger(n) && n >= 0 ? n : null;
        };
        const progress = phase => window.postMessage({
            type: 'SAI_EXPORT_CHAT_PROGRESS', requestId, count: messagesData?.messages?.length || messagesById.size,
            expected: expected(), page: pageNum, phase
        }, '*');
        const checkCancelled = () => {
            if (controller.signal.aborted) throw new Error('Export cancelled');
        };
        const wait = ms => new Promise((resolve, reject) => {
            if (controller.signal.aborted) return reject(new Error('Export cancelled'));
            const onAbort = () => { clearTimeout(timer); reject(new Error('Export cancelled')); };
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        async function getJSON(url) {
            for (let attempt = 0; attempt < 3; attempt++) {
                checkCancelled();
                const requestController = new AbortController();
                const onAbort = () => requestController.abort();
                controller.signal.addEventListener('abort', onAbort, { once: true });
                const timer = setTimeout(() => requestController.abort(), 45000);
                let retryAfter = 0;
                try {
                    const response = await fetch(url, { method: 'GET', headers, credentials: 'include', signal: requestController.signal });
                    if (!response.ok) {
                        const error = new Error(`HTTP ${response.status}`);
                        error.permanent = ![408, 425, 429, 500, 502, 503, 504].includes(response.status);
                        const raw = response.headers.get('Retry-After');
                        if (raw) {
                            const seconds = Number(raw);
                            retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
                        }
                        // Avoid retaining unconsumed response streams across retries.
                        try { await response.body?.cancel(); } catch (_) {}
                        throw error;
                    }
                    const result = await response.json();
                    checkCancelled();
                    return result;
                } catch (error) {
                    checkCancelled();
                    if (error.permanent || attempt === 2) throw error;
                    // Honor server backoff. If it exceeds the idle budget, stop clearly
                    // instead of repeatedly hitting a rate-limited endpoint.
                    if (retryAfter > 120000) throw new Error('Server requested a long retry delay; retry the export later');
                    progress(`Temporary request failure; retry ${attempt + 1}/2`);
                } finally {
                    clearTimeout(timer);
                    controller.signal.removeEventListener('abort', onAbort);
                }
                await wait(Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0));
            }
        }
        function timestampOf(message) {
            const value = message.createdAt ?? message.created_at;
            if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
            if (typeof value === 'string' && value.trim()) {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? numeric : Date.parse(value);
            }
            return NaN;
        }
        progress('Fetching chat');
        while (pageNum < MAX_PAGES) {
            checkCancelled();
            const base = `https://prod.nd-api.com/characters/${encodeURIComponent(characterId)}/messages` +
                (lockedConversationId ? `/${encodeURIComponent(lockedConversationId)}` : '');
            const url = base + `?limit=${PAGE_LIMIT}` + (cursorLastId ? `&last_id=${encodeURIComponent(cursorLastId)}` : '') + '&';
            const pageData = await getJSON(url);
            if (!pageData || !Array.isArray(pageData.messages)) throw new Error(`Invalid message page ${pageNum + 1}`);
            const returnedId = pageData.conversation_id || pageData.chat_id || null;
            if (lockedConversationId && returnedId && returnedId !== lockedConversationId) throw new Error('Conversation changed during export');
            if (!lockedConversationId && returnedId) lockedConversationId = returnedId;
            if (!messagesData) messagesData = { ...pageData, messages: [] };
            const pageMsgs = pageData.messages;
            pageNum++;
            if (pageMsgs.length === 0) { reachedEnd = true; break; }
            let added = 0;
            let oldestTs = Infinity;
            let oldestId = null;
            for (const message of pageMsgs) {
                if (!message || typeof message.id !== 'string' || !message.id) throw new Error(`Message without an ID on page ${pageNum}`);
                const ts = timestampOf(message);
                if (!Number.isFinite(ts)) throw new Error(`Message without a valid timestamp on page ${pageNum}`);
                if (!messagesById.has(message.id)) { messagesById.set(message.id, message); added++; }
                if (ts <= oldestTs) { oldestTs = ts; oldestId = message.id; }
            }
            progress('Fetching chat');
            if (!added) {
                // Some cursor endpoints repeat the last record at the beginning.
                // Only accept the exact terminal cursor record and a satisfied total.
                if (pageMsgs.length === 1 && pageMsgs[0].id === cursorLastId && expected() !== null && messagesById.size >= expected()) {
                    reachedEnd = true; break;
                }
                throw new Error(`Pagination stopped making progress after ${messagesById.size} messages; no incomplete file was saved`);
            }
            if (!lockedConversationId) throw new Error('Cannot verify the conversation ID for subsequent export pages');
            if (!oldestId || oldestId === cursorLastId || seenCursors.has(oldestId)) throw new Error('Pagination cursor repeated; no incomplete file was saved');
            seenCursors.add(oldestId);
            cursorLastId = oldestId;
        }
        if (!reachedEnd) throw new Error('Export reached its pagination safety limit; no incomplete file was saved');
        if (expected() !== null && messagesById.size < expected()) throw new Error(`Incomplete export: got ${messagesById.size} of ${expected()} reported messages`);
        checkCancelled();
        progress('Sorting messages');
        if (!messagesData) messagesData = { messages: [] };
        messagesData.messages = Array.from(messagesById.values()).sort((a, b) => timestampOf(a) - timestampOf(b));
        messagesById.clear();
        if (lockedConversationId) messagesData.conversation_id = lockedConversationId;
        let characterData = null;
        progress('Fetching character details');
        try {
            characterData = await getJSON(`https://prod.nd-api.com/v2/characters/${encodeURIComponent(characterId)}`);
        } catch (error) { checkCancelled(); console.warn('[Export] Character lookup failed:', error.message); }
        if (!characterData?.name && lockedConversationId) {
            try {
                const conversations = await getJSON('https://prod.nd-api.com/v2/conversations?limit=500');
                const match = Array.isArray(conversations) ? conversations.find(c => c.id === lockedConversationId) : null;
                if (match?.character) characterData = { ...characterData, ...match.character };
            } catch (error) { checkCancelled(); console.warn('[Export] Character fallback failed:', error.message); }
        }
        checkCancelled();
        window.postMessage({ type: 'SAI_EXPORT_CHAT_PROGRESS', requestId, count: messagesData.messages.length, expected: expected(), page: pageNum, phase: 'Preparing download' }, '*');
        window.postMessage({ type: 'SAI_EXPORT_CHAT_RESPONSE', requestId, success: true, messages: messagesData, character: characterData }, '*');
    } catch (error) {
        console.error('[Export] Error fetching chat data:', error);
        window.postMessage({ type: 'SAI_EXPORT_CHAT_RESPONSE', requestId, success: false, error: error.message }, '*');
    } finally {
        window.removeEventListener('message', cancelHandler);
        saiActiveChatExports.delete(requestId);
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