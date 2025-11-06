/**
 * Background service worker for S.AI Toolkit
 * Handles extension-wide tasks and initialization
 */

// Get storage API (works for both Firefox and Chrome)
const storageAPI = typeof browser !== 'undefined' ? browser : chrome;

// Log extension installation or update
storageAPI.runtime.onInstalled.addListener((details) => {
    console.log('[S.AI Toolkit] Extension installed/updated:', details.reason);
    
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
        
        // Open welcome page or instructions
        console.log('[S.AI Toolkit] First install - defaults set');
    }
});

// Listen for messages from content script
storageAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[S.AI Toolkit Background] Received message:', message);
    
    // Handle different message types
    if (message.type === 'getSettings') {
        // Return current settings
        storageAPI.storage.local.get(null).then(sendResponse);
        return true; // Keep channel open for async response
    }
    
    if (message.type === 'notification') {
        // Could show browser notification here if needed
        console.log('[S.AI Toolkit] Notification:', message.text);
    }
    
    return false;
});

// Log when extension is running
console.log('[S.AI Toolkit] Background service worker active');
