/**
 * Storage wrapper for browser extension
 * Provides GM_getValue/GM_setValue compatibility using browser.storage.local
 */

// Determine which browser API to use
const storageAPI = typeof browser !== 'undefined' ? browser : chrome;

// Helper to check if extension context is still valid
function isContextValid() {
    try {
        // In Chrome MV3, if the context is invalidated, accessing chrome.runtime will throw
        return !!(storageAPI && storageAPI.runtime && storageAPI.runtime.id);
    } catch (e) {
        return false;
    }
}

// Storage wrapper object
const storage = {
    /**
     * Get a value from storage
     * @param {string} key - Storage key
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {Promise<*>} The stored value or default
     */
    async get(key, defaultValue) {
        try {
            // Check if extension context is still valid
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, returning default value for:', key);
                return defaultValue;
            }
            const result = await storageAPI.storage.local.get({ [key]: defaultValue });
            return result[key];
        } catch (error) {
            // Don't log if it's a context invalidation error (happens during dev reload)
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, returning default value for:', key);
            } else {
                console.error('[Storage] Error getting value:', key, error);
            }
            return defaultValue;
        }
    },

    /**
     * Set a value in storage
     * @param {string} key - Storage key
     * @param {*} value - Value to store
     * @returns {Promise<void>}
     */
    async set(key, value) {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, cannot set:', key);
                return;
            }
            await storageAPI.storage.local.set({ [key]: value });
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, cannot set:', key);
            } else {
                console.error('[Storage] Error setting value:', key, error);
            }
        }
    },

    /**
     * Get multiple values at once
     * @param {Object} keys - Object with key-default pairs
     * @returns {Promise<Object>} Object with stored values
     */
    async getMultiple(keys) {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, returning defaults');
                return keys;
            }
            return await storageAPI.storage.local.get(keys);
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, returning defaults');
            } else {
                console.error('[Storage] Error getting multiple values:', error);
            }
            return keys;
        }
    },

    /**
     * Set multiple values at once
     * @param {Object} items - Object with key-value pairs
     * @returns {Promise<void>}
     */
    async setMultiple(items) {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, cannot set multiple values');
                return;
            }
            await storageAPI.storage.local.set(items);
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, cannot set multiple values');
            } else {
                console.error('[Storage] Error setting multiple values:', error);
            }
        }
    },

    /**
     * Remove a value from storage
     * @param {string} key - Storage key
     * @returns {Promise<void>}
     */
    async remove(key) {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, cannot remove:', key);
                return;
            }
            await storageAPI.storage.local.remove(key);
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, cannot remove:', key);
            } else {
                console.error('[Storage] Error removing value:', key, error);
            }
        }
    },

    /**
     * Clear all storage
     * @returns {Promise<void>}
     */
    async clear() {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, cannot clear storage');
                return;
            }
            await storageAPI.storage.local.clear();
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, cannot clear storage');
            } else {
                console.error('[Storage] Error clearing storage:', error);
            }
        }
    },

    /**
     * Get storage usage statistics
     * @returns {Promise<number>} Bytes in use
     */
    async getBytesInUse() {
        try {
            if (!isContextValid()) {
                console.warn('[Storage] Extension context invalidated, cannot get bytes in use');
                return 0;
            }
            return await storageAPI.storage.local.getBytesInUse();
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Storage] Extension was reloaded, cannot get bytes in use');
            } else {
                console.error('[Storage] Error getting bytes in use:', error);
            }
            return 0;
        }
    },

    /**
     * Listen for storage changes
     * @param {Function} callback - Called when storage changes
     */
    onChanged(callback) {
        storageAPI.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                callback(changes);
            }
        });
    }
};

// Create GM_* compatibility functions for easier migration
function GM_getValue(key, defaultValue) {
    // Return a promise to match async behavior
    return storage.get(key, defaultValue);
}

function GM_setValue(key, value) {
    return storage.set(key, value);
}

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { storage, GM_getValue, GM_setValue };
}
