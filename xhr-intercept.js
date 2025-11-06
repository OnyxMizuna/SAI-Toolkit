/**
 * XHR/Fetch Intercept Script - Runs in page context to capture API calls
 * This MUST run at document_start to catch the initial GET /messages call
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
                    
                    // Extract conversation_id from response
                    const conversationId = response.conversation_id || response.chat_id || response.id || null;
                    debugLog('[Stats] Extracted conversation ID:', conversationId);
                    
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
                        
                        // Send data to content script
                        window.postMessage({
                            type: 'SAI_MESSAGES_LOADED',
                            conversationId: conversationId, // Include conversation ID
                            botMessages: botMessages.map(msg => ({
                                id: msg.id,
                                createdAt: msg.createdAt,
                                inference_model: msg.inference_model,
                                inference_settings: msg.inference_settings
                            })),
                            userMessages: userMessages.map(msg => ({
                                id: msg.id,
                                createdAt: msg.createdAt
                            }))
                        }, '*');
                        debugLog('[Stats] Sent SAI_MESSAGES_LOADED postMessage');
                        
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
                    
                    // Listen for the response
                    this.addEventListener('load', function() {
                        debugLog('[Stats] POST response received');
                        try {
                            const response = JSON.parse(this.responseText);
                            debugLog('[Stats] POST response structure - top-level keys:', Object.keys(response));
                            if (response.message) {
                                debugLog('[Stats] response.message keys:', Object.keys(response.message));
                            }
                            
                            if (response.message && response.message.id) {
                                const messageId = response.message.id;
                                const createdAt = response.message.createdAt || response.message.created_at || null;
                                const conversationId = response.message.conversation_id || response.message.chat_id || response.chat_id || response.conversation_id || null;
                                debugLog('[Stats] Got message ID from response:', messageId, 'conversation:', conversationId);
                                debugLog('[Stats] About to send postMessage with model:', lastGenerationSettings.model);
                                debugLog('[Stats] About to send postMessage with settings:', lastGenerationSettings.settings);
                                
                                // Send to content script
                                window.postMessage({
                                    type: 'SAI_NEW_MESSAGE',
                                    messageId: messageId,
                                    conversationId: conversationId,
                                    model: lastGenerationSettings.model,
                                    settings: lastGenerationSettings.settings,
                                    createdAt: createdAt
                                }, '*');
                                
                                // Update local tracking
                                loadedMessageIds.push(messageId);
                                messageIdToIndexMap = {};
                                loadedMessageIds.forEach((id, index) => {
                                    messageIdToIndexMap[index] = id;
                                });
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
    
    // Also intercept fetch as backup
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const [url, options] = args;
        
        debugLog('[Stats] Fetch intercepted:', typeof url === 'string' ? url : url?.toString(), options?.method || 'GET');
        
        // POST /chat via fetch
        if (url && typeof url === 'string' && url.includes('/chat') && options && options.method === 'POST') {
            debugLog('[Stats] Intercepted POST to /chat via fetch');
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
        
        // Check response for message ID
        if (url && typeof url === 'string' && url.includes('/chat')) {
            const clonedResponse = response.clone();
            try {
                const data = await clonedResponse.json();
                
                if (data.message && data.message.id && lastGenerationSettings) {
                    const messageId = data.message.id;
                    const createdAt = data.message.createdAt || data.message.created_at || null;
                    debugLog('[Stats] Got message ID from fetch response:', messageId);
                    
                    // Send to content script
                    window.postMessage({
                        type: 'SAI_NEW_MESSAGE',
                        messageId: messageId,
                        model: lastGenerationSettings.model,
                        settings: lastGenerationSettings.settings,
                        createdAt: createdAt
                    }, '*');
                    
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
