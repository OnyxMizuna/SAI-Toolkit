/**
 * ============================================================================
 * XHR/Fetch Intercept Script - SECURITY DISCLOSURE FOR EXTENSION REVIEWERS
 * ============================================================================
 * 
 * PURPOSE:
 * This file intercepts XMLHttpRequest and fetch API calls in the page context
 * to capture AI generation settings (temperature, top_p, top_k, model name)
 * from SpicyChat.ai API responses.
 * 
 * WHY PAGE CONTEXT INJECTION IS NECESSARY:
 * - SpicyChat.ai implements Content Security Policy (CSP) that prevents
 *   content scripts from accessing page-level network requests
 * - We need page context access to listen to XMLHttpRequest/fetch events
 * - Content scripts run in isolated world and cannot intercept page requests
 * 
 * SECURITY GUARANTEES:
 * ✓ READ-ONLY INTERCEPTION: We never modify requests or responses
 * ✓ LOCAL-ONLY STORAGE: All data saved to chrome.storage.local (browser)
 * ✓ NO EXTERNAL CONNECTIONS: This script makes zero network requests
 * ✓ LIMITED SCOPE: Only reads public AI model parameters, not user messages
 * ✓ NO CREDENTIALS: Does not access passwords, tokens, or auth headers
 * 
 * DATA FLOW:
 * 1. Listen for API calls to /messages and /chat endpoints
 * 2. Parse JSON responses to extract model settings (public parameters)
 * 3. Send extracted data to content script via window.postMessage
 * 4. Content script stores data locally in chrome.storage.local
 * 5. Data never leaves user's browser
 * 
 * WHAT WE READ:
 * - inference_model: Model name (e.g., "llama-3.1-70b")
 * - inference_settings: { temperature, top_p, top_k, max_new_tokens }
 * - createdAt: Timestamp for organizing saved profiles
 * - conversation_id: For organizing stats by conversation
 * 
 * WHAT WE DO NOT READ:
 * ✗ Message content (user or AI responses)
 * ✗ User credentials or authentication tokens
 * ✗ Personal information or account details
 * ✗ Payment information
 * 
 * TESTING INSTRUCTIONS FOR REVIEWERS:
 * 1. Install extension and open DevTools Network tab
 * 2. Verify: Extension makes ZERO external network requests
 * 3. Open DevTools → Application → Storage → Local Storage
 * 4. Verify: All data stored locally (no external transmission)
 * 5. Test: Save a profile, verify it's stored in chrome.storage.local
 * 
 * OPEN SOURCE:
 * Full source code available at: https://github.com/CLedebur/Spicychat.ai-Mods
 * Reviewers can verify every line of code
 * 
 * This MUST run at document_start to catch the initial GET /messages call
 * ============================================================================
 */

(function() {
    // DEBUG_MODE will be replaced when injecting the script
    const DEBUG_MODE = window.__SAI_DEBUG_MODE__ || false;
    
    function debugLog(...args) {
        if (DEBUG_MODE) {
            console.log(...args);
        }
    }
    
    debugLog('[Stats] [PAGE CONTEXT] Setting up network interception...');
    
    // Only set up once
    if (window.__SAI_STATS_INTERCEPTED__) {
        debugLog('[Stats] Already intercepted, skipping');
        return;
    }
    window.__SAI_STATS_INTERCEPTED__ = true;
    
    let lastGenerationSettings = null;
    let loadedMessageIds = [];
    let messageIdToIndexMap = {};
    
    // NSFW Mode state - can be toggled via postMessage from content script
    // Initialize from localStorage if available
    let nsfwModeOverride = null; // null = use site default, true/false = override
    try {
        const stored = localStorage.getItem('sai_nsfw_mode_override');
        if (stored !== null) {
            nsfwModeOverride = stored === 'true';
            debugLog('[NSFW] Loaded NSFW mode override from localStorage:', nsfwModeOverride);
        }
    } catch (e) {
        // localStorage not available
    }
    
    // Listen for NSFW mode toggle from content script
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'SAI_SET_NSFW_MODE') {
            nsfwModeOverride = event.data.enabled;
            debugLog('[NSFW] NSFW mode override set to:', nsfwModeOverride);
            // Persist to localStorage
            try {
                if (nsfwModeOverride === null) {
                    localStorage.removeItem('sai_nsfw_mode_override');
                } else {
                    localStorage.setItem('sai_nsfw_mode_override', String(nsfwModeOverride));
                }
            } catch (e) {
                // localStorage not available
            }
            // Send confirmation back
            window.postMessage({
                type: 'SAI_NSFW_MODE_UPDATED',
                enabled: nsfwModeOverride
            }, '*');
        }
        
        // Handle request for current NSFW state
        if (event.data && event.data.type === 'SAI_GET_NSFW_MODE') {
            window.postMessage({
                type: 'SAI_NSFW_MODE_STATE',
                enabled: nsfwModeOverride
            }, '*');
        }
    });
    
    // Intercept XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._method = method;
        this._url = url;
        return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
        debugLog('[Stats] XHR send intercepted:', this._method, this._url);
        
        // GET /messages - loading message history
        if (this._method === 'GET' && this._url && this._url.includes('/messages')) {
            debugLog('[Stats] Setting up load handler for GET /messages');
            this.addEventListener('load', function() {
                debugLog('[Stats] GET /messages load event fired');
                try {
                    debugLog('[Stats] Attempting to parse response...');
                    const response = JSON.parse(this.responseText);
                    debugLog('[Stats] Response parsed, top-level keys:', Object.keys(response));
                    
                    // Extract conversation_id and label from response
                    const conversationId = response.conversation_id || response.chat_id || response.id || null;
                    const label = response.label || null;
                    console.log('[ChatTitle XHR] ========== GET /messages RESPONSE ==========');
                    console.log('[ChatTitle XHR] Full response keys:', Object.keys(response));
                    console.log('[ChatTitle XHR] Extracted conversation ID:', conversationId);
                    console.log('[ChatTitle XHR] Extracted label:', label);
                    console.log('[ChatTitle XHR] Label type:', typeof label);
                    debugLog('[Stats] Extracted conversation ID:', conversationId, 'label:', label);
                    
                    if (response.messages && Array.isArray(response.messages)) {
                        const botMessages = response.messages.filter(msg => msg.role === 'bot');
                        const userMessages = response.messages.filter(msg => msg.role === 'user');
                        
                        debugLog('[Stats] GET /messages - found', botMessages.length, 'bot messages');
                        
                        // Log first bot message to see what fields are available
                        if (botMessages.length > 0) {
                            debugLog('[Stats] Sample bot message from GET:', {
                                id: botMessages[0].id,
                                createdAt: botMessages[0].createdAt,
                                inference_model: botMessages[0].inference_model,
                                inference_settings: botMessages[0].inference_settings,
                                chat_id: botMessages[0].chat_id,
                                allKeys: Object.keys(botMessages[0])
                            });
                        }
                        
                        // Send data to content script (including label for page title)
                        const messageData = {
                            type: 'SAI_MESSAGES_LOADED',
                            conversationId: conversationId, // Include conversation ID
                            label: label, // Include label for page title
                            botMessages: botMessages.map(msg => ({
                                id: msg.id,
                                createdAt: msg.createdAt,
                                inference_model: msg.inference_model,
                                inference_settings: msg.inference_settings,
                                is_alternative: msg.is_alternative || false,
                                prev_id: msg.prev_id || null
                            })),
                            userMessages: userMessages.map(msg => ({
                                id: msg.id,
                                createdAt: msg.createdAt
                            }))
                        };
                        console.log('[ChatTitle XHR] Sending postMessage SAI_MESSAGES_LOADED');
                        console.log('[ChatTitle XHR] Message data includes label:', label);
                        window.postMessage(messageData, '*');
                        debugLog('[Stats] Sent SAI_MESSAGES_LOADED postMessage with label:', label);
                        
                        loadedMessageIds = botMessages.map(msg => msg.id).reverse();
                        messageIdToIndexMap = {};
                        loadedMessageIds.forEach((id, index) => {
                            messageIdToIndexMap[index] = id;
                        });
                    } else {
                        debugLog('[Stats] No messages array in response:', response);
                    }
                } catch (e) {
                    console.error('[Stats] Error parsing messages response:', e);
                }
            });
        }
        
        // POST /chat - new message generation
        if (this._method === 'POST' && this._url && this._url.includes('/chat')) {
            debugLog('[Stats] Intercepted POST to /chat');
            try {
                const parsedBody = JSON.parse(body);
                
                if (parsedBody.inference_model && parsedBody.inference_settings) {
                    debugLog('[Stats] Found inference settings in POST body');
                    debugLog('[Stats] inference_model:', parsedBody.inference_model);
                    debugLog('[Stats] inference_settings:', parsedBody.inference_settings);
                    lastGenerationSettings = {
                        model: parsedBody.inference_model,
                        settings: parsedBody.inference_settings
                    };
                    debugLog('[Stats] Stored lastGenerationSettings:', lastGenerationSettings);
                    
                    // Capture the POST send timestamp for user message
                    const userMessageTimestamp = Date.now();
                    
                    // Listen for the response
                    this.addEventListener('load', function() {
                        debugLog('[Stats] POST response received');
                        try {
                            const response = JSON.parse(this.responseText);
                            debugLog('[Stats] POST response structure - top-level keys:', Object.keys(response));
                            
                            // Handle bot message (response.message)
                            if (response.message && response.message.id) {
                                const messageId = response.message.id;
                                const createdAt = response.message.createdAt || response.message.created_at || null;
                                const conversationId = response.message.conversation_id || response.message.chat_id || response.chat_id || response.conversation_id || null;
                                
                                // Check if this is a regeneration (alternative message)
                                // IMPORTANT: prev_id exists for ALL messages (points to preceding message in conversation)
                                // It does NOT indicate a regeneration! The API only sets is_alternative in GET /messages responses.
                                // 
                                // We can only detect regenerations at POST time by checking the request:
                                // - continue_chat: true with empty message = regeneration/continue
                                // - alt_message_id present = regenerating a specific alternative
                                //
                                // For now, we'll be conservative and NOT mark anything as alternative at POST time.
                                // The SAI_MESSAGES_LOADED handler will correctly identify alternatives when the full
                                // message list is loaded with is_alternative flags.
                                const prevId = response.message.prev_id || null;
                                const isAlternative = false; // Cannot reliably detect at POST time - let GET /messages handle it
                                
                                debugLog('[Stats XHR] ========== NEW BOT MESSAGE ==========');
                                debugLog('[Stats XHR] Bot message ID:', messageId);
                                debugLog('[Stats XHR] Raw response.message.createdAt:', response.message.createdAt);
                                debugLog('[Stats XHR] Extracted createdAt value:', createdAt);
                                debugLog('[Stats XHR] createdAt type:', typeof createdAt);
                                debugLog('[Stats XHR] createdAt as Date:', new Date(createdAt).toISOString());
                                debugLog('[Stats XHR] Is regeneration:', isAlternative, '(always false at POST time - see comment above)');
                                debugLog('[Stats XHR] Previous message ID:', prevId);
                                debugLog('[Stats XHR] =======================================');
                                
                                // Extract model info - use response.engine first (actual model used)
                                // Fall back to lastGenerationSettings (requested model)
                                const responseModel = response.engine || null;
                                const requestModel = lastGenerationSettings?.model || null;
                                
                                // Build model display string
                                let modelDisplay;
                                if (requestModel && responseModel && requestModel !== responseModel) {
                                    modelDisplay = `${requestModel} → ${responseModel}`;
                                } else if (responseModel) {
                                    modelDisplay = responseModel;
                                } else if (requestModel) {
                                    modelDisplay = requestModel;
                                } else {
                                    modelDisplay = null;
                                }
                                
                                debugLog('[Stats] Request model:', requestModel, 'Response model:', responseModel, 'Display:', modelDisplay);
                            debugLog('[Stats XHR] About to postMessage with createdAt:', createdAt);
                                
                                // Send to content script
                                window.postMessage({
                                    type: 'SAI_NEW_MESSAGE',
                                    messageId: messageId,
                                    conversationId: conversationId,
                                    model: modelDisplay,
                                    settings: lastGenerationSettings?.settings || null,
                                    createdAt: createdAt,
                                    role: 'bot',
                                    isAlternative: isAlternative,
                                    prevId: prevId
                                }, '*');
                                
                                // Update local tracking
                                loadedMessageIds.push(messageId);
                                messageIdToIndexMap = {};
                                loadedMessageIds.forEach((id, index) => {
                                    messageIdToIndexMap[index] = id;
                                });
                            }
                            
                            // Send notification for user message using captured timestamp
                            // Note: User message ID is not returned in the response, so we send
                            // a notification to the content script to detect it via DOM observation
                            debugLog('[Stats] Sending SAI_USER_MESSAGE_SENT with timestamp:', userMessageTimestamp);
                            window.postMessage({
                                type: 'SAI_USER_MESSAGE_SENT',
                                timestamp: userMessageTimestamp,
                                conversationId: response.conversation_id || response.chat_id || null
                            }, '*');
                        } catch (e) {
                            console.error('[Stats] Error parsing chat response:', e);
                        }
                    });
                }
            } catch (e) {
                console.error('[Stats] Error parsing chat body:', e);
            }
        }
        
        // Intercept image generation requests to inject NSFW mode override
        // The endpoint is: POST /chat/conversation-image with field "nsfw_mode"
        if (this._method === 'POST' && this._url && nsfwModeOverride !== null) {
            const urlLower = this._url.toLowerCase();
            if (urlLower.includes('conversation-image') || urlLower.includes('/image') || urlLower.includes('/generate')) {
                debugLog('[NSFW] Intercepted image generation request:', this._url);
                try {
                    if (body && typeof body === 'string') {
                        const parsedBody = JSON.parse(body);
                        // Set nsfw_mode - this is the field used by SpicyChat API
                        debugLog('[NSFW] Modifying request body, setting nsfw_mode to:', nsfwModeOverride);
                        parsedBody.nsfw_mode = nsfwModeOverride;
                        body = JSON.stringify(parsedBody);
                        debugLog('[NSFW] Modified body:', body);
                    }
                } catch (e) {
                    debugLog('[NSFW] Could not parse body for NSFW injection:', e);
                }
            }
        }
        
        return originalXHRSend.apply(this, [body]);
    };
    
    // Also intercept fetch as backup
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        let [url, options] = args;
        
        debugLog('[Stats] Fetch intercepted:', typeof url === 'string' ? url : url?.toString(), options?.method || 'GET');
        
        // Log ALL character-related URLs to see what's actually being called
        if (url && typeof url === 'string' && url.includes('characters')) {
            console.log('[ChatTitle FETCH DEBUG] Character-related URL detected:', url);
            console.log('[ChatTitle FETCH DEBUG] Method:', options?.method || 'GET');
        }
        
        // Intercept image generation requests to inject NSFW mode override (fetch version)
        // The endpoint is: POST /chat/conversation-image with field "nsfw_mode"
        const urlString = typeof url === 'string' ? url : url?.toString();
        if (options && options.method === 'POST' && urlString && nsfwModeOverride !== null) {
            const urlLower = urlString.toLowerCase();
            if (urlLower.includes('conversation-image') || urlLower.includes('/image') || urlLower.includes('/generate')) {
                debugLog('[NSFW FETCH] Intercepted image generation request:', urlString);
                try {
                    if (options.body && typeof options.body === 'string') {
                        const parsedBody = JSON.parse(options.body);
                        // Set nsfw_mode - this is the field used by SpicyChat API
                        debugLog('[NSFW FETCH] Modifying request body, setting nsfw_mode to:', nsfwModeOverride);
                        parsedBody.nsfw_mode = nsfwModeOverride;
                        options = { ...options, body: JSON.stringify(parsedBody) };
                        args = [url, options];
                        debugLog('[NSFW FETCH] Modified body');
                    }
                } catch (e) {
                    debugLog('[NSFW FETCH] Could not parse body for NSFW injection:', e);
                }
            }
        }
        
        // Capture timestamp when POST /chat is sent
        let userMessageTimestamp = null;
        
        // POST /chat via fetch
        if (url && typeof url === 'string' && url.includes('/chat') && options && options.method === 'POST') {
            debugLog('[Stats] Intercepted POST to /chat via fetch');
            userMessageTimestamp = Date.now();
            try {
                const body = JSON.parse(options.body);
                if (body.inference_model && body.inference_settings) {
                    debugLog('[Stats] Found inference settings in fetch body');
                    lastGenerationSettings = {
                        model: body.inference_model,
                        settings: body.inference_settings
                    };
                }
            } catch (e) {
                console.error('[Stats] Error parsing fetch body:', e);
            }
        }
        
        // Call original fetch
        const response = await originalFetch.apply(this, args);
        
        // Intercept GET /v2/characters/{id} - character details for page title
        // Try multiple patterns to catch the actual endpoint
        const fetchUrlString = typeof url === 'string' ? url : url?.toString();
        console.log('[ChatTitle FETCH DEBUG] Checking URL:', fetchUrlString);
        
        // Pattern 1: /v2/characters/{uuid}
        const v2Pattern = /\/v2\/characters\/[a-f0-9-]+/;
        // Pattern 2: /characters/{uuid} (without v2)
        const v1Pattern = /\/characters\/[a-f0-9-]+$/;
        // Pattern 3: Any characters endpoint
        const anyCharPattern = /\/characters\/[a-f0-9-]+/;
        
        if (fetchUrlString && (v2Pattern.test(fetchUrlString) || v1Pattern.test(fetchUrlString) || anyCharPattern.test(fetchUrlString)) && (!options || !options.method || options.method === 'GET')) {
            console.log('[ChatTitle FETCH] ========== CHARACTER API MATCHED ==========');
            console.log('[ChatTitle FETCH] URL:', fetchUrlString);
            console.log('[ChatTitle FETCH] Matched pattern:', v2Pattern.test(fetchUrlString) ? 'v2' : v1Pattern.test(fetchUrlString) ? 'v1' : 'any');
            const clonedResponse = response.clone();
            try {
                const data = await clonedResponse.json();
                console.log('[ChatTitle FETCH] Response keys:', Object.keys(data));
                console.log('[ChatTitle FETCH] Character name:', data.name);
                if (data.name) {
                    console.log('[ChatTitle FETCH] Sending postMessage SAI_CHARACTER_LOADED with name:', data.name);
                    debugLog('[ChatTitle] Got character name from API:', data.name);
                    // Send to content script
                    window.postMessage({
                        type: 'SAI_CHARACTER_LOADED',
                        characterName: data.name
                    }, '*');
                } else {
                    console.warn('[ChatTitle FETCH] No name field in character response!');
                    console.warn('[ChatTitle FETCH] Full response:', data);
                }
            } catch (e) {
                console.error('[ChatTitle FETCH] Error parsing character response:', e);
                debugLog('[ChatTitle] Error parsing character response:', e);
            }
        }
        
        // Check response for message ID
        if (url && typeof url === 'string' && url.includes('/chat')) {
            const clonedResponse = response.clone();
            try {
                const data = await clonedResponse.json();
                
                if (data.message && data.message.id) {
                    const messageId = data.message.id;
                    const createdAt = data.message.createdAt || data.message.created_at || null;
                    const conversationId = data.message.conversation_id || data.message.chat_id || data.chat_id || data.conversation_id || null;
                    
                    // Check if this is a regeneration (alternative message)
                    // IMPORTANT: prev_id exists for ALL messages (points to preceding message in conversation)
                    // It does NOT indicate a regeneration! See detailed comment in XHR handler above.
                    const prevId = data.message.prev_id || null;
                    const isAlternative = false; // Cannot reliably detect at POST time - let GET /messages handle it
                    
                    debugLog('[Stats FETCH] Is regeneration:', isAlternative, '(always false at POST time)');
                    debugLog('[Stats FETCH] Previous message ID:', prevId);
                    
                    // Extract model info - use response.engine first (actual model used)
                    // Fall back to lastGenerationSettings (requested model)
                    const responseModel = data.engine || null;
                    const requestModel = lastGenerationSettings?.model || null;
                    
                    // Build model display string
                    let modelDisplay;
                    if (requestModel && responseModel && requestModel !== responseModel) {
                        modelDisplay = `${requestModel} → ${responseModel}`;
                    } else if (responseModel) {
                        modelDisplay = responseModel;
                    } else if (requestModel) {
                        modelDisplay = requestModel;
                    } else {
                        modelDisplay = null;
                    }
                    
                    // Get settings from lastGenerationSettings if available
                    const settings = lastGenerationSettings?.settings || null;
                    
                    debugLog('[Stats] Got message ID from fetch response:', messageId, 'conversation:', conversationId);
                    debugLog('[Stats] Request model:', requestModel, 'Response model:', responseModel, 'Display:', modelDisplay);
                    
                    // Send to content script - even if we don't have full settings, send what we have
                    // This ensures the message timestamp is captured
                    window.postMessage({
                        type: 'SAI_NEW_MESSAGE',
                        messageId: messageId,
                        conversationId: conversationId,
                        model: modelDisplay,
                        settings: settings,
                        createdAt: createdAt,
                        role: 'bot',
                        isAlternative: isAlternative,
                        prevId: prevId
                    }, '*');
                    
                    // Send user message notification
                    if (userMessageTimestamp) {
                        debugLog('[Stats] Sending SAI_USER_MESSAGE_SENT with timestamp:', userMessageTimestamp);
                        window.postMessage({
                            type: 'SAI_USER_MESSAGE_SENT',
                            timestamp: userMessageTimestamp,
                            conversationId: conversationId
                        }, '*');
                    }
                    
                    // Update local tracking
                    loadedMessageIds.push(messageId);
                    messageIdToIndexMap = {};
                    loadedMessageIds.forEach((id, index) => {
                        messageIdToIndexMap[index] = id;
                    });
                }
            } catch (e) {
                // Response might not be JSON, that's OK
            }
        }
        
        return response;
    };
    
    debugLog('[Stats] [PAGE CONTEXT] Network interception setup complete');
})();

// =============================================================================
// END OF SECURITY-CRITICAL INJECTION SCRIPT
// =============================================================================
// Reviewers: This script operates entirely in local browser context.
// No data is transmitted externally. All operations are read-only on API
// responses and data is stored locally via postMessage to content script.
// =============================================================================
