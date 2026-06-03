/**
 * Background service worker for S.AI Toolkit
 * Handles extension-wide tasks and initialization
 */

// Get storage API (works for both Firefox and Chrome)
const storageAPI = typeof browser !== 'undefined' ? browser : chrome;

// Log extension installation or update
storageAPI.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Set default values on first install
        await storageAPI.storage.local.set({
            'enableSidebarLayout': false,
            'enableThemeCustomization': true,
            'enableHideForYou': true,
            'enablePageJump': true,
            'showGenerationStats': false,
            'timestampDateFirst': true,
            'lastSeenVersion': null  // Track for update notifications
        });

        // First install complete
        console.log('[Core] Extension installed');
    } else if (details.reason === 'update') {
        // Extension was updated - set flag to show update notification
        const currentVersion = storageAPI.runtime.getManifest().version;
        console.log('[Core] Extension updated to version:', currentVersion);

        // IMPORTANT: await the storage write to ensure it completes before any content scripts check
        await storageAPI.storage.local.set({
            'showUpdateNotification': true,
            'updatedToVersion': currentVersion
        });
        
        console.log('[Core] Update notification flag set successfully');
    }
});

// Listen for messages from content script
storageAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle different message types
    if (message.type === 'getSettings') {
        // Return current settings
        storageAPI.storage.local.get(null).then(sendResponse);
        return true; // Keep channel open for async response
    }
    
    if (message.type === 'notification') {
        // Could show browser notification here if needed
    }
    
    if (message.type === 'ping') {
        sendResponse({ pong: true });
        return true;
    }
    
    return false;
});

// Background service worker active