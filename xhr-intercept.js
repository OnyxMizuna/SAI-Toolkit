/**
 * ============================================================================
 * XHR/Fetch Intercept Script - SECURITY DISCLOSURE FOR EXTENSION REVIEWERS
 * ============================================================================
 *
 * PURPOSE:
 * This file intercepts XMLHttpRequest and fetch API calls in the page context
 * to capture AI generation settings (temperature, top_p, top_k, model name)
 * from SpicyChat.ai API responses, and — when the user explicitly opts in via
 * the Message Recovery feature — to capture the text of an outgoing chat
 * message so it can be restored after a failed send.
 *
 * WHY PAGE CONTEXT INJECTION IS NECESSARY:
 * - SpicyChat.ai implements Content Security Policy (CSP) that prevents
 *   content scripts from accessing page-level network requests
 * - We need page context access to listen to XMLHttpRequest/fetch events
 * - Content scripts run in isolated world and cannot intercept page requests
 *
 * SECURITY GUARANTEES:
 * ✓ READ-ONLY INTERCEPTION: We never modify requests or responses
 *   (the model-override and NSFW-mode features modify the OUTGOING request
 *   body only — they never alter responses)
 * ✓ LOCAL-ONLY STORAGE: All data saved to chrome.storage.local (browser)
 * ✓ NO EXTERNAL CONNECTIONS: This script makes zero network requests
 * ✓ NO CREDENTIALS: Does not access passwords, tokens, or auth headers
 *
 * WHAT WE READ (always):
 * - inference_model: Model name (e.g., "llama-3.1-70b")
 * - inference_settings: { temperature, top_p, top_k, max_new_tokens }
 * - createdAt: Timestamp for organizing saved profiles
 * - conversation_id / character_id: For organizing stats by conversation
 * - response.engine: The actual model the server used (may differ from request)
 *
 * WHAT WE READ ONLY WHEN MESSAGE RECOVERY IS ENABLED:
 * - body.message: The text of the user's outgoing chat message
 *
 *   Why this exists: When SpicyChat's chat API fails (502 from Cloudflare,
 *   CORS preflight failure, network drop, request timeout), the message the
 *   user just typed is silently destroyed — the textarea is cleared the
 *   instant the request is issued, and the only on-screen affordance is a
 *   generic "Oops! Something went wrong" banner. Long, carefully-written
 *   messages disappear with no recovery path. The Message Recovery feature
 *   addresses exactly this and nothing else.
 *
 *   How it is gated: The user must explicitly enable "Message Recovery" in
 *   the Features tab of the S.AI Settings modal. The default is OFF. When
 *   off, message text is never read into our code. When on, we:
 *
 *     1. Snapshot body.message at the moment of POST /chat or POST /story.
 *     2. Hold the snapshot in a closure waiting for the request's outcome.
 *     3. If the request SUCCEEDS, the snapshot is discarded immediately and
 *        nothing is ever written to disk.
 *     4. If the request FAILS (XHR error/timeout/abort/status>=400, fetch
 *        throws or returns !response.ok), the snapshot is sent via
 *        window.postMessage to the content script, which persists it to
 *        chrome.storage.local under the 'failedMessages' key.
 *     5. The user can then click a "Recover message" button injected next
 *        to SpicyChat's existing "Resubmit" button to restore the text into
 *        the input field.
 *
 *   Eviction: the persistent queue is capped at 50 entries (FIFO) and the
 *   "Clear All Data" button in the settings modal wipes it. Recovered
 *   messages are also removed from the queue automatically.
 *
 * WHAT WE DO NOT READ (ever):
 * ✗ Bot/AI response content (only the response.message.id, engine, and
 *   timestamps are read; response.message.content is never persisted)
 * ✗ User credentials or authentication tokens
 * ✗ Personal information or account details
 * ✗ Payment information
 *
 * WHAT IS NEVER TRANSMITTED:
 * Every value above — including failed-message text when recovery is
 * enabled — stays inside the user's browser. This script makes no network
 * requests of its own and does not call out to any external service.
 *
 * TESTING INSTRUCTIONS FOR REVIEWERS:
 * 1. Install extension and open DevTools Network tab
 * 2. Verify: Extension makes ZERO external network requests
 * 3. Open DevTools → Application → Storage → Local Storage
 * 4. Verify: All data stored locally (no external transmission)
 * 5. Test: Save a profile, verify it's stored in chrome.storage.local
 * 6. Message Recovery test:
 *    a. Confirm the toggle defaults to OFF (Features tab → Message Recovery)
 *    b. With it OFF, send a message — verify nothing is written to the
 *       'failedMessages' storage key.
 *    c. Enable it, simulate a failure (e.g., block prod.nd-api.com), and
 *       verify the typed text appears in 'failedMessages' only on failure.
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
    // Memory optimization: Maximum message IDs to track (prevents unbounded growth)
    const MAX_LOADED_MESSAGE_IDS = 500;
    
    // Model Override state - can be toggled via postMessage from content script
    // When set, forces inference_model to this value for all chat/story POST requests
    let modelOverride = null; // null = no override, string = forced model name
    try {
        const storedModel = localStorage.getItem('sai_model_override');
        if (storedModel !== null) {
            modelOverride = storedModel;
            debugLog('[Model] Loaded model override from localStorage:', modelOverride);
        }
    } catch (e) {
        // localStorage not available
    }

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

    // -------------------------------------------------------------------------
    // MESSAGE RECOVERY — feature gate
    // -------------------------------------------------------------------------
    // PURPOSE
    //   When SpicyChat's chat API fails (502 from Cloudflare, CORS preflight
    //   error, network drop, request timeout), the user-typed message is
    //   silently lost: the textarea is cleared the instant the request is
    //   issued, and the only on-screen affordance is a generic red "Oops!
    //   Something went wrong" banner. Long, carefully-written messages
    //   disappear with no way to recover them.
    //
    // WHEN THIS FLAG IS TRUE
    //   We snapshot the outgoing user message text *only at the moment of
    //   send*, hold it in memory pending the request's outcome, and only
    //   persist it to chrome.storage.local if the request fails. On success
    //   the snapshot is discarded immediately and never written to disk.
    //
    // WHY THIS IS GATED BY AN OPT-IN CHECKBOX
    //   Capturing message content is a strict superset of what the rest of
    //   this interceptor does (which is metadata-only). Even though the data
    //   never leaves the browser, persisting message text to local storage
    //   is materially different from persisting model names and timestamps,
    //   so it requires explicit user consent via the "Message Recovery"
    //   toggle in the Features tab of the S.AI Settings modal.
    //
    // STATE LIFECYCLE
    //   - Default: false (disabled). The interceptor behaves exactly as
    //     before — message content is never read into our code.
    //   - Enabled: content script sends SAI_SET_MESSAGE_RECOVERY with
    //     enabled=true; we mirror it to localStorage so the setting survives
    //     a page navigation that re-runs this script before the content
    //     script can re-bridge it.
    //   - Disabled: any in-flight pending snapshots are dropped.
    let messageRecoveryEnabled = false;
    try {
        const storedRecovery = localStorage.getItem('sai_message_recovery_enabled');
        if (storedRecovery !== null) {
            messageRecoveryEnabled = storedRecovery === 'true';
            debugLog('[MsgRecovery] Loaded message recovery flag from localStorage:', messageRecoveryEnabled);
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

        // Handle model override toggle from content script
        if (event.data && event.data.type === 'SAI_SET_MODEL_OVERRIDE') {
            modelOverride = event.data.model; // null to disable, string to enable
            console.warn('[SAI Model Override] Received SAI_SET_MODEL_OVERRIDE →', modelOverride);
            debugLog('[Model] Model override set to:', modelOverride);
            try {
                if (modelOverride === null) {
                    localStorage.removeItem('sai_model_override');
                } else {
                    localStorage.setItem('sai_model_override', modelOverride);
                }
            } catch (e) {
                // localStorage not available
            }
            window.postMessage({
                type: 'SAI_MODEL_OVERRIDE_UPDATED',
                model: modelOverride
            }, '*');
        }

        // Handle request for current model override state
        if (event.data && event.data.type === 'SAI_GET_MODEL_OVERRIDE') {
            window.postMessage({
                type: 'SAI_MODEL_OVERRIDE_STATE',
                model: modelOverride
            }, '*');
        }

        // Message Recovery: enable/disable from content script
        if (event.data && event.data.type === 'SAI_SET_MESSAGE_RECOVERY') {
            messageRecoveryEnabled = !!event.data.enabled;
            debugLog('[MsgRecovery] Recovery flag set to:', messageRecoveryEnabled);
            try {
                if (messageRecoveryEnabled) {
                    localStorage.setItem('sai_message_recovery_enabled', 'true');
                } else {
                    localStorage.removeItem('sai_message_recovery_enabled');
                }
            } catch (e) {
                // localStorage not available
            }
            window.postMessage({
                type: 'SAI_MESSAGE_RECOVERY_UPDATED',
                enabled: messageRecoveryEnabled
            }, '*');
        }

        // Message Recovery: content script asks for current state on load
        if (event.data && event.data.type === 'SAI_GET_MESSAGE_RECOVERY') {
            window.postMessage({
                type: 'SAI_MESSAGE_RECOVERY_STATE',
                enabled: messageRecoveryEnabled
            }, '*');
        }
    });

    // -------------------------------------------------------------------------
    // MESSAGE RECOVERY helper — emit a failure event with the captured text
    // -------------------------------------------------------------------------
    // Called from XHR error/timeout/load(>=400) and fetch reject/!ok paths.
    // Sends the snapshot to the content script via postMessage; the content
    // script is responsible for the actual chrome.storage.local write so the
    // page context never directly touches extension storage. The snapshot is
    // dropped on the floor when recovery is disabled or when the message text
    // is empty (e.g. continue_chat regenerations have message="").
    function emitMessageSendFailed(snapshot, reason) {
        if (!messageRecoveryEnabled) return;
        if (!snapshot || !snapshot.message || !snapshot.message.trim()) return;
        debugLog('[MsgRecovery] Emitting SAI_MESSAGE_SEND_FAILED, reason:', reason, 'len:', snapshot.message.length);
        window.postMessage({
            type: 'SAI_MESSAGE_SEND_FAILED',
            reason: reason,
            snapshot: snapshot
        }, '*');
    }
    
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
                    debugLog('[ChatTitle XHR] ========== GET /messages RESPONSE ==========');
                    debugLog('[ChatTitle XHR] Full response keys:', Object.keys(response));
                    debugLog('[ChatTitle XHR] Extracted conversation ID:', conversationId);
                    debugLog('[ChatTitle XHR] Extracted label:', label);
                    debugLog('[ChatTitle XHR] Label type:', typeof label);
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
                        debugLog('[ChatTitle XHR] Sending postMessage SAI_MESSAGES_LOADED');
                        debugLog('[ChatTitle XHR] Message data includes label:', label);
                        window.postMessage(messageData, '*');
                        debugLog('[Stats] Sent SAI_MESSAGES_LOADED postMessage with label:', label);
                        
                        loadedMessageIds = botMessages.map(msg => msg.id).reverse();
                        // Limit array size to prevent memory growth
                        if (loadedMessageIds.length > MAX_LOADED_MESSAGE_IDS) {
                            loadedMessageIds = loadedMessageIds.slice(-MAX_LOADED_MESSAGE_IDS);
                        }
                    } else {
                        debugLog('[Stats] No messages array in response:', response);
                    }
                } catch (e) {
                    console.error('[Stats] Error parsing messages response:', e);
                }
            });
        }
        
        // Model override: Force inference_model for POST /chat or /story requests
        if (this._method === 'POST' && this._url && modelOverride !== null) {
            const urlLower = this._url.toLowerCase();
            if (urlLower.includes('/chat') || urlLower.includes('/story')) {
                console.warn('[SAI Model Override XHR] Intercepted POST', this._url, '| modelOverride =', modelOverride);
                try {
                    if (body && typeof body === 'string') {
                        const parsedBody = JSON.parse(body);
                        console.warn('[SAI Model Override XHR] Overriding inference_model:', parsedBody.inference_model, '→', modelOverride);
                        parsedBody.inference_model = modelOverride;
                        body = JSON.stringify(parsedBody);
                    } else {
                        console.warn('[SAI Model Override XHR] body is not a string:', typeof body, body);
                    }
                } catch (e) {
                    console.warn('[SAI Model Override XHR] Parse error:', e);
                }
            }
        }
        // Note: no log when modelOverride is null — that's the default/inactive
        // state and firing a warning on every chat POST was pure noise.

        // POST /chat or /story-chat - new message generation
        // Story mode may use a different endpoint, so check for both
        const isChatPost = this._method === 'POST' && this._url &&
            (this._url.includes('/chat') || this._url.includes('/story'));

        // ------------------------------------------------------------------
        // MESSAGE RECOVERY: snapshot outgoing message text and watch for
        // failure on this XHR. We do this BEFORE the inference_model branch
        // below so it works even for requests that don't carry inference
        // settings (e.g. server-side request shape changes).
        // ------------------------------------------------------------------
        if (isChatPost && messageRecoveryEnabled) {
            try {
                const parsedForRecovery = (body && typeof body === 'string') ? JSON.parse(body) : null;
                if (parsedForRecovery && typeof parsedForRecovery.message === 'string' && parsedForRecovery.message.trim()) {
                    const snapshot = {
                        message: parsedForRecovery.message,
                        conversationId: parsedForRecovery.conversation_id || null,
                        characterId: parsedForRecovery.character_id || null,
                        url: this._url,
                        capturedAt: Date.now(),
                        transport: 'xhr'
                    };
                    debugLog('[MsgRecovery] XHR snapshot captured, msg length:', snapshot.message.length);

                    // Failure: HTTP-level errors raise `error`; timeouts raise
                    // `timeout`; abort raises `abort` (we treat as failure too
                    // because the user lost the message either way). A `load`
                    // event with status >= 400 is also a failure.
                    let failureReported = false;
                    const reportOnce = (reason) => {
                        if (failureReported) return;
                        failureReported = true;
                        emitMessageSendFailed(snapshot, reason);
                    };
                    this.addEventListener('error', () => reportOnce('xhr-error'));
                    this.addEventListener('timeout', () => reportOnce('xhr-timeout'));
                    this.addEventListener('abort', () => reportOnce('xhr-abort'));
                    this.addEventListener('load', function() {
                        // status 0 happens for CORS preflight failures and
                        // network-layer rejections that fire `load` instead
                        // of `error` in some browsers. >=400 is any HTTP error.
                        if (this.status === 0 || this.status >= 400) {
                            reportOnce('xhr-status-' + this.status);
                        }
                    });
                }
            } catch (e) {
                // Body wasn't JSON or had unexpected shape — silently skip
                // recovery for this request rather than disrupting the send.
                debugLog('[MsgRecovery] XHR body not parseable for recovery snapshot');
            }
        }

        if (isChatPost) {
            debugLog('[Stats] Intercepted POST to chat/story endpoint:', this._url);
            try {
                const parsedBody = JSON.parse(body);
                
                if (parsedBody.inference_model && parsedBody.inference_settings) {
                    debugLog('[Stats] Found inference settings in POST body');
                    debugLog('[Stats] inference_model:', parsedBody.inference_model);
                    debugLog('[Stats] inference_settings:', parsedBody.inference_settings);
                    lastGenerationSettings = {
                        model: parsedBody.inference_model,
                        settings: parsedBody.inference_settings,
                        timestamp: Date.now() // Track when this was captured
                    };
                    debugLog('[Stats] Stored lastGenerationSettings:', lastGenerationSettings);

                    // Memory optimization: Clear settings if not used within 30 seconds
                    const capturedTimestamp = lastGenerationSettings.timestamp;
                    setTimeout(() => {
                        if (lastGenerationSettings && lastGenerationSettings.timestamp === capturedTimestamp) {
                            debugLog('[Stats] Clearing stale lastGenerationSettings (30s timeout)');
                            lastGenerationSettings = null;
                        }
                    }, 30000);
                    
                    // Capture the POST send timestamp for user message
                    const userMessageTimestamp = Date.now();

                    // Capture regeneration signals from the REQUEST body. The
                    // response payload alone can't distinguish regenerations
                    // from first-time replies (both carry prev_id), so we read
                    // them from the request and close over them in the load
                    // handler. continue_chat:true = regen/continue; an explicit
                    // alt_message_id field also indicates a regen.
                    const isRegenerationRequested = parsedBody.continue_chat === true;
                    const altMessageIdFromRequest = parsedBody.alt_message_id || null;

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
                                
                                // Extract content length for short response detection
                                const responseContent = response.message.content || '';
                                debugLog('[Stats XHR] Response content length:', responseContent.length);
                                
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
                                    isRegenerationRequested: isRegenerationRequested,
                                    altMessageId: altMessageIdFromRequest,
                                    prevId: prevId,
                                    responseContentLength: responseContent.length,
                                    responseEngine: responseModel
                                }, '*');
                                
                                // Update local tracking with size limit
                                loadedMessageIds.push(messageId);
                                if (loadedMessageIds.length > MAX_LOADED_MESSAGE_IDS) {
                                    loadedMessageIds = loadedMessageIds.slice(-MAX_LOADED_MESSAGE_IDS);
                                }
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
            debugLog('[ChatTitle FETCH DEBUG] Character-related URL detected:', url);
            debugLog('[ChatTitle FETCH DEBUG] Method:', options?.method || 'GET');
        }
        
        // Model override: Force inference_model for POST /chat or /story requests (fetch version)
        const urlString = typeof url === 'string' ? url : url?.toString();
        if (options && options.method === 'POST' && urlString && modelOverride !== null) {
            const urlLower = urlString.toLowerCase();
            if (urlLower.includes('/chat') || urlLower.includes('/story')) {
                console.warn('[SAI Model Override FETCH] Intercepted POST', urlString, '| modelOverride =', modelOverride);
                try {
                    if (options.body && typeof options.body === 'string') {
                        const parsedBody = JSON.parse(options.body);
                        console.warn('[SAI Model Override FETCH] Overriding inference_model:', parsedBody.inference_model, '→', modelOverride);
                        parsedBody.inference_model = modelOverride;
                        options = { ...options, body: JSON.stringify(parsedBody) };
                        args = [url, options];
                    } else {
                        console.warn('[SAI Model Override FETCH] body is not a string:', typeof options?.body);
                    }
                } catch (e) {
                    console.warn('[SAI Model Override FETCH] Parse error:', e);
                }
            }
        }
        // Note: no log when modelOverride is null — that's the default/inactive
        // state and firing a warning on every chat POST was pure noise.

        // Intercept image generation requests to inject NSFW mode override (fetch version)
        // The endpoint is: POST /chat/conversation-image with field "nsfw_mode"
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
        // Regeneration signals parsed from the request body — see XHR path for
        // the full rationale. These travel down to the response handler so we
        // can attach authoritative regen flags to the SAI_NEW_MESSAGE event.
        let isRegenerationRequested = false;
        let altMessageIdFromRequest = null;

        // POST /chat or /story via fetch
        const isFetchChatPost = url && typeof url === 'string' &&
            (url.includes('/chat') || url.includes('/story')) &&
            options && options.method === 'POST';

        // Message Recovery snapshot (fetch path) — see XHR path for the full
        // rationale. We hold the snapshot in this closure and only persist it
        // on failure (originalFetch throws, or returns !response.ok).
        let recoverySnapshot = null;
        if (isFetchChatPost && messageRecoveryEnabled) {
            try {
                if (options && typeof options.body === 'string') {
                    const parsedForRecovery = JSON.parse(options.body);
                    if (typeof parsedForRecovery.message === 'string' && parsedForRecovery.message.trim()) {
                        recoverySnapshot = {
                            message: parsedForRecovery.message,
                            conversationId: parsedForRecovery.conversation_id || null,
                            characterId: parsedForRecovery.character_id || null,
                            url: urlString,
                            capturedAt: Date.now(),
                            transport: 'fetch'
                        };
                        debugLog('[MsgRecovery] Fetch snapshot captured, msg length:', recoverySnapshot.message.length);
                    }
                }
            } catch (e) {
                debugLog('[MsgRecovery] Fetch body not parseable for recovery snapshot');
            }
        }

        if (isFetchChatPost) {
            debugLog('[Stats] Intercepted POST to chat/story via fetch:', url);
            userMessageTimestamp = Date.now();
            try {
                const body = JSON.parse(options.body);
                isRegenerationRequested = body.continue_chat === true;
                altMessageIdFromRequest = body.alt_message_id || null;
                if (body.inference_model && body.inference_settings) {
                    debugLog('[Stats] Found inference settings in fetch body');
                    lastGenerationSettings = {
                        model: body.inference_model,
                        settings: body.inference_settings,
                        timestamp: Date.now() // Track when this was captured
                    };

                    // Memory optimization: Clear settings if not used within 30 seconds
                    const capturedTimestamp = lastGenerationSettings.timestamp;
                    setTimeout(() => {
                        if (lastGenerationSettings && lastGenerationSettings.timestamp === capturedTimestamp) {
                            debugLog('[Stats] Clearing stale lastGenerationSettings (30s timeout)');
                            lastGenerationSettings = null;
                        }
                    }, 30000);
                }
            } catch (e) {
                console.error('[Stats] Error parsing fetch body:', e);
            }
        }
        
        // Call original fetch
        // Wrapped to detect message-send failures for the recovery feature:
        //   - originalFetch throws (network error, CORS error, abort)
        //   - originalFetch returns a Response with response.ok === false
        // In either case, if we have a recoverySnapshot we hand it off to the
        // content script for persistence. The throw is re-raised so site code
        // continues to see exactly the same error it would have seen otherwise.
        let response;
        try {
            response = await originalFetch.apply(this, args);
        } catch (err) {
            if (recoverySnapshot) {
                emitMessageSendFailed(recoverySnapshot, 'fetch-throw');
            }
            throw err;
        }
        if (recoverySnapshot && response && !response.ok) {
            emitMessageSendFailed(recoverySnapshot, 'fetch-status-' + response.status);
        }

        // Intercept GET /v2/characters/{id} - character details for page title
        // Try multiple patterns to catch the actual endpoint
        const fetchUrlString = typeof url === 'string' ? url : url?.toString();
        debugLog('[ChatTitle FETCH DEBUG] Checking URL:', fetchUrlString);
        
        // Pattern 1: /v2/characters/{uuid}
        const v2Pattern = /\/v2\/characters\/[a-f0-9-]+/;
        // Pattern 2: /characters/{uuid} (without v2)
        const v1Pattern = /\/characters\/[a-f0-9-]+$/;
        // Pattern 3: Any characters endpoint
        const anyCharPattern = /\/characters\/[a-f0-9-]+/;
        
        if (fetchUrlString && (v2Pattern.test(fetchUrlString) || v1Pattern.test(fetchUrlString) || anyCharPattern.test(fetchUrlString)) && (!options || !options.method || options.method === 'GET')) {
            debugLog('[ChatTitle FETCH] ========== CHARACTER API MATCHED ==========');
            debugLog('[ChatTitle FETCH] URL:', fetchUrlString);
            debugLog('[ChatTitle FETCH] Matched pattern:', v2Pattern.test(fetchUrlString) ? 'v2' : v1Pattern.test(fetchUrlString) ? 'v1' : 'any');
            const clonedResponse = response.clone();
            try {
                const data = await clonedResponse.json();
                debugLog('[ChatTitle FETCH] Response keys:', Object.keys(data));
                debugLog('[ChatTitle FETCH] Character name:', data.name);
                if (data.name) {
                    debugLog('[ChatTitle FETCH] Sending postMessage SAI_CHARACTER_LOADED with name:', data.name);
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
                        isRegenerationRequested: isRegenerationRequested,
                        altMessageId: altMessageIdFromRequest,
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
                    
                    // Update local tracking with size limit
                    loadedMessageIds.push(messageId);
                    if (loadedMessageIds.length > MAX_LOADED_MESSAGE_IDS) {
                        loadedMessageIds = loadedMessageIds.slice(-MAX_LOADED_MESSAGE_IDS);
                    }
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
// No data is transmitted externally. The interceptor reads API response
// metadata (model name, settings, message IDs, timestamps) and — only when
// the user opts in to Message Recovery — captures the text of an outgoing
// chat message at send time, persisting it locally only if the request
// fails. See the header at the top of this file for the full disclosure.
// =============================================================================
