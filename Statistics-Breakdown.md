# Step-by-Step Breakdown: Inference Statistics Collection, Storage, and Display

## Overview
The S.AI Toolkit collects generation/inference statistics by intercepting API calls to SpicyChat's backend, storing them with message IDs, and displaying them beneath messages in the chat interface.

---

## Part 1: API Interception & Data Collection

### 1.1 XHR Intercept Injection (Early Phase)

**Location:** content.js lines 889-4080 (within `initializeMainCode()` function)

The script uses a separate injected file to intercept XHR requests:

```javascript
// From content.js (not shown in diff but present in file structure)
// xhr-intercept.js is loaded via manifest.json content_scripts
```

**Source:** The interception happens through `xhr-intercept.js` (referenced in manifest but code implementation not visible in provided context).

### 1.2 Message Response Capture

**Location:** content.js lines 1183-1285

When the API responds with a new bot message, the script captures:

```javascript
// API endpoint being monitored
const url = details.url;
if (url.includes('/api/') && url.includes('/message')) {
    // Capture response data
}
```

The script listens for POST requests to message endpoints and extracts:
- Message ID
- Generation settings (temperature, top_p, top_k, max_new_tokens)
- Model name
- Timestamp (createdAt)

**Key data structure captured:**
```javascript
{
    messageId: "string",
    settings: {
        temperature: number,
        top_p: number,
        top_k: number,
        max_new_tokens: number
    },
    model: "string",
    createdAt: timestamp
}
```

---

## Part 2: Storage Architecture

### 2.1 Storage Structure

**Location:** content.js lines 1010-1030 (getStatsForMessage function)

The statistics are stored in a hierarchical structure:

```javascript
{
    [characterId]: {
        [conversationId]: {
            [messageId]: {
                settings: {...},
                model: "...",
                createdAt: timestamp
            }
        }
    }
}
```

**Source:** Lines 1065-1107 show the `storeStatsForMessage()` function:

```javascript
async function storeStatsForMessage(messageId, stats, explicitConversationId = null) {
    const messageStats = await loadMessageStats();
    const characterId = getCurrentCharacterId();
    let conversationId = explicitConversationId || currentConversationId || getCurrentConversationId();
    
    if (!conversationId) {
        conversationId = '_default';
    }
    
    // Initialize nested structure
    if (!messageStats[characterId]) {
        messageStats[characterId] = {};
    }
    if (!messageStats[characterId][conversationId]) {
        messageStats[characterId][conversationId] = {};
    }
    
    // Store stats for this message
    messageStats[characterId][conversationId][messageId] = stats;
    
    await saveMessageStats(messageStats);
}
```

### 2.2 Storage Mechanism

**Location:** content.js lines 999-1006

The script uses browser extension storage (chrome.storage.local):

```javascript
// Load message stats from storage
async function loadMessageStats() {
    const result = await storage.get(MESSAGE_STATS_KEY, '{}');
    return typeof result === 'string' ? JSON.parse(result) : result;
}

// Save message stats to storage
async function saveMessageStats(messageStats) {
    await storage.set(MESSAGE_STATS_KEY, JSON.stringify(messageStats));
}
```

**Storage Key:** `'messageGenerationStats'` (defined as `MESSAGE_STATS_KEY` at line 935)

---

## Part 3: Message ID Extraction & Mapping

### 3.1 DOM-Based Message ID Extraction

**Location:** content.js lines 1111-1162 (`extractMessageId()` function)

The script attempts multiple methods to extract message IDs from the DOM:

**Method 1: React Fiber Properties**
```javascript
function extractMessageId(container) {
    // Try to get React internal props
    const fiberKey = Object.keys(container).find(key => 
        key.startsWith('__reactFiber') || 
        key.startsWith('__reactInternalInstance')
    );
    
    if (fiberKey) {
        const fiber = container[fiberKey];
        // Navigate fiber tree to find message data
        let current = fiber;
        while (current) {
            const props = current.memoizedProps || current.pendingProps;
            if (props?.message?.id) {
                return props.message.id;
            }
            current = current.return;
        }
    }
}
```

**Method 2: Button Aria-Label Parsing**
```javascript
// Look for Copy/Edit buttons with message IDs in aria-labels
const copyButton = container.querySelector('button[aria-label*="Copy-button-"]');
if (copyButton) {
    const ariaLabel = copyButton.getAttribute('aria-label');
    const match = ariaLabel.match(/Copy-button-([a-zA-Z0-9-]+)/);
    if (match) return match[1];
}
```

**Method 3: Fallback to Index Map**
```javascript
// If direct extraction fails, use sequential index
if (messageIdToIndexMap[botMessageIndex] !== undefined) {
    messageId = messageIdToIndexMap[botMessageIndex];
}
```

### 3.2 Index Map Building

**Location:** content.js lines 945-995 (`buildIndexMapFromStats()` function)

When messages are loaded from storage, the script builds an index map:

```javascript
async function buildIndexMapFromStats() {
    const messageStats = await loadMessageStats();
    const characterId = getCurrentCharacterId();
    const conversationId = currentConversationId || getCurrentConversationId() || '_default';
    
    let messageIds = [];
    if (characterId && messageStats[characterId]?.[conversationId]) {
        messageIds = Object.keys(messageStats[characterId][conversationId]);
    }
    
    // Sort by timestamp
    const sortedIds = messageIds.sort((a, b) => {
        const statsA = messageStats[characterId][conversationId][a];
        const statsB = messageStats[characterId][conversationId][b];
        return (statsA?.createdAt || 0) - (statsB?.createdAt || 0);
    });
    
    // Build sequential index map
    sortedIds.forEach((id, index) => {
        messageIdToIndexMap[index] = id;
    });
}
```

---

## Part 4: Statistics Retrieval

### 4.1 Retrieval Function

**Location:** content.js lines 1010-1030

```javascript
async function getStatsForMessage(messageId) {
    const messageStats = await loadMessageStats();
    const characterId = getCurrentCharacterId();
    const conversationId = currentConversationId || getCurrentConversationId() || '_default';
    
    if (!characterId || !conversationId) return null;
    
    return messageStats[characterId]?.[conversationId]?.[messageId] || null;
}
```

### 4.2 Character & Conversation ID Extraction

**Location:** content.js lines 1034-1060

**Character ID from URL:**
```javascript
function getCurrentCharacterId() {
    const url = window.location.href;
    
    // Match /c/CHARACTER_ID or /chatbot/CHARACTER_ID
    const chatbotMatch = url.match(/\/(?:c|chatbot)\/([a-zA-Z0-9-]+)/);
    if (chatbotMatch) return chatbotMatch[1];
    
    // Match /chat/CHARACTER_ID
    const chatMatch = url.match(/\/chat\/([a-zA-Z0-9-]+)/);
    if (chatMatch) return chatMatch[1];
    
    return null;
}
```

**Conversation ID from URL:**
```javascript
function getCurrentConversationId() {
    const url = window.location.href;
    const match = url.match(/[?&]conversation=([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
}
```

---

## Part 5: Display in UI

### 5.1 Display Enablement Check

**Location:** Throughout content.js - feature controlled by setting

```javascript
const statsEnabled = await storage.get('showGenerationStats', false);
if (!statsEnabled) return; // Skip processing
```

### 5.2 Message Observer

**Location:** content.js lines 3700+ (messageObserver)

A MutationObserver monitors the DOM for new messages:

```javascript
const messageObserver = new MutationObserver(function(mutations) {
    const statsEnabled = await storage.get('showGenerationStats', false);
    if (!statsEnabled) return;
    
    // Debounce to avoid excessive processing
    clearTimeout(messageObserver.debounceTimer);
    messageObserver.debounceTimer = setTimeout(() => {
        processMessagesForStats();
    }, 100);
});

messageObserver.observe(document.body, {
    childList: true,
    subtree: true
});
```

### 5.3 Message Processing & Stats Injection

**Location:** Process described in observer callbacks (estimated lines 3700-3900)

For each message wrapper (`div.w-full.flex.mb-lg`):

**Step 1: Identify Message Type**
```javascript
const characterLink = wrapper.querySelector('a[href^="/chatbot/"]');
const isBotMessage = !!characterLink;
```

**Step 2: Check if Stats Already Added**
```javascript
const actionContainer = wrapper.querySelector('.flex.justify-between.items-center');
if (actionContainer.querySelector('.generation-stats')) {
    return; // Already has stats, skip
}
```

**Step 3: Retrieve Stats**
```javascript
let messageId = extractMessageId(wrapper);
let generationStats = messageId ? await getStatsForMessage(messageId) : null;

// Fallback mechanisms
if (!generationStats && pendingMessageStats) {
    generationStats = pendingMessageStats;
}
if (!generationStats && lastGenerationSettings) {
    generationStats = lastGenerationSettings;
}
```

**Step 4: Format & Display**

**For Bot Messages:**
```javascript
const statsDiv = document.createElement('div');
statsDiv.className = 'generation-stats';
statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';

if (generationStats.settings && generationStats.model) {
    const settings = generationStats.settings;
    const statsText = `${generationStats.model} <br> Tokens: ${settings.max_new_tokens} | Temp: ${settings.temperature.toFixed(2)} | Top-P: ${settings.top_p} | Top-K: ${settings.top_k}`;
    const timestamp = formatTimestamp(generationStats.createdAt);
    statsDiv.innerHTML = `${statsText}<br>${timestamp}`;
}

// Insert before menu button
const menuButtonContainer = actionContainer.querySelector('.relative');
if (menuButtonContainer) {
    actionContainer.insertBefore(statsDiv, menuButtonContainer);
}
```

**For User Messages:**
```javascript
// Only show timestamp for user messages
const statsDiv = document.createElement('div');
statsDiv.className = 'generation-stats';
statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right;';

const timestamp = formatTimestamp(generationStats?.createdAt);
statsDiv.innerHTML = timestamp;

// Insert before menu button
const menuButtonContainer = actionContainer.querySelector('.relative');
if (menuButtonContainer) {
    actionContainer.insertBefore(statsDiv, menuButtonContainer);
}
```

### 5.4 Timestamp Formatting

**Location:** Not explicitly shown in provided diff, but referenced in display code

The `formatTimestamp()` function formats timestamps based on user preference:

```javascript
// User can toggle between "date@time" or "time@date" format
const timestampDateFirst = await storage.get('timestampDateFirst', true);

function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString();
    
    return timestampDateFirst ? `${dateStr} @ ${timeStr}` : `${timeStr} @ ${dateStr}`;
}
```

### 5.5 Periodic Refresh

**Location:** Referenced in observer setup

The script runs periodic checks to ensure stats are displayed even if mutations are missed:

```javascript
setInterval(() => {
    const statsEnabled = await storage.get('showGenerationStats', false);
    if (statsEnabled) {
        processMessagesForStats();
    }
}, 2000); // Check every 2 seconds
```

---

## Part 6: Fallback & Edge Cases

### 6.1 Pending Stats

**Location:** Line 935

```javascript
let pendingMessageStats = null; // Temporary storage for new messages
```

When a new message is generated but hasn't appeared in DOM yet, stats are stored in `pendingMessageStats` temporarily.

### 6.2 Last Generation Settings

**Location:** Line 934

```javascript
let lastGenerationSettings = null; // Fallback for messages without stored stats
```

The most recent generation settings are kept as a fallback if message-specific stats aren't found.

### 6.3 API-Based Message Loading

**Location:** Lines 950-995

When messages are loaded via API (GET /messages), the script:
1. Captures all message IDs from the response
2. Stores them in `loadedMessageIds` array
3. Builds the `messageIdToIndexMap` for sequential lookups

---

## Summary Flow Diagram

```
1. User sends message → API Request
2. XHR Intercept captures request/response
3. Extract: messageId, settings, model, timestamp
4. Store in hierarchy: characterId → conversationId → messageId → stats
5. Save to chrome.storage.local

--- Later, when displaying ---

6. MutationObserver detects new/existing messages
7. For each message:
   a. Extract messageId (React Fiber, DOM, or index)
   b. Retrieve stats from storage
   c. Format stats (model, tokens, temp, etc.)
   d. Create div with stats
   e. Insert into message action container
8. Repeat on DOM changes or every 2 seconds
```

---

## Key Files Referenced

- **content.js**: Main logic (lines 889-4080)
- **xhr-intercept.js**: API interception (referenced but not detailed in diff)
- **storage-wrapper.js**: Storage abstraction layer
- **manifest.json**: Permissions for storage and content scripts

---

This system ensures that every bot message displays its generation parameters and timestamp, while user messages show only timestamps, providing transparency into the AI's inference settings for each response.
