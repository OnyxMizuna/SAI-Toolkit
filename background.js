/**
 * Background service worker for S.AI Toolkit
 * Handles extension-wide tasks and initialization
 */

// Get storage API (works for both Firefox and Chrome)
const storageAPI = typeof browser !== 'undefined' ? browser : chrome;

// Log extension installation or update
storageAPI.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // Set default values on first install
        storageAPI.storage.local.set({
            'enableSidebarLayout': false,
            'enableThemeCustomization': true,
            'enableHideForYou': true,
            'enablePageJump': true,
            'showGenerationStats': false,
            'timestampDateFirst': true
        });
        
        // First install complete
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