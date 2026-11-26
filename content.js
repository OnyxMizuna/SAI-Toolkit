/**
 * ============================================================================
 * S.AI Toolkit - Browser Extension Content Script
 * ============================================================================
 * 
 * SECURITY DISCLOSURE FOR EXTENSION REVIEWERS:
 * 
 * This extension enhances SpicyChat.ai with local-only features including
 * generation profile management, UI customization, and statistics tracking.
 * 
 * KEY SECURITY POINTS:
 * ✓ ALL DATA STORED LOCALLY: Uses chrome.storage.local exclusively
 * ✓ NO EXTERNAL SERVERS: Extension makes zero requests to external domains
 * ✓ NO DATA TRANSMISSION: All processing happens in user's browser
 * ✓ OPEN SOURCE: Full code available for review on GitHub
 * 
 * PERMISSIONS JUSTIFICATION:
 * - storage: Required to save user profiles and settings locally
 * - unlimitedStorage: User may save many profiles over time
 * - spicychat.ai host access: Required to inject UI enhancements and read
 *   AI generation settings from page
 * 
 * PAGE CONTEXT INJECTION (See detailed notes in xhr-intercept.js):
 * This extension injects scripts into page context to read AI model settings
 * from network responses. This is necessary due to Content Security Policy
 * preventing content scripts from accessing page-level network calls.
 * Injection is READ-ONLY and LOCAL-ONLY (no external transmission).
 * 
 * TESTING CHECKLIST FOR REVIEWERS:
 * □ Verify no external network requests in DevTools Network tab
 * □ Verify all data in chrome.storage.local (Application → Storage)
 * □ Verify injected scripts are bundled (not remote)
 * □ Verify no modification of network requests/responses
 * □ Test profile save/load functionality (stays local)
 * 
 * PROJECT INFO:
 * Repository: https://github.com/CLedebur/Spicychat.ai-Mods
 * License: Open source for transparency and security audit
 * 
 * ============================================================================
 */

/**
 * S.AI Toolkit - Browser Extension Content Script
 * Converted from Tampermonkey userscript
 * 
 * Features:
 * - Generation Settings Profiles (save/load/manage)
 * - Sidebar Layout (pin modals to right side)
 * - Classic Theme Customization
 * - Hide "For You" Characters
 * - Page Jump Modal
 * - Generation Stats Display
 * 
 * Testing the onboarding flow:
 * Run in browser console: resetSAIToolkitOnboarding()
 * Then reload the page to see the onboarding modal again.
 */

// Debug mode - set to true to enable console logging for all operations
// Can be toggled at runtime via easter egg (shift+click version text in settings)
// Persists between sessions via storage
let DEBUG_MODE = false;

// Load DEBUG_MODE from storage (async, but we start with false and update when ready)
// This ensures debug logging works immediately if it was previously enabled
if (typeof storage !== 'undefined') {
    storage.get('debugMode', false).then(savedDebugMode => {
        DEBUG_MODE = savedDebugMode;
        if (DEBUG_MODE) {
            console.log('[Core] 🐛 Debug mode loaded from storage (ENABLED)');
            window.__SAI_DEBUG_MODE__ = true;
        }
    }).catch(() => {
        // Storage not ready yet, keep default
    });
}

// Debug log category filters - controls which log categories are shown
// Categories: Core, Stats, Memories, Export, NSFW, ChatTitle, Profile, Model, Cache, Migration, Custom, Compact, Sync, AutoRegen, MsgRecovery
let debugLogFilters = {
    Core: true,
    Stats: true,
    Memories: true,
    Export: true,
    NSFW: true,
    ChatTitle: true,
    Profile: true,
    Model: true,
    Cache: true,
    Migration: true,
    Custom: true,
    Compact: true,
    Sync: true,
    AutoRegen: true,
    MsgRecovery: true
};

// Track sidebar width to detect transitions - prevents injection during React re-renders
let lastKnownSidebarWidth = null;
let sidebarWidthTransitionPending = false;

// Drive auth error state — set when auto-sync detects an expired token
let driveAuthErrorMessage = null;

// Callback to push sync progress updates into the settings modal UI when it's open
let syncProgressCallback = null;

// Load debug filters from storage
if (typeof storage !== 'undefined' && storage.get) {
    storage.get('debugLogFilters').then(filters => {
        if (filters && typeof filters === 'object') {
            debugLogFilters = { ...debugLogFilters, ...filters };
        }
    }).catch(() => {});
}

// Keep the in-memory debug filters in sync with storage. On WebKit/Orion the per-checkbox
// change/click handlers are unreliable, so the authoritative path is: Save & Refresh writes
// debugLogFilters to storage (see the save handler) and this listener mirrors it straight
// into the live object debugLog() reads — independent of DOM events AND of the document_start
// load race above. This is what makes a disabled category actually stop logging on iOS.
try {
    const _storageEvtAPI = (typeof browser !== 'undefined' ? browser : chrome);
    if (_storageEvtAPI && _storageEvtAPI.storage && _storageEvtAPI.storage.onChanged) {
        _storageEvtAPI.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.debugLogFilters && changes.debugLogFilters.newValue
                && typeof changes.debugLogFilters.newValue === 'object') {
                debugLogFilters = { ...debugLogFilters, ...changes.debugLogFilters.newValue };
            }
        });
    }
} catch (_) {}

// Helper to extract category from log message
function getLogCategory(message) {
    if (typeof message !== 'string') return null;
    const match = message.match(/^\[([^\]]+)\]/);
    if (!match) return null;
    
    const fullCategory = match[1];
    // Map sub-categories to main categories
    if (fullCategory.startsWith('Stats')) return 'Stats';
    if (fullCategory.startsWith('ChatTitle')) return 'ChatTitle';
    if (fullCategory.startsWith('Memories')) return 'Memories';
    if (fullCategory === 'Profile Controls') return 'Profile';
    if (fullCategory === 'Change Model' || fullCategory === 'Model Change') return 'Model';
    if (fullCategory === 'Custom Style') return 'Custom';
    if (fullCategory === 'Compact') return 'Compact';
    if (fullCategory === 'Sync' || fullCategory === 'Drive Sync') return 'Sync';

    return fullCategory;
}

// Production-safe debug logging helper - sanitizes sensitive data
function debugLog(...args) {
    if (DEBUG_MODE) {
        // Check category filter - first arg usually contains [Category]
        const firstArg = args[0];
        const category = getLogCategory(firstArg);
        if (category && debugLogFilters[category] === false) {
            return; // Skip this log category
        }
        
        // Sanitize arguments to prevent logging sensitive data
        const sanitized = args.map(arg => {
            if (typeof arg === 'string') {
                // Redact potential auth tokens
                return arg.replace(/Bearer\s+[A-Za-z0-9-_]+/gi, 'Bearer [REDACTED]')
                          .replace(/token["']?:\s*["']?[A-Za-z0-9-_]+/gi, 'token: [REDACTED]');
            }
            if (typeof arg === 'object' && arg !== null) {
                // Create shallow copy to avoid modifying original
                const copy = Array.isArray(arg) ? [...arg] : { ...arg };
                // Redact common sensitive fields
                const sensitiveFields = ['token', 'authorization', 'auth', 'password', 'secret', 'apiKey'];
                for (const field of sensitiveFields) {
                    if (copy[field]) copy[field] = '[REDACTED]';
                }
                return copy;
            }
            return arg;
        });
        // The message already carries its own [Category] prefix, so log it as-is —
        // that's what the category filter and the console reader key off of. Only
        // stamp the default [Core] namespace on genuinely uncategorized logs.
        // (Previously every line was hard-prefixed '[Core]', which mislabeled
        // Stats/Model/Export/NSFW/etc. as "Core" in the console.)
        if (category) {
            console.log(...sanitized);
        } else {
            console.log('[Core]', ...sanitized);
        }
    }
}

// Production console.log wrapper - only logs in DEBUG_MODE
const prodLog = (...args) => {
    if (DEBUG_MODE) {
        console.log(...args);
    }
}

// Prevent duplicate initialization if script is injected multiple times
if (window.__saiToolkitLoaded) {
    debugLog('[Core] Already loaded, skipping duplicate initialization');
} else {
    window.__saiToolkitLoaded = true;
}

// Listen for ping from background script to confirm content script is running
const runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;

// Merge-window heartbeat (Orion/iOS). The background asks us (BEGIN) to ping it while it runs a
// message-silent IndexedDB merge, during which the OS would otherwise suspend it — freezing its
// event loop AND its watchdog timers (the "Merging data…" stall that previously only a manual page
// refresh could break). This content script stays alive in the foreground, so an incoming ping every
// 500ms keeps the background scheduled to completion. Driven by a BEGIN/END handshake so it covers
// EVERY background merge (manual sync, auto-sync, restore, import), independent of the settings modal.
let _mergeHeartbeatTimer = null;
let _mergeHeartbeatStopAt = 0;
function startMergeHeartbeat() {
    _mergeHeartbeatStopAt = Date.now() + 120000; // safety: never ping forever if END is lost (bg died)
    if (_mergeHeartbeatTimer) return;
    const ping = () => {
        if (Date.now() > _mergeHeartbeatStopAt) { stopMergeHeartbeat(); return; }
        try { runtimeAPI.runtime.sendMessage({ type: 'SAI_KEEPALIVE_PING' }, () => { void runtimeAPI.runtime.lastError; }); } catch (_) {}
    };
    ping(); // immediate first wake — no gap at merge start
    _mergeHeartbeatTimer = setInterval(ping, 500);
}
function stopMergeHeartbeat() {
    if (_mergeHeartbeatTimer) { clearInterval(_mergeHeartbeatTimer); _mergeHeartbeatTimer = null; }
}

if (runtimeAPI && runtimeAPI.runtime && runtimeAPI.runtime.onMessage) {
    runtimeAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'ping') {
            sendResponse({ pong: true });
            return true;
        }
        if (message.type === 'SAI_MERGE_HEARTBEAT_BEGIN') {
            startMergeHeartbeat();
            sendResponse({ ok: true });
            return true;
        }
        if (message.type === 'SAI_MERGE_HEARTBEAT_END') {
            stopMergeHeartbeat();
            sendResponse({ ok: true });
            return true;
        }
    });
}

// ---------------------------------------------------------------------------
// Stats store RPC — content <-> background messaging for the IndexedDB stats
// store. The store lives at the EXTENSION origin (owned by background.js);
// content scripts run at the page origin and cannot open it, so every stats
// read/write goes through these messages. Modeled on sendDriveMessage: one
// retry on the MV3 service-worker "Could not establish connection" cold start.
// Defined at module scope so both the page-context debug bridge (below) and the
// IIFE stats engine can call it.
// ---------------------------------------------------------------------------
// Settles with an error after `ms`, so a call whose other side froze can't hang
// the caller forever. (The original promise is left to settle on its own.)
function withTimeout(promise, ms, label) {
    if (!ms) return promise;
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + ' ms')), ms); })
    ]).finally(() => clearTimeout(timer));
}

// timeoutMs: optional time limit. Orion can SUSPEND the background page mid-call:
// the reply then never arrives and the background's own timers are frozen too, so
// only this (foreground) side can give up. Large one-off ops (export, import merge)
// pass no limit because they can legitimately take a while.
function sendStatsMessage(type, payload, _retries = 1, timeoutMs = 0) {
    const call = new Promise((resolve, reject) => {
        try {
            runtimeAPI.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
                const err = runtimeAPI.runtime.lastError;
                if (err) {
                    if (_retries > 0 && err.message && err.message.includes('Could not establish connection')) {
                        setTimeout(() => sendStatsMessage(type, payload, _retries - 1).then(resolve).catch(reject), 300);
                    } else {
                        reject(new Error(err.message));
                    }
                } else {
                    resolve(res);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
    return withTimeout(call, timeoutMs, type);
}

// ---------------------------------------------------------------------------
// Stats holding list (write-ahead) — survives a dead or frozen background page.
// Orion on iOS unloads or SUSPENDS the background page when the app is
// backgrounded. A suspended page never answers at all, so "fall back when the
// save fails" isn't enough: the save just hangs and the record is lost with the
// tab. So every record is written HERE FIRST (storage.local, served by the
// browser, no background page needed) as { [messageId]: record }, then sent to
// the background, and removed only once the background confirms. Anything left
// is retried on load, periodically, when the tab returns to the foreground, and
// after any confirmed save. Replaying is safe to repeat: the store merges by
// messageId (idbMergePut).
// ---------------------------------------------------------------------------
const STATS_HOLD_KEY = 'pendingStatsRecords';
const STATS_HOLD_MAX = 2000;          // oldest are dropped beyond this (~300 KB worst case)
const STATS_RECORD_FIELDS = ['model', 'max_tokens', 'temperature', 'top_p', 'top_k', 'role'];
const STATS_PUT_TIMEOUT_MS = 8000;    // background must confirm a save within this
const STATS_READ_TIMEOUT_MS = 8000;   // ...and answer a display read within this
const STATS_HOLD_IO_TIMEOUT_MS = 5000;
const STATS_HOLD_RETRY_MS = 60000;
let _heldStatsMayExist = true;        // unknown until first read
let _heldStatsFlushing = null;

// Every read-modify-write of the holding list goes through this chain, so a save
// and a flush running at the same time can't overwrite each other's update.
// (Two TABS saving in the same instant can still race; that window is tiny.)
let _heldStatsLock = Promise.resolve();
function withHeldStatsLock(fn) {
    const run = _heldStatsLock.catch(() => {}).then(fn);
    _heldStatsLock = run.catch(() => {});
    return run;
}

async function readHeldStats() {
    try {
        const got = await withTimeout(runtimeAPI.storage.local.get(STATS_HOLD_KEY), STATS_HOLD_IO_TIMEOUT_MS, 'holding list read');
        const v = got && got[STATS_HOLD_KEY];
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (_) {
        return {};
    }
}

async function writeHeldStats(held) {
    try {
        if (Object.keys(held).length) await withTimeout(runtimeAPI.storage.local.set({ [STATS_HOLD_KEY]: held }), STATS_HOLD_IO_TIMEOUT_MS, 'holding list write');
        else await withTimeout(runtimeAPI.storage.local.remove(STATS_HOLD_KEY), STATS_HOLD_IO_TIMEOUT_MS, 'holding list clear');
        _heldStatsMayExist = Object.keys(held).length > 0;
        return true;
    } catch (e) {
        debugLog('[Stats] holding list write failed:', e && e.message);
        return false;
    }
}

// Newer non-null fields win; never lose a value we already had.
function mergeHeldRecord(older, newer) {
    const out = { ...(older || {}), messageId: newer.messageId, characterId: newer.characterId || (older && older.characterId) || null };
    STATS_RECORD_FIELDS.forEach((f) => {
        if (newer[f] !== null && newer[f] !== undefined) out[f] = newer[f];
        else if (out[f] === undefined) out[f] = null;
    });
    return out;
}

// Adds/merges a record into the holding list. Returns the merged copy that was
// stored, or null if storage.local couldn't be written.
function holdStatsRecord(record) {
    if (!record || !record.messageId) return Promise.resolve(null);
    return withHeldStatsLock(async () => {
        const held = await readHeldStats();
        const merged = mergeHeldRecord(held[record.messageId], record);
        held[record.messageId] = merged;
        const ids = Object.keys(held);
        for (let i = 0; i < ids.length - STATS_HOLD_MAX; i++) delete held[ids[i]];
        return (await writeHeldStats(held)) ? merged : null;
    });
}

// Removes the given records — but only those still exactly as they were sent,
// so an update that arrived while sending stays held for the next attempt.
function releaseHeldStats(sentById) {
    return withHeldStatsLock(async () => {
        const held = await readHeldStats();
        let removed = 0;
        Object.keys(sentById).forEach((id) => {
            if (held[id] && JSON.stringify(held[id]) === JSON.stringify(sentById[id])) { delete held[id]; removed++; }
        });
        if (removed) await writeHeldStats(held);
        return Object.keys(held).length;
    });
}

// True only when the background positively confirmed the write.
async function tryPutStatsRecord(record) {
    try {
        const res = await sendStatsMessage('SAI_STATS_PUT', { record }, 1, STATS_PUT_TIMEOUT_MS);
        return !!(res && res.success);
    } catch (_) {
        return false;
    }
}

// Orion on iOS/iPadOS. Orion doesn't identify itself in the user agent, so
// detect it by elimination: it is the only browser on an Apple touch device
// that runs Firefox-style (moz-extension://) or Chrome-style
// (chrome-extension://) extensions — it accepts both builds of this extension.
// Safari uses safari-web-extension://, and Chrome/Firefox for iOS can't run
// extensions at all. Desktop Macs are excluded by the touch check.
function isOrionOnIOS() {
    try {
        const ua = navigator.userAgent || '';
        const foreignExtensionScheme = /^(moz|chrome)-extension:/.test(runtimeAPI.runtime.getURL(''));
        const appleTouch = /iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(navigator.platform || '') ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        return foreignExtensionScheme && appleTouch;
    } catch (_) {
        return false;
    }
}

const ORION_BACKGROUND_DEAD_MSG =
    'S.AI Toolkit: Orion has shut down the extension\'s background page.\n\n' +
    'This is a bug in the Orion app — not in SpicyChat or S.AI Toolkit. Until it is restarted, ' +
    'generation statistics can\'t be saved to the database and Google Drive sync won\'t work.\n\n' +
    'To fix it: force-quit Orion (swipe it away in the app switcher) and open it again.\n\n' +
    'Nothing is lost: your new statistics are being held safely and will be saved automatically ' +
    'once Orion is restarted.';

// Tell the user once per page load, and only on Orion for iOS, that stats can't
// reach the background page. Deferred so the blocking alert() never runs inside
// the stats write queue.
let _orionBackgroundAlertShown = false;
function warnOrionBackgroundDead() {
    if (_orionBackgroundAlertShown || !isOrionOnIOS()) return;
    _orionBackgroundAlertShown = true;
    debugLog('[Stats] Orion background page is down — alerting the user');
    setTimeout(() => { try { alert(ORION_BACKGROUND_DEAD_MSG); } catch (_) {} }, 0);
}

// ---------------------------------------------------------------------------
// Background health: probe, reconnect, and (experimental) extension bridge.
// On WebKit/iOS the background page can stop answering after the app is
// backgrounded and is not always woken by the next message. Preferred recovery
// (approach 1): probe it, and if it's silent open a FRESH port and probe again —
// re-creating the connection is a workaround reported for the same WebKit bug.
// Fallback (approach 3, Debug Mode + opt-in only): a hidden extension page
// (bridge.html) that may be able to revive the background or write stats itself.
// ---------------------------------------------------------------------------
const BG_PROBE_TIMEOUT_MS = 2500;
const BG_RECONNECT_DELAYS_MS = [300, 1000, 2000];
const BG_DEAD_BACKOFF_MS = 30000;      // after a failed revive, don't retry on every save
let _bgReviving = null;
let _bgDeadUntil = 0;
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function probeBackground() {
    return sendStatsMessage('SAI_KEEPALIVE_PING', null, 0, BG_PROBE_TIMEOUT_MS)
        .then(res => !!(res && res.alive))
        .catch(() => false);
}

// Resolves true if the background answers (possibly after reconnecting).
// force: ignore the "recently failed" backoff (used by the debug buttons).
function reviveBackground(force = false) {
    if (_bgReviving) return _bgReviving;
    if (!force && Date.now() < _bgDeadUntil) return Promise.resolve(false);
    _bgReviving = (async () => {
        const steps = [];
        if (await probeBackground()) return { alive: true, via: 'already alive', steps };
        for (const delay of BG_RECONNECT_DELAYS_MS) {
            let port = null;
            try { port = runtimeAPI.runtime.connect({ name: 'sai-wake' }); } catch (e) { steps.push('connect failed: ' + e.message); }
            await _sleep(delay);
            const ok = await probeBackground();
            try { if (port) port.disconnect(); } catch (_) {}
            steps.push('reconnect + ' + delay + ' ms: ' + (ok ? 'alive' : 'no answer'));
            if (ok) return { alive: true, via: 'reconnect', steps };
        }
        if (await bridgeEnabled()) {
            const r = await bridgeCall('revive');
            steps.push('bridge revive: ' + (r.ok ? JSON.stringify(r.result) : r.error));
            if (r.ok && r.result && r.result.after && r.result.after.alive) return { alive: true, via: 'bridge', steps };
        }
        return { alive: false, via: null, steps };
    })().then((outcome) => {
        _bgDeadUntil = outcome.alive ? 0 : Date.now() + BG_DEAD_BACKOFF_MS;
        debugLog('[Core] Background health:', outcome.alive ? 'alive (' + outcome.via + ')' : 'NOT responding', outcome.steps);
        _lastBackgroundHealth = outcome;
        return outcome.alive;
    }).catch(() => false).finally(() => { _bgReviving = null; });
    return _bgReviving;
}
let _lastBackgroundHealth = null;

// Run when the page loads and whenever the tab comes back to the foreground —
// the moments the background is most likely to have been killed.
async function checkBackgroundHealth() {
    const alive = await reviveBackground();
    if (alive) { if (_heldStatsMayExist) flushHeldStats(); }
    else warnOrionBackgroundDead();
    return alive;
}

// ---- Experimental extension bridge (bridge.html), Debug Mode + opt-in only ----
const BRIDGE_ENABLED_KEY = 'experimentalBridge';
const BRIDGE_TOKEN_KEY = 'bridgeToken';
let _bridgeFrame = null;
let _bridgeReady = null;
const _bridgePending = new Map();

async function bridgeEnabled() {
    try {
        const s = await withTimeout(runtimeAPI.storage.local.get(['debugMode', BRIDGE_ENABLED_KEY]), 4000, 'storage');
        return s.debugMode === true && s[BRIDGE_ENABLED_KEY] === true;
    } catch (_) {
        return false;
    }
}

async function getBridgeToken() {
    const s = await withTimeout(runtimeAPI.storage.local.get(BRIDGE_TOKEN_KEY), 4000, 'storage');
    if (typeof s[BRIDGE_TOKEN_KEY] === 'string' && s[BRIDGE_TOKEN_KEY].length >= 16) return s[BRIDGE_TOKEN_KEY];
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    await withTimeout(runtimeAPI.storage.local.set({ [BRIDGE_TOKEN_KEY]: token }), 4000, 'storage');
    return token;
}

function bridgeOrigin() {
    return runtimeAPI.runtime.getURL('').replace(/\/$/, '');
}

window.addEventListener('message', (ev) => {
    if (!_bridgeFrame || ev.source !== _bridgeFrame.contentWindow || !ev.data) return;
    if (ev.data.__saiBridge === 'reply' && _bridgePending.has(ev.data.id)) {
        const done = _bridgePending.get(ev.data.id);
        _bridgePending.delete(ev.data.id);
        done(ev.data);
    }
});

function ensureBridgeFrame() {
    if (_bridgeReady) return _bridgeReady;
    _bridgeReady = new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
        const onMsg = (ev) => {
            if (ev.source === frame.contentWindow && ev.data && ev.data.__saiBridge === 'ready') { cleanup(); resolve(frame); }
        };
        const timer = setTimeout(() => {
            cleanup();
            try { frame.remove(); } catch (_) {}
            _bridgeFrame = null; _bridgeReady = null;
            reject(new Error('bridge page did not load (blocked by the page or the browser)'));
        }, 5000);
        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); };
        window.addEventListener('message', onMsg);
        _bridgeFrame = frame;
        frame.src = runtimeAPI.runtime.getURL('bridge.html');
        (document.body || document.documentElement).appendChild(frame);
    });
    return _bridgeReady;
}

// Always resolves: { ok: true, result } or { ok: false, error }.
async function bridgeCall(cmd, extra, timeoutMs = 15000) {
    try {
        const frame = await ensureBridgeFrame();
        const token = await getBridgeToken();
        const id = 'b' + Date.now() + Math.random().toString(16).slice(2);
        const reply = new Promise(resolve => _bridgePending.set(id, resolve));
        frame.contentWindow.postMessage({ __saiBridge: 'request', id, cmd, token, ...(extra || {}) }, bridgeOrigin());
        const res = await withTimeout(reply, timeoutMs, 'bridge ' + cmd).finally(() => _bridgePending.delete(id));
        return res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error || 'bridge error' };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

// Write-ahead save. Returns 'stored' (background confirmed), 'held' (kept in the
// holding list for a later retry) or 'lost' (neither worked — only possible if
// storage.local itself is failing).
async function putStatsRecordDurably(record) {
    const held = await holdStatsRecord(record);          // 1) durable first
    const toSend = held || record;                        //    (send the merged copy)
    // 2) then the database. If a revive just failed, don't make every save wait out
    //    the full time limit again — the record is already safe in the holding list.
    const knownDead = held && Date.now() < _bgDeadUntil;
    let saved = knownDead ? false : await tryPutStatsRecord(toSend);
    if (!saved && !knownDead && await reviveBackground()) {             //    silent? probe + reconnect, retry once
        saved = await tryPutStatsRecord(toSend);
    }
    if (!saved && await bridgeEnabled()) {                //    experimental: write via the extension bridge page
        const viaBridge = await bridgeCall('put', { record: toSend });
        saved = viaBridge.ok;
        debugLog('[Stats] Bridge fallback for message', String(toSend.messageId).substring(0, 8), viaBridge.ok ? 'stored' : 'failed: ' + viaBridge.error);
    }
    if (saved) {
        if (held) await releaseHeldStats({ [toSend.messageId]: toSend });
        if (_heldStatsMayExist) flushHeldStats();         //    catch up on anything still held
        return 'stored';
    }
    warnOrionBackgroundDead();
    if (!held) {
        console.warn('[Stats] Could not save stats for message', String(record.messageId).substring(0, 8),
            '— neither the background page nor extension storage responded');
        return 'lost';
    }
    debugLog('[Stats] Background unavailable — kept stats for message', String(record.messageId).substring(0, 8), 'in the holding list');
    return 'held';
}

// Replay parked records. Stops at the first failure (background still down).
// Each record is removed only after the background confirmed it, and the list
// is re-read before writing so records parked meanwhile aren't clobbered.
function flushHeldStats() {
    if (_heldStatsFlushing) return _heldStatsFlushing;
    _heldStatsFlushing = (async () => {
        const held = await readHeldStats();
        const ids = Object.keys(held);
        if (!ids.length) { _heldStatsMayExist = false; return 0; }
        const delivered = {};
        for (const id of ids) {
            if (!(await tryPutStatsRecord(held[id]))) break;
            delivered[id] = held[id];
        }
        const n = Object.keys(delivered).length;
        if (n) {
            const waiting = await releaseHeldStats(delivered);
            debugLog('[Stats] Delivered', n, 'held stats record(s);', waiting, 'still waiting');
        }
        return n;
    })().catch(() => 0).finally(() => { _heldStatsFlushing = null; });
    return _heldStatsFlushing;
}

function removeHeldStats(messageId) {
    if (!_heldStatsMayExist) return Promise.resolve();
    return withHeldStatsLock(async () => {
        const held = await readHeldStats();
        if (held[messageId]) { delete held[messageId]; await writeHeldStats(held); }
    });
}

function clearHeldStats() {
    return withHeldStatsLock(() => writeHeldStats({}));
}

// Keep retrying while anything is held: every minute, and as soon as the tab
// comes back to the foreground (the moment Orion is most likely to have just
// restored the background page).
setInterval(() => { if (_heldStatsMayExist) flushHeldStats(); }, STATS_HOLD_RETRY_MS);
// Tab back in front (or restored from the back/forward cache): check the
// background is still there, reconnect if not, then deliver anything held.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkBackgroundHealth();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) checkBackgroundHealth(); });
setTimeout(() => { checkBackgroundHealth(); }, 1500);

// Parked records for one character, in the same shape the store returns.
async function getHeldStatsForCharacter(characterId) {
    if (!_heldStatsMayExist) return {};
    const held = await readHeldStats();
    if (!Object.keys(held).length) { _heldStatsMayExist = false; return {}; }
    const out = {};
    Object.values(held).forEach((r) => {
        if (!r || r.characterId !== characterId) return;
        const rec = {};
        STATS_RECORD_FIELDS.forEach((f) => { rec[f] = r[f] === undefined ? null : r[f]; });
        out[r.messageId] = rec;
    });
    return out;
}

debugLog('[Core] Content script starting...');
debugLog('[Core] URL:', window.location.href);
debugLog('[Core] Document ready state:', document.readyState);

// Inject debug functions into page context using external file (MV3 compatible - no inline scripts)
const debugScript = document.createElement('script');
// Use runtime API if available (extensions), otherwise fall back to relative path
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    debugScript.src = chrome.runtime.getURL('page-context.js');
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
    debugScript.src = browser.runtime.getURL('page-context.js');
} else {
    // Fallback for non-extension environments
    debugScript.src = 'page-context.js';
}
(document.head || document.documentElement).appendChild(debugScript);
debugScript.remove(); // Clean up script element after injection

// =============================================================================
// DEBUG HELPER FUNCTIONS - MESSAGE BRIDGE
// =============================================================================
// These handlers bridge between page-context.js debug functions and this
// content script, allowing developers to inspect/manage extension data from
// the browser console.
//
// Message flow:
// 1. User calls debug function in console (e.g., debugSAIToolkitStats())
// 2. page-context.js sends postMessage to this content script
// 3. Content script accesses chrome.storage.local
// 4. Response sent back via postMessage
// 5. page-context.js displays result in console
//
// This is necessary because console functions run in page context but
// chrome.storage API is only accessible in content script context.
// =============================================================================

window.addEventListener('message', async (event) => {
    // Security check: Only process messages from same window (not iframes or external sources)
    if (event.source !== window) return;
    
    // -------------------------------------------------------------------------
    // DEBUG STATS REQUEST - View stored message statistics
    // -------------------------------------------------------------------------
    // Retrieves all message generation stats from local storage and returns
    // them to the debug function for console display
    if (event.data.type === 'SAI_DEBUG_STATS_REQUEST') {
        // Stats now live in the background's IndexedDB store; ask for the full
        // nested wire-format snapshot for console display.
        let stats = {};
        try {
            await flushHeldStats();   // include stats parked while the background was down
            const res = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
            if (res && res.success) stats = res.stats || {};
        } catch (_) { /* return empty on failure */ }
        // Send stats back to page context for console display
        window.postMessage({ type: 'SAI_DEBUG_STATS_RESPONSE', stats }, '*');
    }

    // -------------------------------------------------------------------------
    // CLEAR STATS REQUEST - Delete all stored statistics
    // -------------------------------------------------------------------------
    // Wipes all message generation stats from storage (useful for testing)
    if (event.data.type === 'SAI_CLEAR_STATS_REQUEST') {
        try { await clearHeldStats(); await sendStatsMessage('SAI_STATS_CLEAR'); } catch (_) { /* ignore */ }
        // Confirm deletion to page context
        window.postMessage({ type: 'SAI_CLEAR_STATS_RESPONSE' }, '*');
    }

    // -------------------------------------------------------------------------
    // EXPORT STATS REQUEST - Export statistics to downloadable JSON file
    // -------------------------------------------------------------------------
    // Allows user to backup or share their generation statistics
    if (event.data.type === 'SAI_EXPORT_STATS_REQUEST') {
        // The per-conversation filter is gone — conversationId is no longer part
        // of the stats model — so this always exports the full nested snapshot.
        let stats = {};
        try {
            await flushHeldStats();   // include stats parked while the background was down
            const res = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
            if (res && res.success) stats = res.stats || {};
        } catch (_) { /* return empty on failure */ }
        // Return stats to page context which will trigger download
        window.postMessage({ type: 'SAI_EXPORT_STATS_RESPONSE', stats }, '*');
    }

    // -------------------------------------------------------------------------
    // IMPORT STATS REQUEST - Import statistics from JSON file
    // -------------------------------------------------------------------------
    // Allows user to restore backed up statistics or merge from another browser
    if (event.data.type === 'SAI_IMPORT_STATS_REQUEST') {
        // Background performs the authoritative merge into IndexedDB (collapsing
        // the conversation level, never overwriting richer entries).
        try {
            await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: event.data.jsonData });
        } catch (_) { /* ignore */ }
        // Confirm import completion to page context
        window.postMessage({ type: 'SAI_IMPORT_STATS_RESPONSE' }, '*');
    }
    
    // -------------------------------------------------------------------------
    // NSFW MODE STATE - Handle state updates from page context
    // -------------------------------------------------------------------------
    // When xhr-intercept.js responds with NSFW mode state, update our button
    if (event.data.type === 'SAI_NSFW_MODE_STATE' || event.data.type === 'SAI_NSFW_MODE_UPDATED') {
        if (typeof event.data.enabled === 'boolean') {
            // Update the global state variable (defined later in the file)
            if (typeof nsfwModeEnabled !== 'undefined') {
                nsfwModeEnabled = event.data.enabled;
                // Update button if it exists
                if (typeof updateNSFWButtonIcon === 'function') {
                    updateNSFWButtonIcon();
                }
                debugLog('[NSFW] Received NSFW state from page context:', event.data.enabled);
            }
        }
    }

    // -------------------------------------------------------------------------
    // MESSAGE RECOVERY — receive failed-send snapshots from page context
    // -------------------------------------------------------------------------
    // The page-context interceptor (xhr-intercept.js) detected a failure on a
    // POST /chat or /story request and is handing us the user's typed text.
    // We persist it to chrome.storage.local under 'failedMessages' as a FIFO
    // ring buffer (oldest entries dropped at the cap). We never transmit this
    // data anywhere — it's stored locally so the user can recover it via the
    // "Recover message" button injected next to SpicyChat's "Oops!" banner.
    //
    // STORAGE SHAPE
    //   key: 'failedMessages'
    //   value: Array<{
    //     id: string,            // local UUID for delete-by-id
    //     message: string,       // the user's original typed text
    //     conversationId: string|null,
    //     characterId: string|null,
    //     url: string,           // the failing endpoint, for debugging
    //     capturedAt: number,    // ms epoch
    //     reason: string,        // e.g. 'xhr-status-502', 'fetch-throw'
    //     transport: 'xhr'|'fetch'
    //   }>
    //
    // CAP: 50 entries. Old ones are evicted FIFO so the queue can't grow
    // unbounded if the user has a long outage.
    if (event.data.type === 'SAI_MESSAGE_SEND_FAILED') {
        try {
            const snapshot = event.data.snapshot || {};
            const reason = event.data.reason || 'unknown';
            if (!snapshot.message || typeof snapshot.message !== 'string') return;

            const entry = {
                id: 'fm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
                message: snapshot.message,
                conversationId: snapshot.conversationId || null,
                characterId: snapshot.characterId || null,
                url: snapshot.url || null,
                capturedAt: snapshot.capturedAt || Date.now(),
                reason: reason,
                transport: snapshot.transport || 'unknown'
            };

            const MAX_FAILED = 50;
            const existing = await storage.get('failedMessages', []);
            const list = Array.isArray(existing) ? existing.slice() : [];
            list.push(entry);
            while (list.length > MAX_FAILED) list.shift();
            await storage.set('failedMessages', list);
            debugLog('[MsgRecovery] Persisted failed message, reason:', reason, 'queue size:', list.length);

            // If the "Oops!" banner is already on screen by the time we get
            // here (race between fetch failure and banner render), make sure
            // the recover button is present.
            if (typeof injectRecoverButtonIfNeeded === 'function') {
                injectRecoverButtonIfNeeded();
            }
        } catch (e) {
            console.error('[MsgRecovery] Failed to persist message:', e);
        }
    }
});

// Stats merging is now owned by the background (IndexedDB store): the import/restore
// paths and the SAI_IMPORT_STATS_REQUEST handler delegate to it via
// sendStatsMessage('SAI_STATS_IMPORT_MERGE', …). The old content-side
// pruneStatsObject/mergeMessageEntry/mergeStatsDeep copies were removed to avoid a
// misleading second source of merge truth. normalizeImportPayload (below) is still used
// to un-nest v2 backup files before applying their non-stats settings.

// Normalize a backup/import payload to the flat key layout the import logic expects.
// v2 backups nest keys under settings/style and store stats under `stats`; v1/flat
// payloads already have everything at the top level (passed through unchanged).
// Without this, importing a v2 file (e.g. the Drive sync file) silently drops every
// grouped setting — including the Custom Style group (enableCustomStyle/customStyleValues).
function normalizeImportPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const isV2 = data._format === 'v2' ||
                 (data.settings && typeof data.settings === 'object') ||
                 (data.style && typeof data.style === 'object');
    if (!isV2) return data;
    const flat = { ...data };
    if (data.settings && typeof data.settings === 'object') Object.assign(flat, data.settings);
    if (data.style && typeof data.style === 'object') Object.assign(flat, data.style);
    // v2 keeps the stats object under `stats`; the apply logic reads messageGenerationStats.
    if (data.stats !== undefined && flat.messageGenerationStats === undefined) {
        flat.messageGenerationStats = data.stats;
    }
    delete flat.settings;
    delete flat.style;
    delete flat.stats;
    delete flat._format;
    return flat;
}

'use strict';

// =============================================================================
// =============================================================================
// ===                                                                       ===
// ===   CRITICAL SECURITY SECTION - FOR MANUAL REVIEW BY CHROME/MOZILLA   ===
// ===                                                                       ===
// =============================================================================
// =============================================================================
//
// The following code injects JavaScript files into the page context.
// This is necessary for functionality and is implemented securely.
//
// WHY INJECTION IS REQUIRED:
// 1. SpicyChat.ai uses Content Security Policy (CSP) that blocks content
//    scripts from accessing page-level XMLHttpRequest and fetch APIs
// 2. We need to intercept these network calls to read AI generation settings
//    (temperature, top_p, top_k, model name) from API responses
// 3. Content scripts run in isolated world and cannot access page context
//
// WHAT IS INJECTED:
// - xhr-intercept.js: Intercepts network requests (READ-ONLY)
// - page-context.js: Exposes debug functions to console (USER-INITIATED)
//
// SECURITY GUARANTEES:
// ✓ NO REMOTE CODE: All injected scripts are bundled with extension
// ✓ NO EXTERNAL REQUESTS: Scripts make zero network calls to external servers
// ✓ READ-ONLY ON RESPONSES: Server responses are never modified
// ✓ LOCAL STORAGE ONLY: All data saved to chrome.storage.local
// ✓ NO CREDENTIALS: Does not access passwords, tokens, or auth headers
// ✓ TRANSPARENT: Fully open source at github.com/CLedebur/Spicychat.ai-Mods
//
// ABOUT MESSAGE CONTENT:
// By default, message content is NOT read or stored. The optional
// "Message Recovery" feature (Features tab → Message Recovery, default OFF)
// captures the text of an outgoing chat message ONLY at send time, and ONLY
// persists it locally if the send fails — so the user can recover what they
// typed when SpicyChat's backend errors out. See xhr-intercept.js header
// for the full disclosure.
//
// DATA FLOW:
// Page Context (xhr-intercept.js)
//   → Reads API response (model settings only)
//   → postMessage to Content Script
//   → Content Script saves to chrome.storage.local
//   → Data stays in browser (never transmitted)
//
// TESTING FOR REVIEWERS:
// 1. Install extension → Open DevTools Network tab
// 2. Verify: Extension makes ZERO external network requests
// 3. Open DevTools → Application → Storage → chrome.storage.local
// 4. Verify: All data local (profiles, settings, stats)
// 5. Test: Save profile → Check it's in local storage only
//
// =============================================================================
// INJECT XHR/FETCH INTERCEPTION INTO PAGE CONTEXT - IMMEDIATELY
// This MUST happen at document_start to catch the initial GET /messages call
// =============================================================================

debugLog('[Stats] Injecting XHR/Fetch interception into page context (EARLY)...');

// Make DEBUG_MODE available to injected scripts via window object
// This allows xhr-intercept.js to use the same debug mode setting
window.__SAI_DEBUG_MODE__ = DEBUG_MODE;

// =============================================================================
// INJECT xhr-intercept.js AS EXTERNAL SCRIPT
// =============================================================================
// Using createElement('script') with src (not inline code) for MV3 compliance
// The script file is part of the extension bundle (web_accessible_resources)
const interceptScript = document.createElement('script');

// Get correct URL for the script file (Chrome vs Firefox API differences)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    // Chrome/Edge: Use chrome.runtime.getURL
    interceptScript.src = chrome.runtime.getURL('xhr-intercept.js');
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
    // Firefox: Use browser.runtime.getURL
    interceptScript.src = browser.runtime.getURL('xhr-intercept.js');
} else {
    // Fallback for non-extension environments (development/testing)
    interceptScript.src = 'xhr-intercept.js';
}

// Inject the script tag into page head/document
// Using documentElement as fallback if head doesn't exist yet
(document.head || document.documentElement).appendChild(interceptScript);
// Remove script element after injection (script already executed, DOM cleanup)
interceptScript.remove();
debugLog('[Stats] Injection script added to page context (EARLY)');

// =============================================================================
// STORAGE API WRAPPER
// =============================================================================
// The storage-wrapper.js file is loaded FIRST via manifest.json and provides
// a unified storage API that works across Chrome and Firefox:
//
// Available methods:
// - storage.get(key, defaultValue) → Returns value or default if not found
// - storage.set(key, value) → Saves value to browser storage
// - storage.remove(key) → Deletes key from storage
// - storage.clear() → Clears all extension storage
// - storage.setMultiple(obj) → Batch save multiple key-value pairs
//
// All methods support both callback and Promise (await) patterns
// Storage data persists across browser sessions
// =============================================================================

// =============================================================================
// MAIN CONTENT SCRIPT - ASYNC IIFE (Immediately Invoked Function Expression)
// =============================================================================
// Everything runs inside this async function to allow top-level await
// This pattern lets us wait for storage operations before proceeding
(async function() {
    'use strict';

    // ------------------------------------------------------------------
    // EARLY-DECLARED STATE
    // ------------------------------------------------------------------
    // Hoisted here because asynchronous observers (body-class,
    // resize) are wired up partway through this IIFE and can fire BEFORE
    // execution reaches the later `let` declarations. Reading a let/const
    // before its declaration line throws TDZ ("Cannot access … before
    // initialization"). The values themselves are re-assigned later; this
    // block only ensures the bindings exist as soon as the IIFE starts.
    let isResizing = false;
    let resizeEndTimer = null;
    // Sidebar Layout body-class observer state — accessed by the
    // startSidebarLayoutBodyClassObserver function, which is called from the
    // early-inject block (~line 895) long before the later declarations would
    // run. Without these hoists, the first call hit TDZ on
    // `sidebarLayoutBodyObserver`, threw ReferenceError, and halted the
    // entire early-init block — which manifested as ALL injections/page
    // modifications appearing broken because the IIFE never reached them.
    let sidebarLayoutBodyObserver = null;
    let sidebarLayoutBodyClassRafPending = false;

    debugLog('[Core] Content script loaded - starting initialization...');
    debugLog('[Core] Storage object available:', typeof storage !== 'undefined');

    // =============================================================================
    // MIGRATION NOTE: Tampermonkey → Extension
    // =============================================================================
    // Automatic migration from Tampermonkey userscript is not possible because:
    // 1. Userscripts use GM_getValue/GM_setValue (different storage)
    // 2. Content scripts run in isolated world (cannot access GM storage)
    // 3. Cross-origin restrictions prevent direct storage access
    //
    // Solution: Users can manually export from userscript and import to extension
    // via the "Export All Data" / "Import All Data" buttons in settings
    // =============================================================================

    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    EARLY CSS INJECTION (CRITICAL)                    ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    //
    // TIMING IS CRITICAL:
    // CSS must be injected BEFORE React initializes to prevent:
    // 1. Flash of unstyled content (FOUC)
    // 2. React's virtual DOM conflicts with our style changes
    // 3. Layout thrashing during page load
    //
    // This happens at document_start (before DOM is built) to ensure our
    // styles are in place when React renders the page for the first time.
    //
    // CSS INJECTION STRATEGY:
    // - Check if feature is enabled (from storage)
    // - If enabled, inject <style> tag immediately
    // - Use ID to prevent duplicate injection
    // - Insert at head start for maximum priority
    //
    // =============================================================================
    
    // Storage keys for each CSS feature
    const SIDEBAR_LAYOUT_KEY = 'enableSidebarLayout';      // Pin modals to right sidebar
    // RETIRED Custom Style. Only read for the Style tab's "Export Custom Style URL
    // to SpicyChat" / "Clear Custom Style data" buttons and the one-time migration
    // into STYLE_OVERRIDES_KEY — nothing applies these to the page anymore.
    const CUSTOM_STYLE_KEY = 'enableCustomStyle';
    const CUSTOM_STYLE_VALUES_KEY = 'customStyleValues';
    const ROUNDED_PROFILE_IMAGES_KEY = 'enableRoundedProfileImages';  // Rounded profile images
    const SWAP_CHECKBOX_POSITION_KEY = 'enableSwapCheckboxPosition';  // Swap selection checkbox positions
    const SQUARE_MESSAGE_EDGES_KEY = 'enableSquareMessageEdges';  // Square message box edges
    const SHOW_MESSAGE_IDS_KEY = 'showMessageIds';  // Show message IDs in stats display
    const ENABLE_GENERATION_PROFILES_KEY = 'enableGenerationProfiles';  // Override to force-enable generation profiles (debug only)
    const MEMORY_DOT_ENABLED_KEY = 'memoryDotEnabled';  // Show/hide memory limit indicator dot
    const MEMORY_DOT_COLOR_KEY = 'memoryDotColor';  // Custom color for memory limit indicator dot
    const HIDE_CREATOR_KEY = 'hideCreatorName';  // Hide bot creator @username link under bot messages

    // Default (legacy) Custom Style values — measured off native SpicyChat, so
    // they double as the native palette for HTML chat export and as the
    // "untouched" baseline when migrating / exporting a legacy Custom Style.
    // Color fields are split per-theme (light/dark) since a color that reads
    // fine on a dark chat background (e.g. white body text) can be invisible
    // on a light one. Typography/layout fields aren't a contrast concern, so
    // they stay shared across both themes.
    const CUSTOM_STYLE_FLAT_COLOR_FIELDS = [
        'aiMessageBg', 'userMessageBg', 'highlightBgColor', 'highlightTextColor',
        'hoverButtonColor', 'creatorLinkColor'
    ];
    // Body/Dialogue/Narration are further split by bot vs. user: SpicyChat's
    // own bubble backgrounds differ by role (the AI's follows the page theme,
    // the user's stays a fixed dark navy in both themes), so one shared color
    // per theme can't read well against both. See the CUSTOM_STYLE_RULES
    // comment below for the rest of this story.
    const CUSTOM_STYLE_ROLE_COLOR_FIELDS = ['bodyColor', 'spanQuoteColor', 'narrationColor'];
    const DEFAULT_CUSTOM_STYLE = {
        // Measured directly off spicychat.ai with Custom Style off (bg-gray-4,
        // plain text color, text-sky-10/text-sky-6, --nextui-colorHighlight,
        // hover:bg-gray-1 for bot; text-sky-6/text-sky-7 — both #8cdfff — for
        // user) so the unedited defaults are a no-op visually in both themes.
        light: {
            aiMessageBg: '#ededed',
            userMessageBg: '#335566',
            bot: { bodyColor: '#000000', spanQuoteColor: '#000000', narrationColor: '#316185' },
            user: { bodyColor: '#ffffff', spanQuoteColor: '#ffffff', narrationColor: '#8cdfff' },
            highlightBgColor: '#ffdd6d',
            highlightTextColor: '#000000',
            hoverButtonColor: '#fcfcfc',
            creatorLinkColor: ''
        },
        dark: {
            aiMessageBg: 'rgba(100, 100, 100, 0.1)',
            userMessageBg: 'rgba(0, 100, 255, 0.1)',
            bot: { bodyColor: '#ffffff', spanQuoteColor: '#ffffff', narrationColor: '#06B7DB' },
            user: { bodyColor: '#ffffff', spanQuoteColor: '#ffffff', narrationColor: '#8cdfff' },
            highlightBgColor: '#ffdd6d',
            highlightTextColor: '#000000',
            hoverButtonColor: '#292929',
            creatorLinkColor: ''
        },
        bodyFontWeight: 'normal',
        bodyFontStyle: 'normal',
        bodyTextDecoration: 'none',
        spanQuoteFontWeight: 'normal',
        spanQuoteFontStyle: 'normal',
        spanQuoteTextDecoration: 'none',
        narrationFontWeight: 'normal',
        narrationFontStyle: 'italic',
        narrationTextDecoration: 'none',
        highlightFontWeight: 'normal',
        highlightFontStyle: 'normal',
        highlightTextDecoration: 'none',
        fontSize: '16px',
        fontFamily: '',
        backgroundImage: ''
    };

    // Accepts a raw stored/imported customStyleValues in ANY form this codebase
    // has ever produced: a JSON string, an already-parsed object, the legacy
    // flat shape (one set of colors, pre-dual-theme), the pre-bot/user-split
    // { light, dark, ...shared } shape, or the current shape with bot/user
    // nested under each theme — and always returns a complete, well-formed
    // object. Legacy values are never written back to storage, so this
    // re-derives the same result on every read/every future improvement to
    // DEFAULT_CUSTOM_STYLE — there's nothing to migrate once, up front, that
    // could go stale.
    function normalizeCustomStyleValues(raw) {
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (e) { raw = null; }
        }
        const base = raw && typeof raw === 'object' ? raw : {};
        const hasProfiles = base.light && typeof base.light === 'object' &&
                             base.dark && typeof base.dark === 'object';

        const shared = {};
        Object.keys(DEFAULT_CUSTOM_STYLE).forEach((key) => {
            if (key === 'light' || key === 'dark') return;
            shared[key] = base[key] !== undefined ? base[key] : DEFAULT_CUSTOM_STYLE[key];
        });

        // Merges one saved theme profile (light or dark) against its
        // defaults. A profile saved before the bot/user split has
        // bodyColor/spanQuoteColor/narrationColor flat on itself, tuned only
        // for the AI's bubble — those migrate into "bot" as-is. "user" always
        // gets fresh native-matched defaults rather than inheriting a color
        // that was never designed for the user's own fixed-dark bubble (that
        // mismatch is exactly the bug this split exists to fix).
        function normalizeProfile(saved, defaults) {
            saved = saved && typeof saved === 'object' ? saved : {};
            const flat = {};
            CUSTOM_STYLE_FLAT_COLOR_FIELDS.forEach((key) => {
                flat[key] = saved[key] !== undefined ? saved[key] : defaults[key];
            });
            const hasRoles = saved.bot && typeof saved.bot === 'object' &&
                              saved.user && typeof saved.user === 'object';
            if (hasRoles) {
                return {
                    ...flat,
                    bot: { ...defaults.bot, ...saved.bot },
                    user: { ...defaults.user, ...saved.user }
                };
            }
            const legacyBot = {};
            CUSTOM_STYLE_ROLE_COLOR_FIELDS.forEach((key) => {
                legacyBot[key] = saved[key] !== undefined ? saved[key] : defaults.bot[key];
            });
            return { ...flat, bot: legacyBot, user: { ...defaults.user } };
        }

        if (hasProfiles) {
            return {
                light: normalizeProfile(base.light, DEFAULT_CUSTOM_STYLE.light),
                dark: normalizeProfile(base.dark, DEFAULT_CUSTOM_STYLE.dark),
                ...shared
            };
        }

        // Legacy flat shape: this codebase only ever had one color set before
        // the light/dark split, and it was tuned against SpicyChat's dark
        // background (white body text, etc.) — so it migrates into dark.bot
        // only. Light gets DEFAULT_CUSTOM_STYLE.light (which now matches
        // SpicyChat's native Light Mode) rather than inheriting colors that
        // were never designed for a light background — e.g. the legacy
        // default's white body text would be invisible on the AI bubble's
        // light-gray background. Existing users see no change in Dark Mode
        // and a correct, native-looking Light Mode until they customize it
        // themselves.
        const legacyFlat = {};
        CUSTOM_STYLE_FLAT_COLOR_FIELDS.forEach((key) => {
            legacyFlat[key] = base[key] !== undefined ? base[key] : DEFAULT_CUSTOM_STYLE.dark[key];
        });
        const legacyBot = {};
        CUSTOM_STYLE_ROLE_COLOR_FIELDS.forEach((key) => {
            legacyBot[key] = base[key] !== undefined ? base[key] : DEFAULT_CUSTOM_STYLE.dark.bot[key];
        });
        return {
            light: {
                ...DEFAULT_CUSTOM_STYLE.light,
                bot: { ...DEFAULT_CUSTOM_STYLE.light.bot },
                user: { ...DEFAULT_CUSTOM_STYLE.light.user }
            },
            dark: { ...legacyFlat, bot: legacyBot, user: { ...DEFAULT_CUSTOM_STYLE.dark.user } },
            ...shared
        };
    }

    // =============================================================================
    // STYLE TAB OVERRIDES (successor to the retired Custom Style)
    // =============================================================================
    // SpicyChat now has native chat styles (text colors, fonts, bubble shapes), so
    // Custom Style was retired. Only these survive as individual Style-tab
    // settings, each with its own Light and Dark value ('' = SpicyChat's color):
    const STYLE_OVERRIDES_KEY = 'styleOverrides';
    // `enabled` is the "Custom Message Colors" checkbox: the three colors are only
    // applied while it is on. Values are kept when it is off.
    const EMPTY_STYLE_OVERRIDES = {
        enabled: false,
        botMessageBg:  { light: '', dark: '' },
        userMessageBg: { light: '', dark: '' },
        buttonHover:   { light: '', dark: '' },
        backgroundImage: ''
    };

    function normalizeStyleOverrides(raw) {
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (e) { raw = null; }
        }
        const base = raw && typeof raw === 'object' ? raw : {};
        const pair = (v) => ({
            light: v && typeof v.light === 'string' ? v.light : '',
            dark:  v && typeof v.dark  === 'string' ? v.dark  : ''
        });
        const out = {
            enabled: false,
            botMessageBg:  pair(base.botMessageBg),
            userMessageBg: pair(base.userMessageBg),
            buttonHover:   pair(base.buttonHover),
            backgroundImage: typeof base.backgroundImage === 'string' ? base.backgroundImage : ''
        };
        // Records saved before the checkbox existed applied whatever was set.
        out.enabled = typeof base.enabled === 'boolean' ? base.enabled : styleOverridesHaveColors(out);
        return out;
    }

    function styleOverridesHaveColors(o) {
        return ['botMessageBg', 'userMessageBg', 'buttonHover'].some(k => o[k].light || o[k].dark);
    }

    // What the fields are filled with when "Custom Message Colors" is switched on
    // and a field is still empty: the retired Custom Style's own values (the
    // translucent gray/blue bubbles in Dark mode).
    const STYLE_COLOR_DEFAULTS = {
        botMessageBg:  { light: DEFAULT_CUSTOM_STYLE.light.aiMessageBg,      dark: DEFAULT_CUSTOM_STYLE.dark.aiMessageBg },
        userMessageBg: { light: DEFAULT_CUSTOM_STYLE.light.userMessageBg,    dark: DEFAULT_CUSTOM_STYLE.dark.userMessageBg },
        buttonHover:   { light: DEFAULT_CUSTOM_STYLE.light.hoverButtonColor, dark: DEFAULT_CUSTOM_STYLE.dark.hoverButtonColor }
    };

    // Carries the kept fields over from a legacy Custom Style. The three colors
    // are copied as stored (built-in values included — in Dark mode those are
    // Custom Style's own look, not SpicyChat's), and the "Custom Message Colors"
    // checkbox takes over Custom Style's on/off state, so the chat looks the same
    // after the update: on -> still applied, off -> stored but not applied.
    function deriveStyleOverridesFromLegacy(enabled, rawValues) {
        const out = normalizeStyleOverrides(null);
        if (rawValues == null) return out;
        const v = normalizeCustomStyleValues(rawValues);
        ['light', 'dark'].forEach((t) => {
            out.botMessageBg[t]  = v[t].aiMessageBg || '';
            out.userMessageBg[t] = v[t].userMessageBg || '';
            out.buttonHover[t]   = v[t].hoverButtonColor || '';
        });
        out.backgroundImage = v.backgroundImage || '';
        out.enabled = enabled === true && styleOverridesHaveColors(out);
        return out;
    }

    // True while there's legacy Custom Style data worth exporting/clearing.
    function hasLegacyCustomStyleData(enabled, rawValues) {
        if (enabled === true) return true;
        if (rawValues == null) return false;
        return JSON.stringify(normalizeCustomStyleValues(rawValues)) !==
               JSON.stringify(normalizeCustomStyleValues(DEFAULT_CUSTOM_STYLE));
    }

    // Light rules are scoped to html:not(.dark) (not left unprefixed) so a value
    // set only for Light never leaks into Dark mode, and vice versa.
    function getStyleOverridesCSSEarly(raw) {
        const o = normalizeStyleOverrides(raw);
        const scopes = { light: 'html:not(.dark) ', dark: 'html.dark ' };
        const rules = [];
        if (o.enabled) ['light', 'dark'].forEach((t) => {
            const p = scopes[t];
            if (o.botMessageBg[t])  rules.push(`${p}.py-md.rounded-\\[4px_20px_20px_20px\\] {\n  background-color: ${o.botMessageBg[t]} !important;\n}`);
            if (o.userMessageBg[t]) rules.push(`${p}.py-md.rounded-\\[20px_4px_20px_20px\\] {\n  background-color: ${o.userMessageBg[t]} !important;\n}`);
            if (o.buttonHover[t])   rules.push(`${p}button:hover {\n  background-color: ${o.buttonHover[t]} !important;\n}`);
        });
        if (o.backgroundImage) {
            rules.push(`.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative {\n  background-image: url('${o.backgroundImage}') !important;\n  background-size: cover !important;\n  background-position: center !important;\n  background-repeat: no-repeat !important;\n  background-attachment: fixed !important;\n}`);
        }
        return rules.length ? `/* S.AI Toolkit - Style tab overrides */\n${rules.join('\n\n')}` : '';
    }

    // ---- Legacy Custom Style -> SpicyChat native style share link ----
    // Format reverse-engineered from spicychat.ai's own encoder/decoder:
    //   https://spicychat.ai/share/style/<base64url(JSON)>
    //   { v: 1, n: name(<=40), d: {dark overrides}, l: {light overrides}, ... }
    // Override keys: narration, dialogue, text, bold, highlight, command,
    // botBubble, userBubble, background. Values MUST be #RRGGBB — the decoder
    // silently drops anything else, and rejects a link with nothing valid left.
    const SPICYCHAT_STYLE_SHARE_BASE = 'https://spicychat.ai/share/style/';
    // Page background each theme's translucent colors are blended onto (dark
    // measured off the live site's chat wrapper; light is the white page).
    const SPICYCHAT_THEME_BASE_RGB = { dark: [15, 15, 15], light: [255, 255, 255] };

    // Any CSS color -> '#rrggbb', alpha-blended onto the theme background.
    // Returns null for empty/invalid input.
    function cssColorToOpaqueHex(color, theme) {
        if (!color || typeof color !== 'string') return null;
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return null;
        // An invalid color leaves fillStyle unchanged: test against two sentinels.
        ctx.fillStyle = '#010203'; ctx.fillStyle = color.trim();
        const a = ctx.fillStyle;
        ctx.fillStyle = '#040506'; ctx.fillStyle = color.trim();
        const b = ctx.fillStyle;
        if (a !== b) return null;
        let r, g, bl, alpha = 1;
        if (a.startsWith('#')) {
            r = parseInt(a.slice(1, 3), 16); g = parseInt(a.slice(3, 5), 16); bl = parseInt(a.slice(5, 7), 16);
        } else {
            const m = a.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const parts = m[1].split(',').map(x => parseFloat(x));
            [r, g, bl] = parts; alpha = parts.length > 3 ? parts[3] : 1;
        }
        const base = SPICYCHAT_THEME_BASE_RGB[theme] || SPICYCHAT_THEME_BASE_RGB.dark;
        const mix = (c, bc) => Math.round(c * alpha + bc * (1 - alpha));
        return '#' + [mix(r, base[0]), mix(g, base[1]), mix(bl, base[2])]
            .map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
    }

    // Builds the share link from a stored customStyleValues. Only colors that
    // differ from the built-in (native-matching) defaults are included, so an
    // untouched theme doesn't override SpicyChat's own look. Returns null when
    // nothing differs (the site would reject the link as "empty").
    function buildSpicyChatStyleShareUrl(rawValues) {
        const v = normalizeCustomStyleValues(rawValues);
        const map = [
            ['botBubble',  (p) => p.aiMessageBg],
            ['userBubble', (p) => p.userMessageBg],
            ['text',       (p) => p.bot.bodyColor],
            ['dialogue',   (p) => p.bot.spanQuoteColor],
            ['narration',  (p) => p.bot.narrationColor],
            ['highlight',  (p) => p.highlightBgColor]
        ];
        const payload = { v: 1, n: 'Toolkit Custom Style' };
        ['dark', 'light'].forEach((t) => {
            const overrides = {};
            map.forEach(([key, get]) => {
                const val = get(v[t]);
                if (!val || val === get(DEFAULT_CUSTOM_STYLE[t])) return;
                const hex = cssColorToOpaqueHex(val, t);
                if (hex) overrides[key] = hex;
            });
            if (Object.keys(overrides).length) payload[t === 'dark' ? 'd' : 'l'] = overrides;
        });
        if (!payload.d && !payload.l) return null;

        // What SpicyChat styles can't express, so the user knows what's left behind.
        const notCarried = [];
        const differs = (k) => JSON.stringify(v[k]) !== JSON.stringify(DEFAULT_CUSTOM_STYLE[k]);
        if (['light', 'dark'].some(t => JSON.stringify(v[t].user) !== JSON.stringify(DEFAULT_CUSTOM_STYLE[t].user))) notCarried.push('separate text colors for your own messages (SpicyChat uses one set for both sides)');
        if (['light', 'dark'].some(t => v[t].highlightTextColor !== DEFAULT_CUSTOM_STYLE[t].highlightTextColor)) notCarried.push('highlight text color');
        if (['bodyFontWeight', 'bodyFontStyle', 'bodyTextDecoration', 'spanQuoteFontWeight', 'spanQuoteFontStyle',
             'spanQuoteTextDecoration', 'narrationFontWeight', 'narrationFontStyle', 'narrationTextDecoration',
             'highlightFontWeight', 'highlightFontStyle', 'highlightTextDecoration'].some(differs)) notCarried.push('font weight/style/decoration');
        if (differs('fontSize') || differs('fontFamily')) notCarried.push('font size/family');

        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        const code = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { url: SPICYCHAT_STYLE_SHARE_BASE + code, payload, notCarried };
    }

    // =============================================================================
    // STORAGE MIGRATION: Custom Style retirement + removed-feature cleanup
    // =============================================================================
    // 1) First run after the update: derive styleOverrides from the legacy Custom
    //    Style. Legacy enableCustomStyle/customStyleValues are left in place (they
    //    back the Style tab's Export/Clear buttons) until the user clears them.
    // 2) Drop storage for features that no longer exist.
    //
    // STYLE_MIGRATION_VERSION gates step 1 so it runs once per rule change.
    // v3: colors are copied as stored (built-in values included) and Custom
    // Style's on/off state becomes the "Custom Message Colors" checkbox. (v1/v2
    // skipped built-in values, which left the fields empty for most people.)
    // Stored overrides that already hold values are never overwritten.
    const STYLE_MIGRATION_KEY = 'styleOverridesMigration';
    const STYLE_MIGRATION_VERSION = 3;
    async function migrateRetiredStyleFeatures() {
        const state = await storage.getMultiple({ [STYLE_OVERRIDES_KEY]: null, [STYLE_MIGRATION_KEY]: 0 });
        const existing = state[STYLE_OVERRIDES_KEY];
        const existingNorm = normalizeStyleOverrides(existing);
        const existingIsEmpty = existing === null ||
            (!styleOverridesHaveColors(existingNorm) && !existingNorm.backgroundImage);
        if (state[STYLE_MIGRATION_KEY] !== STYLE_MIGRATION_VERSION) {
            await storage.set(STYLE_MIGRATION_KEY, STYLE_MIGRATION_VERSION);
        }
        if (existingIsEmpty && state[STYLE_MIGRATION_KEY] !== STYLE_MIGRATION_VERSION) {
            const legacy = await storage.getMultiple({ enableCustomStyle: false, customStyleValues: null });
            const derived = deriveStyleOverridesFromLegacy(legacy.enableCustomStyle === true, legacy.customStyleValues);
            // Only persist when something was actually carried over. Writing an
            // EMPTY object here would make a fresh install "have" local style
            // settings, and Drive sync (local wins over remote) would then wipe
            // the Style settings synced from the user's other devices.
            if (JSON.stringify(derived) !== JSON.stringify(EMPTY_STYLE_OVERRIDES)) {
                await storage.set(STYLE_OVERRIDES_KEY, JSON.stringify(derived));
                debugLog('[Migration] Style overrides derived from legacy Custom Style:', derived);
            }
        }
        await storage.remove([
            'enableClassicLayout', 'enableClassicStyle', 'enableThemeCustomization',
            'enableSmallProfileImages', 'enableWysiwygEditor', 'messageContainerMaxWidth'
        ]);
    }
    await migrateRetiredStyleFeatures();
    
    // =============================================================================
    // TIMING CONSTANTS - Centralized delay/timeout values (Issue #15)
    // =============================================================================
    const TIMING = {
        // CSS injection retries
        CSS_RETRY_SHORT: 10,           // Quick retry for missing document.head
        
        // Debouncing and throttling
        MUTATION_DEBOUNCE: 150,        // Debounce mutations before processing stats
        STATS_INITIAL_DELAY: 100,      // Initial delay before processing stats
        STATS_RETRY_DELAY: 500,        // Retry delay for failed stats processing
        
        // Modal and UI operations
        MODAL_OPEN_DELAY: 500,         // Wait for modal to appear
        MODAL_CONFIRM_DELAY: 800,      // Wait for modal confirmation action
        MODEL_CHANGE_CONFIRM: 500,     // Wait after model change confirmation
        SCROLL_POLL_INTERVAL: 500,     // Poll interval for scroll position
        
        // Initialization and retries
        BUTTON_INJECT_RETRIES: [500, 1000, 2000, 3000, 5000], // Progressive retry delays
        INITIAL_STATS_CHECK: 2000,     // Initial stats check after page load
        DELAYED_STATS_CHECK: 5000,     // Delayed stats check for slow loading
        TITLE_UPDATE_DELAY: 1000,      // Delay before updating page title
        PERIODIC_CHECK: 2000,          // Periodic button existence check
        
        // Cache and storage
        STORAGE_CACHE_TTL: 5000,       // Storage cache time-to-live (5 seconds)
    };
    
    // =============================================================================
    // HELPER: Wait for document.body to exist
    // =============================================================================
    // When opening a new tab via middle-click, the content script may run at
    // document_start before document.body exists. This helper ensures observers
    // and DOM manipulations wait for body to be available.
    function waitForBody(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            debugLog('[Core] waitForBody called, readyState:', document.readyState, 'body:', !!document.body);
            
            if (document.body) {
                debugLog('[Core] document.body already exists');
                resolve(document.body);
                return;
            }
            
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.error('[Core] waitForBody timed out after', timeoutMs, 'ms');
                    // Still try to resolve with body if it exists now, otherwise reject
                    if (document.body) {
                        resolved = true;
                        resolve(document.body);
                    } else {
                        reject(new Error('document.body not available after timeout'));
                    }
                }
            }, timeoutMs);
            
            const onBodyReady = () => {
                if (!resolved && document.body) {
                    resolved = true;
                    clearTimeout(timeout);
                    debugLog('[Core] document.body now available');
                    resolve(document.body);
                }
            };
            
            // Try DOMContentLoaded first
            if (document.readyState === 'loading') {
                debugLog('[Core] Waiting for DOMContentLoaded...');
                document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
            } else {
                // DOM should be ready - poll briefly in case body is just not set yet
                debugLog('[Core] DOM ready but no body, polling...');
                const checkBody = setInterval(() => {
                    if (document.body) {
                        clearInterval(checkBody);
                        onBodyReady();
                    }
                }, 10);
                
                // Also listen just in case
                document.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
            }
        });
    }
    
    // =============================================================================
    // Z-INDEX HIERARCHY - Centralized z-index values (Issue #15)
    // =============================================================================
    const Z_INDEX = {
        SIDEBAR_MODAL: 9000000,        // Base z-index for sidebar modals
        GENERATION_SETTINGS: 10000001, // Generation Settings when both modals open
        MEMORY_MANAGER: 10000000,      // Memory Manager modal
        CONTEXT_MENU: 10000002,        // Message context menu (above modals)
        SETTINGS_POPOVER: 10000001,    // Settings popover
        TOOLKIT_MODAL: 10000003,       // Toolkit settings modal
        TOOLKIT_BACKDROP: 10000003,    // Toolkit modal backdrop
        TOOLKIT_CONFIRM: 10000004,     // Confirmation dialog
        PAGE_JUMP_MODAL: 10000,        // Page jump modal
        STICKY_HEADER: 2,              // Sticky header in Generation Settings
        NOTIFICATION: 9999,            // Notification toasts
    };

    // =============================================================================
    // CHANGELOG - see loadChangelogData() / changelog.json for release notes data
    // =============================================================================

    // Load feature flags from storage (async operations)
    // These determine which CSS to inject before page renders
    // PERFORMANCE: Batch all early CSS settings into a single storage read
    const earlySettings = await storage.getMultiple({
        [SIDEBAR_LAYOUT_KEY]: false,
        [STYLE_OVERRIDES_KEY]: null,
        [ROUNDED_PROFILE_IMAGES_KEY]: false,
        [SWAP_CHECKBOX_POSITION_KEY]: false,
        [SQUARE_MESSAGE_EDGES_KEY]: false,
        [MEMORY_DOT_ENABLED_KEY]: true,
        [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
        [HIDE_CREATOR_KEY]: false
    });
    
    const sidebarEnabled = earlySettings[SIDEBAR_LAYOUT_KEY];
    
    // Check if current page should have sidebar layout disabled.
    // Allowlist rather than denylist: Sidebar Layout only applies on chat and Story
    // Mode pages (/chat/..., /chats/..., /story/..., and localized
    // /{language}/chat(s)/..., /{language}/story/...). A denylist kept
    // missing pages — e.g. the new-bot creation page pinned the "Attach Lorebook"
    // modal into the sidebar panel and hid its Attach/Cancel buttons.
    // Defined here, in the outer content-script scope, because the early composer CSS
    // injection below needs it before initializeMainCode (where the rest of the sidebar
    // code lives) is defined.
    function isNonChatPageForSidebar() {
        return !/^\/([a-z]{2}\/)?(chats?|story)\//i.test(window.location.pathname);
    }
    
    // -------------------------------------------------------------------------
    // COMPOSER CSS INJECTION (Dependency: Sidebar Layout)
    // -------------------------------------------------------------------------
    // The composer CSS (message input area styling) only works correctly with
    // sidebar layout enabled. It's designed specifically for that layout mode.
    // Without sidebar, the default SpicyChat layout is fine.
    // 
    // Only applies on chat pages - every other page (chatbot create/edit, lorebook,
    // group, voice, ...) has its own layout. See isNonChatPageForSidebar().
    const isNonChatPage = isNonChatPageForSidebar();
    if (sidebarEnabled && !isNonChatPage) {
        const injectComposerCSS = () => {
            // Wait for document.head to exist (very early in page lifecycle)
            if (!document.head) {
                // Head doesn't exist yet - retry based on document state
                if (document.readyState === 'loading') {
                    // Still loading - wait for DOMContentLoaded
                    document.addEventListener('DOMContentLoaded', injectComposerCSS, { once: true });
                } else {
                    // DOM should be ready but head missing - retry soon
                    setTimeout(injectComposerCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            // Check if already injected (prevent duplicates)
            if (document.getElementById('sai-toolkit-composer-layout-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-composer-layout-early';
            style.textContent = getComposerLayoutCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Composer Layout CSS injected EARLY (before React initialization)');
        };
        
        injectComposerCSS();
    }
    
    // Inject Sidebar Layout CSS early if enabled
    // Skip on lorebook, chatbot, and group pages - different layouts there
    if (sidebarEnabled && !isNonChatPage) {
        const injectSidebarCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSidebarCSS, { once: true });
                } else {
                    setTimeout(injectSidebarCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-sidebar-layout-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-sidebar-layout-early';
            style.textContent = getSidebarLayoutCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Sidebar Layout CSS injected EARLY (before React initialization)');
        };

        injectSidebarCSS();

        // Start the body-class observer that drives Sidebar Layout state. The
        // observer waits for document.body internally, so it's safe to call
        // before the body exists. This replaces ~30 chained body:has() rules
        // with simple class selectors — fixes the 8s+ forced reflows reported
        // on older CPUs during typing. (Defined later in the IIFE — defer the
        // call so the function is in scope when the page actually has a body.)
        const startObserverWhenReady = () => {
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            } else {
                // Function defined later in the same IIFE; retry once microtask is clear
                setTimeout(startObserverWhenReady, 0);
            }
        };
        startObserverWhenReady();
    }
    
    // Inject the Style tab's overrides (bubble BGs, button hover, background image)
    const styleOverridesCSS = getStyleOverridesCSSEarly(earlySettings[STYLE_OVERRIDES_KEY]);
    if (styleOverridesCSS) {
        const injectStyleOverridesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectStyleOverridesCSS, { once: true });
                } else {
                    setTimeout(injectStyleOverridesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }

            if (document.getElementById('sai-toolkit-style-overrides-early')) {
                return;
            }

            const style = document.createElement('style');
            style.id = 'sai-toolkit-style-overrides-early';
            style.textContent = styleOverridesCSS;

            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }

            debugLog('[Core] Style overrides CSS injected EARLY (before React initialization)');
        };

        injectStyleOverridesCSS();
    }

    // Load new layout options from storage
    // PERFORMANCE: Use values from batched earlySettings read above
    const roundedProfileImagesEnabled = earlySettings[ROUNDED_PROFILE_IMAGES_KEY];
    const swapCheckboxPositionEnabled = earlySettings[SWAP_CHECKBOX_POSITION_KEY];
    const squareMessageEdgesEnabled = earlySettings[SQUARE_MESSAGE_EDGES_KEY];

    // Inject Rounded Profile Images CSS early if enabled
    if (roundedProfileImagesEnabled) {
        const injectRoundedProfileImagesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectRoundedProfileImagesCSS, { once: true });
                } else {
                    setTimeout(injectRoundedProfileImagesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-rounded-profile-images-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-rounded-profile-images-early';
            style.textContent = getRoundedProfileImagesCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Rounded Profile Images CSS injected EARLY');
        };
        
        injectRoundedProfileImagesCSS();
    }
    
    // Inject Swap Checkbox Position CSS early if enabled
    if (swapCheckboxPositionEnabled) {
        const injectSwapCheckboxPositionCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSwapCheckboxPositionCSS, { once: true });
                } else {
                    setTimeout(injectSwapCheckboxPositionCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-swap-checkbox-position-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-swap-checkbox-position-early';
            style.textContent = getSwapCheckboxPositionCSSEarly();
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Swap Checkbox Position CSS injected EARLY');
        };
        
        injectSwapCheckboxPositionCSS();
    }
    
    // Inject Square Message Edges CSS early if enabled
    // NOTE: This is appended to the END of head (not beginning) so it overrides other layout CSS
    if (squareMessageEdgesEnabled) {
        const injectSquareMessageEdgesCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectSquareMessageEdgesCSS, { once: true });
                } else {
                    setTimeout(injectSquareMessageEdgesCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-square-message-edges-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-square-message-edges-early';
            style.textContent = getSquareMessageEdgesCSSEarly();
            
            // Append to END of head so it overrides Classic Layout's border-radius
            document.head.appendChild(style);
            
            debugLog('[Core] Square Message Edges CSS injected EARLY');
        };
        
        injectSquareMessageEdgesCSS();
    }

    // Inject Memory Dot CSS early if customized
    // PERFORMANCE: Use values from batched earlySettings read above
    const memoryDotEnabled = earlySettings[MEMORY_DOT_ENABLED_KEY];
    const memoryDotColor = earlySettings[MEMORY_DOT_COLOR_KEY];
    
    // Only inject CSS if user has customized the default settings
    if (!memoryDotEnabled || memoryDotColor !== '#ff3b3b') {
        const injectMemoryDotCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectMemoryDotCSS, { once: true });
                } else {
                    setTimeout(injectMemoryDotCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            
            if (document.getElementById('sai-toolkit-memory-dot-early')) {
                return;
            }
            
            const style = document.createElement('style');
            style.id = 'sai-toolkit-memory-dot-early';
            style.textContent = getMemoryDotCSSEarly(memoryDotEnabled, memoryDotColor);
            
            if (document.head.firstChild) {
                document.head.insertBefore(style, document.head.firstChild);
            } else {
                document.head.appendChild(style);
            }
            
            debugLog('[Core] Memory Dot CSS injected EARLY - Enabled:', memoryDotEnabled, 'Color:', memoryDotColor);
        };
        
        injectMemoryDotCSS();
    }

    // -------------------------------------------------------------------------
    // HIDE CREATOR NAME CSS INJECTION
    // -------------------------------------------------------------------------
    const hideCreatorEnabled = earlySettings[HIDE_CREATOR_KEY];
    if (hideCreatorEnabled) {
        const injectHideCreatorCSS = () => {
            if (!document.head) {
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', injectHideCreatorCSS, { once: true });
                } else {
                    setTimeout(injectHideCreatorCSS, TIMING.CSS_RETRY_SHORT);
                }
                return;
            }
            if (document.getElementById('sai-toolkit-hide-creator-early')) return;
            const style = document.createElement('style');
            style.id = 'sai-toolkit-hide-creator-early';
            style.textContent = `/* SAI Toolkit - Hide Creator Name */\na[aria-label="creator-profile"], a[href^="/creator/"] { display: none !important; }`;
            document.head.appendChild(style);
            debugLog('[Core] Hide Creator CSS injected EARLY');
        };
        injectHideCreatorCSS();
    }

    // -------------------------------------------------------------------------
    // MOBILE RESPONSIVE CSS INJECTION (Always Active)
    // -------------------------------------------------------------------------
    // Inject mobile-responsive CSS that applies globally regardless of layout
    // Currently includes: contextual menu left-justification for mobile devices
    const injectMobileResponsiveCSS = () => {
        if (!document.head) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', injectMobileResponsiveCSS, { once: true });
            } else {
                setTimeout(injectMobileResponsiveCSS, TIMING.CSS_RETRY_SHORT);
            }
            return;
        }

        if (document.getElementById('sai-toolkit-mobile-responsive-early')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'sai-toolkit-mobile-responsive-early';
        style.textContent = `/* SAI Toolkit - Mobile Responsive CSS */

/* ===== Character info bar full-width background fix ===== */
/* The character info bar (Iyarin name + buttons) is inside the bg-gray-2 container with background image */
/* Make it extend full width to cover the background image on the sides */
/* BUGFIX: previously hardcoded background via var(--color-gray-2, #18181b) — that
   variable is never defined by SpicyChat or this extension, so the !important
   fallback (#18181b, near-black) applied unconditionally, forcing this bar dark
   even in Light Mode. The element's own bg-gray-2 class already resolves the
   correct theme-aware color, so we only need position:relative here. */
/* BUGFIX: this pseudo-element centers a 100vw-wide box via left:50% + translateX(-50%),
   which only lands correctly when the bar itself spans the full viewport (true on
   mobile, where the left nav collapses). On desktop the bar sits to the right of the
   ~220px-wide persistent left nav, so centering 100vw around it overflows by roughly
   half the nav's width on BOTH sides — the right-side half pushes past the viewport
   edge and forces a permanent horizontal scrollbar on the whole page. Scoped to the
   same mobile breakpoint as the sibling rule below, where the underlying gap this
   fixes actually exists. */
@media (max-width: 999px) {
  div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative > div.flex.w-full.bg-gray-2[class*="z-[2]"] {
    position: relative;
  }

  /* Use pseudo-element to extend background full width */
  /* background: inherit picks up the parent's real (theme-correct) background
     instead of a hardcoded color, so this follows Light/Dark mode automatically. */
  div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2.relative > div.flex.w-full.bg-gray-2[class*="z-[2]"]::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 100vw;
    height: 100%;
    background: inherit;
    z-index: -1;
  }
}

/* Message contextual menu (Copy/Edit): reposition to left on mobile devices */
@media (max-width: 999px) {
  div.absolute.w-max.z-\\[100\\][style*="box-shadow"]:has(button[aria-label="Copy"]) {
    z-index: ${Z_INDEX.CONTEXT_MENU} !important;
    right: auto !important;
    left: auto !important;
    transform: translateX(-100%) !important;
    margin-right: 0.25rem !important;
  }
}
`;

        if (document.head.firstChild) {
            document.head.insertBefore(style, document.head.firstChild);
        } else {
            document.head.appendChild(style);
        }

        debugLog('[Core] Mobile Responsive CSS injected EARLY');
    };

    injectMobileResponsiveCSS();

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Composer Layout
    // =============================================================================
    // These functions return complete CSS strings for injection into <style> tags.
    // They're called during early injection (before React) to prevent FOUC.
    // 
    // FUNCTION: getComposerLayoutCSSEarly()
    // PURPOSE: Fixes message composer (input box) layout and button alignment
    // USED BY: Both Sidebar Layout and Classic Layout features
    // 
    // WHY NEEDED:
    // - SpicyChat's default composer has buttons at the bottom (flex-column)
    // - We want buttons inline with the input (flex-row) for more compact UI
    // - Must center the 800px max-width composer container
    // - Must align buttons to center of textarea (not bottom)
    // 
    // TECHNICAL APPROACH:
    // - Uses :has() selector to target correct container (has input/textarea)
    // - Changes flex-direction from column to row
    // - Aligns items to center for vertical button alignment
    // - Centers the max-width:800px container with auto margins
    // - Removes bottom margins from buttons (no longer needed in row layout)
    // 
    // CSS SPECIFICITY:
    // - Highly specific selectors to override React's inline styles
    // - Uses !important to ensure styles persist through React updates
    // - Targets exact class combinations to avoid affecting other elements
    // =============================================================================
    function getComposerLayoutCSSEarly() {
        return `/* ===== Composer layout & icon placement ===== */
/* Target the outer composer container with image button */
div.flex.items-end.gap-sm[style*="margin-left"] {
  align-items: center !important;
}

/* Target ONLY the composer input row, NOT persona grid containers */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;  /* Align icons to center of textarea */
  flex-wrap: nowrap !important;
  gap: 0.5rem !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}

/* Make button wrapper divs stretch to full height */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) > div.inline-flex {
  height: 100% !important;
  align-items: center !important;
}

/* Remove margin from image generation button and other composer buttons */
div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 > div.flex.justify-undefined.items-undefined:has(input, textarea) button {
  margin-bottom: 0 !important;
}

/* Also remove margin from the image button outside the input row */
div.flex.items-end.gap-sm[style*="margin-left"] button {
  margin-bottom: 0 !important;
}

/* Fix message box alignment */
.flex-row-reverse { 
  flex-direction: row !important;
}

/* ===== Center message input container ===== */
/* The container with inline style max-width: 800px */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full
  > div.flex.justify-undefined.items-undefined.bg-transparent.w-full[style*="max-width"] {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}
`;
    }
    
    // =============================================================================
    // CSS GENERATION FUNCTIONS - Sidebar Layout
    // =============================================================================
    // FUNCTION: getSidebarLayoutCSSEarly()
    // PURPOSE: Pins modals to right sidebar and adjusts chat layout accordingly
    // FEATURE: "Memory Manager - Sidebar Layout" checkbox
    // 
    // WHY NEEDED:
    // - Default SpicyChat modals appear centered and block the entire chat
    // - This pins Memories & Generation Settings to right side as permanent panels
    // - Allows user to chat while adjusting settings/memories
    // - Creates a 3-column layout: Left Nav | Chat | Right Sidebar
    // 
    // MODAL BEHAVIOR:
    // - Memories & Generation Settings: Pinned to right (380px width)
    // - When both open: Generation Settings on top (40vh), Memories on bottom (60vh)
    // - Image modals: Stay centered with backdrop blur (not pinned)
    // - "Select a model" modal: Stays centered (not pinned)
    // - Toolkit Settings modal: Pinned to right but with backdrop blur
    // 
    // CHAT LAYOUT ADJUSTMENTS:
    // - Chat container width reduced by 380px (sidebar width)
    // - Messages remain centered within available space
    // - Composer stays centered at 800px max-width
    // - Context menu repositioned to left side (away from sidebar)
    // 
    // RESPONSIVE BEHAVIOR:
    // - Sidebar only applies at desktop widths (min-width: 1000px)
    // - Mobile/tablet: Modals behave normally (centered)
    // 
    // Z-INDEX HIERARCHY:
    // - Sidebar modals: z-index 9000000 - 10000001
    // - Context menu: z-index 10000002 (above modals)
    // - Settings popover: z-index 10000001 (above Generation Settings)
    // - Image modal: Default z-index (appears above everything when open)
    // 
    // CSS VARIABLES:
    // - --mm-width: Modal panel width (380px)
    // - --mm-gap: Gap between chat and modal (0px)
    // - --mm-safe: Safe area inset for notched devices
    // - --mm-gutter: Total space reserved for sidebar (width + gap + safe area)
    // - --left-sidebar-width: SpicyChat's left navigation width (220px)
    // - --left-sidebar-collapsed-width: Collapsed left nav (54px)
    // 
    // TECHNICAL CHALLENGES SOLVED:
    // 1. React tries to hide Generation Settings when Memories opens
    //    Solution: Force display:flex !important, visibility:visible
    // 2. Both modals try to occupy same space
    //    Solution: Split screen vertically (40vh / 60vh) when both open
    // 3. Backdrop overlays block interaction
    //    Solution: Hide backdrops for sidebar modals, show for image modals
    // 4. Image modal too wide with sidebar
    //    Solution: Reduce width by --mm-gutter, add margin-right
    // 5. Context menu hidden behind sidebar
    //    Solution: High z-index + reposition to left side
    // =============================================================================
    
    // Define the CSS functions early for immediate use
    function getSidebarLayoutCSSEarly() {
        return `/* Memory Manager - Modal Layout CSS - EARLY INJECTION */

/* ===== Sidebar / Modals (Memories & Generation Settings) ===== */

/* Vars */
:root {
  --mm-width: 380px;
  --mm-gap: 0px;
  --mm-safe: env(safe-area-inset-right, 0px);
  --mm-gutter: calc(var(--mm-width) + var(--mm-gap) + var(--mm-safe));
  --left-sidebar-width: 220px; /* Default expanded width */
  --left-sidebar-collapsed-width: 54px;
}

/* Base modal: pin to right, full height, square corners */
/* Exclude image modals and toolkit modal from sidebar styling */
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container),
div.fixed.inset-0.z-\\[10000\\]:not(.size-full) > div.bg-white.dark\\:bg-gray-3.rounded-xl {
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  left: auto !important;
  transform: none !important;
  margin: 0 !important;
  width: var(--mm-width) !important;
  border-radius: 0 !important;
  z-index: ${Z_INDEX.SIDEBAR_MODAL} !important;
  display: block !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
}

/* Exception: Keep "Select a model" modal centered and height-constrained */
div.fixed.left-1\\/2.top-1\\/2:has(p.text-heading-6:contains("Select a model")),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:has(button[aria-label="Set Model"]) {
  position: fixed !important;
  top: 50% !important;
  left: 50% !important;
  right: auto !important;
  bottom: auto !important;
  transform: translate(-50%, -50%) !important;
  width: 500px !important;
  max-width: 90vw !important;
  height: auto !important;
  max-height: min(700px, 90vh) !important;
  border-radius: 0.5rem !important;
}

/* Force dark gray background on Generation Settings modal to match Memories */
/* BUGFIX: previously ungated, so this fired in Light Mode too — one selector
   matched [class*="bg-white"] (the LIGHT-mode class itself!) and the other
   matched the literal Tailwind class-name string "dark:!bg-gray-6", which is
   present in the DOM regardless of which theme is actually active. Scoped to a
   real .dark ancestor so the override only applies when Dark Mode is genuinely
   active; in Light Mode the modal's own bg-white already matches Memories. */
.dark div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container).dark\\:\\!bg-gray-6,
.dark div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container)[class*="bg-white"] {
  background-color: rgb(26, 27, 30) !important; /* dark:bg-gray-3 color */
}

/* Align Memories header with Generation Settings header (remove center alignment) */
div.fixed.left-1\\/2.top-1\\/2.h-full p.text-heading-6.text-center {
  text-align: left !important;
  padding-left: 0 !important;
}

/* Toolkit Settings modal specific adjustments */
div.fixed.inset-0.z-\\[10000\\] {
  position: fixed !important;
  background: transparent !important;
  backdrop-filter: none !important;
  pointer-events: none !important;
}

div.fixed.inset-0.z-\\[10000\\] > div.bg-white.dark\\:bg-gray-3.rounded-xl {
  pointer-events: auto !important;
  max-width: var(--mm-width) !important;
  margin: 0 !important;
  padding: 1.5rem !important;
}

/* Inner scrollers fill */
div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"],
div.fixed.inset-0.z-\\[10000\\] > div.bg-white.dark\\:bg-gray-3.rounded-xl [class*="overflow-y-auto"] {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
}

/* NOTE: All body-state matchers below were originally chained body:has() rules.
   They were replaced with body classes managed by startSidebarLayoutBodyClassObserver()
   to avoid catastrophic forced reflows during typing on slower hardware. */

/* Hide backdrop overlays for sidebar modals only (sidebar open, image NOT open) */
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
div.fixed.inset-0:not(.z-\\[10000\\]):not(.toolkit-modal-backdrop),
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
[role="presentation"][aria-hidden="true"],
body.sai-mm-sidebar-modal-open:not(.sai-mm-image-modal-open)
[data-overlay][aria-hidden="true"] {
  display: none !important;
}

/* Show backdrop overlays for image modals (.size-full) */
body.sai-mm-image-modal-open div.fixed.inset-0,
body.sai-mm-image-modal-open [role="presentation"][aria-hidden="true"],
body.sai-mm-image-modal-open [data-overlay][aria-hidden="true"] {
  display: block !important;
  backdrop-filter: blur(8px) !important;
  background-color: rgba(0, 0, 0, 0.5) !important;
}

/* Blur sidebar modals when image modal is open */
body.sai-mm-image-modal-open
div.fixed.left-1\\/2.top-1\\/2:not(.size-full) {
  filter: blur(4px) !important;
  opacity: 0.7 !important;
  pointer-events: none !important;
}

/* Blur sidebar modals when toolkit settings modal is open */
body.sai-mm-toolkit-modal-open
div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container) {
  filter: blur(4px) !important;
  opacity: 0.7 !important;
  pointer-events: none !important;
}

/* Settings popover: keep above the sidebar */
div[style*="position: absolute"][style*="z-index: 10000000"] {
  z-index: ${Z_INDEX.SETTINGS_POPOVER} !important;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* Image modal: center between sidebars when sidebar is present */
@media (min-width: 1000px) {
  body.sai-mm-sidebar-modal-open
    div.fixed.left-1\\/2.top-1\\/2.size-full {
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
    width: calc(100vw - var(--mm-gutter)) !important;
    height: 100vh !important;
    margin-right: var(--mm-gutter) !important;
  }

  body.sai-mm-sidebar-modal-open
    button.fixed.top-6.right-lg.z-\\[99999999999\\] {
    right: calc(var(--mm-gutter) + 1.5rem) !important;
  }
}

/* Message contextual menu (Copy/Edit): boost above sidebar and reposition to left */
div.absolute.w-max.z-\\[100\\][style*="box-shadow"]:has(button[aria-label="Copy"]) {
  z-index: ${Z_INDEX.CONTEXT_MENU} !important;
  right: auto !important;
  left: auto !important;
  transform: translateX(-100%) !important;
  margin-right: 0.25rem !important;
}

/* Allow message dropdown containers to overflow */
div.w-full.flex.mb-lg.bg-transparent.items-center div.relative {
  overflow: visible !important;
}

/* ===== Split the sidebar when BOTH modals are open ===== */

/* GENERATION SETTINGS PANEL (TOP 40vh) when BOTH modals open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full):not(.sai-placeholder-modal),
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full):not(.sai-placeholder-modal) {
  position: fixed !important;
  top: 0 !important;
  bottom: auto !important;
  right: 0 !important;
  height: 40vh !important;
  max-height: 40vh !important;
  z-index: 10000001 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* MEMORY MANAGER PANEL (BOTTOM 60vh) when BOTH modals open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not(.size-full) {
  position: fixed !important;
  top: auto !important;
  bottom: 0 !important;
  right: 0 !important;
  height: 60vh !important;
  max-height: 60vh !important;
  z-index: 10000000 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* When only Memory Manager is open */
body:not(.sai-mm-gen-settings-open)
  div.fixed.left-1\\/2.top-1\\/2.h-full.max-h-\\[600px\\]:not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* When only Generation Settings is open */
body:not(.sai-mm-memories-open)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full),
body:not(.sai-mm-memories-open)
  div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not([hidden]):not(.hidden):not(.size-full) {
  top: 0 !important;
  bottom: 0 !important;
  height: 100vh !important;
  max-height: 100vh !important;
  z-index: 10000000 !important;
}

/* ===== Generation panel internals: sticky footer & safe scroller ===== */

div.fixed.left-1\\/2.top-1\\/2:has(.flex.flex-col.gap-sm.px-lg) .flex.flex-col.gap-sm.px-lg {
  position: sticky !important;
  bottom: 0 !important;
  z-index: 2 !important;
  background: inherit !important;
}

div.fixed.left-1\\/2.top-1\\/2:has(.flex.flex-col.gap-sm.px-lg) > [class*="overflow-y-auto"] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  padding-bottom: 0.5rem !important;
}

div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full) {
  display: flex !important;
  flex-direction: column !important;
}

div.fixed.left-1\\/2.top-1\\/2:not(:has(.flex.flex-col.gap-sm.px-lg)) [class*="overflow-y-auto"] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
}

/* Inner scrollers fill split panels when BOTH modals are open */
body.sai-mm-gen-settings-open.sai-mm-memories-open
  div.fixed.left-1\\/2.top-1\\/2:not(.size-full) [class*="overflow-y-auto"] {
  height: 100% !important;
  max-height: 100% !important;
  overflow-y: auto !important;
}

/* Keep Generation Settings modal visible (prevent React from hiding it) */
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full),
div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full) {
  display: flex !important;
  visibility: visible !important;
  opacity: 1 !important;
}

/* ===== Chat container / gutter ===== */

@media (min-width: 1000px) {
  body.sai-mm-any-center-modal-open
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - 220px) !important;
    max-width: calc(100vw - var(--mm-gutter) - 220px) !important;
    box-sizing: border-box !important;
  }
}

div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
  box-sizing: border-box !important;
  overflow-x: hidden !important;
  overflow-y: visible !important;
}

div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
  position: relative;
  /* No right padding: the real scrollbar lives on the absolutely-positioned
     .custom-scroll child, whose containing block sits inside this element's
     content box. Any right padding here insets that scroller and pushes its
     scrollbar inward, leaving a gutter between the scrollbar and the viewport
     edge (its apparent width varies by browser because the scrollbar's own
     reserved track stacks on top of the padding). Keep it 0 so the scrollbar
     sits flush against the right edge. Messages/composer stay readable because
     they're centered via max-width + margin:auto, not via this padding.
     NOTE: the <1000px rule below re-adds 16px for mobile symmetry with the
     left padding. The sidebar-modal-open override intentionally does NOT —
     see its own comment for why. */
  padding-right: 0 !important;
  padding-left: 16px !important;
  padding-top: 0px !important;
  align-items: flex-start;
  box-sizing: border-box !important;
  overflow-x: visible !important;
  max-height: calc(100vh - 56px) !important;
}

@media (min-width: 1000px) {
  body.sai-mm-any-center-modal-open
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 220px) !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }

  /* BUGFIX: padding-right here used to be 16px to "separate the chat from
     the pinned right panel." But this container is position:relative and
     its absolutely-positioned scroller child (see comment above) uses its
     padding box as containing block — so that padding insets the scroller
     and its native scrollbar away from the sidebar, leaving a visible gap
     between the scrollbar and the sidebar's left edge instead of the
     scrollbar sitting flush against it. Keep it 0 like the no-modal case;
     messages already have plenty of clearance since they're centered at
     max-width well short of the full container width. */
  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 {
    padding-right: 0 !important;
    max-height: calc(100vh - 56px) !important;
    flex: 1 1 auto !important;
  }

  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: 100% !important;
    overflow: visible !important;
    padding-top: 0.5rem !important;
  }

  body.sai-mm-any-center-modal-open
    div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2
    > div.flex.flex-col.justify-undefined.items-undefined.grow.relative.w-full
    > div.grow.flex.flex-col.w-full.left-0.items-center.absolute.h-full.overflow-auto {
    overflow-y: auto !important;
    overflow-x: visible !important;
  }

  /* OVERRIDE: When left sidebar is collapsed (54px instead of 220px) */
  body.sai-mm-nav-collapsed.sai-mm-any-center-modal-open
    div.p-0[style*="width: 100%"][style*="display: flex"][style*="flex-direction: column"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  /* OVERRIDE: Header bar when left sidebar is collapsed */
  body.sai-mm-nav-collapsed.sai-mm-any-center-modal-open
    div.sticky.top-0[class*="z-[100]"] {
    width: calc(100vw - var(--mm-gutter) - 54px) !important;
    max-width: calc(100vw - var(--mm-gutter) - 54px) !important;
  }

  body.sai-mm-any-center-modal-open
    .py-md.rounded-\\[20px_4px_20px_20px\\],
  body.sai-mm-any-center-modal-open
    .py-md.rounded-\\[4px_20px_20px_20px\\],
  body.sai-mm-any-center-modal-open
    [class*="max-w-\\\\[800px\\\\]"] {
    width: 100% !important;
    max-width: var(--sai-message-max-width, 800px) !important;
    box-sizing: border-box !important;
  }

  body.sai-mm-any-center-modal-open
    [class*="max-w-\\\\[800px\\\\]"] {
    max-width: min(var(--sai-message-max-width, 800px), 100%) !important;
  }
}

@media (max-width: 999px) {
  div.fixed.left-1\\/2.top-1\\/2 { display: none !important; }
  div.flex.grow.flex-col.top-0.left-0.w-full.h-full.bg-gray-2 { 
    padding-right: 16px !important;
    max-height: 100vh !important; /* No header in narrow view, use full viewport */
  }
}

/* ===== Center message bubbles ===== */
div.w-full.flex.mb-lg.bg-transparent.items-center.justify-between {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* ===== Center message input container (the one with max-width: 800px inline style) ===== */
/* The centered container with the input box - ALWAYS center it, not just when modal is open */
div.flex.flex-col.justify-undefined.items-undefined.items-center.p-md.w-full
  > div.flex.justify-undefined.items-undefined.bg-transparent.w-full[style*="max-width"] {
  width: 100% !important;
  max-width: var(--sai-message-max-width, 800px) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  box-sizing: border-box !important;
}`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Rounded Profile Images
    // =============================================================================
    function getRoundedProfileImagesCSSEarly() {
        return `
/* Rounded PFP */
button.w-11 img {
    border-radius: 16px !important;
}

span:has(.text-warning) .leading-6 { 
    display: block !important; 
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Swap Checkbox Position
    // =============================================================================
    function getSwapCheckboxPositionCSSEarly() {
        return `
/* Swap selection checkbox positions */
.w-full.flex.mb-lg.bg-transparent.items-center {
    flex-direction: row-reverse !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Square Message Edges
    // =============================================================================
    function getSquareMessageEdgesCSSEarly() {
        return `
/* Square message box edges */
.py-md.rounded-\\[4px_20px_20px_20px\\],
.py-md.rounded-\\[20px_4px_20px_20px\\] {
    border-radius: 4px !important;
}
`;
    }

    // =============================================================================
    // CSS GENERATION FUNCTIONS - Memory Dot Customization
    // =============================================================================
    // FUNCTION: getMemoryDotCSSEarly()
    // PURPOSE: Customize the memory limit indicator dot (red dot in chat toolbar)
    // FEATURE: "Memory Limit Indicator" settings in Style tab
    // 
    // WHAT IT DOES:
    // - Hides the parent container (div.relative) if disabled
    // - Changes the dot color if custom color is set
    // 
    // CSS SELECTORS:
    // - div.relative[data-testid="ContextCapIndicator"] = Parent container (using data-testid)
    // - button[data-testid="ContextCapIndicator-Button"] = Memory button (using data-testid)
    // - Default classes: w-3 h-3 rounded-full cursor-pointer bg-gray-9 border border-gray-11
    // 
    // PARAMETERS:
    // - enabled: boolean - true = show dot (default), false = hide container
    // - color: string - CSS color value (default: #ff3b3b)
    // =============================================================================
    function getMemoryDotCSSEarly(enabled, color) {
        if (!enabled) {
            // Hide the parent container of the memory dot entirely
            return `
/* Hide Memory Limit Indicator Dot and Parent Container */
div[data-testid="ContextCapIndicator"] {
    display: none !important;
}
`;
        }
        
        if (color && color !== '#ff3b3b') {
            // Change the memory dot color
            return `
/* Custom Memory Limit Indicator Dot Color */
button[data-testid="ContextCapIndicator-Button"] {
    background-color: ${color} !important;
    border-color: ${color} !important;
    box-shadow: 0 4px 6px -1px ${color}70, 0 2px 4px -1px ${color}70 !important;
}
`;
        }
        
        return ''; // No customization needed
    }

    // =============================================================================
    // Wait for DOM to be ready before running main code
    // =============================================================================
    
    async function initializeMainCode() {
        debugLog('[Core] DOM ready, initializing main code...');
        
        // =============================================================================
        // STORAGE CACHE - Reduce redundant storage reads (Issue #13)
        // =============================================================================
        const storageCache = {
            data: {},
            timestamps: {},
            TTL: TIMING.STORAGE_CACHE_TTL,
            
            async get(key, defaultValue) {
                const now = Date.now();
                // Check if cached and not expired
                if (this.data[key] !== undefined && 
                    this.timestamps[key] && 
                    (now - this.timestamps[key]) < this.TTL) {
                    debugLog('[Cache] HIT:', key);
                    return this.data[key];
                }
                
                // Cache miss - fetch from storage
                debugLog('[Cache] MISS:', key);
                const value = await storage.get(key, defaultValue);
                this.data[key] = value;
                this.timestamps[key] = now;
                return value;
            },
            
            async set(key, value) {
                // Update cache and storage
                this.data[key] = value;
                this.timestamps[key] = Date.now();
                await storage.set(key, value);
            },
            
            invalidate(key) {
                delete this.data[key];
                delete this.timestamps[key];
            },
            
            clear() {
                this.data = {};
                this.timestamps = {};
            }
        };
        
        // Make cache available globally within this scope
        window.__toolkitStorageCache = storageCache;

    // =============================================================================
    // ===              AUTH HEADER INTERCEPTOR FOR MEMORY REFRESH              ===
    // =============================================================================
    // NOTE: The auth header interceptor has been moved to page-context.js
    // It is injected as an external script (CSP-compliant) and runs in page context
    // where it can intercept XHR/fetch calls to capture auth tokens and headers.
    // The interceptor stores tokens in window.__kindeAccessToken and 
    // window.__lastAuthHeaders for use by chat export and memory refresh features.
    // =============================================================================

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===              INFERENCE PROFILES & MESSAGE STATS - START              ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    const PROFILES_KEY = 'generationProfiles';
    const LAST_PROFILE_KEY = 'lastSelectedProfile';
    // NOTE: message stats no longer live in storage.local — they are owned by the
    // background IndexedDB store and accessed via SAI_STATS_* messages (sendStatsMessage).
    let lastGenerationSettings = null;
    let pendingMessageStats = null; // Store stats temporarily until message appears in DOM
    let loadedMessageIds = []; // Store message IDs from GET /messages response
    let messageIdToIndexMap = {}; // Map bot message IDs to their order in the conversation
    // Separate from messageIdToIndexMap on purpose: that map's keys are
    // window-relative 0-based positions (GET /messages is windowed to
    // ?limit=50, and existing fallback lookups throughout this file compute
    // `storageOffset + messageIndex` to match — a small, 0-based number for
    // whatever's in the CURRENTLY loaded window). Overwriting those keys with
    // absolute positions broke every one of those lookups. This map instead
    // holds id -> absolute 1-based display number (calibrated against the
    // API's num_messages total in the SAI_MESSAGES_LOADED handler), read only
    // by getMessageNumber() for the Story Mode "| #N" display.
    let messageDisplayNumberMap = {};
    let userMessageIdToIndexMap = {}; // Map user message IDs to their order in the conversation
    let currentConversationId = null; // Store the actual conversation ID from API
    
    // Track alternative message groups for regeneration switching
    // Structure: { prev_id: [msg1_id, msg2_id, ...] } - sorted by createdAt (oldest first)
    let alternativeMessageGroups = {};
    
    // Track which prevIds we've seen messages for (to detect regenerations)
    // Structure: { prevId: [messageId1, messageId2, ...] }
    let prevIdToMessageIds = {};
    
    // Store message timestamps from API responses (source of truth for timestamps)
    // Structure: { messageId: createdAt (unix ms) }
    let messageTimestamps = {};

    // In-memory set of bot message IDs — used by story mode to classify messages
    // without requiring a stored stats entry (which won't exist for null-inference messages)
    const botMessageIds = new Set();

    // Track which message IDs have already had stats inserted to prevent duplicates
    // Note: We clear these sets when navigating conversations to allow re-insertion
    const statsInsertedForMessageIds = new Set();      // Successfully inserted
    const statsInsertionInProgress = new Set();        // Currently being processed (prevents parallel runs)
    // Declared here, before the message listener is registered, so the handler can never hit the TDZ
    let statsFailedForWrappers = new WeakSet();        // Wrappers that failed ID extraction (prevents retries)

    // Track how many new messages are pending insertion (used to skip newest messages in processMessagesForStats)
    // This prevents race conditions where processMessagesForStats runs before insertStatsForRegeneratedMessage
    let pendingNewMessageCount = 0;

    // Helper function to detect if we're in Story Mode
    // Supports localized URLs: /story/ or /{language}/story/
    function isStoryMode() {
        return /\/(?:[a-z]{2}\/)?story\//i.test(window.location.pathname);
    }
    
    // Build an SVG element from a tag + attribute map, with optional children.
    // Children entries: ['tag', { attr: value, ... }]. Used for the lucide-style
    // icons we previously assembled with innerHTML on Button elements.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function makeSVG(rootAttrs, children) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        for (const [k, v] of Object.entries(rootAttrs)) svg.setAttribute(k, v);
        if (children) {
            for (const [tag, attrs] of children) {
                const node = document.createElementNS(SVG_NS, tag);
                for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
                svg.appendChild(node);
            }
        }
        return svg;
    }

    // Parse a static HTML template string into a DocumentFragment, avoiding
    // .innerHTML assignment (which Mozilla's addons-linter flags). Use this with
    // element.replaceChildren(parseHTMLToFragment(template)) for static markup.
    // DOMParser does not execute scripts and is the standard recommended path.
    function parseHTMLToFragment(html) {
        const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        const frag = document.createDocumentFragment();
        // Move children out of the parsed body into our fragment, adopting them
        // into the live document so subsequent queries work as expected.
        while (doc.body.firstChild) {
            frag.appendChild(document.adoptNode(doc.body.firstChild));
        }
        return frag;
    }

    // Helper function to safely set HTML content (sanitizes input)
    function safeSetHTML(element, content) {
        // For simple text content, use textContent
        if (!content.includes('<')) {
            element.textContent = content;
            return;
        }
        
        // For content with <br> tags, convert to text nodes and actual <br> elements
        // This avoids innerHTML security warnings while preserving line breaks
        element.textContent = ''; // Clear existing content
        const parts = content.split(/<br\s*\/?>/i);
        parts.forEach((part, index) => {
            if (part) {
                element.appendChild(document.createTextNode(part));
            }
            if (index < parts.length - 1) {
                element.appendChild(document.createElement('br'));
            }
        });
    }

    // =============================================================================
    // ===              AUTO-REGENERATION LOGIC                                 ===
    // =============================================================================
    
    // Track auto-regeneration attempts per message thread
    // Key = prevId (the message being regenerated), Value = attempt count
    const autoRegenAttempts = {};
    
    // Cached settings for synchronous access
    window.__autoRegenOnMismatch = false;
    window.__autoRegenOnShort = false;
    window.__autoRegenMaxAttempts = 1;
    
    // When model override is active, suppress the first mismatch regen (model change is expected)
    window.__suppressMismatchNext = false;
    
    // Track the last known engine to detect mismatches on new messages
    window.__lastKnownEngine = null;
    
    // Flag to prevent re-entrancy during auto-regeneration
    window.__autoRegenInProgress = false;
    
    /**
     * Click the regenerate button on the last bot message.
     * The button has aria-label="RefreshCcw-button" and is in the last message's controls.
     */
    function clickRegenerateButton() {
        // Find all message wrappers with the regenerate button
        const regenButtons = document.querySelectorAll('button[aria-label="RefreshCcw-button"]');
        if (regenButtons.length === 0) {
            debugLog('[AutoRegen] No regenerate button found');
            return false;
        }
        // Click the LAST regenerate button (most recent message)
        const lastRegenBtn = regenButtons[regenButtons.length - 1];
        debugLog('[AutoRegen] Clicking regenerate button');
        lastRegenBtn.click();
        return true;
    }
    
    /**
     * Check if auto-regeneration should occur and trigger it.
     * Called when a new bot message is received.
     * @param {string} prevId - The previous message ID (used to track regen attempts)
     * @param {string} responseEngine - The engine used for this response
     * @param {number} responseContentLength - Length of the response content
     */
    function checkAndAutoRegenerate(prevId, responseEngine, responseContentLength) {
        if (window.__autoRegenInProgress) {
            debugLog('[AutoRegen] Already in progress, skipping');
            return;
        }
        
        const maxAttempts = window.__autoRegenMaxAttempts || 1;
        const trackingKey = prevId || 'unknown';
        const currentAttempts = autoRegenAttempts[trackingKey] || 0;
        
        if (currentAttempts >= maxAttempts) {
            debugLog('[AutoRegen] Max attempts reached for', trackingKey.substring(0, 8), ':', currentAttempts, '/', maxAttempts);
            // Reset tracking for this message thread
            delete autoRegenAttempts[trackingKey];
            window.__autoRegenInProgress = false;
            return;
        }
        
        let shouldRegen = false;
        let reason = '';
        
        // Check for model mismatch
        // Require both engines to be non-blank — a blank previous engine means we have no
        // valid baseline to compare against (e.g. first message, or engine field missing
        // from a prior response), so we must not regenerate.
        const hasValidPrevEngine = typeof window.__lastKnownEngine === 'string' && window.__lastKnownEngine.trim() !== '';
        const hasValidCurrEngine = typeof responseEngine === 'string' && responseEngine.trim() !== '';
        if (window.__autoRegenOnMismatch && hasValidCurrEngine && hasValidPrevEngine) {
            // Use the same core model extraction as applyModelChangeIndicators
            const extractCoreModel = (engineString) => {
                if (!engineString) return null;
                const slashIndex = engineString.indexOf('/');
                if (slashIndex === -1) return engineString.toLowerCase().trim();
                const afterSlash = engineString.substring(slashIndex + 1);
                const underscoreIndex = afterSlash.indexOf('_');
                if (underscoreIndex === -1) return afterSlash.toLowerCase().trim();
                return afterSlash.substring(0, underscoreIndex).toLowerCase().trim();
            };
            
            const currentCore = extractCoreModel(responseEngine);
            const previousCore = extractCoreModel(window.__lastKnownEngine);
            
            debugLog('[AutoRegen] Mismatch check - current:', currentCore, 'previous:', previousCore);
            
            if (currentCore && previousCore && currentCore !== previousCore) {
                if (window.__suppressMismatchNext) {
                    window.__suppressMismatchNext = false;
                    debugLog('[AutoRegen] Mismatch suppressed for this message (model override: change was expected)');
                } else {
                    shouldRegen = true;
                    reason = `model mismatch (${previousCore} → ${currentCore})`;
                }
            }
        }
        
        // Check for short response
        if (!shouldRegen && window.__autoRegenOnShort && responseContentLength !== undefined) {
            if (responseContentLength < 50) {
                shouldRegen = true;
                reason = `short response (${responseContentLength} chars < 50)`;
            }
        }
        
        if (shouldRegen) {
            autoRegenAttempts[trackingKey] = currentAttempts + 1;
            debugLog('[AutoRegen] Triggering auto-regeneration - reason:', reason, '- attempt:', currentAttempts + 1, '/', maxAttempts);
            
            window.__autoRegenInProgress = true;
            
            // Delay slightly to let the DOM update with the new message before clicking regen
            setTimeout(() => {
                const clicked = clickRegenerateButton();
                if (!clicked) {
                    debugLog('[AutoRegen] Failed to click regenerate button');
                    window.__autoRegenInProgress = false;
                } else {
                    // Reset the in-progress flag after a reasonable time for the regen to complete
                    // The next SAI_NEW_MESSAGE will trigger another check if needed
                    setTimeout(() => {
                        window.__autoRegenInProgress = false;
                    }, 2000);
                }
            }, 1500);
        } else {
            // Successful message (no regen needed) - reset attempt tracking for this thread
            if (autoRegenAttempts[trackingKey]) {
                debugLog('[AutoRegen] Message passed checks, resetting attempt counter for', trackingKey.substring(0, 8));
                delete autoRegenAttempts[trackingKey];
            }
            // Update last known engine for future comparisons.
            // Skip blank/whitespace values so we don't poison the baseline.
            if (typeof responseEngine === 'string' && responseEngine.trim() !== '') {
                window.__lastKnownEngine = responseEngine;
                debugLog('[AutoRegen] Updated lastKnownEngine to:', responseEngine);
            }
        }
    }

    // Helper function to check if model changed from previous message and apply indicator
    // This function should be called AFTER all stats are populated, as a final pass
    function applyModelChangeIndicators() {
        // Check if the feature is enabled
        if (!window.__highlightModelChanges) {
            // Feature disabled - remove any existing borders
            document.querySelectorAll('.generation-stats').forEach(statsDiv => {
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
            });
            return;
        }
        
        debugLog('[Model Change] Applying model change indicators to all stats divs');
        
        // Get all generation-stats divs in document order (chronological)
        const allStatsDivs = Array.from(document.querySelectorAll('.generation-stats'));
        debugLog('[Model Change] Found', allStatsDivs.length, 'stats divs');
        
        // Extract core model identifier from full engine string
        // Examples:
        //   "zai-org/GLM-4.6" → "GLM-4.6"
        //   "zai-org/GLM-4.6_friendli_dedicated" → "GLM-4.6"
        //   "anthropic/claude-3-opus" → "claude-3-opus"
        const extractCoreModel = (engineString) => {
            if (!engineString) return null;
            
            // Find the part between "/" and first "_" (or end if no "_")
            const slashIndex = engineString.indexOf('/');
            if (slashIndex === -1) {
                // No slash, return the whole string
                return engineString.toLowerCase().trim();
            }
            
            // Get everything after the slash
            const afterSlash = engineString.substring(slashIndex + 1);
            
            // Find the first underscore (if any)
            const underscoreIndex = afterSlash.indexOf('_');
            if (underscoreIndex === -1) {
                // No underscore, return everything after slash
                return afterSlash.toLowerCase().trim();
            }
            
            // Return the part between slash and underscore
            return afterSlash.substring(0, underscoreIndex).toLowerCase().trim();
        };
        
        // Extract engine from a stats div's HTML content
        // The first line contains model info like "glm47-beta → zai-org/glm-4.7"
        // We need to parse innerHTML since textContent doesn't preserve <br> as newlines
        const extractEngine = (statsDiv) => {
            // Get innerHTML and split by <br> to get the first line
            const html = statsDiv.innerHTML || '';
            const firstLine = html.split(/<br\s*\/?>/i)[0].trim();
            
            debugLog('[Model Change] First line from HTML:', firstLine);
            
            // Format is typically: "model → engine" or just timestamp/ID
            if (firstLine.includes('→')) {
                const engine = firstLine.split('→')[1].trim();
                debugLog('[Model Change] Extracted engine:', engine);
                return engine;
            }
            // If no arrow, this might be a timestamp-only stats div, skip it
            debugLog('[Model Change] No arrow found, returning null');
            return null;
        };
        
        let prevCoreModel = null;
        
        for (let i = 0; i < allStatsDivs.length; i++) {
            const statsDiv = allStatsDivs[i];
            const currentEngine = extractEngine(statsDiv);
            
            // Skip divs that don't have model info (e.g., timestamp-only user messages)
            if (!currentEngine) {
                // Don't update prevCoreModel, just clear any existing border
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
                continue;
            }
            
            // Extract core model identifier for comparison
            const currentCoreModel = extractCoreModel(currentEngine);
            
            debugLog('[Model Change] Stats div', i, '- Engine:', currentEngine, '| Core Model:', currentCoreModel, '| Prev Core:', prevCoreModel);
            
            if (prevCoreModel && currentCoreModel !== prevCoreModel) {
                // Model changed from previous - apply yellow border
                statsDiv.style.borderRight = '4px solid #fbbf24';
                statsDiv.style.paddingRight = '8px';
                debugLog('[Model Change] Applied yellow border to stats div', i, '(', prevCoreModel, '→', currentCoreModel, ')');
            } else {
                // Same model or first message - remove border
                statsDiv.style.borderRight = '';
                statsDiv.style.paddingRight = '';
            }
            
            // Update prevCoreModel for next iteration
            prevCoreModel = currentCoreModel;
            
            // Track the last engine seen for auto-regeneration mismatch detection
            window.__lastKnownEngine = currentEngine;
        }
    }
    
    // Wrapper function that can be called from multiple places
    function checkAndApplyModelChangeIndicator(statsDiv, currentModel) {
        // This is now just a stub - the actual work is done by applyModelChangeIndicators()
        // which runs as a final pass after all stats are inserted
    }

    // Build index map from stored message stats (for imported/old messages)
    async function buildIndexMapFromStats() {
        debugLog('[Stats] buildIndexMapFromStats starting...');

        // The index map is scoped to messages currently in view (those with an API
        // timestamp). At startup messageTimestamps is empty and SAI_MESSAGES_LOADED
        // rebuilds the map directly anyway, so skip the background round-trip entirely
        // until timestamps exist — avoids a wasted SAI_STATS_GET_CHARACTER on every load.
        if (!Object.keys(messageTimestamps).length) {
            debugLog('[Stats] buildIndexMapFromStats - no timestamps yet, skipping (rebuilt by MESSAGES_LOADED)');
            return;
        }

        const characterId = getCurrentCharacterId();
        // Stats are keyed by messageId (conversationId dropped); this returns ALL of
        // the character's stat records. Scope to the messages currently in view — i.e.
        // those with an API timestamp in messageTimestamps — which mirrors the old
        // per-conversation scoping (messageTimestamps is rebuilt per loaded conversation).
        const charStats = await loadCharacterStats(characterId);
        const messageIds = Object.keys(charStats).filter(id => messageTimestamps[id]);
        debugLog('[Stats] buildIndexMapFromStats - character:', characterId,
            '| records:', Object.keys(charStats).length, '| in-view:', messageIds.length);

        // Sort messages by API timestamp (oldest first). Records carry no timestamp,
        // so order by the in-memory messageTimestamps map.
        const sortedIds = messageIds.sort((a, b) => {
            const aTime = messageTimestamps[a] || 0;
            const bTime = messageTimestamps[b] || 0;
            return aTime - bTime;
        });

        // Build index map - this maps sequential index to message IDs
        // This is only used as a fallback when extractMessageId() fails
        sortedIds.forEach((id, index) => {
            messageIdToIndexMap[index] = id;
        });

        debugLog('[Stats] Built index map from storage:', Object.keys(messageIdToIndexMap).length, 'messages');
    }

    // Stats live in the background's IndexedDB store (extension origin). Content
    // requests the CURRENT character's records and caches them briefly for the
    // display passes. cachedCharStatsId tracks which character the cache is for so
    // navigating between bots refetches.
    // PERFORMANCE: one indexed query per character view instead of parsing an 11 MB blob.
    let cachedCharStats = null;
    let cachedCharStatsId = null;
    let cachedCharStatsTime = 0;
    const STATS_CACHE_TTL = 2000; // 2 seconds - short TTL since stats can change

    // Serialises content-side write messages so concurrent MESSAGES_LOADED handlers
    // (rapid chat navigation) keep their send ordering. The background owns the store
    // and applies each PUT/DELETE in an atomic transaction, so the old whole-blob
    // clobber race (the 1,836-entry incident) is structurally impossible now.
    let statsWriteQueue = Promise.resolve();

    // Load the current character's stats as { [messageId]: {model,max_tokens,temperature,top_p,top_k,role} }
    // from the background store, cached for STATS_CACHE_TTL.
    async function loadCharacterStats(characterId) {
        const now = Date.now();
        if (cachedCharStats && cachedCharStatsId === characterId && (now - cachedCharStatsTime) < STATS_CACHE_TTL) {
            return cachedCharStats;
        }
        let map = {};
        if (characterId) {
            try {
                const res = await sendStatsMessage('SAI_STATS_GET_CHARACTER', { characterId }, 1, STATS_READ_TIMEOUT_MS);
                if (res && res.success && res.stats) {
                    map = res.stats;
                    if (_heldStatsMayExist) flushHeldStats();   // background is alive: catch up
                }
            } catch (e) {
                debugLog('[Stats] loadCharacterStats failed:', e && e.message);
            }
            // Overlay records still parked in the holding list, so messages keep
            // their stats on screen while the background page is down.
            const held = await getHeldStatsForCharacter(characterId);
            Object.keys(held).forEach((id) => {
                const base = map[id] || {};
                const merged = { ...base };
                STATS_RECORD_FIELDS.forEach((f) => {
                    if (held[id][f] !== null) merged[f] = held[id][f];
                    else if (merged[f] === undefined) merged[f] = null;
                });
                map[id] = merged;
            });
        }
        cachedCharStats = map;
        cachedCharStatsId = characterId;
        cachedCharStatsTime = now;
        return map;
    }

    // Invalidate stats cache (call after writes, and on SAI_DRIVE_SYNC_COMPLETE)
    function invalidateStatsCache() {
        cachedCharStats = null;
        cachedCharStatsId = null;
        cachedCharStatsTime = 0;
    }

    // Remove a single stored entry (used to evict corrupted records).
    // explicitConversationId is retained for call-site compatibility but ignored —
    // the store is keyed by globally-unique messageId.
    async function deleteStatsEntry(messageId, explicitConversationId = null) {
        await (statsWriteQueue = statsWriteQueue.catch(() => {}).then(async () => {
            try {
                await removeHeldStats(messageId);
                await sendStatsMessage('SAI_STATS_DELETE', { messageId });
                invalidateStatsCache();
                debugLog('[Stats] deleteStatsEntry: removed entry for', messageId.substring(0, 8));
            } catch (e) {
                debugLog('[Stats] deleteStatsEntry failed:', e && e.message);
            }
        }));
    }

    // Startup cleanup: ask the background to drop null-only records from the store.
    // (Can also be called after import.) Background serialises this against writes.
    async function pruneNullStats() {
        try {
            const res = await sendStatsMessage('SAI_STATS_PRUNE');
            if (res && res.success && res.removed) {
                debugLog('[Stats] pruneNullStats: removed', res.removed, 'null entries');
            }
        } catch (e) {
            debugLog('[Stats] pruneNullStats failed:', e && e.message);
        }
    }

    // Get stats for a specific message ID.
    // Keyed by globally-unique messageId, so cloned chats resolve directly (no
    // conversation scan needed). Timestamp is always overlaid from messageTimestamps.
    async function getStatsForMessage(messageId) {
        const characterId = getCurrentCharacterId();
        const charStats = await loadCharacterStats(characterId);

        // Start with an empty stats object
        let stats = null;

        const storedStats = charStats[messageId] || null;
        if (storedStats) {
            // Only copy generation settings, not timestamp
            stats = {
                model: storedStats.model,
                max_tokens: storedStats.max_tokens,
                temperature: storedStats.temperature,
                top_p: storedStats.top_p,
                top_k: storedStats.top_k,
                role: storedStats.role
            };
        }

        // ALWAYS get timestamp from messageTimestamps (API source of truth)
        // This works even if no other stats are stored (e.g., user messages)
        if (messageTimestamps[messageId]) {
            if (!stats) {
                stats = {};
            }
            stats.timestamp = messageTimestamps[messageId];
        }

        if (stats) {
            return stats;
        }

        debugLog('[Stats] getStatsForMessage - not found (no stored stats and no API timestamp) for', messageId);
        return null;
    }
    
    // Helper: Check if current path is a chat page (supports localization: /chat/ or /{language}/chat/)
    // Supports both formats: /chat/{charId} and /en/chat/{charId}, /fr/chat/{charId}, etc.
    function isOnChatPage() {
        const path = window.location.pathname.toLowerCase();
        // Match both /chat/ and /{2-letter-lang}/chat/ patterns
        return /^\/([a-z]{2}\/)?chat\//i.test(window.location.pathname) || path.startsWith('/chat/');
    }
    
    // Helper: Get normalized chat URL pattern that supports localization
    // Returns regex that matches both /chat/ and /{language}/chat/
    function getChatUrlPattern() {
        return /^\/([a-z]{2}\/)?chat\//i;
    }

    // Get current character ID from URL
    function getCurrentCharacterId() {
        // URL structure: 
        // - Chat mode: /chat/{character_id} or /chat/{character_id}/{conversation_id}
        //             or /{language}/chat/{character_id} (with localization)
        // - Story mode: /story/{character_id}/{conversation_id}
        // Note: URL may have mixed case so use case-insensitive match
        
        // Try /chat/ pattern first (supports optional language prefix: /en/chat/ or /chat/)
        const chatMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chat\/([a-f0-9-]+)/i);
        if (chatMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /chat/ URL:', chatMatch[1]);
            return chatMatch[1];
        }
        
        // Try /story/ pattern (Story Mode) - supports optional language prefix
        const storyMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?story\/([a-f0-9-]+)/i);
        if (storyMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /story/ URL:', storyMatch[1]);
            return storyMatch[1];
        }

        // Fallback: Try /chatbot/ pattern if on character profile page - supports optional language prefix
        const chatbotMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chatbot\/([a-f0-9-]+)/i);
        if (chatbotMatch) {
            debugLog('[Stats] getCurrentCharacterId - from /chatbot/ URL:', chatbotMatch[1]);
            return chatbotMatch[1];
        }

        debugLog('[Stats] getCurrentCharacterId - not found, URL:', window.location.pathname);
        return null;
    }

    // Get current conversation ID from URL
    function getCurrentConversationId() {
        // URL structure: /chat/{character_id}/{conversation_id} or /story/{character_id}/{conversation_id}
        //               or /{language}/chat/{character_id}/{conversation_id} (with localization)
        // If only /chat/{character_id}, conversation_id will be null (defaults to most recent)
        // Note: URL may have /Chat/ or /Story/ (capital letters) so use case-insensitive match
        const chatMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?chat\/[a-f0-9-]+\/([a-f0-9-]+)/i);
        if (chatMatch) {
            debugLog('[Stats] getCurrentConversationId - from /chat/ URL:', chatMatch[1]);
            return chatMatch[1];
        }
        
        const storyMatch = window.location.pathname.match(/\/(?:[a-z]{2}\/)?story\/[a-f0-9-]+\/([a-f0-9-]+)/i);
        if (storyMatch) {
            debugLog('[Stats] getCurrentConversationId - from /story/ URL:', storyMatch[1]);
            return storyMatch[1];
        }
        
        debugLog('[Stats] getCurrentConversationId - URL:', window.location.pathname, 'extracted: null');
        return null;
    }
    
    // Store stats for a specific message ID.
    // Keyed by messageId in the background IndexedDB store; characterId rides on the
    // record for the by_character index. explicitConversationId is retained for
    // call-site compatibility but ignored — conversationId is no longer part of the model.
    async function storeStatsForMessage(messageId, stats, explicitConversationId = null) {
        // Never store user-role messages — timestamps come from messageTimestamps map
        if (stats.role === 'user') return;

        // Skip if there is no meaningful generation data to store
        const hasData = stats.model
            || stats.settings?.max_new_tokens != null
            || stats.settings?.temperature != null
            || stats.settings?.top_p != null
            || stats.settings?.top_k != null
            || stats.max_tokens != null
            || stats.temperature != null
            || stats.top_p != null
            || stats.top_k != null;
        if (!hasData) return;

        const characterId = getCurrentCharacterId();
        if (!characterId) {
            debugLog('[Stats] Warning: Missing character ID - cannot store stats');
            return;
        }

        // Build the record — generation settings only (timestamp comes from messageTimestamps).
        // Flatten both stats.settings.* and flat stats.* shapes (settings wins via ||).
        const record = {
            messageId: messageId,
            characterId: characterId,
            model: stats.model || null,
            max_tokens: stats.settings?.max_new_tokens || stats.max_tokens || null,
            temperature: stats.settings?.temperature || stats.temperature || null,
            top_p: stats.settings?.top_p || stats.top_p || null,
            top_k: stats.settings?.top_k || stats.top_k || null,
            role: stats.role || null
        };

        // Serialise through the write queue so concurrent handlers keep send ordering.
        await (statsWriteQueue = statsWriteQueue.catch(() => {}).then(async () => {
            // Delivered to the background store, or parked in the holding list if the
            // background page isn't answering (see putStatsRecordDurably).
            const outcome = await putStatsRecordDurably(record);
            invalidateStatsCache();
            debugLog('[Stats]', outcome === 'stored' ? 'Stored' : outcome === 'held' ? 'Held (background unavailable)' : 'LOST',
                'stats for character:', characterId, 'message:', messageId, record);
        }));
    }

    // Extract message ID from DOM element
    function extractMessageId(container) {
        // Method 1: Check for data-message-id attribute
        let messageElement = container.closest('[data-message-id]');
        if (messageElement) {
            const id = messageElement.getAttribute('data-message-id');
            debugLog('[Stats] extractMessageId - Method 1 (data-message-id):', id);
            return id;
        }
        
        // Method 2: Look for message ID in React props
        let current = container;
        for (let i = 0; i < 10; i++) {
            if (!current) break;
            const keys = Object.keys(current);
            const reactKey = keys.find(key => key.startsWith('__reactProps') || key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber'));
            if (reactKey) {
                const props = current[reactKey];
                
                // Try different paths to find message ID
                if (props?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React props.message.id):', props.message.id);
                    return props.message.id;
                }
                if (props?.children?.props?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React children):', props.children.props.message.id);
                    return props.children.props.message.id;
                }
                if (props?.memoizedProps?.message?.id) {
                    debugLog('[Stats] extractMessageId - Method 2 (React memoized):', props.memoizedProps.message.id);
                    return props.memoizedProps.message.id;
                }
            }
            current = current.parentElement;
        }
        
        // Method 3: Check nearby button handlers for ID patterns
        const nearbyButtons = container.querySelectorAll('button[aria-label]');
        for (const btn of nearbyButtons) {
            const keys = Object.keys(btn);
            const reactKey = keys.find(key => key.startsWith('__reactProps') || key.startsWith('__reactFiber'));
            if (reactKey && btn[reactKey]?.onClick) {
                const handler = btn[reactKey].onClick.toString();
                const uuidMatch = handler.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (uuidMatch) {
                    debugLog('[Stats] extractMessageId - Method 3 (button handler):', uuidMatch[0]);
                    return uuidMatch[0];
                }
            }
        }
        
        debugLog('[Stats] extractMessageId - ALL METHODS FAILED');
        return null;
    }

    // Normalize timestamp to UTC milliseconds (always store as number)
    function normalizeTimestamp(timestamp) {
        if (!timestamp) return null;
        
        // Already a number (Unix timestamp in milliseconds)
        if (typeof timestamp === 'number') {
            return timestamp;
        }
        
        // ISO string or other date string format
        if (typeof timestamp === 'string') {
            const date = new Date(timestamp);
            return isNaN(date.getTime()) ? null : date.getTime();
        }
        
        // Date object
        if (timestamp instanceof Date) {
            return isNaN(timestamp.getTime()) ? null : timestamp.getTime();
        }
        
        return null;
    }
    
    // Format timestamp according to system's locale settings
    async function formatTimestamp(timestamp) {
        if (!timestamp) return null; // Return null instead of current time
        
        // Normalize to UTC milliseconds first
        const normalized = normalizeTimestamp(timestamp);
        if (!normalized) return null;
        
        // Create Date object from normalized timestamp
        const date = new Date(normalized);
        if (isNaN(date.getTime())) return null;
        
        debugLog('[Stats] formatTimestamp input:', timestamp, 'normalized:', normalized, 'UTC date:', date.toISOString());
        const formatted = await formatDate(date);
        debugLog('[Stats] formatTimestamp output:', formatted);
        return formatted;
    }
    
    async function formatDate(date) {
        // Get user preferences for timestamp format
        // PERFORMANCE: Use cache if available to avoid storage reads during batch processing
        const cache = window.__toolkitStorageCache;
        const dateFirst = cache ? await cache.get('timestampDateFirst', true) : await storage.get('timestampDateFirst', true); // true = date@time, false = time@date
        const use24Hour = cache ? await cache.get('timestamp24Hour', false) : await storage.get('timestamp24Hour', false); // false = 12-hour (default), true = 24-hour
        
        // Use locale-aware formatting for date and time
        // This respects the browser's language/region settings
        const dateStr = date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const timeStr = date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: !use24Hour  // false for 24-hour, true for 12-hour
        });
        
        debugLog('[Stats] formatDate - dateFirst:', dateFirst, 'dateStr:', dateStr, 'timeStr:', timeStr);
        
        // Return format based on user preference
        return dateFirst ? `${dateStr} @ ${timeStr}` : `${timeStr} @ ${dateStr}`;
    }

    // Reverse-lookup a message's 1-based position in the full conversation
    // (both roles combined) from messageIdToIndexMap, for display next to its
    // timestamp in Story Mode (e.g. "... @ ... | #37") — see isStoryMode()
    // callers of formatTimestamp() below. O(n) over the index map, but only
    // run once per message when its stats line is (re-)built, not on every
    // mutation.
    function getMessageNumber(messageId) {
        if (!messageId) return null;
        return messageDisplayNumberMap[messageId] || null;
    }

    // Appends "| #N" (N = 1-based position in the full conversation) to a
    // formatted timestamp, Story Mode only — Chat Mode's shorter back-and-forth
    // doesn't need a running count the way a long, unattended Story Mode
    // session does. Falls back to the plain timestamp if the message isn't in
    // messageIdToIndexMap yet (e.g. it was just added and hasn't been indexed).
    function withStoryMessageNumber(timestamp, messageId) {
        if (!isStoryMode()) return timestamp;
        const number = getMessageNumber(messageId);
        return number ? `${timestamp} | #${number}` : timestamp;
    }

    // =============================================================================
    // HELPER: Find Generation Settings modal (supports both old and new UI)
    // =============================================================================
    // SpicyChat has multiple UI versions that they switch between. This helper
    // detects Generation Settings modal in both versions:
    // 
    // NEW UI (current as of Nov 2025):
    //   - Modal title uses <p class="text-heading-6">Generation Settings</p>
    //   - Model name in <p class="text-label-lg font-regular text-gray-12">
    //   - Sliders for: Max Tokens, Temperature, Top P, Top K
    //
    // OLD UI (used before, may return):
    //   - Modal title may use different heading structure (h2, h3, etc)
    //   - Model name in element with class="text-[14px] font-medium"
    //   - Same slider structure
    //
    // This function tries multiple detection methods to work with both UIs.
    // =============================================================================
    function findGenerationSettingsModal() {
        // Try multiple selectors for modal containers
        const modalSelectors = [
            'div.fixed.left-1\\/2.top-1\\/2',
            'div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]',
            'div.fixed[style*="left: 50%"]',
            'div.fixed[style*="left:50%"]'
        ];
        
        let allModals = [];
        for (const selector of modalSelectors) {
            const modals = Array.from(document.querySelectorAll(selector));
            allModals = allModals.concat(modals.filter(m => !allModals.includes(m)));
        }
        
        // Try to find modal by checking heading text
        for (const modal of allModals) {
            // New UI: Check for p.text-heading-6
            const newHeading = modal.querySelector('p.text-heading-6');
            if (newHeading && newHeading.textContent && newHeading.textContent.includes('Generation Settings')) {
                return modal;
            }
            
            // Old UI: Check for h2, h3, or other common heading tags
            const oldHeadings = modal.querySelectorAll('h2, h3, h4, p[class*="heading"], div[class*="title"]');
            for (const heading of oldHeadings) {
                if (heading && heading.textContent && heading.textContent.includes('Generation Settings')) {
                    return modal;
                }
            }
            
            // Fallback: Check if modal contains generation-related text anywhere
            const modalText = modal.textContent || '';
            if (modalText.includes('Inference Model') || 
                (modalText.includes('Temperature') && modalText.includes('Top P') && modalText.includes('Top K'))) {
                // Additional check: make sure it has sliders (not just text mentioning these terms)
                const sliders = modal.querySelectorAll('input[type="range"]');
                if (sliders.length >= 4) {
                    return modal;
                }
            }
        }
        
        return null;
    }

    // Get current settings from the modal
    async function getCurrentSettings() {
        try {
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                debugLog('[Core] Generation Settings modal not found in getCurrentSettings');
                return null;
            }

            // Find the model name - try multiple selectors for compatibility
            let model = 'Unknown';
            try {
                // New UI: Look for "Inference Model" label and associated model name
                const labels = modal.querySelectorAll('p.text-label-lg');
                const inferenceModelLabel = Array.from(labels).find(p => 
                    p && p.textContent && p.textContent.trim() === 'Inference Model'
                );
                if (inferenceModelLabel && inferenceModelLabel.parentElement) {
                    const modelNameElement = inferenceModelLabel.parentElement.querySelector('p.text-label-lg.font-regular.text-gray-12');
                    if (modelNameElement && modelNameElement.textContent) {
                        model = modelNameElement.textContent.trim();
                    }
                }
                
                // Old UI: Try the legacy selector
                if (model === 'Unknown') {
                    const modelElement = modal.querySelector('.text-\\[14px\\].font-medium');
                    if (modelElement && modelElement.textContent) {
                        model = modelElement.textContent.trim();
                    }
                }
                
                // Additional fallback: Look for any element that might contain model name
                if (model === 'Unknown') {
                    // Try to find text near "Inference Model" or "Model" label
                    const allTextElements = modal.querySelectorAll('p, span, div');
                    for (let i = 0; i < allTextElements.length; i++) {
                        const elem = allTextElements[i];
                        if (elem.textContent && elem.textContent.trim() === 'Inference Model') {
                            // Check next sibling or parent's next child
                            const nextElem = allTextElements[i + 1];
                            if (nextElem && nextElem.textContent && nextElem.textContent.trim().length > 0) {
                                const possibleModel = nextElem.textContent.trim();
                                // Verify it looks like a model name (contains common model keywords)
                                if (possibleModel.match(/llama|mixtral|qwen|gemma|deepseek|mistral/i)) {
                                    model = possibleModel;
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (modelError) {
                console.error('[Core] Error extracting model name:', modelError);
                model = 'Unknown';
            }

            // Get slider values (excluding max tokens - not saved in profiles)
            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length < 4) {
                console.error('[Core] Expected 4 sliders, found:', sliders ? sliders.length : 0);
                return null;
            }
            
            // Validate slider values before parsing
            const settings = {
                model: model,
                // responseMaxTokens is intentionally excluded - not saved in profiles
                temperature: sliders[1] && sliders[1].value !== undefined ? parseFloat(sliders[1].value) : 1,
                topP: sliders[2] && sliders[2].value !== undefined ? parseFloat(sliders[2].value) : 0.7,
                topK: sliders[3] && sliders[3].value !== undefined ? parseFloat(sliders[3].value) : 80
            };

            return settings;
        } catch (error) {
            console.error('[Core] Error in getCurrentSettings:', error);
            return null;
        }
    }

    // =============================================================================
    // MESSAGE LISTENERS FOR NETWORK INTERCEPTION DATA
    // These handlers receive postMessage events from the injected page-context script
    // =============================================================================
    
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        
        // Listen for network interception data from page context
        if (event.data.type === 'SAI_MESSAGES_LOADED') {
            debugLog('[Stats] Received SAI_MESSAGES_LOADED from page context');
            const { conversationId, botMessages, userMessages, label, numMessages } = event.data;
            
            // =================================================================
            // HANDLE CHAT LABEL FOR PAGE TITLE (extracted from GET /messages)
            // =================================================================
            debugLog('[ChatTitle CONTENT] ========== SAI_MESSAGES_LOADED RECEIVED ==========');
            debugLog('[ChatTitle CONTENT] Event data has label:', !!label);
            debugLog('[ChatTitle CONTENT] Label value:', label);
            
            // Store label (even if null) and always update title
            window.__saiChatLabel = label;
            debugLog('[ChatTitle CONTENT] Stored in window.__saiChatLabel:', window.__saiChatLabel);
            debugLog('[ChatTitle CONTENT] Calling updatePageTitle()...');
            
            // Always call updatePageTitle - it will handle both cases (with and without label)
            updatePageTitle();
            
            // =================================================================
            // HANDLE MESSAGE STATS PROCESSING
            // =================================================================
            
            // Store the conversation ID globally for buildIndexMapFromStats to use
            currentConversationId = conversationId;
            debugLog('[Stats] Conversation ID from event:', conversationId);
            debugLog('[Stats] Stored as currentConversationId:', currentConversationId);
            
            // Debug: Log first few messages
            if (botMessages.length > 0) {
                debugLog('[Stats] Sample bot messages:', botMessages.slice(0, 3).map(m => ({
                    id: m.id.substring(0, 8),
                    createdAt: m.createdAt,
                    time: new Date(m.createdAt).toLocaleTimeString()
                })));
            }
            if (userMessages.length > 0) {
                debugLog('[Stats] Sample user messages:', userMessages.slice(0, 3).map(m => ({
                    id: m.id.substring(0, 8),
                    createdAt: m.createdAt,
                    time: new Date(m.createdAt).toLocaleTimeString()
                })));
            }
            
            // Log all message IDs received from GET /messages
                debugLog('[Stats MESSAGES_LOADED] Total bot messages in GET response:', botMessages.length);
                debugLog('[Stats MESSAGES_LOADED] All bot message IDs:', botMessages.map(m => m.id));
            
            // =================================================================
            // BUILD MESSAGE TIMESTAMPS MAP (Source of truth for all timestamps)
            // =================================================================
            // Store createdAt from API for ALL messages - this is the authoritative source
            messageTimestamps = {};
            for (const msg of [...botMessages, ...userMessages]) {
                if (msg.id && msg.createdAt) {
                    messageTimestamps[msg.id] = msg.createdAt;
                }
            }
            debugLog('[Core] Built messageTimestamps map with', Object.keys(messageTimestamps).length, 'entries');
            
            // =================================================================
            // BUILD PREV_ID TO MESSAGE_IDS MAP (For regeneration detection)
            // =================================================================
            // Track which messageIds share the same prevId - used to detect regenerations
            prevIdToMessageIds = {};
            for (const msg of botMessages) {
                if (msg.prev_id && msg.id) {
                    if (!prevIdToMessageIds[msg.prev_id]) {
                        prevIdToMessageIds[msg.prev_id] = [];
                    }
                    if (!prevIdToMessageIds[msg.prev_id].includes(msg.id)) {
                        prevIdToMessageIds[msg.prev_id].push(msg.id);
                    }
                }
            }
            debugLog('[Core] Built prevIdToMessageIds map with', Object.keys(prevIdToMessageIds).length, 'entries');
            
            // =================================================================
            // BUILD ALTERNATIVE MESSAGE GROUPS FOR REGENERATION TRACKING
            // =================================================================
            // Messages with the same prev_id are alternatives of each other (same position in conversation)
            // The original (v1) has is_alternative=false, regenerations (v2, v3, etc.) have is_alternative=true
            // Group them together so we can switch between them when user clicks < >
            alternativeMessageGroups = {};
            
            // DEBUG: Log raw message data to see if is_alternative is being captured
            debugLog('[Core] Raw bot messages for alternative check:', botMessages.map(m => ({
                id: m.id?.substring(0, 8),
                is_alternative: m.is_alternative,
                prev_id: m.prev_id?.substring(0, 8)
            })));
            
            // First, find all messages that are alternatives (regenerations)
            const alternativeMessages = botMessages.filter(msg => msg.is_alternative && msg.prev_id);
            debugLog('[Core] Found', alternativeMessages.length, 'messages with is_alternative=true');
            debugLog('[Stats] Found', alternativeMessages.length, 'alternative messages');
            
            // Group by prev_id and include ALL messages with that prev_id (including v1)
            // IMPORTANT: All messages at the same conversation position share the same prev_id
            // The original (v1) is NOT marked is_alternative, but shares the same prev_id
            for (const msg of alternativeMessages) {
                if (!alternativeMessageGroups[msg.prev_id]) {
                    // First time seeing this prev_id - find ALL bot messages with this prev_id
                    // This includes the original (v1) which has is_alternative=false
                    const allVersions = botMessages.filter(m => m.prev_id === msg.prev_id);
                    alternativeMessageGroups[msg.prev_id] = allVersions.map(m => ({
                        id: m.id,
                        createdAt: m.createdAt
                    }));
                }
            }
            
            // Sort each group by createdAt (oldest first = version 1)
            for (const prevId of Object.keys(alternativeMessageGroups)) {
                alternativeMessageGroups[prevId].sort((a, b) => a.createdAt - b.createdAt);
            }
            
            // Always log alternative groups for debugging regeneration switching
            debugLog('[Core] Built', Object.keys(alternativeMessageGroups).length, 'alternative message groups');
            for (const [prevId, alts] of Object.entries(alternativeMessageGroups)) {
                debugLog('[Core] Group prev_id=' + prevId.substring(0, 8) + ':', alts.map((m, i) => `v${i+1}=${m.id.substring(0, 8)} (${new Date(m.createdAt).toLocaleTimeString()})`));
            }
            
            // Also log what timestamp the prev_id (parent) message has
            for (const prevId of Object.keys(alternativeMessageGroups)) {
                const parentTimestamp = messageTimestamps[prevId];
                debugLog('[Core] Parent message', prevId.substring(0, 8), 'timestamp:', parentTimestamp, '→', parentTimestamp ? new Date(parentTimestamp).toLocaleTimeString() : 'not found');
            }
            
            // =================================================================
            // BUILD COMBINED INDEX MAP FROM ALL MESSAGES
            // =================================================================
            // The DOM displays messages interleaved (user, bot, user, bot, ...)
            // sorted by createdAt (oldest first). We need a combined index map.
            //
            // For alternative messages (regenerations), only ONE is displayed at a time.
            // We include only the FIRST (oldest) from each alternative group.
            
            // Combine all messages and sort by createdAt (oldest first for DOM order)
            const allMessages = [...botMessages, ...userMessages].map(msg => ({
                ...msg,
                isBot: botMessages.includes(msg)
            }));
            
            // Sort by createdAt ascending (oldest first = DOM order)
            allMessages.sort((a, b) => a.createdAt - b.createdAt);
            
            // Build combined index map, handling alternative groups
            messageIdToIndexMap = {};
            userMessageIdToIndexMap = {}; // Keep for backwards compatibility but also populate combined
            const countedAlternativeGroups = new Set();
            let combinedIndex = 0;
            let userOnlyIndex = 0;
            let botOnlyIndex = 0;
            
            for (const msg of allMessages) {
                if (!msg.id) continue;
                
                if (msg.isBot && msg.prev_id && alternativeMessageGroups[msg.prev_id]) {
                    // This is part of an alternative group
                    // Only count the FIRST one we encounter from each group
                    if (!countedAlternativeGroups.has(msg.prev_id)) {
                        countedAlternativeGroups.add(msg.prev_id);
                        // Get the first (oldest) message from this group
                        const group = alternativeMessageGroups[msg.prev_id];
                        if (group && group.length > 0) {
                            messageIdToIndexMap[combinedIndex] = group[0].id;
                            debugLog('[Core] Combined index', combinedIndex, '→', group[0].id.substring(0, 8), '(v1 of alternative group, bot)');
                            combinedIndex++;
                            botOnlyIndex++;
                        }
                    }
                    // Skip other alternatives in the same group
                } else {
                    // Regular message (not an alternative)
                    messageIdToIndexMap[combinedIndex] = msg.id;
                    
                    if (msg.isBot) {
                        botOnlyIndex++;
                    } else {
                        userMessageIdToIndexMap[userOnlyIndex] = msg.id;
                        userOnlyIndex++;
                    }
                    combinedIndex++;
                }
            }
            
            debugLog('[Core] Built combined index map with', Object.keys(messageIdToIndexMap).length, 'entries');
            debugLog('[Core] (Bot messages:', botOnlyIndex, ', User messages:', userOnlyIndex, ')');

            // Build messageDisplayNumberMap by calibrating against the API's
            // own num_messages total, WITHOUT touching messageIdToIndexMap
            // itself (see its declaration comment for why that matters). GET
            // /messages is windowed (?limit=50, never fetching older history
            // unless the user scrolls up), so on a long conversation this
            // window always starts at 0 regardless of the real total — left
            // uncalibrated, the most recent message would relabel to e.g.
            // "#50" on every reload instead of its real, stable position.
            // num_messages reports the true total regardless of the limit, so
            // anchor the last entry in this window to it and count backward
            // for the rest, per the user's own diagnosis from the raw API
            // response.
            messageDisplayNumberMap = {};
            if (typeof numMessages === 'number' && numMessages > 0) {
                const windowEntryCount = Object.keys(messageIdToIndexMap).length;
                const offset = numMessages - windowEntryCount;
                if (offset >= 0) {
                    for (const [idx, id] of Object.entries(messageIdToIndexMap)) {
                        messageDisplayNumberMap[id] = parseInt(idx, 10) + offset + 1; // 1-based
                    }
                    for (const group of Object.values(alternativeMessageGroups)) {
                        const number = group.map(entry => messageDisplayNumberMap[entry.id]).find(Number.isFinite);
                        if (number !== undefined) for (const entry of group) messageDisplayNumberMap[entry.id] = number;
                    }
                    debugLog('[Core] Calibrated display numbering against API num_messages:', numMessages, 'offset:', offset);
                }
            }

            if (DEBUG_MODE) {
                debugLog('[Stats MESSAGES_LOADED] First 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(0, 5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
                debugLog('[Stats MESSAGES_LOADED] Last 5 combined mappings:', Object.keys(messageIdToIndexMap).slice(-5).map(k => `${k}: ${messageIdToIndexMap[k]}`));
            }
            
            // Store stats for bot messages
            for (const msg of botMessages) {
                if (msg.id) {
                    botMessageIds.add(msg.id);

                    // Check if stats already exist in storage (to preserve POST data)
                    const existingStats = await getStatsForMessage(msg.id);
                    
                    debugLog('[Stats MESSAGES_LOADED] Processing message:', msg.id.substring(0, 8));
                    debugLog('[Stats MESSAGES_LOADED] Message createdAt:', msg.createdAt, 'as Date:', new Date(msg.createdAt).toISOString());
                    debugLog('[Stats MESSAGES_LOADED] Existing stats:', existingStats);
                    
                    // Only update if we don't have stats yet, or if we're adding NEW data
                    // GET /messages never includes the engine field (response model), so don't overwrite!
                    // Note: Timestamps are now stored in messageTimestamps map from API, not in storage
                    if (!existingStats) {
                         debugLog('[Stats MESSAGES_LOADED] No existing stats, creating new');
                        // No stats yet - store whatever we have
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model || null,
                            settings: msg.inference_settings || null
                            // Timestamp is handled by messageTimestamps map, not stored here
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (existingStats.model && existingStats.model.includes('→')) {
                        debugLog('[Stats MESSAGES_LOADED] Model has arrow format - PRESERVING:', existingStats.model);
                        // Model already has the full "request → response" format - don't overwrite!
                        // This data came from POST /chat which includes the actual engine field
                    } else if (!existingStats.model && msg.inference_model && msg.inference_settings) {
                        debugLog('[Stats MESSAGES_LOADED] Updating with inference data from GET');
                        // We don't have model data yet AND we have inference data - update
                        const stats = {
                            role: 'bot',
                            model: msg.inference_model,
                            settings: msg.inference_settings
                            // Timestamp is handled by messageTimestamps map, not stored here
                        };
                        await storeStatsForMessage(msg.id, stats, conversationId);
                    } else if (!existingStats.role) {
                        debugLog('[Stats MESSAGES_LOADED] Adding role to existing stats');
                        // Add role if missing (but don't overwrite model!)
                        existingStats.role = 'bot';
                        await storeStatsForMessage(msg.id, existingStats, conversationId);
                    } else if (existingStats.role === 'user') {
                        // Recovery for records corrupted by the prevId-write bug:
                        // this message is in botMessages (we're inside the bot loop),
                        // but the stored record claims role:'user'. That can only
                        // happen via the old auto-regen prevId path. Reset to a clean
                        // bot record. If the GET response carries inference data, we
                        // get full repair; otherwise role-only repair, which still
                        // routes the display through the correct code branches.
                        debugLog('[Stats MESSAGES_LOADED] Repairing corrupted user-marker on bot message:', msg.id.substring(0, 8));
                        if (msg.inference_model || msg.inference_settings) {
                            // We have real inference data — overwrite the corrupted entry
                            await storeStatsForMessage(msg.id, {
                                role: 'bot',
                                model: msg.inference_model || null,
                                settings: msg.inference_settings || null
                            }, conversationId);
                        } else {
                            // No inference data — delete the corrupted entry entirely.
                            // botMessageIds.has() handles story-mode detection without a stored entry.
                            await deleteStatsEntry(msg.id, conversationId);
                        }
                    } else {
                        debugLog('[Stats MESSAGES_LOADED] Existing stats preserved - no update');
                        // Existing stats preserved - no update needed
                    }
                }
            }
            
            debugLog('[Stats] Stored stats for', botMessages.length, 'bot messages (user messages no longer stored)');
            
            // Don't rebuild index map - we already built it from GET /messages order above
            // await buildIndexMapFromStats();

            // Retry wrappers that previously failed ID extraction.
            statsFailedForWrappers = new WeakSet();

            // Reprocess all messages, including versioned messages.
            setTimeout(() => processMessagesForStats(false), 250);
            setTimeout(() => processMessagesForStats(false), 1200);
        }
        
        if (event.data.type === 'SAI_NEW_MESSAGE') {
            debugLog('[Stats] Received SAI_NEW_MESSAGE from page context');
            const { messageId, conversationId, model, settings, createdAt, role, isAlternative, isRegenerationRequested, altMessageId, prevId, responseContentLength, responseEngine } = event.data;
            
            debugLog('[Stats CONTENT] ========== RECEIVED SAI_NEW_MESSAGE ==========');
            debugLog('[Stats CONTENT] Message ID:', messageId);
            debugLog('[Stats CONTENT] Role:', role);
            debugLog('[Stats CONTENT] Received createdAt:', createdAt);
            debugLog('[Stats CONTENT] createdAt type:', typeof createdAt);
            debugLog('[Stats CONTENT] createdAt as Date:', createdAt ? new Date(createdAt).toISOString() : 'null');
            debugLog('[Stats CONTENT] Is alternative (from API):', isAlternative);
            debugLog('[Stats CONTENT] Previous message ID:', prevId);
            debugLog('[Stats CONTENT] Response content length:', responseContentLength);
            debugLog('[Stats CONTENT] Response engine:', responseEngine);
            debugLog('[Stats CONTENT] ==============================================');
            
            // Store/update the conversation ID
            if (conversationId) {
                currentConversationId = conversationId;
            }
            
            // ALWAYS store the timestamp in messageTimestamps (source of truth)
            if (messageId && createdAt) {
                messageTimestamps[messageId] = createdAt;
                debugLog('[Stats] Added to messageTimestamps:', messageId.substring(0, 8), '→', createdAt);
            }
            
            // Track prevId → messageId relationships to detect regenerations.
            // The request-side signal `isRegenerationRequested` (continue_chat:true
            // or alt_message_id present in the POST body) is authoritative — it
            // catches regens on the very first one of a session, before the
            // session-state heuristic below has any siblings to compare against.
            // The heuristic still runs as a fallback for events that arrive
            // without the request-side flag (e.g. older builds, non-XHR paths).
            let isRegenerationDetected = isRegenerationRequested === true || !!altMessageId;
            if (isRegenerationDetected) {
                debugLog('[Stats] Regeneration flagged from request payload (continue_chat or alt_message_id)');
            }
            if (prevId && messageId) {
                if (!prevIdToMessageIds[prevId]) {
                    prevIdToMessageIds[prevId] = [];
                }
                // Heuristic fallback: if we already have other messages with this
                // prevId in this session, treat as regen even without the flag.
                if (!isRegenerationDetected && prevIdToMessageIds[prevId].length > 0 && !prevIdToMessageIds[prevId].includes(messageId)) {
                    isRegenerationDetected = true;
                    debugLog('[Stats] Detected regeneration via session heuristic: prevId', prevId.substring(0, 8), 'already has messages:', prevIdToMessageIds[prevId].map(id => id.substring(0, 8)));
                }
                // Add this message to the tracking
                if (!prevIdToMessageIds[prevId].includes(messageId)) {
                    prevIdToMessageIds[prevId].push(messageId);
                }
            }
            
            // If this is an alternative (regenerated) message, update the alternativeMessageGroups
            if ((isAlternative || isRegenerationDetected) && prevId && messageId &&
                (!isStoryMode() || isAlternative || altMessageId || (prevIdToMessageIds[prevId] || []).some(id => id !== messageId))) {
                debugLog('[Stats] Updating alternativeMessageGroups for regenerated message');
                if (!alternativeMessageGroups[prevId]) {
                    // First time seeing this prev_id in this session.
                    //
                    // BUGFIX: prev_id points at the user message that triggered this
                    // turn — NOT at the v1 bot reply. The v1 bot's message ID is the
                    // sibling that arrived earlier this session with the same prev_id.
                    // We can recover it from prevIdToMessageIds[prevId], which holds
                    // every messageId we've seen against that prev_id (including the
                    // current regen we just pushed at line ~3572). v1 is anything in
                    // that list other than the current messageId.
                    alternativeMessageGroups[prevId] = [];
                    const siblingIds = (prevIdToMessageIds[prevId] || []).filter(id => id !== messageId);
                    for (const siblingId of siblingIds) {
                        const siblingTimestamp = messageTimestamps[siblingId];
                        alternativeMessageGroups[prevId].push({
                            id: siblingId,
                            createdAt: typeof siblingTimestamp === 'string'
                                ? new Date(siblingTimestamp).getTime()
                                : (siblingTimestamp || 0)
                        });
                        debugLog('[Stats] Seeded alternative group with sibling bot message:', siblingId.substring(0, 8));
                    }
                    if (siblingIds.length === 0) {
                        // No siblings tracked yet (e.g. v1 came from a cold page load
                        // before our interceptor was attached, or a build that didn't
                        // record it). MESSAGES_LOADED will repair this on next reload;
                        // for now leave the group with only the new alternative below.
                        debugLog('[Stats] No prior bot siblings in prevIdToMessageIds for prev_id:', prevId.substring(0, 8), '— v1 will be filled by MESSAGES_LOADED');
                    }
                }
                // Add this message to the group if not already present
                const existingIndex = alternativeMessageGroups[prevId].findIndex(m => m.id === messageId);
                if (existingIndex === -1) {
                    // Convert createdAt to number for sorting
                    const createdAtNum = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt;
                    alternativeMessageGroups[prevId].push({
                        id: messageId,
                        createdAt: createdAtNum
                    });
                    // Sort by createdAt ascending
                    alternativeMessageGroups[prevId].sort((a, b) => a.createdAt - b.createdAt);
                    debugLog('[Stats] Added regeneration to alternative group, now has', alternativeMessageGroups[prevId].length, 'versions');
                    debugLog('[Stats] Group contents:', alternativeMessageGroups[prevId].map((m, i) => `v${i+1}=${m.id.substring(0, 8)}`).join(', '));
                }
            }
            
            debugLog('[Stats] New message - ID:', messageId, 'role:', role, 'conversation:', conversationId);
            debugLog('[Stats] New message - createdAt received:', createdAt, 'type:', typeof createdAt);
            
            if (messageId && createdAt) {
                const statsToStore = {
                    role: role || 'bot',  // Use role from interceptor
                    model: model,
                    settings: settings
                    // Timestamp is NOT stored - it comes from messageTimestamps map
                };
                
                debugLog('[Stats SAVE] ============ SAVING NEW MESSAGE ============');
                debugLog('[Stats SAVE] Message ID:', messageId);
                debugLog('[Stats SAVE] Role:', role);
                debugLog('[Stats SAVE] Model being saved:', model);
                debugLog('[Stats SAVE] Settings being saved:', settings);
                debugLog('[Stats SAVE] Timestamp in messageTimestamps:', messageTimestamps[messageId]);
                debugLog('[Stats SAVE] Full stats object:', statsToStore);
                debugLog('[Stats SAVE] =============================================');
                
                await storeStatsForMessage(messageId, statsToStore, conversationId);
                
                if (DEBUG_MODE) {
                    console.log('[Stats SAVE] Storage complete, verifying...');
                    const verifyStats = await getStatsForMessage(messageId);
                    console.log('[Stats SAVE] Verified stored stats:', verifyStats);
                    console.log('[Stats SAVE] Verified timestamp (from messageTimestamps):', verifyStats?.timestamp);
                }
                
                debugLog('[Stats] Stored stats for new message:', messageId);

                // If this is a bot message and we have prevId, store the user message too
                // The prevId is the user message ID, and we have its timestamp from SAI_USER_MESSAGE_SENT
                //
                // IMPORTANT: skip this when isRegenerationDetected. In a regeneration the
                // prevId points at the *previous bot message*, not the user message before
                // it — so writing { role: 'user' } here would overwrite that bot's stats
                // record (model, settings, timestamp) with a user marker. Auto-regen flows
                // can leave lastUserMessageTimestamp populated across the regen, which
                // historically masked this distinction and corrupted records.
                if ((role === 'bot' || !role) && prevId && lastUserMessageTimestamp && !isRegenerationDetected) {
                    debugLog('[Stats] Bot message has prevId - recording user message timestamp:', prevId.substring(0, 8));

                    // Record the user message timestamp (source of truth for display)
                    messageTimestamps[prevId] = lastUserMessageTimestamp;
                    debugLog('[Stats] Added user message to messageTimestamps:', prevId.substring(0, 8), '→', lastUserMessageTimestamp);

                    // Add to index map (user message comes before bot message)
                    if (!isRegenerationDetected) {
                        const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                        const userIndex = currentMaxIndex + 1;
                        messageIdToIndexMap[userIndex] = prevId;
                        debugLog('[Stats SAVE] Added user message to index map at index:', userIndex, 'messageId:', prevId.substring(0, 8));
                    }

                    // Trigger stats insertion for the user message timestamp display
                    setTimeout(() => processMessagesForStats(true), 200);
                    setTimeout(() => processMessagesForStats(true), 600);

                    // Clear the last user message timestamp so we don't reuse it
                    lastUserMessageTimestamp = null;
                }

                // For bot messages, use insertStatsForRegeneratedMessage which handles the version counter UI
                // This is more reliable than index-based matching in processMessagesForStats
                // processMessagesForStats will skip messages with version counters
                if (role === 'bot' || !role) {
                    botMessageIds.add(messageId);
                    debugLog('[Stats] Bot message - will insert stats directly via insertStatsForRegeneratedMessage');
                    // Increment pending count - this tells processMessagesForStats to skip the newest messages
                    pendingNewMessageCount++;
                    debugLog('[Stats] Incremented pendingNewMessageCount to:', pendingNewMessageCount);
                    // Insert stats with retries - use a single call with built-in retry logic
                    // This prevents race conditions when browser throttles background tab timers
                    // NOTE: insertStatsForRegeneratedMessage will add messageId to statsInsertionInProgress
                    insertStatsWithRetry(messageId, model, settings, createdAt);
                    
                    // Also add to index map for historical message display on page refresh.
                    //
                    // Story Mode's "Continue Story" sends the same continue_chat:true
                    // flag that Chat Mode's regenerate uses, so isRegenerationDetected
                    // is true for every single continue — but a Story Mode continue is
                    // a genuinely new message appended to the story, not an alternate
                    // replacing an existing one the way a Chat Mode regen is. Skipping
                    // the index update for it (as Chat Mode correctly does for real
                    // regens) left every continue permanently missing from
                    // messageIdToIndexMap and messageDisplayNumberMap.
                    if (!isRegenerationDetected || isStoryMode()) {
                        // messageIdToIndexMap is the window-relative fallback map.
                        // Only append an id that isn't already in it, so a duplicate
                        // SAI_NEW_MESSAGE (or a Story Mode regeneration re-firing for a
                        // new id at the same position) can't grow it past what a page
                        // reload would rebuild.
                        const versionGroup = prevId && alternativeMessageGroups[prevId];
                        const sharesPosition = Array.isArray(versionGroup) && versionGroup.some(entry =>
                            entry.id !== messageId && Object.values(messageIdToIndexMap).includes(entry.id));
                        if (!sharesPosition && !Object.values(messageIdToIndexMap).includes(messageId)) {
                            const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                            const newIndex = currentMaxIndex + 1;
                            messageIdToIndexMap[newIndex] = messageId;
                            debugLog('[Stats SAVE] Added message to index map at index:', newIndex, 'messageId:', messageId);
                        }

                        // Extend the calibrated Story Mode display numbering (see its
                        // declaration and the SAI_MESSAGES_LOADED handler). Anchor to the
                        // predecessor's number rather than a running max+1: every Story
                        // Mode message's prev_id is the immediately preceding message
                        // (verified against the live API — the conversation is a clean
                        // bot→bot linked list), so number(new) = number(prev_id) + 1 is
                        // both deterministic and idempotent. That keeps the live counter
                        // locked to the API's num_messages instead of drifting ahead of
                        // it, because:
                        //   - a duplicate SAI_NEW_MESSAGE for the same id recomputes the
                        //     SAME number instead of adding one, and
                        //   - a regeneration (a new id that shares prev_id with the message
                        //     it replaces) resolves to that message's number, since a regen
                        //     replaces a position rather than appending one.
                        // Fall back to max+1 only if the predecessor isn't numbered yet
                        // (e.g. it scrolled out of the loaded window) and the id is new.
                        let displayNumber;
                        const siblingNumber = Array.isArray(versionGroup) && versionGroup.length > 1
                            ? versionGroup.map(entry => messageDisplayNumberMap[entry.id]).find(Number.isFinite) : undefined;
                        if (siblingNumber !== undefined) {
                            displayNumber = siblingNumber;
                        } else if (prevId && messageDisplayNumberMap[prevId] !== undefined) {
                            displayNumber = messageDisplayNumberMap[prevId] + 1;
                        } else if (messageDisplayNumberMap[messageId] !== undefined) {
                            displayNumber = messageDisplayNumberMap[messageId];
                        } else {
                            displayNumber = Math.max(0, ...Object.values(messageDisplayNumberMap)) + 1;
                        }
                        messageDisplayNumberMap[messageId] = displayNumber;
                        debugLog('[Stats SAVE] Story display number for', messageId, '=', displayNumber);
                    }
                    
                    // Check if auto-regeneration should be triggered
                    if (window.__autoRegenOnMismatch || window.__autoRegenOnShort) {
                        checkAndAutoRegenerate(prevId, responseEngine, responseContentLength);
                    } else {
                        // If auto-regen is off, still update lastKnownEngine for future use
                        if (typeof responseEngine === 'string' && responseEngine.trim() !== '') {
                            window.__lastKnownEngine = responseEngine;
                        }
                    }
                } else {
                    // User message - use processMessagesForStats
                    const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                    const newIndex = currentMaxIndex + 1;
                    messageIdToIndexMap[newIndex] = messageId;
                    debugLog('[Stats SAVE] Added user message to index map at index:', newIndex, 'messageId:', messageId);
                    
                    // Trigger stats insertion after delays to let DOM update
                    setTimeout(() => processMessagesForStats(true), 300);
                    setTimeout(() => processMessagesForStats(true), 800);
                }
            } else if (messageId && !createdAt) {
                debugLog('[Stats] SAI_NEW_MESSAGE received without createdAt timestamp for message:', messageId);
                // Still store the model info even without timestamp
                if (model) {
                    const statsToStore = {
                        role: role || 'bot',
                        model: model,
                        settings: settings
                    };
                    debugLog('[Stats SAVE] Storing model info without timestamp:', statsToStore);
                    await storeStatsForMessage(messageId, statsToStore, conversationId);
                    
                    // Add to index map
                    const currentMaxIndex = Math.max(-1, ...Object.keys(messageIdToIndexMap).map(k => parseInt(k)));
                    const newIndex = currentMaxIndex + 1;
                    messageIdToIndexMap[newIndex] = messageId;
                    
                    // Trigger stats insertion
                    setTimeout(() => processMessagesForStats(true), 300);
                    setTimeout(() => processMessagesForStats(true), 800);
                }
            }
        }
        
        if (event.data.type === 'SAI_USER_MESSAGE_SENT') {
            debugLog('[Stats] Received SAI_USER_MESSAGE_SENT from page context');
            const { timestamp, conversationId, messageId } = event.data;
            
            debugLog('[Stats] User message sent at timestamp:', timestamp);
            
            // Store the timestamp in messageTimestamps (source of truth)
            if (messageId && timestamp) {
                messageTimestamps[messageId] = timestamp;
                debugLog('[Stats] Added user message to messageTimestamps:', messageId);
            }
            
            // Store the timestamp for when we detect the user message in the DOM
            lastUserMessageTimestamp = timestamp;
            
            // Trigger stats display for the newly sent user message (shows timestamp)
            setTimeout(() => processMessagesForStats(true), 500);
            setTimeout(() => processMessagesForStats(true), 1000);
        }
    });
    
    // Cache for title update feature setting (avoid repeated storage reads)
    let cachedShowChatNameInTitle = null;
    let cacheInitialized = false;
    let titleUpdateRetries = 0;
    const MAX_TITLE_RETRIES = 20; // Max 2 seconds of retries
    
    // Update page title with character name and label (synchronous for speed)
    async function updatePageTitle() {
        debugLog('[ChatTitle UPDATE] ========== updatePageTitle() CALLED ==========');
        
        // If cache not initialized yet, initialize it now (shouldn't happen but safety check)
        if (!cacheInitialized) {
            debugLog('[ChatTitle UPDATE] Cache not initialized, initializing now...');
            cachedShowChatNameInTitle = await storage.get('showChatNameInTitle', false);
            cacheInitialized = true;
            debugLog('[ChatTitle UPDATE] Cache initialized to:', cachedShowChatNameInTitle);
        }
        
        // Check cached setting (set by initial load and settings changes)
        if (!cachedShowChatNameInTitle) {
            debugLog('[ChatTitle UPDATE] Feature is disabled (cached value:', cachedShowChatNameInTitle, '), exiting');
            return;
        }
        
        const label = window.__saiChatLabel;
        const currentTitle = document.title;
        const titleIsEmpty = !currentTitle || currentTitle.trim() === '';
        
        debugLog('[ChatTitle UPDATE] Current state:');
        debugLog('[ChatTitle UPDATE]   - Label:', label);
        debugLog('[ChatTitle UPDATE]   - Current document.title:', currentTitle || '<empty string>');
        debugLog('[ChatTitle UPDATE]   - Title is empty?:', titleIsEmpty);
        debugLog('[ChatTitle UPDATE]   - Retry count:', titleUpdateRetries, '/', MAX_TITLE_RETRIES);
        
        // If title is empty or not set yet, wait a bit and retry
        if (titleIsEmpty) {
            if (titleUpdateRetries < MAX_TITLE_RETRIES) {
                titleUpdateRetries++;
                debugLog('[ChatTitle UPDATE] Title is empty, waiting 100ms and retrying... (attempt', titleUpdateRetries, '/', MAX_TITLE_RETRIES, ')');
                setTimeout(() => updatePageTitle(), 100);
                return;
            } else {
                debugLog('[ChatTitle UPDATE] Max retries reached, giving up');
                titleUpdateRetries = 0; // Reset for next time
                return;
            }
        }
        
        // Reset retry counter on success
        titleUpdateRetries = 0;
        
        // Extract character name from existing title. SpicyChat's own native title
        // format has changed over time — try both so this survives either one:
        //   legacy:  "Chat with {name} - AI Sex Chatbot | Spicychat"
        //   current: "Chat with {name} on SpicyChat"
        // The brand's capitalisation has flipped between "Spicychat" and
        // "SpicyChat", so every match here is case-insensitive — a
        // case-sensitive miss falls through to the short-title branch and
        // treats the whole native title as the character name.
        // Also handle already-shortened format: just "{name}" or "{name} (label)"
        let characterName = null;
        const legacyFullTitleMatch = document.title.match(/^Chat with (.+) - AI Sex Chatbot \| Spicychat$/i);
        const currentFullTitleMatch = document.title.match(/^Chat with (.+) on Spicychat$/i);
        const shortTitleMatch = document.title.match(/^([^(]+?)(?:\s*\([^)]+\))?$/);
        const titleLooksNative = /spicychat/i.test(document.title) || /^Chat with /i.test(document.title);

        if (legacyFullTitleMatch) {
            characterName = legacyFullTitleMatch[1];
            debugLog('[ChatTitle UPDATE]   - Extracted character name from legacy full title:', characterName);
        } else if (currentFullTitleMatch) {
            characterName = currentFullTitleMatch[1];
            debugLog('[ChatTitle UPDATE]   - Extracted character name from current full title:', characterName);
        } else if (shortTitleMatch && !titleLooksNative) {
            // Already shortened, extract base name (before any label in parentheses)
            characterName = shortTitleMatch[1].trim();
            debugLog('[ChatTitle UPDATE]   - Extracted character name from shortened title:', characterName);
        } else {
            debugLog('[ChatTitle UPDATE]   - Could not extract character name from title format');
        }
        
        debugLog('[ChatTitle] Current state - Character:', characterName, 'Label:', label);
        
        if (characterName && label) {
            // Both character name and label exist: "characterName (label)"
            const newTitle = `${characterName} (${label})`;
            debugLog('[ChatTitle UPDATE] Setting title to:', newTitle);
            document.title = newTitle;
            debugLog('[ChatTitle UPDATE] Title set. Actual document.title:', document.title);
        } else if (characterName) {
            // Only character name exists (no label yet): just "characterName"
            const newTitle = characterName;
            debugLog('[ChatTitle UPDATE] No label yet, using character name only:', newTitle);
            document.title = newTitle;
            debugLog('[ChatTitle UPDATE] Title set. Actual document.title:', document.title);
        } else {
            debugLog('[ChatTitle UPDATE] Could not extract character name from title');
            debugLog('[ChatTitle UPDATE]   Title format:', document.title);
        }
    }

    // Track the last user message timestamp for later tagging
    let lastUserMessageTimestamp = null;
    
    // Initialize the cached setting and try initial title update
    // This happens early on page load to shorten title ASAP
    (async () => {
        cachedShowChatNameInTitle = await storage.get('showChatNameInTitle', false);
        cacheInitialized = true;
        debugLog('[ChatTitle] Cached setting initialized:', cachedShowChatNameInTitle);
        
        if (cachedShowChatNameInTitle && document.title.startsWith('Chat with ')) {
            debugLog('[ChatTitle] Attempting initial title update on page load');
            await updatePageTitle();
        }
    })();
    
    // Also listen for setting changes to update the cache
    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'SAI_SETTINGS_CHANGED' && event.data.key === 'showChatNameInTitle') {
            cachedShowChatNameInTitle = event.data.value;
            cacheInitialized = true;
            debugLog('[ChatTitle] Setting cache updated:', cachedShowChatNameInTitle);
            if (cachedShowChatNameInTitle) {
                await updatePageTitle();
            }
        }
    });

    // =============================================================================
    // SLIDER UPDATE HELPER - Shared React-compatible slider update logic (Issue #16)
    // =============================================================================
    // Helper function to properly update slider with React-style events
    // Used by applySettings and any other code that needs to programmatically
    // update slider values in a way that React will recognize
    function updateSliderValue(slider, value) {
        if (!slider || value === undefined || value === null) return false;
        
        try {
            // Validate slider is still in DOM and value is a number
            if (!slider.isConnected || typeof value !== 'number') {
                console.error('[Core] Invalid slider state or value:', { connected: slider.isConnected, value });
                return false;
            }
            
            // Set the value using native setter to bypass React's control
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(slider, value);
            
            // Dispatch multiple events for React compatibility
            slider.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            slider.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            
            // Trigger pointer/mouse events to simulate user interaction
            slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            
            return true;
        } catch (error) {
            console.error('[Core] Error updating slider:', error);
            return false;
        }
    }
    
    // Load profiles from storage
    async function loadProfiles() {
        const stored = await storage.get(PROFILES_KEY, '{}');
        return JSON.parse(stored);
    }

    // Save profiles to storage
    async function saveProfiles(profiles) {
        await storage.set(PROFILES_KEY, JSON.stringify(profiles));
    }

    // Change the model by clicking on it in the model selection modal
    function changeModel(modelName, callback) {
        let changeModelBtn; // Declare at function scope
        let modelModal; // Declare at function scope
        
        try {
            // Validate inputs
            if (!modelName || typeof modelName !== 'string') {
                callback(false, 'Invalid model name provided');
                return;
            }
            if (!callback || typeof callback !== 'function') {
                console.error('[Core] changeModel: Invalid callback provided');
                return;
            }
            
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                callback(false, 'Generation Settings modal not found');
                return;
            }
            
            const buttons = modal.querySelectorAll('button');
            if (!buttons || buttons.length === 0) {
                callback(false, 'No buttons found in modal');
                return;
            }
            
            changeModelBtn = Array.from(buttons).find(btn => 
                btn && btn.textContent && btn.textContent.includes('Change Model')
            );
            
            if (!changeModelBtn) {
                callback(false, 'Change Model button not found');
                return;
            }
        } catch (error) {
            console.error('[Core] Error in changeModel (initial checks):', error);
            callback(false, `Error: ${error.message}`);
            return;
        }
        
        // A model change is intentional — suppress the first mismatch regen for this message
        window.__suppressMismatchNext = true;
        debugLog('[Model] Model change initiated; suppressing next mismatch auto-regen');

        // Click the button
        try {
            changeModelBtn.click();
        } catch (error) {
            console.error('[Core] Error clicking Change Model button:', error);
            callback(false, `Error clicking button: ${error.message}`);
            return;
        }
        
        // Wait for the model selection modal to appear
        setTimeout(() => {
            try {
                // Find the model selection modal
                const allModals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2, div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]'));
                modelModal = allModals.find(el => {
                    const text = el && el.textContent;
                    return text && (text.includes('Select a model') || text.includes('Choose Model') || text.includes('Select Model'));
                });
                
                if (!modelModal) {
                    callback(false, 'Model selection modal did not appear');
                    return;
                }
                
                // Find the model option by matching the text content (using includes for flexibility)
                const modelOptions = Array.from(modelModal.querySelectorAll('li, button, div[role="option"], p.text-label-lg'));
                const modelOption = modelOptions.find(el => {
                    if (!el || !el.textContent) return false;
                    const text = el.textContent.trim();
                    // Try exact match first, then check if the model name is contained in the text
                    return text === modelName || text.includes(modelName);
                });
                
                if (!modelOption) {
                    // Close the modal
                    try {
                        const closeBtn = modelModal.querySelector('button[aria-label="X-button"], button[aria-label="Close"]') ||
                                        Array.from(modelModal.querySelectorAll('button')).find(btn => 
                                            btn && btn.textContent && btn.textContent.includes('Close')
                                        );
                        if (closeBtn) closeBtn.click();
                    } catch (closeError) {
                        console.error('[Core] Error closing modal:', closeError);
                    }
                    callback(false, `Model "${modelName}" not found in list`);
                    return;
                }
                
                // Click the model option
                try {
                    modelOption.click();
                    debugLog('[Change Model] Clicked model option');
                    
                    // Check if this is the new UI (which requires "Set Model" button) or old UI (auto-applies)
                    // New UI has a confirmation step, old UI applies immediately
                    const hasSetModelButton = Array.from(modelModal.querySelectorAll('button')).some(btn => 
                        btn && btn.textContent && btn.textContent.includes('Set Model')
                    );
                    
                    if (hasSetModelButton) {
                        // New UI: Wait for React to process and click "Set Model" button
                        setTimeout(() => {
                            try {
                                const buttons = modelModal.querySelectorAll('button');
                                const setModelBtn = Array.from(buttons).find(btn => 
                                    btn && btn.textContent && btn.textContent.includes('Set Model')
                                );
                                
                                if (setModelBtn) {
                                    setModelBtn.click();
                                    debugLog('[Change Model] Clicked "Set Model" button (new UI)');
                                    
                                    setTimeout(() => {
                                        callback(true, 'Model changed successfully');
                                    }, 500);
                                } else {
                                    callback(false, '"Set Model" button not found');
                                }
                            } catch (error) {
                                console.error('[Core] Error clicking Set Model button:', error);
                                callback(false, `Error confirming model: ${error.message}`);
                            }
                        }, TIMING.MODAL_CONFIRM_DELAY);
                    } else {
                        // Old UI: Selection applies immediately, just wait and report success
                        setTimeout(() => {
                            callback(true, 'Model changed successfully');
                        }, 500);
                    }
                } catch (clickError) {
                    console.error('[Core] Error clicking model option:', clickError);
                    callback(false, `Error selecting model: ${clickError.message}`);
                    return;
                }
            } catch (error) {
                console.error('[Core] Error in model selection modal handling:', error);
                callback(false, `Error: ${error.message}`);
                return;
            }
        }, TIMING.MODAL_OPEN_DELAY);
    }

    // Apply settings to the modal
    async function applySettings(settings, autoChangeModel = false) {
        try {
            // Validate settings object
            if (!settings || typeof settings !== 'object') {
                console.error('[Core] Invalid settings object provided to applySettings');
                return false;
            }
            
            // Find the Generation Settings modal (supports both old and new UI)
            const modal = findGenerationSettingsModal();
            
            if (!modal) {
                debugLog('[Core] Generation Settings modal not found in applySettings');
                return false;
            }

            const sliders = modal.querySelectorAll('input[type="range"]');
            if (!sliders || sliders.length === 0) {
                console.error('[Core] No sliders found in Generation Settings modal');
                return false;
            }
            
            // Apply slider settings (skip max tokens - not saved in profiles)
            // sliders[0] is max tokens - intentionally not applied from profiles
            
            if (sliders[1] && settings.temperature !== undefined) {
                updateSliderValue(sliders[1], settings.temperature);
            }
            
            if (sliders[2] && settings.topP !== undefined) {
                updateSliderValue(sliders[2], settings.topP);
            }
            
            if (sliders[3] && settings.topK !== undefined) {
                updateSliderValue(sliders[3], settings.topK);
            }
            
            // Change model if requested and available
            if (autoChangeModel && settings.model) {
                try {
                    const currentSettings = await getCurrentSettings();
                    if (currentSettings && currentSettings.model !== settings.model) {
                        // Model will change — suppress the first mismatch auto-regen
                        window.__suppressMismatchNext = true;
                        changeModel(settings.model, (success, message) => {
                            if (success) {
                                showNotification(`✓ Profile loaded with model: ${settings.model}`);
                            } else {
                                showNotification(`⚠️ Settings loaded but model change failed: ${message}`, true);
                            }
                        });
                        return true;
                    }
                } catch (modelError) {
                    console.error('[Core] Error changing model:', modelError);
                    showNotification(`⚠️ Settings loaded but model change failed`, true);
                }
            }

            return true;
        } catch (error) {
            console.error('[Core] Error in applySettings:', error);
            return false;
        }
    }

    // Flag to prevent duplicate profile controls
    let isCreatingProfileControls = false;

    // Create profile controls UI
    async function createProfileControls() {
        debugLog('[Profile Controls] Function called. Flag:', isCreatingProfileControls);
        
        // Find the Generation Settings modal (supports both old and new UI)
        const modal = findGenerationSettingsModal();
        
        if (!modal) {
            debugLog('[Profile Controls] No Generation Settings modal found');
            return;
        }
        
        // Check if user has profiles stored OR has explicitly enabled via debug setting
        const storedProfiles = await loadProfiles();
        const hasProfiles = Object.keys(storedProfiles).length > 0;
        const forceEnabled = await storage.get(ENABLE_GENERATION_PROFILES_KEY, false);
        
        debugLog('[Profile Controls] hasProfiles:', hasProfiles, 'forceEnabled:', forceEnabled);
        
        // Only show profile controls if user has profiles OR force-enabled via debug setting
        if (!hasProfiles && !forceEnabled) {
            debugLog('[Profile Controls] No profiles stored and not force-enabled, skipping UI creation');
            return;
        }

        // Check if controls already exist OR if a placeholder exists (being created)
        const existingControls = modal.querySelector('#profile-controls');
        const placeholder = modal.querySelector('#profile-controls-placeholder');
        debugLog('[Profile Controls] Existing controls found:', !!existingControls, 'Placeholder:', !!placeholder);
        if (existingControls || placeholder) {
            debugLog('[Profile Controls] Controls already exist or being created, skipping');
            return;
        }

        // Immediately insert a placeholder to mark that we're creating controls
        const placeholder2 = document.createElement('div');
        placeholder2.id = 'profile-controls-placeholder';
        placeholder2.style.display = 'none';
        modal.appendChild(placeholder2);
        debugLog('[Profile Controls] Placeholder inserted, creating controls...');

        // Find the scrollable content section - look for the container with px-lg class
        // that contains the sliders
        const sliders = modal.querySelectorAll('input[type="range"]');
        if (sliders.length === 0) {
            debugLog('[Profile Controls] No sliders found');
            placeholder2.remove();
            return;
        }
        
        // Get the px-lg container that holds the settings
        let settingsContainer = sliders[0].closest('.px-lg');
        if (!settingsContainer) {
            // Fallback: try to find any parent with gap and flex classes
            settingsContainer = sliders[0].closest('.flex.flex-col');
        }
        if (!settingsContainer) {
            placeholder2.remove();
            return;
        }

        // Create profile controls container
        const controlsDiv = document.createElement('div');
        controlsDiv.id = 'profile-controls';
        controlsDiv.className = 'flex flex-col gap-sm border-t border-gray-300 dark:border-gray-700 pt-3 mt-3';

        // Profile selector row
        const selectorRow = document.createElement('div');
        selectorRow.className = 'flex justify-undefined items-center gap-2';

        // Profile label
        const label = document.createElement('span');
        label.className = 'text-foreground text-[12px] font-medium';
        label.textContent = 'Profile:';

        // Profile dropdown
        const select = document.createElement('select');
        select.id = 'profile-select';
        select.className = 'flex-1 h-[28px] px-2 rounded-md bg-gray-100 dark:bg-gray-800 text-[12px] border border-gray-300 dark:border-gray-700 cursor-pointer';
        
        // Populate dropdown
        const profilesList = await loadProfiles();
        const lastProfile = await storage.get(LAST_PROFILE_KEY, '');
        
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select Profile --';
        select.appendChild(defaultOption);

        Object.keys(profilesList).sort().forEach(async name => {
            const option = document.createElement('option');
            option.value = name;
            const profile = profilesList[name];
            option.textContent = `${name} ${profile.model ? `(${profile.model})` : ''}`;
            if (name === lastProfile) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        select.addEventListener('change', async function() {
            const profileName = this.value;
            if (profileName) {
                const profilesData = await loadProfiles();
                if (profilesData[profileName]) {
                    const profileSettings = profilesData[profileName];
                    const autoChange = true; // Always auto-change model
                    applySettings(profileSettings, autoChange);
                    await storage.set(LAST_PROFILE_KEY, profileName);
                    
                    // Poll for the Generation Settings modal to reappear, then scroll
                    let pollAttempts = 0;
                    const maxAttempts = 5;
                    
                    const pollForModal = () => {
                        pollAttempts++;
                        
                        // Find the scrollable container
                        const modals = Array.from(document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2'));
                        
                        // Find modal that contains our profile controls
                        const modal = modals.find(m => m.querySelector('#profile-controls'));
                        
                        if (modal) {
                            const scrollContainer = modal.querySelector('.overflow-y-auto');
                            
                            if (scrollContainer) {
                                // Found it! Scroll to bottom
                                scrollContainer.scrollTop = 999999;
                                return; // Success, stop polling
                            }
                        }
                        
                        // If not found and we haven't exceeded max attempts, try again
                        if (pollAttempts < maxAttempts) {
                            setTimeout(pollForModal, 500);
                        }
                    };
                    
                    // Start polling after a short initial delay
                    setTimeout(pollForModal, 100);
                    
                    // Always show notification without model check warning
                    showNotification(`✓ Loaded profile: ${profileName}`);
                }
            }
        });

        selectorRow.appendChild(label);
        selectorRow.appendChild(select);

        // Buttons row
        const buttonsRow = document.createElement('div');
        buttonsRow.className = 'flex justify-undefined items-center gap-2';

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        saveBtn.textContent = 'Save Profile';
        saveBtn.addEventListener('click', async function() {
            const profileName = prompt('Enter profile name:');
            if (profileName && profileName.trim()) {
                const settings = await getCurrentSettings();
                if (settings) {
                    const profiles = await loadProfiles();
                    profiles[profileName.trim()] = settings;
                    await saveProfiles(profiles);
                    
                    // Refresh dropdown
                    updateProfileDropdown();
                    select.value = profileName.trim();
                    await storage.set(LAST_PROFILE_KEY, profileName.trim());
                    
                    showNotification(`Saved profile: ${profileName.trim()}`);
                }
            }
        });

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'flex-1 h-[28px] px-3 rounded-md bg-red-500 hover:bg-red-600 text-white text-[12px] font-medium cursor-pointer transition-colors';
        deleteBtn.textContent = 'Delete Profile';
        deleteBtn.addEventListener('click', async function() {
            const profileName = select.value;
            if (profileName) {
                if (confirm(`Delete profile "${profileName}"?`)) {
                    const profiles = await loadProfiles();
                    delete profiles[profileName];
                    await saveProfiles(profiles);
                    
                    // Refresh dropdown
                    updateProfileDropdown();
                    select.value = '';
                    
                    showNotification(`Deleted profile: ${profileName}`);
                }
            } else {
                alert('Please select a profile to delete');
            }
        });

        buttonsRow.appendChild(saveBtn);
        buttonsRow.appendChild(deleteBtn);

        controlsDiv.appendChild(selectorRow);
        controlsDiv.appendChild(buttonsRow);

        // Insert at the end of the scrollable settings container (under Top-K)
        settingsContainer.appendChild(controlsDiv);
        
        // Remove placeholder now that real controls are inserted
        placeholder2.remove();
        debugLog('[Profile Controls] Controls created successfully');
    }

    // Update profile dropdown
    async function updateProfileDropdown() {
        const select = document.getElementById('profile-select');
        if (!select) return;

        const currentValue = select.value;
        const profiles = await loadProfiles();
        
        // Clear and rebuild
        select.replaceChildren();

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select Profile --';
        select.appendChild(defaultOption);

        Object.keys(profiles).sort().forEach(async name => {
            const option = document.createElement('option');
            option.value = name;
            const profile = profiles[name];
            option.textContent = `${name} ${profile.model ? `(${profile.model})` : ''}`;
            select.appendChild(option);
        });

        // Restore selection if still exists
        if (profiles[currentValue]) {
            select.value = currentValue;
        }
    }

    // Show notification
    function showNotification(message, isWarning = false) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${isWarning ? 'rgba(255, 153, 0, 0.95)' : 'rgba(0, 0, 0, 0.85)'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10000003;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease-out;
            white-space: pre-line;
            max-width: 400px;
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        const duration = isWarning ? 5000 : 2500;
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.3s';
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    // Add animation styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        @keyframes sai-slide-up {
            from {
                transform: translate(-50%, 20px);
                opacity: 0;
            }
            to {
                transform: translate(-50%, 0);
                opacity: 1;
            }
        }
        
        @keyframes sai-slide-down {
            from {
                transform: translate(-50%, 0);
                opacity: 1;
            }
            to {
                transform: translate(-50%, 20px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===               INFERENCE PROFILES & MESSAGE STATS - END               ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================


    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    TOOLKIT SPECIFIC CODE - START                     ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    // Feature Management  
    // Note: All storage key constants (SIDEBAR_LAYOUT_KEY, STYLE_OVERRIDES_KEY, etc.) 
    // are defined at the top of the file for early injection and shared use
    const HIDE_FOR_YOU_KEY = 'enableHideForYou';
    const PAGE_JUMP_KEY = 'enablePageJump';
    const COMPACT_GENERATION_KEY = 'enableCompactGeneration';
    const SIDEBAR_MIN_WIDTH_KEY = 'sidebarMinWidth';
    const DEFAULT_SIDEBAR_MIN_WIDTH = 1000; // Default minimum page width for sidebar layout
    
    let sidebarStyleElement = null;
    let composerLayoutStyleElement = null; // Composer CSS: same "chat pages only" gating as Sidebar Layout, see toggleSidebarLayout
    let compactGenerationStyleElement = null;
    let hideForYouObserver = null;
    let hideForYouUrlObserver = null;
    let hideForYouActive = false;
    let pageJumpObserver = null;
    
    // Responsive sidebar: auto-disable when page is too narrow
    let sidebarMinWidth = DEFAULT_SIDEBAR_MIN_WIDTH; // User-configurable minimum page width
    let sidebarAutoDisabled = false; // True when user has sidebar enabled but page is too narrow
    let sidebarUserEnabled = false; // Tracks user's actual preference (persisted to storage)
    let sidebarPageDisabled = false; // True when CSS is off specifically because the current page isn't a chat page
    
    // Apply or remove sidebar layout CSS
    // saveToStorage: if false, only updates the CSS state without saving (used for responsive auto-disable)
    async function toggleSidebarLayout(enable, saveToStorage = true) {
        // Don't enable sidebar on non-chat pages (chatbot, lorebook, group, voice, ...)
        const shouldBlock = enable && isNonChatPageForSidebar();

        if (enable && !shouldBlock) {
            if (!sidebarStyleElement) {
                // Check if early-injected element exists
                sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early') ||
                                      document.getElementById('sai-toolkit-sidebar-layout');

                if (!sidebarStyleElement) {
                    sidebarStyleElement = document.createElement('style');
                    sidebarStyleElement.id = 'sai-toolkit-sidebar-layout';
                    sidebarStyleElement.textContent = getSidebarLayoutCSSEarly();
                    // Add BEFORE other elements to ensure it loads early
                    if (document.head.firstChild) {
                        document.head.insertBefore(sidebarStyleElement, document.head.firstChild);
                    } else {
                        document.head.appendChild(sidebarStyleElement);
                    }
                }
            }
            sidebarStyleElement.disabled = false;
            // Composer CSS (message input area styling) is designed specifically for
            // sidebar layout and shares its "chat pages only" restriction — keep its
            // enabled state in lockstep here rather than relying solely on the
            // early-inject check, which only ever runs once per page load.
            if (!composerLayoutStyleElement) {
                composerLayoutStyleElement = document.getElementById('sai-toolkit-composer-layout-early') ||
                                            document.getElementById('sai-toolkit-composer-layout');
                if (!composerLayoutStyleElement) {
                    composerLayoutStyleElement = document.createElement('style');
                    composerLayoutStyleElement.id = 'sai-toolkit-composer-layout';
                    composerLayoutStyleElement.textContent = getComposerLayoutCSSEarly();
                    if (document.head.firstChild) {
                        document.head.insertBefore(composerLayoutStyleElement, document.head.firstChild);
                    } else {
                        document.head.appendChild(composerLayoutStyleElement);
                    }
                }
            }
            composerLayoutStyleElement.disabled = false;
            // Body-class observer drives the new class-based selectors; start it
            // here in addition to the early-inject path so runtime toggles also
            // light up the layout correctly.
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            }
        } else {
            if (!sidebarStyleElement) {
                // Check if early-injected element exists
                sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early') ||
                                      document.getElementById('sai-toolkit-sidebar-layout');
            }
            if (sidebarStyleElement) {
                // Don't remove the element, just disable it to avoid React re-render issues
                sidebarStyleElement.disabled = true;
            }
            if (!composerLayoutStyleElement) {
                composerLayoutStyleElement = document.getElementById('sai-toolkit-composer-layout-early') ||
                                            document.getElementById('sai-toolkit-composer-layout');
            }
            if (composerLayoutStyleElement) {
                composerLayoutStyleElement.disabled = true;
            }
            if (typeof stopSidebarLayoutBodyClassObserver === 'function') {
                stopSidebarLayoutBodyClassObserver();
            }
        }
        if (saveToStorage) {
            sidebarUserEnabled = enable;
            await storage.set(SIDEBAR_LAYOUT_KEY, enable);
        }
    }
    
    // Check if page width supports sidebar layout and auto-enable/disable accordingly
    function checkSidebarResponsiveWidth() {
        const pageWidth = window.innerWidth;
        const shouldDisable = pageWidth < sidebarMinWidth;
        
        if (sidebarUserEnabled) {
            if (shouldDisable && !sidebarAutoDisabled) {
                // Page is too narrow - temporarily disable sidebar CSS
                debugLog(`[Core] Page width (${pageWidth}px) below ${sidebarMinWidth}px - auto-disabling sidebar layout`);
                sidebarAutoDisabled = true;
                toggleSidebarLayout(false, false); // Don't save to storage
                showNotification('Sidebar layout disabled (window too narrow)');
            } else if (!shouldDisable && sidebarAutoDisabled) {
                // Page is wide enough again - re-enable sidebar CSS
                debugLog(`[Core] Page width (${pageWidth}px) above ${sidebarMinWidth}px - re-enabling sidebar layout`);
                sidebarAutoDisabled = false;
                toggleSidebarLayout(true, false); // Don't save to storage
                showNotification('Sidebar layout restored');
            }
        }
    }
    
    // Initialize responsive sidebar listener
    function initResponsiveSidebar() {
        // Debounce resize events to avoid excessive calls
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(checkSidebarResponsiveWidth, 150);
        });

        // Check initial state
        checkSidebarResponsiveWidth();
    }

    // Re-check the non-chat-page restriction after SPA navigation. Settings changes
    // force a full reload (so the init-time check at startup is normally sufficient),
    // but clicking around the site (e.g. chat -> chatbot/edit) is client-side routing
    // that never reloads the page. Without this, the sidebar CSS injected on a chat
    // page stayed active after navigating to chatbot/edit, pinning modals like
    // "Attach Lorebook" into the 380px sidebar panel and hiding their action buttons.
    function applySidebarLayoutPageState() {
        if (!sidebarUserEnabled) return;
        const nonChatPage = isNonChatPageForSidebar();
        if (nonChatPage && !sidebarPageDisabled) {
            sidebarPageDisabled = true;
            toggleSidebarLayout(false, false);
        } else if (!nonChatPage && sidebarPageDisabled) {
            sidebarPageDisabled = false;
            if (!sidebarAutoDisabled) {
                toggleSidebarLayout(true, false);
            }
        }
    }

    // Deliberately polls location.pathname instead of patching history.pushState/
    // replaceState. Tried that first, but SpicyChat's own router reassigns
    // history.pushState after this content script runs (confirmed live: even a raw
    // `history.pushState(...)` call from the console stopped reaching a wrapper
    // installed here), so a patched version never actually saw real in-app
    // navigation (e.g. the chat header's "Edit Chatbot" menu item) fire it — it
    // silently never fired. `window.navigation` (the newer Navigation API) is
    // present in this browser too, which is likely what the site's router uses
    // instead of history.pushState — but that API doesn't exist in Firefox, which
    // this extension also ships to. Polling is slightly delayed but framework- and
    // browser-agnostic: it doesn't care how the URL changed underneath it.
    function initSidebarLayoutPageWatcher() {
        let lastPathname = window.location.pathname;
        setInterval(() => {
            const currentPathname = window.location.pathname;
            if (currentPathname !== lastPathname) {
                lastPathname = currentPathname;
                applySidebarLayoutPageState();
            }
        }, 300);
    }

    // CSS for compact generation settings
    function getCompactGenerationCSS() {
        // Use a data attribute to specifically target the Generation Settings modal
        // This prevents affecting other modals like "Select a Model"
        return `
            /* Hide all descriptive text paragraphs in Generation Settings modal ONLY */
            /* Target text-gray-11 descriptions (general descriptions) */
            div[data-sai-generation-settings="true"] p.text-gray-11 {
                display: none !important;
            }
            
            /* Target text-gray-10 descriptions (model description) */
            div[data-sai-generation-settings="true"] p.text-gray-10 {
                display: none !important;
            }
            
            /* Make the inference model section a horizontal row with wrap */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start {
                flex-direction: row !important;
                flex-wrap: wrap !important;
                align-items: center !important;
                gap: 8px !important;
            }
            
            /* "Inference Model" heading on its own line */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > p.text-label-lg {
                order: 1 !important;
                width: 100% !important;
            }
            
            /* Move button after the heading (new line) */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button {
                width: 32px !important;
                height: 32px !important;
                min-width: 32px !important;
                padding: 0 !important;
                border-radius: 4px !important;
                flex-shrink: 0 !important;
                order: 2 !important;
            }
            
            /* Move model info after button */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start .flex.py-md {
                flex: 1 !important;
                padding: 0 !important;
                order: 3 !important;
            }
            
            /* Hide the "Change Model" text */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button p {
                display: none !important;
            }
            
            /* Add pencil icon */
            div[data-sai-generation-settings="true"] div.flex.flex-col.items-start > button::before {
                content: "✎" !important;
                font-size: 18px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
            }
            
            /* Reduce gaps between settings for more compact view */
            div[data-sai-generation-settings="true"] .overflow-y-auto.overflow-x-hidden.grow.flex.flex-col.gap-lg.px-lg {
                gap: 0rem !important;
            }
            
            /* Target each setting container directly */
            div[data-sai-generation-settings="true"] .overflow-y-auto.overflow-x-hidden.grow > div.flex.flex-col.gap-1.w-full {
                margin-bottom: 0.5rem !important;
            }
            
            /* Reduce vertical spacing in each slider section */
            div[data-sai-generation-settings="true"] div.flex.flex-col.gap-1 {
                gap: 0.15rem !important;
            }
            
            /* Tighter spacing for slider controls */
            div[data-sai-generation-settings="true"] .flex.flex-1.items-center.gap-3 {
                margin-top: 0.15rem !important;
                margin-bottom: 0.15rem !important;
            }
        `;
    }
    
    let compactGenerationObserver = null;

    // Watch the Generation Settings modal for model name changes caused by SpicyChat's own
    // presets/profiles. When the displayed model changes, suppress the next mismatch regen.
    let _lastObservedModalModel = null;
    let _modelNameObserver = null;

    function checkGenerationSettingsModelChange() {
        const modal = findGenerationSettingsModal();
        if (!modal) {
            _lastObservedModalModel = null;
            return;
        }
        // Read current model name using the same logic as getCurrentSettings
        let currentModel = null;
        const labels = modal.querySelectorAll('p.text-label-lg');
        const inferenceLabel = Array.from(labels).find(p => p.textContent && p.textContent.trim() === 'Inference Model');
        if (inferenceLabel && inferenceLabel.parentElement) {
            const nameEl = inferenceLabel.parentElement.querySelector('p.text-label-lg.font-regular.text-gray-12');
            if (nameEl && nameEl.textContent) currentModel = nameEl.textContent.trim();
        }
        if (!currentModel) {
            const el = modal.querySelector('.text-\\[14px\\].font-medium');
            if (el && el.textContent) currentModel = el.textContent.trim();
        }
        if (!currentModel) return;

        if (_lastObservedModalModel !== null && _lastObservedModalModel !== currentModel) {
            window.__suppressMismatchNext = true;
            debugLog('[Model] Generation Settings model name changed (', _lastObservedModalModel, '→', currentModel, ') — suppressing next mismatch auto-regen');
        }
        _lastObservedModalModel = currentModel;
    }

    function startGenerationSettingsModelWatcher() {
        if (_modelNameObserver) return; // already running
        // Perf: only re-run the model check when a fixed-position modal is added/removed
        // anywhere in the tree. Subtree childList still fires, but characterData (which
        // fires on every streaming-message text node update) is no longer observed.
        _modelNameObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
                const nodes = [...m.addedNodes, ...m.removedNodes];
                for (const n of nodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                        n.querySelector?.('p.text-heading-6')) {
                        checkGenerationSettingsModelChange();
                        return;
                    }
                }
            }
        });
        _modelNameObserver.observe(document.body, { childList: true, subtree: true });
        debugLog('[Model] Generation Settings model-name watcher started');
    }

    // Function to mark Generation Settings modal with data attribute
    function markGenerationSettingsModal() {
        // Find all fixed modals
        const modalSelectors = [
            'div.fixed.left-1\\/2.top-1\\/2',
            'div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]'
        ];
        
        for (const selector of modalSelectors) {
            const modals = document.querySelectorAll(selector);
            for (const modal of modals) {
                // Check if this is the Generation Settings modal by looking for the heading
                const heading = modal.querySelector('p.text-heading-6');
                if (heading && heading.textContent && heading.textContent.includes('Generation Settings')) {
                    // Mark it with our data attribute
                    if (!modal.hasAttribute('data-sai-generation-settings')) {
                        modal.setAttribute('data-sai-generation-settings', 'true');
                        debugLog('[Compact] Marked Generation Settings modal');
                    }
                } else {
                    // Remove attribute if this is not the Generation Settings modal
                    if (modal.hasAttribute('data-sai-generation-settings')) {
                        modal.removeAttribute('data-sai-generation-settings');
                    }
                }
            }
        }
    }
    
    // Apply or remove compact generation settings CSS
    async function toggleCompactGeneration(enable) {
        if (enable) {
            if (!compactGenerationStyleElement) {
                compactGenerationStyleElement = document.createElement('style');
                compactGenerationStyleElement.id = 'sai-toolkit-compact-generation';
                compactGenerationStyleElement.textContent = getCompactGenerationCSS();
                document.head.appendChild(compactGenerationStyleElement);
            }
            
            // Start observing for Generation Settings modal
            if (!compactGenerationObserver) {
                // Initial check
                markGenerationSettingsModal();
                
                // Observer to detect when modal appears
                // Perf: only re-scan when a node is added/removed that could be a modal
                compactGenerationObserver = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
                        const nodes = [...m.addedNodes, ...m.removedNodes];
                        for (const n of nodes) {
                            if (n.nodeType !== 1) continue;
                            if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                                n.querySelector?.('p.text-heading-6')) {
                                markGenerationSettingsModal();
                                return;
                            }
                        }
                    }
                });
                
                compactGenerationObserver.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            }
        } else {
            if (compactGenerationStyleElement) {
                compactGenerationStyleElement.remove();
                compactGenerationStyleElement = null;
            }
            
            // Stop observer
            if (compactGenerationObserver) {
                compactGenerationObserver.disconnect();
                compactGenerationObserver = null;
            }
            
            // Remove data attributes from any marked modals
            const markedModals = document.querySelectorAll('[data-sai-generation-settings]');
            markedModals.forEach(modal => modal.removeAttribute('data-sai-generation-settings'));
        }
        await storage.set(COMPACT_GENERATION_KEY, enable);
    }
    
    // Hide For You functionality
    function isPageOne() {
        const url = window.location.href;
        // Exclude recommended-bots page from hiding
        if (url.includes('/recommended-bots')) {
            return false;
        }
        const hasNoPageParam = !url.includes('%5Bpage%5D=') && !url.includes('[page]=');
        const isPageOneParam = url.includes('%5Bpage%5D=1') || url.includes('[page]=1');
        return hasNoPageParam || isPageOneParam;
    }
    
    function hideForYouCharacters() {
        const characterTiles = document.querySelectorAll('.relative.group.rounded-xl.bg-gray-3');
        characterTiles.forEach(async tile => {
            const forYouBadge = tile.querySelector('.bg-purple-9 p.text-white');
            if (forYouBadge && forYouBadge.textContent.trim() === 'For You') {
                const parentWrapper = tile.parentElement;
                if (parentWrapper && !parentWrapper.dataset.hiddenByScript) {
                    parentWrapper.dataset.hiddenByScript = 'true';
                    parentWrapper.style.cssText = 'display: none !important; position: absolute !important; width: 0 !important; height: 0 !important;';
                }
            }
        });
    }
    
    function startHideForYou() {
        if (hideForYouActive) return;
        
        // OPTIMIZATION: Use single delayed call instead of multiple timers
        setTimeout(hideForYouCharacters, 500);
        
        hideForYouObserver = new MutationObserver((mutations) => {
            if (!isPageOne()) {
                stopHideForYou();
                return;
            }
            
            // OPTIMIZATION: Single pass through mutations checking both relevance and hiding needs
            let needsHiding = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    // Check if mutation is in character grid area (relevance check)
                    const target = mutation.target;
                    if (target.classList && (target.classList.contains('grid') || 
                        target.classList.contains('gap-4') || 
                        target.closest('.grid.gap-4'))) {
                        
                        // Check added nodes for character tiles
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                if (node.matches && (node.matches('.relative.group.rounded-xl.bg-gray-3') || node.matches('.bg-purple-9'))) {
                                    needsHiding = true;
                                    break;
                                }
                                if (node.querySelector && (node.querySelector('.relative.group.rounded-xl.bg-gray-3') || node.querySelector('.bg-purple-9'))) {
                                    needsHiding = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if (needsHiding) break;
            }
            
            if (needsHiding) {
                setTimeout(hideForYouCharacters, 100);
            }
        });
        
        hideForYouObserver.observe(document.body, { childList: true, subtree: true });
        hideForYouActive = true;
    }
    
    function stopHideForYou() {
        if (hideForYouObserver) {
            hideForYouObserver.disconnect();
            hideForYouObserver = null;
        }
        hideForYouActive = false;
        
        // Restore all hidden "For You" characters
        restoreForYouCharacters();
    }
    
    function restoreForYouCharacters() {
        const hiddenWrappers = document.querySelectorAll('[data-hidden-by-script="true"]');
        hiddenWrappers.forEach(async wrapper => {
            wrapper.style.cssText = '';
            delete wrapper.dataset.hiddenByScript;
        });
    }
    
    function checkHideForYouPage() {
        if (isPageOne() && !hideForYouActive) {
            startHideForYou();
        } else if (!isPageOne() && hideForYouActive) {
            stopHideForYou();
        }
    }
    
    async function toggleHideForYou(enable) {
        if (enable) {
            checkHideForYouPage();

            if (!hideForYouUrlObserver) {
                // Originally patched history.pushState/replaceState + listened for
                // popstate, on the assumption that's how SpicyChat's SPA navigation
                // changes the URL. Confirmed (while fixing an identical assumption in
                // Sidebar Layout, see applySidebarLayoutPageState) that it isn't: the
                // site's own router reassigns history.pushState after this content
                // script runs, so a wrapper installed here never actually saw real
                // in-app navigation fire it. Polling location.href is slightly
                // delayed but doesn't depend on how the framework changes the URL.
                let lastUrl = window.location.href;
                hideForYouUrlObserver = setInterval(() => {
                    const currentUrl = window.location.href;
                    if (currentUrl !== lastUrl) {
                        lastUrl = currentUrl;
                        checkHideForYouPage();
                    }
                }, 300);
            }
        } else {
            stopHideForYou();
            if (hideForYouUrlObserver) {
                clearInterval(hideForYouUrlObserver);
                hideForYouUrlObserver = null;
            }
        }
        await storage.set(HIDE_FOR_YOU_KEY, enable);
    }
    
    // Page Jump functionality
    function getTotalPages() {
        const pageButtons = document.querySelectorAll('button[aria-label^="page-"]');
        let maxPage = 1;
        pageButtons.forEach(async button => {
            const label = button.getAttribute('aria-label');
            if (label && label.startsWith('page-')) {
                const pageNum = label.replace('page-', '');
                if (pageNum !== '...' && !isNaN(pageNum)) {
                    const num = parseInt(pageNum);
                    if (num > maxPage) {
                        maxPage = num;
                    }
                }
            }
        });
        return maxPage;
    }
    
    function getCurrentPage() {
        const currentButton = document.querySelector('button[aria-label^="page-"].bg-blue-10');
        if (currentButton) {
            const label = currentButton.getAttribute('aria-label');
            const pageNum = label.replace('page-', '');
            return parseInt(pageNum);
        }
        return 1;
    }
    
    function navigateToPage(pageNumber) {
        let urlString = window.location.href;
        const pagePattern = /%5Bpage%5D=\d+/;
        if (pagePattern.test(urlString)) {
            urlString = urlString.replace(pagePattern, `%5Bpage%5D=${pageNumber}`);
        } else {
            if (urlString.includes('?')) {
                urlString += `&public_characters_alias%2Fsort%2Fnum_messages_24h%3Adesc%5Bpage%5D=${pageNumber}`;
            } else {
                urlString += `?public_characters_alias%2Fsort%2Fnum_messages_24h%3Adesc%5Bpage%5D=${pageNumber}`;
            }
        }
        window.location.href = urlString;
    }
    
    function showPageJumpModal() {
        const totalPages = getTotalPages();
        const currentPage = getCurrentPage();
        const isDark = document.documentElement.classList.contains('dark');
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);`;
        
        const modal = document.createElement('div');
        modal.style.cssText = `background: ${isDark ? '#1a1a1a' : '#ffffff'}; border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);`;
        
        // Use safe HTML construction to avoid innerHTML security warnings
        const h2 = document.createElement('h2');
        h2.style.cssText = `font-size: 20px; font-weight: 600; margin-bottom: 16px; color: ${isDark ? '#fff' : '#000'};`;
        h2.textContent = 'Jump to Page';
        
        const p = document.createElement('p');
        p.style.cssText = `font-size: 14px; margin-bottom: 16px; color: ${isDark ? '#a1a1aa' : '#666'};`;
        p.textContent = `Enter a page number between 1 and ${totalPages}`;
        
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'page-jump-input';
        input.min = '1';
        input.max = totalPages.toString();
        input.value = currentPage.toString();
        input.placeholder = 'Page number';
        input.style.cssText = `width: 100%; padding: 10px 12px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; border-radius: 8px; font-size: 16px; margin-bottom: 20px; background: ${isDark ? '#27272a' : '#fff'}; color: ${isDark ? '#fff' : '#000'};`;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'page-jump-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `padding: 8px 16px; border: 1px solid ${isDark ? '#3f3f46' : '#ccc'}; background: transparent; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; color: ${isDark ? '#fff' : '#000'}; transition: all 0.2s;`;
        
        const okBtn = document.createElement('button');
        okBtn.id = 'page-jump-ok';
        okBtn.textContent = 'Go to Page';
        okBtn.style.cssText = 'padding: 8px 16px; border: none; background: #0072F5; color: white; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;';
        
        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(okBtn);
        
        modal.appendChild(h2);
        modal.appendChild(p);
        modal.appendChild(input);
        modal.appendChild(buttonContainer);
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        const inputElement = document.getElementById('page-jump-input');
        setTimeout(() => { inputElement.focus(); inputElement.select(); }, 100);
        
        const okButton = document.getElementById('page-jump-ok');
        const cancelButton = document.getElementById('page-jump-cancel');
        
        function closeModal() { overlay.remove(); }
        
        function handleSubmit() {
            const pageNumber = parseInt(inputElement.value);
            if (isNaN(pageNumber)) {
                alert('Please enter a valid page number');
                return;
            }
            if (pageNumber < 1 || pageNumber > totalPages) {
                alert(`Please enter a page number between 1 and ${totalPages}`);
                return;
            }
            closeModal();
            navigateToPage(pageNumber);
        }
        
        cancelButton.addEventListener('click', closeModal);
        overlay.addEventListener('click', async (e) => { if (e.target === overlay) closeModal(); });
        okButton.addEventListener('click', handleSubmit);
        inputElement.addEventListener('keypress', async (e) => { if (e.key === 'Enter') handleSubmit(); });
        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escapeHandler);
            }
        });
    }
    
    function enhanceEllipsisButton() {
        const ellipsisButtons = document.querySelectorAll('button[aria-label="page-..."]');
        if (ellipsisButtons.length === 0) return;
        
        ellipsisButtons.forEach(async ellipsisButton => {
            if (ellipsisButton.dataset.enhanced === 'true') return;
            ellipsisButton.dataset.enhanced = 'true';
            ellipsisButton.classList.remove('cursor-default');
            ellipsisButton.classList.add('cursor-pointer');
            ellipsisButton.classList.remove('undefined');
            
            ellipsisButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                showPageJumpModal();
            });
        });
    }
    
    async function togglePageJump(enable) {
        if (enable) {
            setTimeout(enhanceEllipsisButton, 1000);
            
            if (!pageJumpObserver) {
                pageJumpObserver = new MutationObserver((mutations) => {
                    let needsEnhancement = false;
                    for (const mutation of mutations) {
                        if (mutation.addedNodes.length > 0) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === 1) {
                                    if (node.matches && node.matches('button[aria-label="page-..."]')) {
                                        needsEnhancement = true;
                                        break;
                                    }
                                    if (node.querySelector && node.querySelector('button[aria-label="page-..."]')) {
                                        needsEnhancement = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (needsEnhancement) break;
                    }
                    if (needsEnhancement) {
                        setTimeout(enhanceEllipsisButton, 100);
                    }
                });
                pageJumpObserver.observe(document.body, { childList: true, subtree: true });
            }
        } else {
            if (pageJumpObserver) {
                pageJumpObserver.disconnect();
                pageJumpObserver = null;
            }
        }
        await storage.set(PAGE_JUMP_KEY, enable);
    }
    
    // Initialize features on page load
    async function initializeStyles() {
        // PERFORMANCE: Batch all feature settings into a single storage read
        const featureSettings = await storage.getMultiple({
            [SIDEBAR_LAYOUT_KEY]: false,
            [HIDE_FOR_YOU_KEY]: false,
            [PAGE_JUMP_KEY]: false,
            [COMPACT_GENERATION_KEY]: false,
            [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH
        });
        
        const sidebarEnabled = featureSettings[SIDEBAR_LAYOUT_KEY];
        const hideForYouEnabled = featureSettings[HIDE_FOR_YOU_KEY];
        const pageJumpEnabled = featureSettings[PAGE_JUMP_KEY];
        const compactGenerationEnabled = featureSettings[COMPACT_GENERATION_KEY];
        
        // Load sidebar minimum width setting
        sidebarMinWidth = featureSettings[SIDEBAR_MIN_WIDTH_KEY];
        
        debugLog('[Core] Initializing with settings:', {
            sidebar: sidebarEnabled,
            sidebarMinWidth: sidebarMinWidth,
            hideForYou: hideForYouEnabled,
            pageJump: pageJumpEnabled,
            compactGeneration: compactGenerationEnabled
        });
        
        // Initialize sidebarUserEnabled for responsive sidebar tracking
        sidebarUserEnabled = sidebarEnabled;

        // Sidebar Layout CSS is already injected early if enabled
        // Just get a reference to the existing element
        // BUT: Ensure it's disabled on non-chat pages (chatbot, lorebook, group, voice, ...)
        const shouldDisableSidebarLayout = isNonChatPageForSidebar();
        sidebarPageDisabled = sidebarEnabled && shouldDisableSidebarLayout;

        if (sidebarEnabled && !shouldDisableSidebarLayout) {
            sidebarStyleElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (sidebarStyleElement) {
                debugLog('[Core] Using early-injected Sidebar Layout CSS');
                sidebarStyleElement.disabled = false;
            }
            // Defensive: re-run sweep + ensure observer is attached. The early-inject
            // path normally starts the observer, but if the page started on a
            // non-chat URL (early-inject skipped) and then SPA-navigated to a chat
            // page, the observer would never have been kicked off. This is idempotent.
            if (typeof startSidebarLayoutBodyClassObserver === 'function') {
                startSidebarLayoutBodyClassObserver();
            }
            if (typeof updateSidebarLayoutBodyClasses === 'function') {
                updateSidebarLayoutBodyClasses();
            }
            // Composer CSS shares Sidebar Layout's "chat pages only" gating (see
            // toggleSidebarLayout) — mirror the same enable/disable handling here so
            // it isn't stuck on whatever the very first early-inject check decided.
            composerLayoutStyleElement = document.getElementById('sai-toolkit-composer-layout-early');
            if (composerLayoutStyleElement) {
                debugLog('[Core] Using early-injected Composer Layout CSS');
                composerLayoutStyleElement.disabled = false;
            }
        } else {
            // If disabled or on non-chat page, ensure early CSS is disabled
            const earlyElement = document.getElementById('sai-toolkit-sidebar-layout-early');
            if (earlyElement) {
                earlyElement.disabled = true;
                sidebarStyleElement = earlyElement;
                debugLog('[Core] Disabled early-injected Sidebar Layout CSS' + (shouldDisableSidebarLayout ? ' (non-chat page)' : ''));
            }
            const earlyComposerElement = document.getElementById('sai-toolkit-composer-layout-early');
            if (earlyComposerElement) {
                earlyComposerElement.disabled = true;
                composerLayoutStyleElement = earlyComposerElement;
                debugLog('[Core] Disabled early-injected Composer Layout CSS' + (shouldDisableSidebarLayout ? ' (non-chat page)' : ''));
            }
        }
        
        // Initialize responsive sidebar listener (handles auto-disable when page is narrow)
        initResponsiveSidebar();
        // Re-apply the non-chat-page restriction on SPA navigation (chat <-> chatbot/edit etc.)
        initSidebarLayoutPageWatcher();

        if (compactGenerationEnabled) {
            await toggleCompactGeneration(true);
        }
        
        if (hideForYouEnabled) {
            await toggleHideForYou(true);
        } else {
            // Ensure any previously hidden characters are restored on page load
            setTimeout(() => {
                restoreForYouCharacters();
            }, 1000);
        }
        if (pageJumpEnabled) {
            await togglePageJump(true);
        }
    }

    // Function to inject S.AI Toolkit Settings menu item
    // REMOVED: No longer injecting into contextual dropdown menu
    // Toolkit is now accessible only via header icon
    function injectToolkitMenuItem() {
        // This function is intentionally left empty but kept for compatibility
        // The toolkit settings are now only accessible via the header icon
    }

    // ---- Drive auth error helpers ----

    function clearDriveAuthError() {
        driveAuthErrorMessage = null;
        const sb = document.getElementById('sai-toolkit-sidebar-btn');
        const mb = document.getElementById('sai-toolkit-mobile-btn');
        if (sb) sb.style.color = '';
        if (mb) mb.style.color = '';
    }

    function showDriveAuthModal() {
        const existing = document.getElementById('sai-drive-auth-modal');
        if (existing) return;

        const overlay = document.createElement('div');
        overlay.id = 'sai-drive-auth-modal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000010;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';

        const card = document.createElement('div');
        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:300px;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid #dc2626;';

        const titleEl = document.createElement('div');
        titleEl.textContent = 'Google Drive Sign-in Required';
        titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';

        const descEl = document.createElement('div');
        descEl.textContent = 'Your Drive session has expired. Sign in again to resume auto-sync.';
        descEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;';

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'font-size:11px;min-height:1em;color:#9ca3af;';

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;flex-direction:column;gap:0.4rem;margin-top:0.25rem;';

        const signInBtn = document.createElement('button');
        signInBtn.textContent = 'Sign in to Google Drive';
        signInBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #3b82f6;background:#1d4ed8;color:#fff;font-size:12px;cursor:pointer;';

        const laterBtn = document.createElement('button');
        laterBtn.textContent = 'Later';
        laterBtn.style.cssText = 'padding:0.25rem;border:none;background:transparent;color:#6b7280;font-size:11px;cursor:pointer;text-align:center;';

        signInBtn.onclick = async () => {
            signInBtn.disabled = true;
            signInBtn.textContent = 'Signing in…';
            statusEl.textContent = '';
            try {
                const result = await new Promise((resolve, reject) => {
                    runtimeAPI.runtime.sendMessage(
                        { type: 'SAI_DRIVE_SYNC', syncStats: true, syncSettings: false, syncStyle: false },
                        (res) => {
                            const err = runtimeAPI.runtime.lastError;
                            if (err) reject(new Error(err.message));
                            else resolve(res);
                        }
                    );
                });
                if (result && result.success) {
                    clearDriveAuthError();
                    overlay.remove();
                } else {
                    statusEl.textContent = (result && result.error) || 'Sign-in failed.';
                    statusEl.style.color = '#dc2626';
                    signInBtn.disabled = false;
                    signInBtn.textContent = 'Sign in to Google Drive';
                }
            } catch (err) {
                statusEl.textContent = err.message || 'Sign-in failed.';
                statusEl.style.color = '#dc2626';
                signInBtn.disabled = false;
                signInBtn.textContent = 'Sign in to Google Drive';
            }
        };

        laterBtn.onclick = () => overlay.remove();

        btns.appendChild(signInBtn);
        btns.appendChild(laterBtn);
        card.appendChild(titleEl);
        card.appendChild(descEl);
        card.appendChild(statusEl);
        card.appendChild(btns);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    }

    // Function to inject toolkit icon on header (left of notification bell)
    // Function to inject toolkit button into left sidebar
    function injectToolkitSidebarButton() {
        // Skip injection on mobile - sidebar doesn't exist below 600px
        if (window.innerWidth < 600) {
            debugLog('[Core] Skipping sidebar injection - width < 600px');
            return;
        }
        
        // Check for sidebar width transition - React crashes if we inject during width change
        const sidebar = document.querySelector('nav.flex.flex-col');
        if (sidebar) {
            const currentSidebarWidth = sidebar.style.width || sidebar.offsetWidth + 'px';
            if (lastKnownSidebarWidth !== null && lastKnownSidebarWidth !== currentSidebarWidth) {
                debugLog('[Core] Sidebar width changed from', lastKnownSidebarWidth, 'to', currentSidebarWidth, '- skipping injection');
                sidebarWidthTransitionPending = true;
                lastKnownSidebarWidth = currentSidebarWidth;
                // Schedule re-injection after transition settles
                setTimeout(() => {
                    sidebarWidthTransitionPending = false;
                    debugLog('[Core] Sidebar transition settled, ready for injection');
                }, 400);
                return;
            }
            lastKnownSidebarWidth = currentSidebarWidth;
        }
        
        if (sidebarWidthTransitionPending) {
            debugLog('[Core] Sidebar transition pending - skipping injection');
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-toolkit-sidebar-btn');
        if (existingButton) {
            return;
        }
        
        debugLog('[Core] Searching for Help button...');
        
        // Find the Help button in the sidebar (last section with Subscribe and Help)
        // The Help button is now inside an <a> tag linking to docs.spicychat.ai/support
        let helpButton = null;
        let helpLink = null;
        
        // First, try to find the <a> tag with the help link
        helpLink = document.querySelector('a[href="https://docs.spicychat.ai/support"]');
        if (helpLink) {
            helpButton = helpLink.querySelector('button');
            debugLog('[Core] Found help button via link selector');
        }
        
        // Fallback: try finding by icon and text content
        if (!helpButton) {
            debugLog('[Core] Link selector failed, trying icon+text method');
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const hasInfoIcon = btn.querySelector('svg.lucide-info');
                const hasHelpText = btn.textContent?.trim().includes('Help');
                if (hasInfoIcon && hasHelpText) {
                    helpButton = btn;
                    debugLog('[Core] Found help button via icon+text');
                    break;
                }
            }
        }
        
        // Another fallback: find Subscribe button and get its sibling
        if (!helpButton) {
            debugLog('[Core] Trying Subscribe sibling method');
            const subscribeLink = document.querySelector('a[href$="/subscribe"]');
            if (subscribeLink) {
                const subscribeWrapper = subscribeLink.closest('div.w-full');
                if (subscribeWrapper && subscribeWrapper.nextElementSibling) {
                    const helpWrapper = subscribeWrapper.nextElementSibling;
                    helpLink = helpWrapper.querySelector('a[href*="docs.spicychat.ai"]');
                    if (helpLink) {
                        helpButton = helpLink.querySelector('button');
                        debugLog('[Core] Found help button via Subscribe sibling');
                    }
                }
            }
        }
        
        // Last fallback: just find by info icon alone
        if (!helpButton) {
            debugLog('[Core] Trying info icon only method');
            const infoIcons = document.querySelectorAll('svg.lucide-info');
            for (const icon of infoIcons) {
                const btn = icon.closest('button');
                if (btn) {
                    helpButton = btn;
                    debugLog('[Core] Found help button via info icon');
                    break;
                }
            }
        }
        
        if (!helpButton) {
            debugLog('[Core] Help button not found after all attempts');
            debugLog('[Core] Available links:', Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h.includes('spicychat')));
            debugLog('[Core] Info icons found:', document.querySelectorAll('svg.lucide-info').length);
            return;
        }
        
        debugLog('[Core] Help button found, proceeding...');
        
        // Get the parent container (the div.w-full that wraps the <a> tag)
        // The structure is now: div.w-full > a > button
        const helpAnchor = helpButton.closest('a');
        const helpButtonWrapper = helpAnchor ? helpAnchor.closest('div.w-full') : helpButton.closest('div.w-full');
        
        if (!helpButtonWrapper) {
            debugLog('[Core] Help button wrapper not found');
            debugLog('[Core] Help button parent structure:', helpButton.parentElement?.className);
            debugLog('[Core] Help button parent element:', helpButton.parentElement);
            return;
        }
        
        // Clone the Help button structure to match styling exactly
        const buttonWrapper = helpButtonWrapper.cloneNode(true);
        const clonedAnchor = buttonWrapper.querySelector('a');
        const clonedButton = buttonWrapper.querySelector('button');
        
        // Update the cloned button
        clonedButton.id = 'sai-toolkit-sidebar-btn';
        
        // Update the anchor to prevent navigation (make it a button-like link)
        if (clonedAnchor) {
            clonedAnchor.removeAttribute('href');
            clonedAnchor.style.cursor = 'pointer';
        }
        
        // Remove ALL React tooltip attributes to prevent React from creating duplicate tooltips
        // We'll use our own custom tooltip instead
        const elementsWithTooltip = buttonWrapper.querySelectorAll('[data-tooltip-id]');
        elementsWithTooltip.forEach(el => {
            el.removeAttribute('data-tooltip-id');
            el.removeAttribute('data-tooltip-content');
        });
        debugLog('[Core] Removed React tooltip attributes');
        
        // Replace the SVG icon with wrench icon and ensure text element exists
        const iconContainer = clonedButton.querySelector('.flex.items-center.gap-2');
        if (iconContainer) {
            const svg = iconContainer.querySelector('svg');
            if (svg) {
                svg.outerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wrench inline-flex items-center justify-center flex-none">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                </svg>`;
            }
            
            // Remove ALL existing text elements (from cloned Help button)
            const existingTextElements = iconContainer.querySelectorAll('p');
            existingTextElements.forEach(el => el.remove());
            
            // Create ONE new text element with SAME classes as Help/Subscribe buttons
            let textElement = document.createElement('p');
            textElement.className = 'font-sans text-decoration-skip-ink-none text-underline-position-from-font text-label-lg font-regular text-left truncate toolkit-button-text';
            textElement.textContent = 'S.AI Toolkit';
            iconContainer.appendChild(textElement);
        }
        
        // Custom tooltip for collapsed sidebar (since we removed React tooltip attributes)
        let customTooltip = null;
        
        // Add click handler (also cleans up tooltip)
        clonedButton.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (customTooltip) {
                customTooltip.remove();
                customTooltip = null;
            }
            showToolkitSettingsModal();
        });
        
        clonedButton.addEventListener('mouseenter', function(e) {
            // Check if sidebar is collapsed
            const nav = clonedButton.closest('nav');
            const isCollapsed = nav && nav.style.width === '54px';
            
            if (isCollapsed && !customTooltip) {
                // Create tooltip matching React's tooltip format exactly
                customTooltip = document.createElement('div');
                customTooltip.id = ':r-toolkit:';
                customTooltip.setAttribute('role', 'tooltip');
                customTooltip.className = 'react-tooltip core-styles-module_tooltip__3vRRp styles-module_tooltip__mnnfp styles-module_dark__xNqje !px-2.5 !py-1.5 !rounded-[9px] !bg-black !whitespace-nowrap !transition-opacity !duration-300 react-tooltip__place-right core-styles-module_show__Nt9eE react-tooltip__show';
                const authErr = driveAuthErrorMessage;
                customTooltip.style.cssText = `z-index: 200000; border: 1px solid ${authErr ? '#dc2626' : 'rgb(71, 71, 71)'}; opacity: 1;`;
                customTooltip.textContent = authErr ? authErr : 'S.AI Toolkit';
                
                // Create the arrow element
                const arrow = document.createElement('div');
                arrow.className = 'react-tooltip-arrow core-styles-module_arrow__cvMwQ styles-module_arrow__K0L3T';
                arrow.style.cssText = 'left: -5px; top: 10.5px; border-bottom: 1px solid rgb(71, 71, 71); border-right: 1px solid rgb(71, 71, 71); --rt-arrow-size: 8px;';
                customTooltip.appendChild(arrow);
                
                // Position tooltip to the right of the button
                const rect = clonedButton.getBoundingClientRect();
                customTooltip.style.left = (rect.right + 8) + 'px';
                customTooltip.style.top = (rect.top + rect.height / 2 - 14) + 'px'; // Adjust for tooltip height
                
                document.body.appendChild(customTooltip);
            }
        });
        
        clonedButton.addEventListener('mouseleave', function() {
            if (customTooltip) {
                customTooltip.remove();
                customTooltip = null;
            }
        });
        
        // Insert after the Help button wrapper
        helpButtonWrapper.parentNode.insertBefore(buttonWrapper, helpButtonWrapper.nextSibling);
        
        debugLog('[Core] Sidebar button injected successfully');
    }
    
    // Function to inject toolkit button in mobile header (next to Like button)
    function injectToolkitMobileButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-toolkit-mobile-btn');
        if (existingButton) return;
        
        // Find the button container in the chat header
        // Try multiple possible reference buttons (Like button on 1:1 chats, Sparkles on group chats, or chat-dropdown)
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[Core] No reference button found in chat header');
            return;
        }
        
        // Get the parent container (the flex container with gap-sm)
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Core] Mobile button container not found');
            return;
        }
        
        // Create the toolkit button matching the other button styles
        const toolkitBtn = document.createElement('button');
        toolkitBtn.id = 'sai-toolkit-mobile-btn';
        toolkitBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        toolkitBtn.setAttribute('aria-label', 'SAI-Toolkit-button');
        toolkitBtn.setAttribute('type', 'button');
        
        toolkitBtn.appendChild(makeSVG({
            xmlns: SVG_NS, width: '20', height: '20', viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            class: 'lucide lucide-wrench inline-flex items-center justify-center w-5 h-5'
        }, [
            ['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]
        ]));
        
        // Add click handler
        toolkitBtn.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            showToolkitSettingsModal();
        });
        
        // Insert at the beginning of the container (leftmost position)
        buttonContainer.insertBefore(toolkitBtn, buttonContainer.firstChild);
        debugLog('[Core] Mobile button injected successfully');
    }
    
    // ============================================================================
    // CHAT EXPORT FEATURE
    // ============================================================================
    
    // Function to inject chat export button in mobile header (to the left of toolkit settings button)
    function injectChatExportButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Show on chat pages (/chat/ or /{language}/chat/) and on Story Mode
        // pages (/story/...) — export works identically in both.
        if (!isOnChatPage() && !isStoryMode()) {
            return;
        }

        // Check if already injected
        const existingButton = document.getElementById('sai-export-btn');
        if (existingButton) return;
        
        // Find the toolkit button first (our own button), or fall back to other header buttons
        const toolkitBtn = document.getElementById('sai-toolkit-mobile-btn');
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = toolkitBtn || likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[Export] Reference button not found');
            return;
        }
        
        // Get the parent container
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[Export] Button container not found');
            return;
        }
        
        // Create the export button matching the other button styles
        const exportBtn = document.createElement('button');
        exportBtn.id = 'sai-export-btn';
        exportBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        exportBtn.setAttribute('aria-label', 'Export-chat-button');
        exportBtn.setAttribute('type', 'button');
        
        // Download icon SVG
        exportBtn.appendChild(makeSVG({
            xmlns: SVG_NS, width: '20', height: '20', viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            class: 'lucide lucide-download inline-flex items-center justify-center w-5 h-5'
        }, [
            ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
            ['polyline', { points: '7 10 12 15 17 10' }],
            ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]
        ]));
        
        // Add click handler to show export menu
        exportBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showExportMenu(exportBtn);
        });
        
        // Position the button. In Story Mode the reference buttons (Sparkles /
        // Generation Settings, and our Auto Story toggle) are wrapped in
        // tooltip/layout divs rather than being direct children of the row, so
        // use insertBeforeContainerChild. Place export to the LEFT of the Auto
        // Story toggle (or the Sparkles button if the toggle isn't present yet),
        // mirroring Chat Mode where export sits left of the toolkit button.
        if (isStoryMode()) {
            const autoStoryBtn = document.getElementById('sai-auto-story-btn');
            const anchor = autoStoryBtn || sparklesButton || referenceButton;
            insertBeforeContainerChild(buttonContainer, anchor, exportBtn);
        } else if (toolkitBtn) {
            buttonContainer.insertBefore(exportBtn, toolkitBtn);
        } else {
            buttonContainer.insertBefore(exportBtn, buttonContainer.firstChild);
        }
        debugLog('[Export] Export button injected successfully');
    }
    
    // Track NSFW mode state globally
    let nsfwModeEnabled = false;
    
    // Function to inject NSFW mode toggle button in toolbar
    async function injectNSFWToggleButton() {
        // Skip during resize/transition to prevent React 185 error
        if (typeof isResizing !== 'undefined' && isResizing) {
            return;
        }
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) {
            return;
        }
        
        // Only show on chat pages (supports both /chat/ and /{language}/chat/)
        if (!isOnChatPage()) {
            return;
        }
        
        // Check if feature is enabled in settings (default: false)
        const nsfwToggleEnabled = await storage.get('nsfwToggleEnabled', false);
        if (!nsfwToggleEnabled) {
            debugLog('[NSFW] NSFW toggle feature disabled in settings');
            return;
        }
        
        // Check if already injected
        const existingButton = document.getElementById('sai-nsfw-btn');
        if (existingButton) return;
        
        // Find the export button or toolkit button as reference
        const exportBtn = document.getElementById('sai-export-btn');
        const toolkitBtn = document.getElementById('sai-toolkit-mobile-btn');
        const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
        const sparklesButton = document.querySelector('button[aria-label="Sparkles-button"]');
        const chatDropdown = document.querySelector('button[aria-label="chat-dropdown"]');
        
        const referenceButton = exportBtn || toolkitBtn || likeButton || sparklesButton || chatDropdown;
        if (!referenceButton) {
            debugLog('[NSFW] Reference button not found');
            return;
        }
        
        // Get the parent container
        const buttonContainer = referenceButton.closest('.flex.justify-end.items-center.gap-sm');
        if (!buttonContainer) {
            debugLog('[NSFW] Button container not found');
            return;
        }
        
        // Create the NSFW toggle button matching the other button styles
        const nsfwBtn = document.createElement('button');
        nsfwBtn.id = 'sai-nsfw-btn';
        nsfwBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        nsfwBtn.setAttribute('aria-label', 'Toggle-NSFW-image-mode');
        nsfwBtn.setAttribute('type', 'button');
        nsfwBtn.title = 'Toggle NSFW Image Mode';
        
        // Create the icon (flame/fire icon - good for NSFW indicator)
        // We'll update the icon style based on state
        updateNSFWButtonIcon(nsfwBtn);
        
        // Add click handler to toggle NSFW mode
        nsfwBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            toggleNSFWMode();
        });
        
        // Insert before the export button (to the left of it)
        if (exportBtn) {
            buttonContainer.insertBefore(nsfwBtn, exportBtn);
        } else if (toolkitBtn) {
            buttonContainer.insertBefore(nsfwBtn, toolkitBtn);
        } else {
            buttonContainer.insertBefore(nsfwBtn, buttonContainer.firstChild);
        }
        
        // Check initial NSFW state from the page context
        checkCurrentNSFWState();
        
        // Initialize modal watcher to sync with Image Settings modal
        initModalWatcher();
        
        debugLog('[NSFW] NSFW toggle button injected successfully');
    }
    
    // Update the NSFW button icon based on current state
    function updateNSFWButtonIcon(btn) {
        if (!btn) btn = document.getElementById('sai-nsfw-btn');
        if (!btn) return;
        
        // Use a flame icon - colored/highlighted when enabled, monochrome when disabled
        const fillColor = nsfwModeEnabled ? '#f97316' : 'none'; // Orange when enabled
        const strokeColor = nsfwModeEnabled ? '#f97316' : 'currentColor'; // Orange when enabled, gray when disabled
        const opacity = nsfwModeEnabled ? '1' : '0.5';
        
        // Clear existing content
        btn.textContent = '';
        
        // Create SVG element using createElementNS for proper SVG namespace
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', fillColor);
        svg.setAttribute('stroke', strokeColor);
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('class', 'inline-flex items-center justify-center w-5 h-5');
        svg.style.opacity = opacity;
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z');
        svg.appendChild(path);
        btn.appendChild(svg);
        
        btn.title = nsfwModeEnabled ? 'NSFW Image Mode: ON (click to disable)' : 'NSFW Image Mode: OFF (click to enable)';
    }
    
    // Check current NSFW state from the page context (via postMessage)
    function checkCurrentNSFWState() {
        // Request current state from page context (xhr-intercept.js)
        window.postMessage({ type: 'SAI_GET_NSFW_MODE' }, '*');
        
        // Also try to read from localStorage directly as fallback
        try {
            const stored = localStorage.getItem('sai_nsfw_mode_override');
            if (stored !== null) {
                nsfwModeEnabled = stored === 'true';
                debugLog('[NSFW] Loaded NSFW state from localStorage:', nsfwModeEnabled);
                updateNSFWButtonIcon();
            }
        } catch (e) {
            // localStorage not available
        }
    }
    
    // Toggle NSFW mode via postMessage to page context
    function toggleNSFWMode() {
        debugLog('[NSFW] Toggle NSFW mode clicked, current state:', nsfwModeEnabled);
        
        // Toggle the state
        nsfwModeEnabled = !nsfwModeEnabled;
        
        // Send to page context (xhr-intercept.js) to persist and use for API interception
        window.postMessage({
            type: 'SAI_SET_NSFW_MODE',
            enabled: nsfwModeEnabled
        }, '*');
        
        // Update button immediately
        updateNSFWButtonIcon();
        
        // Sync with modal toggle if visible
        syncModalNSFWToggle();
        
        // Show notification
        showNSFWNotification();
        
        debugLog('[NSFW] NSFW mode toggled to:', nsfwModeEnabled);
    }
    
    // Find the NSFW Mode switch in the Conversation Image Settings modal
    function findModalNSFWSwitch() {
        // The modal is a fixed div with classes: fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
        // It contains a <p> with text "Conversation Image Settings"
        // The NSFW toggle is inside a <label class="inline-flex items-center cursor-pointer">
        
        // Find all fixed positioned modals
        const modals = document.querySelectorAll('div.fixed[class*="left-1/2"][class*="top-1/2"]');
        debugLog('[NSFW] Found fixed modals:', modals.length);
        
        for (const modal of modals) {
            // Check if this modal contains "Conversation Image Settings" text
            const allParagraphs = modal.querySelectorAll('p');
            let isImageSettingsModal = false;
            
            for (const p of allParagraphs) {
                if (p.textContent.includes('Conversation Image Settings')) {
                    isImageSettingsModal = true;
                    debugLog('[NSFW] Found Conversation Image Settings modal');
                    break;
                }
            }
            
            if (!isImageSettingsModal) continue;
            
            // Find all labels that could be toggles
            const labels = modal.querySelectorAll('label');
            debugLog('[NSFW] Found labels in modal:', labels.length);
            
            for (const label of labels) {
                // Check if this label contains "NSFW Mode" text
                const labelText = label.textContent.trim();
                debugLog('[NSFW] Label text:', labelText);
                
                if (labelText.includes('NSFW Mode')) {
                    // Found it! Get the checkbox input
                    const checkbox = label.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        debugLog('[NSFW] Found NSFW Mode checkbox');
                        return { checkbox, label };
                    }
                }
            }
        }
        
        debugLog('[NSFW] Could not find NSFW Mode switch');
        return null;
    }
    
    // Sync the modal's NSFW toggle with our state
    function syncModalNSFWToggle() {
        const result = findModalNSFWSwitch();
        if (!result) return;
        
        const { checkbox, label } = result;
        debugLog('[NSFW] Syncing modal toggle, our state:', nsfwModeEnabled, 'modal checked:', checkbox.checked);
        
        if (checkbox.checked !== nsfwModeEnabled) {
            // Click the label to toggle (more reliable than setting checked directly)
            debugLog('[NSFW] States differ, clicking label to sync');
            label.click();
        }
    }
    
    // Watch for changes on the modal's NSFW toggle
    function watchModalNSFWToggle() {
        const result = findModalNSFWSwitch();
        if (!result) return;
        
        const { checkbox, label } = result;
        if (checkbox._saiWatching) {
            debugLog('[NSFW] Already watching this checkbox');
            return;
        }
        
        checkbox._saiWatching = true;
        debugLog('[NSFW] Setting up watcher on modal NSFW checkbox');
        
        // Watch for changes on the checkbox
        const handleChange = () => {
            const modalState = checkbox.checked;
            debugLog('[NSFW] Change detected, modal state:', modalState, 'our state:', nsfwModeEnabled);
            
            if (modalState !== nsfwModeEnabled) {
                debugLog('[NSFW] Updating our state to match modal');
                nsfwModeEnabled = modalState;
                
                // Update page context
                window.postMessage({
                    type: 'SAI_SET_NSFW_MODE',
                    enabled: nsfwModeEnabled
                }, '*');
                
                // Update our button
                updateNSFWButtonIcon();
            }
        };
        
        // Listen for change events on the checkbox
        checkbox.addEventListener('change', handleChange);
        
        // Also listen on the label click (since the checkbox is sr-only)
        label.addEventListener('click', () => {
            debugLog('[NSFW] Label clicked');
            setTimeout(handleChange, 100);
        });
    }
    
    // Watch for the Image Settings modal to open
    function setupModalWatcher() {
        debugLog('[NSFW] Setting up modal watcher');
        
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    // Perf: gate on the modal selector first to avoid reading textContent
                    // on every DOM addition (which is O(n) on the subtree).
                    if (!node.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') &&
                        !node.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) {
                        continue;
                    }
                    if ((node.textContent || '').includes('Conversation Image Settings')) {
                        debugLog('[NSFW] Modal with "Conversation Image Settings" detected!');
                        setTimeout(() => {
                            syncModalNSFWToggle();
                            watchModalNSFWToggle();
                        }, 150);
                        return;
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        debugLog('[NSFW] Modal watcher active');
    }
    
    // Initialize modal watcher when NSFW button is injected
    let modalWatcherInitialized = false;
    function initModalWatcher() {
        if (modalWatcherInitialized) return;
        modalWatcherInitialized = true;
        setupModalWatcher();
    }

    // Show a notification about NSFW mode state
    function showNSFWNotification() {
        // Remove any existing notification
        const existing = document.getElementById('sai-nsfw-notification');
        if (existing) existing.remove();
        
        const notification = document.createElement('div');
        notification.id = 'sai-nsfw-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: ${nsfwModeEnabled ? '#f97316' : '#6b7280'};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000010;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            animation: sai-slide-up 0.3s ease-out;
        `;
        notification.textContent = nsfwModeEnabled 
            ? '🔥 NSFW Image Mode: ON' 
            : 'NSFW Image Mode: OFF';
        
        document.body.appendChild(notification);
        
        // Auto-remove after 2 seconds
        setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'sai-slide-down 0.3s ease-in forwards';
                setTimeout(() => notification.remove(), 300);
            }
        }, 2000);
    }
    
    // =========================================================================
    // MESSAGE RECOVERY
    // =========================================================================
    //
    // PROBLEM
    //   When SpicyChat's chat backend is degraded — Cloudflare 502, CORS
    //   preflight failures, request timeouts, or transient network drops —
    //   the user's typed message is lost without warning. The UX is:
    //
    //     1. User types a long, carefully-considered message.
    //     2. User presses Send. The textarea is cleared instantly.
    //     3. Several seconds later a generic red "Oops! Something went
    //        wrong. Please try again." banner appears with a Resubmit button.
    //     4. The site keeps the message in memory only as long as that
    //        banner is on screen for the most-recent failure. Reload the
    //        page, navigate away, dismiss the banner, or trigger a different
    //        error on top of this one, and the original text is gone.
    //
    //   For users who write multi-paragraph messages this is severely
    //   frustrating: the work disappears between the moment they hit Send
    //   and the moment they realize the request failed.
    //
    // WHAT THIS FEATURE DOES
    //   When the user opts in via the "Message Recovery" checkbox in the
    //   Features tab of the S.AI Settings modal:
    //
    //     - The page-context interceptor (xhr-intercept.js) snapshots the
    //       outgoing message text at the moment of POST /chat. The
    //       textarea has already been cleared by SpicyChat at this point,
    //       so we read the message from the request body that we already
    //       have visibility into for model-override and stats purposes.
    //     - If the request fails (XHR error/timeout/abort/status>=400, or
    //       fetch throws/returns !ok) we hand the snapshot to the content
    //       script, which persists it to chrome.storage.local under the
    //       'failedMessages' key. Successful sends never persist anything.
    //     - When the "Oops!" banner appears, we inject a "Recover message"
    //       button next to SpicyChat's "Resubmit" button. Clicking it
    //       refills the chat textarea with the most-recent failed message
    //       and removes that entry from the queue.
    //
    // WHY OPT-IN
    //   Capturing message *content* is materially different from the rest
    //   of the extension's network observation, which is metadata-only
    //   (model name, settings, message IDs, timestamps). Even though no
    //   data leaves the browser, persisting message text to local storage
    //   warrants explicit informed consent. The default is OFF, the
    //   privacy disclosure has been updated, and the toggle lives in the
    //   Features tab next to other content-touching settings.
    //
    // STORAGE / EVICTION
    //   - Key: 'failedMessages'  (chrome.storage.local)
    //   - Cap: 50 entries, FIFO. Old entries are evicted when the cap is
    //     hit so a long outage can't blow up storage.
    //   - On recovery, the entry is removed from the queue.
    //   - Disabling the feature does not auto-clear the queue (so the
    //     user can recover anything that was already captured) but no
    //     new entries are added until it is re-enabled.
    //   - "Clear All Data" wipes everything including this queue.

    let messageRecoveryActive = false;

    async function initMessageRecovery() {
        const enabled = await storage.get('messageRecoveryEnabled', false);
        messageRecoveryActive = enabled;
        debugLog('[MsgRecovery] Init, enabled:', enabled);
        // Tell the page-context interceptor whether to capture message text.
        // Sent regardless of the value so we explicitly disable on every
        // page load (rather than relying on the page-context script's
        // localStorage fallback, which could drift if the user disabled
        // the feature in another tab).
        window.postMessage({
            type: 'SAI_SET_MESSAGE_RECOVERY',
            enabled: !!enabled
        }, '*');
    }

    // Find the "Oops! Something went wrong" error banner.
    // The banner DOM (per the captured chat-page reference) contains a
    // <p class="text-red-12"> with the literal "Oops!" text and is sibling
    // to a Resubmit button. We match on the text rather than fragile
    // utility-class chains so the selector survives Tailwind class shuffles.
    function findOopsBanner() {
        const candidates = document.querySelectorAll('p.text-red-12, p[class*="text-red"]');
        for (const p of candidates) {
            const txt = (p.textContent || '').trim();
            if (txt.startsWith('Oops!') || txt.includes('Something went wrong')) {
                // Walk up to the row that contains the Resubmit button so we
                // can place our button as its sibling.
                let row = p.closest('div');
                for (let i = 0; i < 6 && row; i++) {
                    if (row.querySelector('button')) return row;
                    row = row.parentElement;
                }
                return p.parentElement;
            }
        }
        return null;
    }

    // Inject the "Recover message" button next to Resubmit. Idempotent —
    // safe to call repeatedly from the periodic mutation observer.
    async function injectRecoverButtonIfNeeded() {
        if (!messageRecoveryActive) return;
        const banner = findOopsBanner();
        if (!banner) return;
        if (banner.querySelector('.sai-recover-btn')) return;

        const failedMessages = await storage.get('failedMessages', []);
        if (!Array.isArray(failedMessages) || failedMessages.length === 0) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sai-recover-btn';
        // Match SpicyChat's existing red Resubmit button styling so it
        // looks like a first-class part of the banner.
        btn.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'gap:6px',
            'padding:0 8px',
            'height:28px',
            'margin-left:6px',
            'border:1px solid rgba(255,255,255,0.25)',
            'border-radius:6px',
            'background:transparent',
            'color:#fff',
            'font:500 13px/1 -apple-system,system-ui,Segoe UI,Roboto,sans-serif',
            'cursor:pointer',
            'white-space:nowrap'
        ].join(';');
        btn.textContent = 'Recover message';
        btn.title = 'Restore the message you tried to send before the error';
        btn.addEventListener('click', onRecoverButtonClick);

        // Try to place next to the Resubmit button; otherwise append.
        const resubmit = Array.from(banner.querySelectorAll('button')).find(b =>
            (b.textContent || '').trim().toLowerCase().includes('resubmit')
        );
        if (resubmit && resubmit.parentElement) {
            resubmit.parentElement.appendChild(btn);
        } else {
            banner.appendChild(btn);
        }
        debugLog('[MsgRecovery] Recover button injected');
    }

    async function onRecoverButtonClick(ev) {
        ev.preventDefault();
        ev.stopPropagation();

        const list = await storage.get('failedMessages', []);
        if (!Array.isArray(list) || list.length === 0) {
            showNotification('No saved message to recover');
            return;
        }
        const entry = list[list.length - 1];

        // Find the chat input textarea. The reference chat-page has a single
        // <textarea placeholder="Message...">. We use that as the primary
        // selector and fall back to the only visible textarea on the page.
        let textarea = document.querySelector('textarea[placeholder="Message..."]');
        if (!textarea) {
            const all = Array.from(document.querySelectorAll('textarea'));
            textarea = all.find(t => t.offsetParent !== null) || all[0] || null;
        }

        if (!textarea) {
            // No input found — fall back to clipboard so the message isn't
            // lost a second time.
            try {
                await navigator.clipboard.writeText(entry.message);
                showNotification('Message copied to clipboard (no input field found)');
            } catch (e) {
                showNotification('Could not recover automatically — see extension storage');
                return;
            }
        } else {
            // React-controlled inputs need the native setter so React's
            // synthetic event system picks up the change. setting .value
            // directly is silently overwritten on next render.
            const proto = Object.getPrototypeOf(textarea);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) {
                setter.call(textarea, entry.message);
            } else {
                textarea.value = entry.message;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.focus();
            showNotification('Message recovered');
        }

        // Drop the recovered entry from the queue.
        const updated = list.slice(0, -1);
        await storage.set('failedMessages', updated);

        // Remove our button — the banner will go away on its own when
        // the user types or the site clears it, but the button has done
        // its job for this entry.
        const btn = document.querySelector('.sai-recover-btn');
        if (btn) btn.remove();
    }

    // =========================================================================
    // AUTO STORY MODE
    // =========================================================================
    //
    // WHAT THIS DOES
    //   Story Mode (spicychat.ai/story/{characterId}/{conversationId}) lets the
    //   user seed a scene and then either direct it or click "Continue Story"
    //   to have the model keep writing unattended. This feature adds a toggle
    //   button, injected to the left of the Generation Settings (Sparkles)
    //   button, that repeatedly clicks "Continue Story" for you: turn it on
    //   and the model keeps extending the story on its own until you turn it
    //   back off.
    //
    // HOW IT WORKS
    //   SpicyChat removes the "Continue Story" button from the DOM the moment
    //   a generation starts and re-renders it once the new passage lands, so
    //   we don't need to track a separate "is it generating" flag — a simple
    //   poll for the button's presence already reflects the page's own state.
    //   Every tick: if the toggle is on, we're still on the same story, no
    //   error banner is showing, and the button is present, we click it and
    //   arm a short cooldown before the next click is allowed.
    //
    // SAFETY
    //   - Stops (and turns the toggle off) if SpicyChat's own "Oops!
    //     Something went wrong" banner appears (see findOopsBanner() above),
    //     rather than hammering a failing request.
    //   - Stops if the URL navigates away from this story, or to a different
    //     story entirely, so it can't silently keep writing the wrong chat.
    //   - Hard safety cap on consecutive continues so a detection bug can't
    //     turn this into an unattended, unbounded API-usage loop.
    //   - Runtime-only: the toggle always starts OFF on a fresh page load
    //     rather than persisting/auto-resuming, so reloading the page can't
    //     silently leave it running in the background.

    let autoStoryModeActive = false;
    let autoStoryPollTimer = null;
    let autoStoryNextClickAt = 0;
    let autoStoryClickInFlight = false;
    let autoStoryConversationKey = null;
    let autoStoryContinueCount = 0;
    const AUTO_STORY_MAX_CONTINUES = 1000; // safety net, not a target — see SAFETY above

    // Find the enabled "Continue Story" button. Primary match is the tooltip
    // wrapper SpicyChat renders around it (data-tooltip-content="Continue
    // Story"); falls back to matching on the button's own text so this
    // survives tooltip markup changes, same approach as findOopsBanner().
    function findContinueStoryButton() {
        const wrapper = document.querySelector('div[data-tooltip-content="Continue Story"]');
        const wrapped = wrapper ? wrapper.querySelector('button') : null;
        if (wrapped && !wrapped.disabled) return wrapped;

        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            if (!b.disabled && (b.textContent || '').trim() === 'Continue Story') return b;
        }
        return null;
    }

    function getStoryConversationKey() {
        const match = window.location.pathname.match(/\/story\/([^/]+)\/([^/?#]+)/i);
        return match ? match[1] + '/' + match[2] : window.location.pathname;
    }

    function stopAutoStoryMode(reason, opts) {
        opts = opts || {};
        if (!autoStoryModeActive) return;
        autoStoryModeActive = false;
        autoStoryContinueCount = 0;
        if (autoStoryPollTimer) {
            clearInterval(autoStoryPollTimer);
            autoStoryPollTimer = null;
        }
        updateAutoStoryButtonIcon();
        debugLog('[AutoStory] Stopped:', reason);
        if (!opts.silent) {
            showNotification('Auto Story Mode stopped — ' + reason, true);
        }
    }

    function autoStoryTick() {
        if (!autoStoryModeActive) return;

        if (!isStoryMode()) {
            stopAutoStoryMode('navigated away from Story Mode');
            return;
        }
        if (getStoryConversationKey() !== autoStoryConversationKey) {
            stopAutoStoryMode('switched to a different story');
            return;
        }
        if (findOopsBanner()) {
            stopAutoStoryMode('SpicyChat reported an error');
            return;
        }
        if (autoStoryContinueCount >= AUTO_STORY_MAX_CONTINUES) {
            stopAutoStoryMode(`reached the safety limit of ${AUTO_STORY_MAX_CONTINUES} continues`);
            return;
        }
        if (autoStoryClickInFlight || Date.now() < autoStoryNextClickAt) return;

        const btn = findContinueStoryButton();
        if (!btn) return; // still generating, or the story hasn't been started yet

        // The Generation Statistics block for the message that JUST arrived is
        // still being written asynchronously (insertStatsWithRetry retries for
        // up to ~3s before giving up) when this button reappears. Clicking
        // again immediately races that retry loop — the DOM changes underneath
        // it as the next message starts streaming in, and the stats insertion
        // silently fails. pendingNewMessageCount is the same counter that
        // pipeline already uses to track "a bot message landed but its stats
        // aren't confirmed yet" (see insertStatsWithRetry/processMessagesForStats
        // above); waiting for it to clear lets stats catch up before we
        // generate more work for them to race against. It self-clears within
        // that ~3s window even if insertion ultimately fails, so this can
        // never hang Auto Story Mode indefinitely.
        if (pendingNewMessageCount > 0) {
            debugLog('[AutoStory] Waiting for generation stats to catch up before continuing (pending:', pendingNewMessageCount, ')');
            return;
        }

        autoStoryClickInFlight = true;
        autoStoryContinueCount++;
        debugLog('[AutoStory] Clicking Continue Story (#' + autoStoryContinueCount + ')');
        btn.click();
        // The button vanishing while SpicyChat generates already paces us —
        // this cooldown is just a floor in case it reappears unexpectedly fast.
        autoStoryNextClickAt = Date.now() + 2000 + Math.random() * 1000;
        setTimeout(() => { autoStoryClickInFlight = false; }, 1500);
    }

    function startAutoStoryMode() {
        if (autoStoryModeActive || !isStoryMode()) return;
        autoStoryModeActive = true;
        autoStoryContinueCount = 0;
        autoStoryNextClickAt = 0;
        autoStoryConversationKey = getStoryConversationKey();
        updateAutoStoryButtonIcon();
        debugLog('[AutoStory] Started for', autoStoryConversationKey);
        autoStoryPollTimer = setInterval(autoStoryTick, 1000);
        autoStoryTick();
    }

    // Update (or create-time initialize) the toggle button's icon/title to
    // reflect autoStoryModeActive. Called with no argument to refresh the
    // live button after state changes.
    function updateAutoStoryButtonIcon(btn) {
        if (!btn) btn = document.getElementById('sai-auto-story-btn');
        if (!btn) return;

        const on = autoStoryModeActive;
        btn.title = on
            ? 'Auto Story Mode: ON — automatically clicking Continue Story (click to stop)'
            : 'Auto Story Mode: OFF — click to auto-continue the story until you turn it off';
        btn.classList.toggle('sai-auto-story-active', on);

        btn.textContent = '';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', on ? '#3b82f6' : 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('class', 'inline-flex items-center justify-center w-5 h-5' + (on ? ' sai-auto-story-spin' : ''));
        svg.style.opacity = on ? '1' : '0.6';
        // Lucide "repeat" icon — reads as "auto-advance/loop" at a glance.
        svg.innerHTML = '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>';
        btn.appendChild(svg);
    }

    let autoStoryStyleInjected = false;
    function ensureAutoStoryStyle() {
        if (autoStoryStyleInjected) return;
        const style = document.createElement('style');
        style.textContent = `
@keyframes sai-auto-story-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.sai-auto-story-spin { animation: sai-auto-story-pulse 1.5s ease-in-out infinite; }
`;
        document.head.appendChild(style);
        autoStoryStyleInjected = true;
    }

    // Walk up from deepDescendant until we find the node that is a direct
    // child of container, then insert newNode before it. Used because the
    // Sparkles/Generation Settings button in Story Mode's header is wrapped
    // in a couple of layout/tooltip divs rather than being a direct child of
    // the row container itself.
    function insertBeforeContainerChild(container, deepDescendant, newNode) {
        let node = deepDescendant;
        while (node && node.parentElement !== container) {
            node = node.parentElement;
        }
        if (node) {
            container.insertBefore(newNode, node);
        } else {
            container.appendChild(newNode);
        }
    }

    function injectAutoStoryToggleButton() {
        if (typeof isResizing !== 'undefined' && isResizing) return;
        if (typeof sidebarWidthTransitionPending !== 'undefined' && sidebarWidthTransitionPending) return;
        if (!isStoryMode()) return;
        if (document.getElementById('sai-auto-story-btn')) return;

        const sparklesBtn = document.querySelector('button[aria-label="Sparkles-button"]');
        if (!sparklesBtn) {
            debugLog('[AutoStory] Generation Settings (Sparkles) button not found');
            return;
        }
        const container = sparklesBtn.closest('.flex.justify-end.items-center.gap-sm') || sparklesBtn.parentElement;

        ensureAutoStoryStyle();

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sai-auto-story-btn';
        toggleBtn.type = 'button';
        toggleBtn.setAttribute('aria-label', 'Auto-Story-toggle');
        toggleBtn.className = 'inline-flex items-center justify-center transition-all duration-200 rounded-full bg-transparent border-1 border-solid border-gray-5 text-black dark:border-gray-8 dark:text-white w-9 h-9 cursor-pointer';
        updateAutoStoryButtonIcon(toggleBtn);

        toggleBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (autoStoryModeActive) {
                stopAutoStoryMode('turned off', { silent: true });
            } else {
                startAutoStoryMode();
            }
        });

        insertBeforeContainerChild(container, sparklesBtn, toggleBtn);
        debugLog('[AutoStory] Toggle button injected');
    }

    // Show export dropdown menu
    function showExportMenu(anchorButton) {
        // Remove any existing menu
        const existingMenu = document.getElementById('sai-export-menu');
        if (existingMenu) {
            existingMenu.remove();
            return; // Toggle off if already open
        }
        
        // Create dropdown menu
        const menu = document.createElement('div');
        menu.id = 'sai-export-menu';
        menu.style.cssText = `
            position: fixed;
            z-index: 10000005;
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            min-width: 160px;
            padding: 4px;
        `;
        
        // Check for dark mode
        const isDarkMode = document.documentElement.classList.contains('dark') || 
                          window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (isDarkMode) {
            menu.style.background = '#353535';
            menu.style.borderColor = '#374151';
            menu.style.color = 'white';
        }
        
        // Create menu items
        const menuItems = [
            { label: 'Export as JSON', icon: '{}', action: () => exportChatAsJSON() },
            { label: 'Export as HTML', icon: '📄', action: () => exportChatAsHTML() }
        ];
        
        menuItems.forEach(item => {
            const menuItem = document.createElement('button');
            menuItem.style.cssText = `
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 8px 12px;
                border: none;
                background: transparent;
                cursor: pointer;
                text-align: left;
                font-size: 14px;
                border-radius: 6px;
                color: ${isDarkMode ? 'white' : '#374151'};
            `;
            
            // Build menu item content using DOM methods (safer than innerHTML)
            const iconSpan = document.createElement('span');
            iconSpan.style.cssText = 'font-family: monospace; font-weight: bold;';
            iconSpan.textContent = item.icon;
            
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            
            menuItem.appendChild(iconSpan);
            menuItem.appendChild(labelSpan);
            
            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.background = isDarkMode ? '#353535' : '#f3f4f6';
            });
            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.background = 'transparent';
            });
            menuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                menu.remove();
                item.action();
            });
            
            menu.appendChild(menuItem);
        });
        
        // Position the menu below the button
        const rect = anchorButton.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        
        document.body.appendChild(menu);
        
        // Close menu when clicking outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorButton) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }
    
    // Fetch all messages from the API (without limit)
    async function fetchAllChatMessages() {
        // URL format: /chat/{characterId}/{conversationId} or /{language}/chat/{characterId}/{conversationId}
        const pathParts = window.location.pathname.split('/').filter(p => p);
        // pathParts should be: ['chat', characterId, conversationId] or ['en', 'chat', ...] or ['Chat', ...]

        debugLog('[Export] Path parts:', pathParts);

        // Handle both /chat/ and /{language}/chat/ formats
        let chatIndexOffset = 0;
        if (pathParts[0].match(/^[a-z]{2}$/i)) {
            // Language prefix detected (e.g., 'en')
            chatIndexOffset = 1;
        }

        // Accept both Chat Mode (/chat/...) and Story Mode (/story/...) — the
        // underlying messages endpoint (characters/{id}/messages/{convId}) is the
        // same for both, so the export path only needs the two ids from the URL.
        const routeSegment = pathParts[chatIndexOffset] ? pathParts[chatIndexOffset].toLowerCase() : '';
        if (pathParts.length < (chatIndexOffset + 2) || (routeSegment !== 'chat' && routeSegment !== 'story')) {
            throw new Error('Not on a chat or story page. URL should be /chat/ or /story/{characterId}/{conversationId} (optionally with a /{language} prefix)');
        }
        
        const characterId = pathParts[chatIndexOffset + 1];
        const conversationId = pathParts.length > (chatIndexOffset + 2) ? pathParts[chatIndexOffset + 2] : null;
        
        if (!characterId) {
            throw new Error('Could not determine character ID from URL');
        }
        
        debugLog('[Export] Character ID:', characterId);
        debugLog('[Export] Conversation ID:', conversationId);
        
        return new Promise((resolve, reject) => {
            if (document.getElementById('sai-toolkit-export-progress')) {
                reject(new Error('A chat export is already running'));
                return;
            }
            const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            const start = Date.now();
            const panel = document.createElement('div');
            panel.id = 'sai-toolkit-export-progress';
            panel.setAttribute('role', 'status');
            panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;max-width:min(360px,90vw);padding:12px;border-radius:8px;background:#202124;color:#fff;font:13px system-ui;box-shadow:0 2px 12px #0006;';
            const status = document.createElement('div');
            status.textContent = 'Exporting chat…';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancel export';
            cancel.style.cssText = 'margin-top:8px;padding:4px 10px;border:1px solid #aaa;border-radius:4px;color:#fff;background:#333;cursor:pointer;';
            panel.append(status, cancel);
            document.body.appendChild(panel);
            let timer;
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                window.removeEventListener('message', handler);
                window.removeEventListener('pagehide', onPageHide);
                panel.remove();
            };
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve(result);
            };
            const abort = (message) => {
                window.postMessage({ type: 'SAI_EXPORT_CHAT_CANCEL', requestId }, '*');
                finish(new Error(message));
            };
            const onPageHide = () => abort('Export interrupted by navigation');
            const arm = () => {
                clearTimeout(timer);
                // Inactivity timeout, not a total export duration limit.
                timer = setTimeout(() => abort('Export stopped responding for 180 seconds. Please retry.'), 180000);
            };
            const handler = (event) => {
                if (event.source !== window || event.data?.requestId !== requestId) return;
                if (event.data.type === 'SAI_EXPORT_CHAT_PROGRESS') {
                    const { count, expected, page, phase } = event.data;
                    const elapsed = Math.max(1, (Date.now() - start) / 1000);
                    const rate = count > 0 ? Math.round(count / elapsed) : 0;
                    const eta = rate > 0 && Number.isFinite(expected) && expected > count ? `~${Math.ceil((expected - count) / rate)}s remaining` : '';
                    const progress = Number.isFinite(count) ? `${count.toLocaleString()}${Number.isFinite(expected) && expected > 0 ? ` / ~${expected.toLocaleString()}` : ''} messages` : '';
                    status.textContent = [phase || 'Fetching chat', progress, page ? `Page ${page}` : '', `${Math.floor(elapsed)}s elapsed`, rate ? `${rate.toLocaleString()} msg/s` : '', eta].filter(Boolean).join(' · ');
                    arm();
                    return;
                }
                if (event.data.type !== 'SAI_EXPORT_CHAT_RESPONSE') return;
                if (event.data.success) finish(null, { messages: event.data.messages, character: event.data.character });
                else finish(new Error(event.data.error || 'Failed to fetch chat data'));
            };
            cancel.addEventListener('click', () => abort('Export cancelled'));
            window.addEventListener('pagehide', onPageHide, { once: true });
            window.addEventListener('message', handler);
            arm();
            window.postMessage({ type: 'SAI_EXPORT_CHAT_REQUEST', requestId, characterId, conversationId }, '*');
        });
    }
    
    // Export chat as JSON
    async function exportChatAsJSON() {
        try {
            debugLog('[Export] Starting JSON export...');
            
            const { messages, character } = await fetchAllChatMessages();
            
            debugLog('[Export] Data received - messages:', messages?.messages?.length || 0, 'character:', character?.name || 'unknown');
            
            const exportData = {
                exportedAt: new Date().toISOString(),
                exportedBy: 'S.AI Toolkit',
                character: character ? {
                    id: character.id,
                    name: character.name,
                    title: character.title,
                    avatar_url: character.avatar_url
                } : null,
                conversationId: messages.conversation_id,
                userPersona: messages.userPersona,
                messageCount: messages.messages?.length || 0,
                messages: messages.messages || []
            };
            
            // Build filename with chat label if available
            const chatLabel = window.__saiChatLabel;
            const characterName = character?.name || 'export';
            const safeCharName = characterName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = chatLabel 
                ? `chat-${safeCharName}-${chatLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').trim()}-${dateStr}.json`
                : `chat-${safeCharName}-${dateStr}.json`;
            downloadFile(JSON.stringify(exportData, null, 2), filename, 'application/json');
            
            debugLog('[Export] JSON export complete:', filename, 'with', exportData.messageCount, 'messages');
        } catch (error) {
            console.error('[Export] JSON export failed:', error);
            alert('Failed to export chat: ' + error.message);
        }
    }
    
    // Resolves the colors the exported HTML should use: SpicyChat's native
    // palette for the live page's light/dark mode (DEFAULT_CUSTOM_STYLE holds
    // values measured off the native site), with the Style tab's Bot/User
    // Message BG overrides layered on top — so the export looks like the chat
    // did at export time. (Text colors/fonts now come from SpicyChat's own
    // chat styles, which the export can't read, so it uses native defaults.)
    function resolveExportStyle({ styleOverrides, isDarkMode }) {
        const theme = isDarkMode ? 'dark' : 'light';
        const base = DEFAULT_CUSTOM_STYLE[theme];
        return {
            isDark: isDarkMode,
            aiMessageBg: (styleOverrides.enabled && styleOverrides.botMessageBg[theme]) || base.aiMessageBg,
            userMessageBg: (styleOverrides.enabled && styleOverrides.userMessageBg[theme]) || base.userMessageBg,
            bot: { ...base.bot },
            user: { ...base.user },
            highlightBgColor: base.highlightBgColor,
            highlightTextColor: base.highlightTextColor,
            bodyFontWeight: DEFAULT_CUSTOM_STYLE.bodyFontWeight,
            bodyFontStyle: DEFAULT_CUSTOM_STYLE.bodyFontStyle,
            bodyTextDecoration: DEFAULT_CUSTOM_STYLE.bodyTextDecoration,
            spanQuoteFontWeight: DEFAULT_CUSTOM_STYLE.spanQuoteFontWeight,
            spanQuoteFontStyle: DEFAULT_CUSTOM_STYLE.spanQuoteFontStyle,
            spanQuoteTextDecoration: DEFAULT_CUSTOM_STYLE.spanQuoteTextDecoration,
            narrationFontWeight: DEFAULT_CUSTOM_STYLE.narrationFontWeight,
            narrationFontStyle: DEFAULT_CUSTOM_STYLE.narrationFontStyle,
            narrationTextDecoration: DEFAULT_CUSTOM_STYLE.narrationTextDecoration,
            highlightFontWeight: DEFAULT_CUSTOM_STYLE.highlightFontWeight,
            highlightFontStyle: DEFAULT_CUSTOM_STYLE.highlightFontStyle,
            highlightTextDecoration: DEFAULT_CUSTOM_STYLE.highlightTextDecoration,
            fontSize: DEFAULT_CUSTOM_STYLE.fontSize,
            fontFamily: DEFAULT_CUSTOM_STYLE.fontFamily
        };
    }

    // Export chat as formatted HTML with embedded images (data URLs)
    async function exportChatAsHTML() {
        try {
            debugLog('[Export] Starting HTML export...');

            // Native palette for the live light/dark mode + the Style tab's
            // bubble BG overrides (see resolveExportStyle).
            const styleOverrides = normalizeStyleOverrides(await storage.get(STYLE_OVERRIDES_KEY, null));
            const isDarkMode = document.documentElement.classList.contains('dark') ||
                                window.matchMedia('(prefers-color-scheme: dark)').matches;
            const exportStyle = resolveExportStyle({ styleOverrides, isDarkMode });

            const { messages, character } = await fetchAllChatMessages();
            
            const botName = character?.name || 'Bot';
            const safeBotName = botName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
            
            // Build full avatar URL - avatars are served from cdn.nd-api.com
            const buildAvatarUrl = (avatarPath) => {
                if (!avatarPath) return null;
                if (avatarPath.startsWith('http')) return avatarPath;
                // Avatar paths like "avatars/xxx.png" need cdn.nd-api.com prefix
                return `https://cdn.nd-api.com/${avatarPath}`;
            };
            
            const botAvatarUrl = buildAvatarUrl(character?.avatar_url);
            
            const userPersona = messages.userPersona || {};
            const userName = userPersona.name || 'User';
            const userAvatarUrl = buildAvatarUrl(userPersona.avatar_url);
            
            debugLog('[Export] Bot avatar URL:', botAvatarUrl);
            debugLog('[Export] User avatar URL:', userAvatarUrl);
            debugLog('[Export] Fetching avatar images...');
            
            // Build sub-character map for group chats
            // Maps character_id -> { name, avatar_url }
            const subCharacterMap = {};
            if (character?.sub_characters && Array.isArray(character.sub_characters)) {
                debugLog('[Export] Group chat detected with', character.sub_characters.length, 'sub-characters');
                for (const subChar of character.sub_characters) {
                    if (subChar.id) {
                        subCharacterMap[subChar.id] = {
                            name: subChar.name || 'Bot',
                            avatarUrl: buildAvatarUrl(subChar.avatar_url)
                        };
                        debugLog('[Export] Sub-character:', subChar.id, '->', subChar.name);
                    }
                }
            }
            const isGroupChat = Object.keys(subCharacterMap).length > 0;
            
            // Fetch and convert images to data URLs
            let botImageDataUrl = botAvatarUrl; // Fallback to original URL
            let userImageDataUrl = userAvatarUrl; // Fallback to original URL
            
            if (botAvatarUrl) {
                try {
                    const imageData = await fetchImageAsBase64(botAvatarUrl);
                    if (imageData) {
                        botImageDataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;
                        debugLog('[Export] Bot avatar embedded successfully');
                    }
                } catch (e) {
                    debugLog('[Export] Failed to fetch bot avatar, using URL fallback:', e.message);
                }
            }
            
            if (userAvatarUrl) {
                try {
                    const imageData = await fetchImageAsBase64(userAvatarUrl);
                    if (imageData) {
                        userImageDataUrl = `data:${imageData.mimeType};base64,${imageData.base64}`;
                        debugLog('[Export] User avatar embedded successfully');
                    }
                } catch (e) {
                    debugLog('[Export] Failed to fetch user avatar, using URL fallback:', e.message);
                }
            }
            
            // For group chats, fetch and embed avatars for each sub-character
            const subCharacterImageMap = {}; // character_id -> data URL or original URL
            if (isGroupChat) {
                for (const [charId, charInfo] of Object.entries(subCharacterMap)) {
                    subCharacterImageMap[charId] = charInfo.avatarUrl; // Default to URL
                    if (charInfo.avatarUrl) {
                        try {
                            const imageData = await fetchImageAsBase64(charInfo.avatarUrl);
                            if (imageData) {
                                subCharacterImageMap[charId] = `data:${imageData.mimeType};base64,${imageData.base64}`;
                                debugLog('[Export] Sub-character avatar embedded:', charInfo.name);
                            }
                        } catch (e) {
                            debugLog('[Export] Failed to fetch sub-character avatar for', charInfo.name, ':', e.message);
                        }
                    }
                }
            }
            
            // Build the HTML with embedded data URLs
            const html = generateChatHTML({
                botName,
                botImageUrl: botImageDataUrl,
                userName,
                userImageUrl: userImageDataUrl,
                characterTitle: character?.title || '',
                conversationId: messages.conversation_id,
                messages: messages.messages || [],
                exportedAt: new Date().toISOString(),
                // Group chat support
                isGroupChat,
                subCharacterMap,
                subCharacterImageMap,
                // Resolved Classic Style / Custom Style / native colors and fonts
                style: exportStyle
            });
            
            // Build filename with chat label if available
            const chatLabel = window.__saiChatLabel;
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = chatLabel 
                ? `chat-${safeBotName}-${chatLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').trim()}-${dateStr}.html`
                : `chat-${safeBotName}-${dateStr}.html`;
            downloadFile(html, filename, 'text/html');
            
            debugLog('[Export] HTML export complete:', filename);
        } catch (error) {
            console.error('[Export] HTML export failed:', error);
            alert('Failed to export chat: ' + error.message);
        }
    }

    // Fetch an image and convert to base64 using Image + Canvas (handles CORS better)
    async function fetchImageAsBase64(url) {
        debugLog('[Export] Fetching image:', url);
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous'; // Request CORS access
            
            const timeout = setTimeout(() => {
                debugLog('[Export] Image fetch timeout for:', url);
                reject(new Error('Image fetch timeout'));
            }, 10000);
            
            img.onload = () => {
                clearTimeout(timeout);
                try {
                    // Create canvas and draw image
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    
                    if (canvas.width === 0 || canvas.height === 0) {
                        throw new Error('Image has zero dimensions');
                    }
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    // Get as data URL and extract base64
                    const dataUrl = canvas.toDataURL('image/png');
                    const base64 = dataUrl.split(',')[1];
                    
                    if (!base64 || base64.length < 100) {
                        throw new Error('Invalid base64 data');
                    }
                    
                    debugLog('[Export] Image fetched successfully, base64 length:', base64.length);
                    resolve({ base64, mimeType: 'image/png', url });
                } catch (e) {
                    debugLog('[Export] Canvas error:', e.message);
                    reject(e);
                }
            };
            
            img.onerror = (e) => {
                clearTimeout(timeout);
                debugLog('[Export] Image load error for:', url, e);
                reject(new Error('Image failed to load'));
            };
            
            // Load the image
            img.src = url;
        });
    }
    
    // Generate standalone HTML for chat export (uses direct URLs or data URLs)
    function generateChatHTML(data) {
        const {
            botName, botImageUrl, userName, userImageUrl, characterTitle,
            conversationId, messages, exportedAt,
            // Group chat support
            isGroupChat = false, subCharacterMap = {}, subCharacterImageMap = {},
            // Resolved Classic Style / Custom Style / native colors and fonts
            style
        } = data;
        
        // =====================================================================
        // IMAGE DEDUPLICATION
        // =====================================================================
        // Collect all unique images and assign them IDs for CSS classes
        // This dramatically reduces HTML size for long chats with many messages
        const imageRegistry = new Map(); // imageUrl -> { id: string, cssClass: string }
        let imageIdCounter = 0;
        
        const registerImage = (imageUrl) => {
            if (!imageUrl) return null;
            if (imageRegistry.has(imageUrl)) {
                return imageRegistry.get(imageUrl);
            }
            const id = `avatar-img-${imageIdCounter++}`;
            const entry = { id, cssClass: id, imageUrl };
            imageRegistry.set(imageUrl, entry);
            return entry;
        };
        
        // Register all avatar images
        const botImageEntry = registerImage(botImageUrl);
        const userImageEntry = registerImage(userImageUrl);
        
        // Register group chat sub-character images
        const subCharImageEntries = {};
        if (isGroupChat) {
            for (const [charId, imgUrl] of Object.entries(subCharacterImageMap)) {
                subCharImageEntries[charId] = registerImage(imgUrl);
            }
        }
        
        // Generate CSS for all registered images
        let imageCSSRules = '';
        for (const [imageUrl, entry] of imageRegistry) {
            imageCSSRules += `
        .${entry.cssClass} {
            background-image: url("${imageUrl.replace(/"/g, '\\"')}");
            background-size: cover;
            background-position: center;
        }`;
        }
        
        // Format timestamp
        const formatTime = (timestamp) => {
            if (!timestamp) return '';
            const date = new Date(timestamp);
            return date.toLocaleString();
        };
        
        // Escape HTML
        const escapeHTML = (text) => {
            if (!text) return '';
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };
        
        // Format message content
        const formatContent = (text) => {
            if (!text) return '';
            let formatted = escapeHTML(text);
            // Process quoted dialogue BEFORE backticks/asterisks — the quote span just
            // wraps in place, so it doesn't interfere with the delimiters below
            formatted = formatted.replace(/&quot;([\s\S]*?)&quot;/g, '<span class="quote">&quot;$1&quot;</span>');
            // Process backticks for highlighted code/text BEFORE asterisks to avoid conflicts
            formatted = formatted.replace(/`([^`]+)`/g, `<span class="highlight-text" style="background-color: ${style.highlightBgColor}; color: ${style.highlightTextColor}; padding: 0 4px; border-radius: 4px; display: inline-block; max-width: max-content; font-weight: ${style.highlightFontWeight}; font-style: ${style.highlightFontStyle}; text-decoration: ${style.highlightTextDecoration};">$1</span>`);
            // Process double asterisks for bold BEFORE single asterisks to avoid conflicts
            formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            formatted = formatted.replace(/\*([^*]+)\*/g, '<em class="action">$1</em>');
            formatted = formatted.replace(/\n/g, '<br>');
            return formatted;
        };
        
        // Sort messages by createdAt
        const sortedMessages = [...messages].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        
        // Generate message HTML
        let messagesHTML = '';
        let isFirstBotMessage = true; // Track if this is the opening/greeting message
        for (const msg of sortedMessages) {
            const isBot = msg.role === 'bot';
            const roleClass = isBot ? 'bot' : 'user';
            const altIndicator = msg.is_alternative ? '<span class="alt-badge">ALT</span>' : '';
            
            // Determine sender name and avatar image entry
            let senderName, imageEntry;
            if (isBot) {
                if (isGroupChat && isFirstBotMessage) {
                    // First bot message in group chat: use group name and avatar
                    senderName = botName;
                    imageEntry = botImageEntry;
                    isFirstBotMessage = false;
                } else if (isGroupChat && msg.character_id && subCharacterMap[msg.character_id]) {
                    // Subsequent bot messages in group chat: use individual character info
                    senderName = subCharacterMap[msg.character_id].name;
                    imageEntry = subCharImageEntries[msg.character_id];
                } else {
                    // Standard single-character chat
                    senderName = botName;
                    imageEntry = botImageEntry;
                }
            } else {
                // User message
                senderName = userName;
                imageEntry = userImageEntry;
            }
            
            // Use CSS class for avatar instead of inline data URL
            const avatarHTML = imageEntry
                ? `<div class="avatar ${imageEntry.cssClass}" role="img" aria-label="${escapeHTML(senderName)}"></div>`
                : `<div class="avatar-placeholder">${escapeHTML(senderName.charAt(0).toUpperCase())}</div>`;
            
            messagesHTML += `
            <div class="message ${roleClass}">
                <div class="avatar-container">
                    ${avatarHTML}
                </div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="sender-name">${escapeHTML(senderName)}</span>
                        ${altIndicator}
                        <span class="timestamp">${formatTime(msg.createdAt)}</span>
                    </div>
                    <div class="message-text">${formatContent(msg.content)}</div>
                </div>
            </div>`;
        }
        
        // Calculate size savings for debug info
        const uniqueImages = imageRegistry.size;
        const totalImageRefs = sortedMessages.length; // Each message has an avatar
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chat with ${escapeHTML(botName)}</title>
    <style>
        /* 
         * S.AI Toolkit Chat Export Stylesheet
         * Feel free to customize these styles!
         * 
         * Image Optimization: ${uniqueImages} unique avatar(s) defined once in CSS,
         * referenced ${totalImageRefs} times throughout ${sortedMessages.length} messages.
         */
        
        :root {
            --bg-color: ${style.isDark ? '#0f0f0f' : '#f5f5f5'};
            --text-color: ${style.isDark ? '#e5e5e5' : '#18181b'};
            --header-bg: ${style.isDark ? '#1a1a1a' : '#ffffff'};
            --message-bg: ${style.isDark ? '#1a1a1a' : '#ffffff'};
            --user-message-bg: ${style.userMessageBg};
            --bot-message-bg: ${style.aiMessageBg};
            --border-color: ${style.isDark ? '#333' : '#e2e2e2'};
            --timestamp-color: ${style.isDark ? '#6b7280' : '#71717a'};
            --accent-color: ${style.highlightBgColor};
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.6;
        }
        
        .container { max-width: 900px; margin: 0 auto; padding: 20px; }
        
        .header {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .header h1 { font-size: 1.5rem; margin-bottom: 8px; }
        .header .subtitle { color: var(--timestamp-color); font-size: 0.9rem; }
        .export-info {
            font-size: 0.75rem;
            color: var(--timestamp-color);
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .messages-container { display: flex; flex-direction: column; gap: 16px; }
        
        .message {
            display: flex;
            gap: 12px;
            padding: 16px;
            border-radius: 12px;
            background: var(--message-bg);
            border: 1px solid var(--border-color);
        }
        
        .message.user { background: var(--user-message-bg); }
        .message.bot { background: var(--bot-message-bg); }
        
        .avatar-container { flex-shrink: 0; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; }
        .avatar-placeholder {
            width: 40px; height: 40px; border-radius: 50%;
            background: var(--accent-color); color: white;
            display: flex; align-items: center; justify-content: center;
            font-weight: bold; font-size: 1.2rem;
        }
        
        /* Deduplicated avatar images - each base64 image defined only once */
        ${imageCSSRules}
        
        .message-content { flex: 1; min-width: 0; }
        .message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
        .sender-name { font-weight: 600; }
        .timestamp { font-size: 0.75rem; color: var(--timestamp-color); }
        .alt-badge {
            font-size: 0.65rem; padding: 2px 6px;
            background: var(--accent-color); color: white;
            border-radius: 4px; text-transform: uppercase; font-weight: 600;
        }
        .message-text {
            word-wrap: break-word;
            font-size: ${style.fontSize};
            ${style.fontFamily ? `font-family: ${style.fontFamily};` : ''}
            font-weight: ${style.bodyFontWeight};
            font-style: ${style.bodyFontStyle};
            text-decoration: ${style.bodyTextDecoration};
        }
        .message.bot .message-text { color: ${style.bot.bodyColor}; }
        .message.user .message-text { color: ${style.user.bodyColor}; }
        .message-text .action {
            font-weight: ${style.narrationFontWeight};
            font-style: ${style.narrationFontStyle};
            text-decoration: ${style.narrationTextDecoration};
        }
        .message.bot .message-text .action { color: ${style.bot.narrationColor}; }
        .message.user .message-text .action { color: ${style.user.narrationColor}; }
        .message-text .quote {
            font-weight: ${style.spanQuoteFontWeight};
            font-style: ${style.spanQuoteFontStyle};
            text-decoration: ${style.spanQuoteTextDecoration};
        }
        .message.bot .message-text .quote { color: ${style.bot.spanQuoteColor}; }
        .message.user .message-text .quote { color: ${style.user.spanQuoteColor}; }

        @media (max-width: 600px) {
            .container { padding: 10px; }
            .message { padding: 12px; }
            .avatar, .avatar-placeholder { width: 32px; height: 32px; font-size: 1rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Chat with ${escapeHTML(botName)}</h1>
            ${characterTitle ? `<p class="subtitle">${escapeHTML(characterTitle)}</p>` : ''}
            <div class="export-info">
                Exported on ${formatTime(exportedAt)} by S.AI Toolkit<br>
                ${sortedMessages.length} messages
            </div>
        </div>
        <div class="messages-container">
            ${messagesHTML}
        </div>
    </div>
</body>
</html>`;
    }
    
    // Helper function to detect iOS
    function isIOS() {
        const ua = navigator.userAgent;
        const isIOSDevice = /iPad|iPhone|iPod/.test(ua) || 
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        console.log('[S.AI Export] iOS detection - isIOS:', isIOSDevice);
        return isIOSDevice;
    }
    
    // Helper function to download a file
    function downloadFile(content, filename, mimeType) {
        console.log('[S.AI Export] downloadFile called:', filename, mimeType, 'content length:', content.length);
        
        const blob = new Blob([content], { type: mimeType });
        
        // iOS needs special handling - blob URLs don't work for downloads
        if (isIOS()) {
            console.log('[S.AI Export] iOS detected, showing save modal');
            showIOSSaveModal(content, filename, mimeType);
            return;
        }
        
        // Standard desktop approach
        console.log('[S.AI Export] Using standard download approach');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    // iOS-specific save modal - shows content for manual copying
    function showIOSSaveModal(content, filename, mimeType) {
        console.log('[S.AI Export] Creating iOS save modal');
        
        // Remove any existing modal
        const existingModal = document.getElementById('ios-save-modal');
        if (existingModal) existingModal.remove();
        
        // Create modal container
        const modal = document.createElement('div');
        modal.id = 'ios-save-modal';
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            z-index: 10000020;
            display: flex;
            flex-direction: column;
            padding: 20px;
            padding-top: env(safe-area-inset-top, 20px);
            padding-bottom: env(safe-area-inset-bottom, 20px);
        `;
        
        // Create content wrapper
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            background: #1a1a2e;
            border-radius: 16px;
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            max-height: 100%;
        `;
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 16px 20px;
            border-bottom: 1px solid #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        
        const title = document.createElement('h2');
        title.textContent = `Save: ${filename}`;
        title.style.cssText = `
            margin: 0;
            font-size: 18px;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: #ef4444;
            color: white;
            border: none;
            width: 32px;
            height: 32px;
            border-radius: 16px;
            font-size: 18px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        closeBtn.onclick = () => modal.remove();
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        
        // Instructions
        const instructions = document.createElement('div');
        instructions.style.cssText = `
            padding: 12px 20px;
            background: #2a2a3e;
            color: #a0a0a0;
            font-size: 14px;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            line-height: 1.4;
        `;
        
        // Build instructions content safely
        const strong1 = document.createElement('strong');
        strong1.style.color = '#4ade80';
        strong1.textContent = 'To save this file:';
        instructions.appendChild(strong1);
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('1. Tap "Copy to Clipboard" below'));
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('2. Open the '));
        const strong2 = document.createElement('strong');
        strong2.textContent = 'Files';
        instructions.appendChild(strong2);
        instructions.appendChild(document.createTextNode(' app or a text editor'));
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('3. Create a new file named '));
        const strong3 = document.createElement('strong');
        strong3.textContent = filename;
        instructions.appendChild(strong3);
        instructions.appendChild(document.createElement('br'));
        instructions.appendChild(document.createTextNode('4. Paste the content and save'));
        
        // Button row
        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = `
            padding: 12px 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        `;
        
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 Copy to Clipboard';
        copyBtn.style.cssText = `
            flex: 1;
            min-width: 140px;
            padding: 14px 20px;
            background: #4f46e5;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(content);
                copyBtn.textContent = '✓ Copied!';
                copyBtn.style.background = '#22c55e';
                showNotification('Content copied to clipboard!');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy to Clipboard';
                    copyBtn.style.background = '#4f46e5';
                }, 2000);
            } catch (e) {
                console.log('[S.AI Export] Clipboard API failed:', e);
                // Fallback: select the textarea content
                textarea.select();
                textarea.setSelectionRange(0, 99999);
                document.execCommand('copy');
                copyBtn.textContent = '✓ Copied!';
                copyBtn.style.background = '#22c55e';
                showNotification('Content copied! (fallback method)');
                setTimeout(() => {
                    copyBtn.textContent = '📋 Copy to Clipboard';
                    copyBtn.style.background = '#4f46e5';
                }, 2000);
            }
        };
        
        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '🔤 Select All';
        selectAllBtn.style.cssText = `
            flex: 1;
            min-width: 100px;
            padding: 14px 20px;
            background: #374151;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        selectAllBtn.onclick = () => {
            textarea.select();
            textarea.setSelectionRange(0, 99999);
            showNotification('Content selected - now copy it');
        };
        
        buttonRow.appendChild(copyBtn);
        buttonRow.appendChild(selectAllBtn);
        
        // Textarea with content
        const textareaContainer = document.createElement('div');
        textareaContainer.style.cssText = `
            flex: 1;
            padding: 0 20px 20px 20px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            min-height: 0;
        `;
        
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.readOnly = true;
        textarea.style.cssText = `
            flex: 1;
            width: 100%;
            background: #0d0d1a;
            color: #e0e0e0;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 12px;
            font-size: 12px;
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
            resize: none;
            line-height: 1.4;
        `;
        
        textareaContainer.appendChild(textarea);
        
        // Assemble modal
        wrapper.appendChild(header);
        wrapper.appendChild(instructions);
        wrapper.appendChild(buttonRow);
        wrapper.appendChild(textareaContainer);
        modal.appendChild(wrapper);
        
        document.body.appendChild(modal);
        console.log('[S.AI Export] iOS save modal displayed');
    }
    
    // Helper function to show iOS download instructions modal (legacy, keeping for reference)
    function showIOSDownloadInstructions(content, filename, mimeType) {
        const modal = document.createElement('div');
        modal.id = 'ios-download-modal';
        modal.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 10000010;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;
        
        const content_div = document.createElement('div');
        content_div.style.cssText = `
            background: #1a1a2e;
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            width: 100%;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        
        const title = document.createElement('h3');
        title.textContent = 'Save File on iOS';
        title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px;';
        
        const instructions = document.createElement('p');
        instructions.textContent = 'Tap the button below to open your file, then use the Share button (↑) in your browser to save it to Files or another app.';
        instructions.style.cssText = 'margin: 0 0 20px 0; font-size: 14px; line-height: 1.5; opacity: 0.9;';
        
        const openButton = document.createElement('button');
        openButton.textContent = 'Open File';
        openButton.style.cssText = `
            width: 100%;
            padding: 14px;
            background: #4f46e5;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-bottom: 12px;
        `;
        openButton.onclick = () => {
            const base64 = btoa(unescape(encodeURIComponent(content)));
            const dataUrl = `data:${mimeType};base64,${base64}`;
            window.open(dataUrl, '_blank');
        };
        
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.style.cssText = `
            width: 100%;
            padding: 14px;
            background: transparent;
            color: white;
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
        `;
        closeButton.onclick = () => modal.remove();
        
        content_div.appendChild(title);
        content_div.appendChild(instructions);
        content_div.appendChild(openButton);
        content_div.appendChild(closeButton);
        modal.appendChild(content_div);
        
        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
        
        document.body.appendChild(modal);
    }
    
    // Function to show toolkit settings modal
    async function showToolkitSettingsModal() {
    debugLog('[Core] ===== OPENING SETTINGS MODAL =====');
    debugLog('[Core] Current Sidebar Layout enabled?', await storage.get(SIDEBAR_LAYOUT_KEY, false));
    // Create or get a dedicated container with SHADOW DOM for complete isolation
        let toolkitRoot = document.getElementById('toolkit-modal-root');
        if (!toolkitRoot) {
            debugLog('[Core] Creating new toolkit-modal-root with Shadow DOM');
            toolkitRoot = document.createElement('div');
            toolkitRoot.id = 'toolkit-modal-root';
            toolkitRoot.className = 'toolkit-modal-container';
            toolkitRoot.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 10000003;';
            document.body.appendChild(toolkitRoot);
            
            // Attach shadow DOM for complete isolation from React
            const shadow = toolkitRoot.attachShadow({ mode: 'open' });
            debugLog('[Core] Shadow DOM attached');
            
            // Add styles to shadow DOM
            const style = document.createElement('style');
            style.textContent = `
                * { box-sizing: border-box; }
                .backdrop {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.3);
                    backdrop-filter: blur(4px);
                    z-index: 10000003;
                    pointer-events: auto;
                }
                .modal {
                    position: fixed;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 12px;
                    width: 420px;
                    max-width: 95vw;
                    max-height: 85vh;   /* fallback for browsers without dvh */
                    max-height: 85dvh;  /* dynamic viewport: excludes iOS toolbars */
                    z-index: 10000004;
                    pointer-events: auto;
                    display: flex;
                    flex-direction: column;
                    padding: 1rem;
                    gap: 0.75rem;
                }
                @media (max-width: 480px) {
                    .modal {
                        /* Pin to the VISIBLE viewport instead of centering a large-viewport
                           box. On iOS, vh = the large viewport (ignores the address/tab bars),
                           so a centered max-height:100vh modal overflowed the visible area top
                           AND bottom — clipping the tabs and the Save/Close row. Anchoring
                           top-left at 100dvh fills exactly the visible viewport, and the flex
                           column (pinned header/tabs + scrolling body + pinned button row)
                           keeps everything reachable. */
                        top: 0;
                        left: 0;
                        transform: none;
                        width: 100%;
                        max-width: 100vw;
                        height: 100vh;       /* fallback */
                        height: 100dvh;
                        max-height: 100vh;   /* fallback */
                        max-height: 100dvh;
                        border-radius: 0;
                        padding: 0.75rem;
                    }
                }
                @media (prefers-color-scheme: dark) {
                    .modal { background: #1a1a1a; color: white; }
                }
                .modal-header {
                    text-align: center;
                    font-size: 1.1rem;
                    font-weight: bold;
                    padding-bottom: 0.5rem;
                    flex-shrink: 0;
                }
                
                /* Tab Navigation */
                .tab-nav {
                    display: flex;
                    gap: 0.25rem;
                    border-bottom: 1px solid #e5e7eb;
                    padding-bottom: 0.5rem !important;
                    margin-bottom: 0.5rem;
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: none;
                    flex-shrink: 0;
                }
                .tab-nav::-webkit-scrollbar {
                    display: none;
                }
                @media (prefers-color-scheme: dark) {
                    .tab-nav { border-color: #404040; }
                }
                .tab-btn {
                    flex: 1;
                    min-width: 70px;
                    min-height: 52px;
                    padding: 0.5rem 0.5rem;
                    border: none;
                    background: transparent;
                    color: #6b7280;
                    font-size: 12px !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                    font-weight: 500 !important;
                    font-style: normal !important;
                    text-decoration: none !important;
                    line-height: 1.2 !important;
                    cursor: pointer;
                    border-radius: 6px;
                    transition: all 0.2s;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 0.25rem;
                    white-space: nowrap;
                }
                .tab-btn:hover {
                    background: #f3f4f6;
                    color: #374151;
                }
                .tab-btn.active {
                    background: #3b82f6;
                    color: white;
                }
                @media (prefers-color-scheme: dark) {
                    .tab-btn { color: #9ca3af; }
                    .tab-btn:hover { background: #2a2a2a; color: #d1d5db; }
                    .tab-btn.active { background: #3b82f6; color: white; }
                }
                .tab-icon {
                    width: 18px;
                    height: 18px;
                    min-width: 18px;
                    min-height: 18px;
                    flex-shrink: 0;
                }
                @media (max-width: 380px) {
                    .tab-btn span { display: none; }
                    .tab-btn { min-width: 44px; padding: 0.5rem; }
                    .tab-icon { width: 20px; height: 20px; min-width: 20px; min-height: 20px; }
                }
                
                /* Tab Content */
                .tab-content {
                    display: none;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                .tab-content.active {
                    display: flex;
                }

                .modal-body {
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    flex: 1;
                    min-height: 0;
                    margin-right: -1rem;
                    padding-right: 1rem;
                }
                @media (max-width: 480px) {
                    .modal-body {
                        margin-right: -0.75rem;
                        padding-right: 0.75rem;
                    }
                }
                .setting-row {
                    background: #f3f4f6;
                    padding: 0.6rem 0.75rem;
                    border-radius: 0.75rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .setting-row { background: #2a2a2a; }
                }
                .setting-row:hover {
                    background: #e5e7eb;
                }
                @media (prefers-color-scheme: dark) {
                    .setting-row:hover { background: #333; }
                }
                .setting-checkbox {
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                    flex-shrink: 0;
                }
                .setting-text {
                    flex: 1;
                    cursor: pointer;
                }
                .setting-title {
                    font-size: 13px;
                    font-weight: 500;
                    margin-bottom: 2px;
                }
                .setting-desc {
                    font-size: 11px;
                    color: #6b7280;
                    line-height: 1.3;
                }
                .sub-setting-row {
                    background: #e5e7eb;
                    padding: 0.5rem 0.6rem;
                    padding-left: 0.5rem;
                    border-radius: 0.5rem;
                    margin-top: -0.25rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-left: 1.5rem;
                }
                @media (prefers-color-scheme: dark) {
                    .sub-setting-row { background: #1f1f1f; }
                }
                .sub-setting-row:hover {
                    background: #d1d5db;
                }
                @media (prefers-color-scheme: dark) {
                    .sub-setting-row:hover { background: #252525; }
                }
                .sub-setting-text {
                    flex: 1;
                    cursor: pointer;
                }
                .sub-setting-title {
                    font-size: 12px;
                    font-weight: 400;
                }
                .hidden {
                    display: none !important;
                }
                .number-input {
                    width: 70px;
                    padding: 4px 6px;
                    border-radius: 4px;
                    border: 1px solid #d1d5db;
                    background: #f9fafb;
                    color: #374151;
                    font-size: 12px;
                }
                @media (prefers-color-scheme: dark) {
                    .number-input {
                        border-color: #4b5563;
                        background: #374151;
                        color: white;
                    }
                }
                .section-title {
                    font-size: 12px;
                    font-weight: 600;
                    margin-bottom: 0.25rem;
                    margin-top: 0.5rem;
                    color: #374151;
                }
                @media (prefers-color-scheme: dark) {
                    .section-title { color: #d1d5db; }
                }
                .section-desc {
                    font-size: 11px;
                    color: #6b7280;
                    margin-bottom: 0.5rem;
                }
                /* Style tab: its sections are standalone groups, so their headings
                   are larger than the small labels used on the other tabs. */
                #tab-style .section-title {
                    font-size: 15px;
                    font-weight: 700;
                    margin-top: 1.1rem;
                    margin-bottom: 0.5rem;
                    color: #111827;
                }
                #tab-style .custom-style-section:first-child .section-title { margin-top: 0.25rem; }
                @media (prefers-color-scheme: dark) {
                    #tab-style .section-title { color: #f3f4f6; }
                }
                .drive-sync-status {
                    font-size: 11px;
                    color: #9ca3af;
                    margin-bottom: 0.25rem;
                    min-height: 1.2em;
                }
                .sync-scope-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                    margin-bottom: 0.35rem;
                }
                .sync-scope-label {
                    font-size: 11px;
                    color: #6b7280;
                }
                .sync-scope-item {
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    font-size: 12px;
                    color: #374151;
                    cursor: pointer;
                }
                @media (prefers-color-scheme: dark) {
                    .sync-scope-item { color: #d1d5db; }
                }
                .auto-sync-select {
                    font-size: 11px;
                    padding: 0.1rem 0.3rem;
                    border-radius: 4px;
                    border: 1px solid #d1d5db;
                    background: transparent;
                    color: #374151;
                    cursor: pointer;
                }
                @media (prefers-color-scheme: dark) {
                    .auto-sync-select { border-color: #4b5563; color: #d1d5db; background: #1f2937; }
                }
                .drive-backup-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 0.25rem;
                }
                .drive-backup-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: #374151;
                }
                .drive-backup-list {
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    max-height: 168px;
                    overflow-y: auto;
                    margin-top: 0.2rem;
                }
                .drive-backup-item {
                    display: flex;
                    align-items: center;
                    padding: 0.3rem 0.5rem;
                    background: #f3f4f6;
                    border-radius: 6px;
                    gap: 0.5rem;
                }
                .drive-backup-item-date {
                    font-size: 11px;
                    color: #374151;
                    flex: 1;
                }
                .drive-backup-item-btns {
                    display: flex;
                    gap: 0.25rem;
                    flex-shrink: 0;
                }
                .drive-backup-empty, .drive-backup-loading {
                    font-size: 11px;
                    color: #9ca3af;
                    padding: 0.5rem;
                    text-align: center;
                }
                @media (prefers-color-scheme: dark) {
                    .drive-backup-title { color: #d1d5db; }
                    .drive-backup-item { background: #374151; }
                    .drive-backup-item-date { color: #d1d5db; }
                }
                .data-buttons {
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                }
                .version-text {
                    margin-top: 0.75rem;
                    text-align: center;
                    font-size: 11px;
                    color: #9ca3af;
                    font-weight: 400;
                }
                @media (prefers-color-scheme: dark) {
                    .version-text { color: #6b7280; }
                }
                .memorial {
                    margin-top: 1.5rem;
                    text-align: center;
                    font-size: 12px;
                    color: #9ca3af;
                }
                .memorial img {
                    display: block;
                    width: 160px;
                    max-width: 100%;
                    margin: 0 auto 0.5rem;
                    border-radius: 8px;
                }
                .memorial-name {
                    font-size: 14px;
                    font-weight: 600;
                }
                .memorial-note {
                    margin-top: 0.25rem;
                    font-style: italic;
                }
                .debug-filter-label {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    font-size: 11px;
                    color: #9ca3af;
                    cursor: pointer;
                    padding: 0.25rem 0.4rem;
                    border-radius: 4px;
                    transition: background 0.15s;
                }
                .debug-filter-label:hover {
                    background: rgba(255,255,255,0.05);
                }
                .debug-filter-label input[type="checkbox"] {
                    width: 14px;
                    height: 14px;
                    accent-color: #4ade80;
                    cursor: pointer;
                }
                .btn-data {
                    flex: 1;
                    min-width: 120px;
                    padding: 0.4rem 0.6rem;
                    border-radius: 6px;
                    border: 1px solid #d1d5db;
                    background: #f9fafb;
                    color: #374151;
                    cursor: pointer;
                    font-size: 11px;
                    font-weight: 500;
                    transition: all 0.2s;
                }
                .btn-data:hover {
                    background: #f3f4f6;
                    border-color: #9ca3af;
                }
                @media (prefers-color-scheme: dark) {
                    .btn-data {
                        background: #1f2937;
                        border-color: #374151;
                        color: #d1d5db;
                    }
                    .btn-data:hover {
                        background: #374151;
                        border-color: #4b5563;
                    }
                }
                .button-row {
                    display: flex;
                    gap: 0.5rem;
                    padding-top: 0.5rem;
                    border-top: 1px solid #e5e7eb;
                    flex-shrink: 0;
                }
                @media (prefers-color-scheme: dark) {
                    .button-row { border-color: #404040; }
                }
                button {
                    flex: 1;
                    padding: 0.5rem 1rem;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    font-size: 13px !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                    font-weight: 500 !important;
                    font-style: normal !important;
                    text-decoration: none !important;
                    transition: all 0.2s;
                }
                .btn-cancel {
                    background: #e5e7eb;
                    color: black;
                }
                .btn-cancel:hover {
                    background: #d1d5db;
                }
                @media (prefers-color-scheme: dark) {
                    .btn-cancel { background: #404040; color: white; }
                    .btn-cancel:hover { background: #4a4a4a; }
                }
                .btn-save {
                    background: #3b82f6;
                    color: white;
                }
                .btn-save:hover {
                    background: #2563eb;
                }
                
                /* Style tab: Light/Dark value pairs (label | light | dark) */
                .style-pair-header,
                .style-pair-row {
                    display: grid;
                    grid-template-columns: 110px 1fr 1fr;
                    gap: 0.5rem;
                    align-items: center;
                }
                .style-pair-row { margin-bottom: 0.4rem; }
                .style-pair-header { margin-bottom: 0.35rem; }
                .style-pair-header span {
                    font-size: 13px;
                    font-weight: 600;
                    color: #374151;
                }
                @media (prefers-color-scheme: dark) {
                    .style-pair-header span { color: #e5e7eb; }
                }
                /* Square icon button (bin) that sits in front of the file picker */
                .icon-btn-danger {
                    /* The modal's generic \`button { flex: 1 }\` rule would stretch
                       this across the row - pin it to a fixed square instead. */
                    flex: 0 0 36px;
                    width: 36px;
                    height: 36px;
                    box-sizing: border-box;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    background: transparent;
                    border: 1px solid #dc2626;
                    color: #dc2626;
                    border-radius: 6px;
                    cursor: pointer;
                    touch-action: manipulation;
                    transition: background-color 0.2s, color 0.2s;
                }
                .icon-btn-danger:hover {
                    background: #dc2626;
                    color: #fff;
                }
                .icon-btn-danger svg { width: 18px; height: 18px; pointer-events: none; }
                .style-pair-cell {
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    min-width: 0;
                }
                @media (max-width: 420px) {
                    .style-pair-header,
                    .style-pair-row { grid-template-columns: 80px 1fr 1fr; }
                }
                .style-input-row {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                }
                .style-label {
                    min-width: 100px;
                    flex-shrink: 0;
                    color: #374151;
                    font-size: 12px;
                    font-weight: 500;
                }
                @media (prefers-color-scheme: dark) {
                    .style-label { color: #d1d5db; }
                }
                @media (max-width: 380px) {
                    .style-label { min-width: 80px; font-size: 11px; }
                }
                .style-input {
                    flex: 1;
                    min-width: 0;
                    padding: 0.5rem;
                    background: #2a2a2a;
                    border: 1px solid #555;
                    color: #fff;
                    border-radius: 6px;
                    font-size: 12px;
                    font-family: 'Courier New', monospace;
                }
                .color-preview {
                    width: 24px;
                    height: 24px;
                    border-radius: 4px;
                    border: 1px solid #555;
                    flex-shrink: 0;
                    background: transparent;
                    background-image: linear-gradient(45deg, #666 25%, transparent 25%), linear-gradient(-45deg, #666 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #666 75%), linear-gradient(-45deg, transparent 75%, #666 75%);
                    background-size: 8px 8px;
                    background-position: 0 0, 0 4px, 4px -4px, -4px 0px;
                }
                .color-preview-inner {
                    width: 100%;
                    height: 100%;
                    border-radius: 3px;
                }
            `;
            shadow.appendChild(style);
        }
        
        const shadow = toolkitRoot.shadowRoot;
        debugLog('[Core] Got shadow root, clearing existing content');
        
        // Clear existing content
        const existingBackdrop = shadow.querySelector('.backdrop');
        if (existingBackdrop) existingBackdrop.remove();
        const existingModal = shadow.querySelector('.modal');
        if (existingModal) existingModal.remove();
        
        
        // State tracking
        // PERFORMANCE: Batch all modal settings into a single storage read
        const modalSettings = await storage.getMultiple({
            [SIDEBAR_LAYOUT_KEY]: false,
            [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH,
            [COMPACT_GENERATION_KEY]: false,
            [STYLE_OVERRIDES_KEY]: JSON.stringify(EMPTY_STYLE_OVERRIDES),
            [HIDE_FOR_YOU_KEY]: false,
            [PAGE_JUMP_KEY]: false,
            'showGenerationStats': false,
            'showModelDetails': true,
            'compactStats': false,
            'showTimestamp': false,
            'highlightModelChanges': false,
            'autoRegenOnMismatch': false,
            'autoRegenOnShort': false,
            'autoRegenMaxAttempts': 1,
            'timestampDateFirst': true,
            'timestamp24Hour': false,
            [SHOW_MESSAGE_IDS_KEY]: false,
            'showChatNameInTitle': false,
            'nsfwToggleEnabled': false,
            'messageRecoveryEnabled': false,
            [ENABLE_GENERATION_PROFILES_KEY]: false,
            [ROUNDED_PROFILE_IMAGES_KEY]: false,
            [SWAP_CHECKBOX_POSITION_KEY]: false,
            [SQUARE_MESSAGE_EDGES_KEY]: false,
            [MEMORY_DOT_ENABLED_KEY]: true,
            [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
            [HIDE_CREATOR_KEY]: false
        });
        
        let sidebarEnabled = modalSettings[SIDEBAR_LAYOUT_KEY];
        let sidebarMinWidthValue = modalSettings[SIDEBAR_MIN_WIDTH_KEY];
        let compactGenerationEnabled = modalSettings[COMPACT_GENERATION_KEY];
        // Style tab's individual color/background overrides (see STYLE_OVERRIDES_KEY)
        const styleOverrides = normalizeStyleOverrides(modalSettings[STYLE_OVERRIDES_KEY]);
        let hideForYouEnabled = modalSettings[HIDE_FOR_YOU_KEY];
        let pageJumpEnabled = modalSettings[PAGE_JUMP_KEY];
        let showStatsEnabled = modalSettings['showGenerationStats'];
        let showModelDetailsEnabled = modalSettings['showModelDetails']; // true = show "model → engine", false = show only "model"
        let compactStatsEnabled = modalSettings['compactStats']; // true = hide stat labels (e.g. "300 | 0.94 | 0.9 | 65")
        let showTimestampEnabled = modalSettings['showTimestamp'];
        let highlightModelChangesEnabled = modalSettings['highlightModelChanges'];
        let autoRegenOnMismatchEnabled = modalSettings['autoRegenOnMismatch'];
        let autoRegenOnShortEnabled = modalSettings['autoRegenOnShort'];
        let autoRegenMaxAttempts = modalSettings['autoRegenMaxAttempts'];
        let timestampDateFirst = modalSettings['timestampDateFirst']; // true = date@time, false = time@date
        let timestamp24Hour = modalSettings['timestamp24Hour'];
        let showMessageIdsEnabled = modalSettings[SHOW_MESSAGE_IDS_KEY]; // false = 12-hour (default), true = 24-hour
        let showChatNameInTitleEnabled = modalSettings['showChatNameInTitle'];
        let nsfwToggleEnabled = modalSettings['nsfwToggleEnabled'];
        let messageRecoveryEnabled = modalSettings['messageRecoveryEnabled'];
        let enableGenerationProfilesEnabled = modalSettings[ENABLE_GENERATION_PROFILES_KEY];
        let roundedProfileImagesEnabled = modalSettings[ROUNDED_PROFILE_IMAGES_KEY];
        let swapCheckboxPositionEnabled = modalSettings[SWAP_CHECKBOX_POSITION_KEY];
        let squareMessageEdgesEnabled = modalSettings[SQUARE_MESSAGE_EDGES_KEY];
        let memoryDotEnabled = modalSettings[MEMORY_DOT_ENABLED_KEY];
        let memoryDotColor = modalSettings[MEMORY_DOT_COLOR_KEY];
        let hideCreatorEnabled = modalSettings[HIDE_CREATOR_KEY];

        debugLog('[Core] Modal state - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', sidebarMinWidthValue, 'CompactGeneration:', compactGenerationEnabled, 'StyleOverrides:', styleOverrides, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled, 'MemoryDot:', memoryDotEnabled, 'MemoryDotColor:', memoryDotColor);
        
        // Create backdrop
        debugLog('[Core] Creating backdrop and modal elements');
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        
        // Create modal with safe HTML (no dynamic content in innerHTML)
        const modal = document.createElement('div');
        modal.className = 'modal';
        // Using static HTML template - checkboxes will be set programmatically below.
        // Built via DOMParser to avoid the .innerHTML setter (Mozilla addons-linter).
        const SETTINGS_MODAL_TEMPLATE = `
            <div class="modal-header">S.AI Toolkit Settings</div>
            
            <!-- Tab Navigation -->
            <div class="tab-nav">
                <button class="tab-btn active" data-tab="layout">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="9" y1="3" x2="9" y2="21"></line>
                    </svg>
                    <span>Layout</span>
                </button>
                <button class="tab-btn" data-tab="style">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"></circle>
                        <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"></circle>
                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"></path>
                    </svg>
                    <span>Style</span>
                </button>
                <button class="tab-btn" data-tab="features">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                    <span>Features</span>
                </button>
                <button class="tab-btn" data-tab="data">
                    <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    <span>Data</span>
                </button>
            </div>
            
            <div class="modal-body">
                <!-- Layout Tab -->
                <div class="tab-content active" id="tab-layout">
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="sidebar-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Sidebar Layout</div>
                            <div class="setting-desc">Pin Generation Settings and Memories modals to sidebar</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="compact-generation-row">
                        <input type="checkbox" class="setting-checkbox" id="compact-generation-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Compact Generation Settings</div>
                            <div class="setting-desc">Hide descriptive text for each setting</div>
                        </div>
                    </label>
                    <div class="sub-setting-row hidden" id="sidebar-min-width-row">
                        <div class="sub-setting-text" style="display: flex; align-items: center; gap: 8px;">
                            <div class="sub-setting-title">Minimum page width</div>
                            <input type="number" id="sidebar-min-width-input" class="number-input" min="600" max="2000" step="50" autocomplete="off">
                            <span style="font-size: 11px; color: #6b7280;">px</span>
                        </div>
                    </div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="rounded-profile-images-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Rounded Profile Images</div>
                            <div class="setting-desc">Make profile images circular</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="swap-checkbox-position-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Selection Checkboxes on Right Side</div>
                            <div class="setting-desc">Move selection checkboxes to opposite side</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="square-message-edges-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Square Message Box Edges</div>
                            <div class="setting-desc">Remove rounded corners from message boxes</div>
                        </div>
                    </label>
                </div>
                
                <!-- Style Tab -->
                <div class="tab-content" id="tab-style">
                    <!-- Message Colors: each has its own Light + Dark value. Empty = SpicyChat's own color. -->
                    <div class="custom-style-section">
                        <div class="section-title">Message Colors</div>
                        <label class="setting-row" style="margin-bottom: 12px;">
                            <input type="checkbox" class="setting-checkbox" id="style-colors-enabled" autocomplete="off">
                            <div class="setting-text">
                                <div class="setting-title">Custom Message Colors</div>
                                <div class="setting-desc">Use your own message bubble and button hover colors</div>
                            </div>
                        </label>
                        <div id="style-colors-fields" class="hidden">
                        <div class="style-pair-header"><span></span><span>☀ Light</span><span>🌙 Dark</span></div>
                        <div class="style-pair-row">
                            <label class="style-label">Bot Message BG:</label>
                            <div class="style-pair-cell">
                                <input type="text" id="style-bot-bg-light" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-bot-bg-light-preview"></div></div>
                            </div>
                            <div class="style-pair-cell">
                                <input type="text" id="style-bot-bg-dark" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-bot-bg-dark-preview"></div></div>
                            </div>
                        </div>
                        <div class="style-pair-row">
                            <label class="style-label">User Message BG:</label>
                            <div class="style-pair-cell">
                                <input type="text" id="style-user-bg-light" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-user-bg-light-preview"></div></div>
                            </div>
                            <div class="style-pair-cell">
                                <input type="text" id="style-user-bg-dark" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-user-bg-dark-preview"></div></div>
                            </div>
                        </div>
                        <div class="style-pair-row">
                            <label class="style-label">Button Hover:</label>
                            <div class="style-pair-cell">
                                <input type="text" id="style-hover-light" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-hover-light-preview"></div></div>
                            </div>
                            <div class="style-pair-cell">
                                <input type="text" id="style-hover-dark" class="style-input" placeholder="default">
                                <div class="color-preview"><div class="color-preview-inner" id="style-hover-dark-preview"></div></div>
                            </div>
                        </div>
                        <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;">Any CSS color (e.g. #1e2b3e, rgba(0, 100, 255, 0.1)). Leave a field empty to use SpicyChat's own color for it. Text colors and fonts now live in SpicyChat's native chat Customize panel.</div>
                        </div>
                    </div>

                    <!-- Background Image Section -->
                    <div class="custom-style-section">
                        <div class="section-title">Background Image</div>
                        <div class="style-input-row" style="margin-bottom: 0;">
                            <input type="file" id="background-image-input" class="style-input" accept="image/*">
                            <button id="clear-background-image-btn" class="icon-btn-danger" type="button" title="Remove background image" aria-label="Remove background image">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                            </button>
                        </div>
                        <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;"><span id="background-image-status"></span> Upload an image for the chat background (converted to data URL).</div>
                    </div>
                    
                    <!-- Memory Limit Indicator Section -->
                    <div class="custom-style-section">
                        <div class="section-title">Memory Limit Indicator</div>
                        <label class="setting-row" style="margin-bottom: 12px;">
                            <input type="checkbox" class="setting-checkbox" id="memory-dot-enabled-checkbox" autocomplete="off">
                            <div class="setting-text">
                                <div class="setting-title">Show Memory Dot</div>
                                <div class="setting-desc">Display red dot when chat reaches memory limit</div>
                            </div>
                        </label>
                        <div class="style-input-row">
                            <label class="style-label">Dot Color:</label>
                            <input type="text" id="memory-dot-color" class="style-input" placeholder="#ff3b3b">
                            <div class="color-preview"><div class="color-preview-inner" id="preview-memory-dot-color"></div></div>
                        </div>
                        <div class="setting-desc" style="margin-top: 6px; font-size: 11px; color: #6b7280;">Customize the memory limit indicator color (default: red)</div>
                    </div>

                    <!-- Legacy Custom Style: only shown while old data exists -->
                    <div class="custom-style-section hidden" id="legacy-custom-style-section">
                        <div class="section-title">Your old Custom Style</div>
                        <div class="setting-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 8px;">Custom Style has been retired in favor of SpicyChat's own chat styles. Export yours as a SpicyChat style link to keep it, then clear the old data.</div>
                        <div class="data-buttons">
                            <button class="btn-data" id="export-custom-style-url-btn">Export Custom Style URL to SpicyChat</button>
                            <button class="btn-data" id="clear-custom-style-data-btn" style="color: #dc2626; border-color: #dc2626;">Clear Custom Style data</button>
                        </div>
                        <div id="custom-style-url-result" class="setting-desc" style="margin-top: 6px; font-size: 11px;"></div>
                    </div>
                </div>
                
                <!-- Features Tab -->
                <div class="tab-content" id="tab-features">
                    <div class="section-title">Main Page</div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="hideforyou-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Hide "For You" Characters</div>
                            <div class="setting-desc">Hide tiles with purple "For You" badge on page 1</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="pagejump-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Page Jump Modal</div>
                            <div class="setting-desc">Click "..." to jump to any page</div>
                        </div>
                    </label>
                    
                    <div class="section-title">Chat</div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showstats-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Generation Stats</div>
                            <div class="setting-desc">Display model and settings below bot messages</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="generation-model-details-row">
                        <input type="checkbox" class="setting-checkbox" id="generation-model-details-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Show full model details</div>
                            <div class="setting-desc">Show "Model → Engine" format</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="compact-stats-row">
                        <input type="checkbox" class="setting-checkbox" id="compact-stats-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Compact Stats</div>
                            <div class="setting-desc">Hide labels: "300 | 0.94 | 0.9 | 65"</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showtimestamp-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Timestamps</div>
                            <div class="setting-desc">Display message timestamps</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="timestamp-format-row">
                        <input type="checkbox" class="setting-checkbox" id="timestamp-format-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Show date first</div>
                            <div class="setting-desc">Format: "date @ time"</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="timestamp-hour-format-row">
                        <input type="checkbox" class="setting-checkbox" id="timestamp-hour-format-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Use 24-hour time</div>
                            <div class="setting-desc">Default: 12-hour format</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="show-message-ids-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Show Message IDs</div>
                            <div class="setting-desc">Display message IDs</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="highlight-model-changes-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Highlight Model Changes</div>
                            <div class="setting-desc">Show yellow border when model changes between messages</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="auto-regen-mismatch-row">
                        <input type="checkbox" class="setting-checkbox" id="auto-regen-mismatch-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Auto-Regenerate on Mismatch</div>
                            <div class="setting-desc">Automatically regenerate if model engine changes</div>
                        </div>
                    </label>
                    <label class="sub-setting-row hidden" id="auto-regen-short-row">
                        <input type="checkbox" class="setting-checkbox" id="auto-regen-short-checkbox" autocomplete="off">
                        <div class="sub-setting-text">
                            <div class="sub-setting-title">Auto-Regenerate on Short Response</div>
                            <div class="setting-desc">Automatically regenerate if response is under 50 characters</div>
                        </div>
                    </label>
                    <div class="sub-setting-row hidden" id="auto-regen-max-row">
                        <div class="sub-setting-text" style="display: flex; align-items: center; gap: 8px;">
                            <div class="sub-setting-title" style="white-space: nowrap;">Max Auto-Regenerations</div>
                            <select id="auto-regen-max-select" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 12px;">
                                <option value="1">1</option>
                                <option value="2">2</option>
                                <option value="3">3</option>
                            </select>
                        </div>
                    </div>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="showchatnametitle-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Chat Name in Title</div>
                            <div class="setting-desc">Show "Character (Label)" in browser tab</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="nsfwtoggle-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">NSFW Image Toggle</div>
                            <div class="setting-desc">Show NSFW toggle button in chat toolbar</div>
                        </div>
                    </label>
                    <label class="setting-row">
                        <input type="checkbox" class="setting-checkbox" id="message-recovery-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Message Recovery</div>
                            <div class="setting-desc">Save messages locally when SpicyChat fails to send them, and offer one-click recovery</div>
                        </div>
                    </label>
                    <!-- Hidden from the UI: SpicyChat no longer shows a per-message creator
                         name in group chats, which is what this was originally built to hide,
                         so the setting no longer does anything useful (its selector still
                         matches the unrelated creator-profile link, hiding that everywhere
                         instead). Kept fully wired up — storage key, CSS injection, import/
                         export — so it's a one-line revert if SpicyChat brings that UI back. -->
                    <label class="setting-row hidden" id="hide-creator-row">
                        <input type="checkbox" class="setting-checkbox" id="hide-creator-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Hide Creator Name</div>
                            <div class="setting-desc">Hide the @username creator link under bot messages</div>
                        </div>
                    </label>
                    <label class="setting-row hidden" id="generation-profiles-row">
                        <input type="checkbox" class="setting-checkbox" id="generation-profiles-checkbox" autocomplete="off">
                        <div class="setting-text">
                            <div class="setting-title">Generation Profiles (Legacy)</div>
                            <div class="setting-desc">Re-enable generation profile selector</div>
                        </div>
                    </label>
                </div>
                
                <!-- Data Tab -->
                <div class="tab-content" id="tab-data">
                    <div id="generation-profiles-section">
                        <div class="section-title">Generation Profiles</div>
                        <div class="section-desc">Export or delete generation profiles</div>
                        <div class="data-buttons">
                            <button class="btn-data" id="export-profiles-btn">Export</button>
                            <button class="btn-data" id="import-profiles-btn" style="display: none;">Import</button>
                            <button class="btn-data" id="delete-profiles-btn" style="background: #dc2626; border-color: #dc2626; color: white;">Delete</button>
                        </div>
                    </div>
                    
                    <div class="section-title">Drive Sync</div>
                    <div class="section-desc">Sync your data across devices via Google Drive. This will automatically save your generation stats across all your devices, enabling you to start a chat on one, and resume on another while carrying over the generation statistics.</div>
                    <div class="sync-scope-row">
                        <span class="sync-scope-label">Sync:</span>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-stats-toggle" autocomplete="off">
                            <span>Stats</span>
                        </label>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-settings-toggle" autocomplete="off">
                            <span>Settings</span>
                        </label>
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="sync-style-toggle" autocomplete="off">
                            <span>Style</span>
                        </label>
                    </div>
                    <div class="sync-scope-row">
                        <label class="sync-scope-item">
                            <input type="checkbox" class="setting-checkbox" id="auto-sync-toggle" autocomplete="off">
                            <span>Auto-sync</span>
                        </label>
                        <select id="auto-sync-interval" class="auto-sync-select" style="display:none;">
                            <option value="5">every 5 min</option>
                            <option value="10">every 10 min</option>
                            <option value="15">every 15 min</option>
                        </select>
                    </div>
                    <div id="drive-sync-status" class="drive-sync-status">Checking…</div>
                    <div class="data-buttons" style="margin-top: 0.5rem;">
                        <button class="btn-data" id="drive-sync-btn">Sync Now</button>
                        <button class="btn-data" id="drive-reconnect-btn" style="display: none; color: #d97706; border-color: #d97706;">Reconnect Google</button>
                        <button class="btn-data" id="drive-disconnect-btn" style="display: none; color: #dc2626; border-color: #dc2626;">Disconnect</button>
                    </div>
                    <div id="sync-progress-section" style="display: none; margin-top: 0.6rem;">
                        <div id="sync-progress-text" style="font-size: 0.72rem; color: #9ca3af; margin-bottom: 0.35rem; font-style: italic;"></div>
                        <div style="height: 3px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                            <div id="sync-progress-bar" style="height: 100%; background: #6366f1; border-radius: 2px; width: 0%; transition: width 0.4s ease;"></div>
                        </div>
                    </div>
                    <div id="drive-backup-section" style="display: none; margin-top: 0.75rem;">
                        <div class="drive-backup-header">
                            <span class="drive-backup-title">Backups</span>
                            <div style="display: flex; gap: 0.4rem;">
                                <button class="btn-data" id="drive-create-backup-btn">Create Backup</button>
                                <button class="btn-data" id="drive-open-folder-btn">Open in Drive ↗</button>
                            </div>
                        </div>
                        <div id="drive-backup-status" class="drive-sync-status"></div>
                        <div id="drive-backup-list" class="drive-backup-list">
                            <div class="drive-backup-loading">Loading backups…</div>
                        </div>
                    </div>

                    <div class="section-title">All Data</div>
                    <div class="section-desc">Export/import everything (settings, profiles, stats)</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="export-all-btn">Export All</button>
                        <button class="btn-data" id="import-all-btn">Import All</button>
                    </div>
                    <div class="data-buttons" style="margin-top: 0.5rem;">
                        <button class="btn-data" id="clear-all-btn" style="background: #dc2626; border-color: #dc2626; color: white;">Clear All Data</button>
                    </div>

                    <div class="section-title">What's New</div>
                    <div class="section-desc">See what changed in recent releases</div>
                    <div class="data-buttons">
                        <button class="btn-data" id="view-whats-new-btn">View Changelog</button>
                    </div>

                    <div class="version-text" id="version-text">v1.2</div>
                    
                    <!-- Debug Log Filters (only visible in debug mode) -->
                    <div id="debug-filters-section" class="hidden" style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(255,255,255,0.1);">
                        <div class="section-title" style="color: #4ade80;">🐛 Debug Log Filters</div>
                        <div class="section-desc">Toggle which log categories appear in console</div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-top: 0.75rem;">
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-core" checked> Core
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-stats" checked> Stats
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-memories" checked> Memories
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-export" checked> Export
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-nsfw" checked> NSFW
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-chattitle" checked> ChatTitle
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-profile" checked> Profile
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-model" checked> Model
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-cache" checked> Cache
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-migration" checked> Migration
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-custom" checked> Custom
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-compact" checked> Compact
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-sync" checked> Sync
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-autoregen" checked> AutoRegen
                            </label>
                            <label class="debug-filter-label">
                                <input type="checkbox" id="debug-filter-msgrecovery" checked> MsgRecovery
                            </label>
                        </div>
                        <div class="data-buttons" style="margin-top: 0.75rem;">
                            <button class="btn-data" id="debug-filter-all-btn">Enable All</button>
                            <button class="btn-data" id="debug-filter-none-btn">Disable All</button>
                        </div>
                        <div id="bg-experiment-section" style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(74,222,128,0.3);">
                            <div style="font-size: 0.75rem; font-weight: 600; color: #4ade80; margin-bottom: 0.4rem;">Background page (experimental)</div>
                            <label class="debug-filter-label" style="display: block; margin-bottom: 0.5rem;">
                                <input type="checkbox" id="bridge-enabled-checkbox"> Use extension-page fallback (bridge) when the background doesn't answer
                            </label>
                            <div class="data-buttons">
                                <button class="btn-data" id="bg-check-btn">Check background</button>
                                <button class="btn-data" id="bg-revive-btn">Try revive</button>
                                <button class="btn-data" id="bg-reload-btn" style="color: #dc2626; border-color: #dc2626;">Restart extension</button>
                            </div>
                            <pre id="bg-experiment-output" style="margin-top: 0.5rem; padding: 0.5rem; max-height: 220px; overflow: auto; background: rgba(0,0,0,0.3); border-radius: 4px; color: #d1d5db; font-size: 10px; white-space: pre-wrap; word-break: break-word; user-select: text; -webkit-user-select: text;">Results appear here.</pre>
                        </div>
                        <div id="model-override-section" style="display: none; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(255,140,0,0.3);">
                            <div style="font-size: 0.75rem; font-weight: 600; color: #ff8c00; margin-bottom: 0.4rem;">Model Override <span style="color: #9ca3af; font-weight: 400; font-size: 0.7rem;">(quad-click "Model" to toggle)</span></div>
                            <input type="text" id="model-override-input" placeholder="e.g. glm5-beta" autocomplete="off" style="width: 100%; box-sizing: border-box; padding: 0.4rem 0.5rem; background: rgba(255,140,0,0.08); border: 1px solid rgba(255,140,0,0.5); border-radius: 4px; color: #ff8c00; font-size: 0.75rem; outline: none; font-family: monospace;">
                        </div>
                    </div>

                    <div class="memorial hidden" id="memorial-section">
                        <img id="memorial-img" alt="Mari">
                        <div class="memorial-name">Mari</div>
                        <div class="memorial-dates">10 October 2013 - 1 October 2026</div>
                        <div class="memorial-note">I miss my baby girl 🌈</div>
                    </div>
                </div>
            </div>
            
            <div class="button-row">
                <button class="btn-cancel" id="cancel-btn">Close</button>
                <button class="btn-save" id="save-btn">Save & Refresh</button>
            </div>
        `;
        modal.replaceChildren(parseHTMLToFragment(SETTINGS_MODAL_TEMPLATE));

        // Append to shadow DOM
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);
        
        debugLog('[Core] Modal and backdrop appended to shadow DOM');
        
        // Get checkbox elements within shadow DOM
        const sidebarCheckbox = shadow.querySelector('#sidebar-checkbox');
        const compactGenerationCheckbox = shadow.querySelector('#compact-generation-checkbox');
        const roundedProfileImagesCheckbox = shadow.querySelector('#rounded-profile-images-checkbox');
        const swapCheckboxPositionCheckbox = shadow.querySelector('#swap-checkbox-position-checkbox');
        const squareMessageEdgesCheckbox = shadow.querySelector('#square-message-edges-checkbox');
        const hideForYouCheckbox = shadow.querySelector('#hideforyou-checkbox');
        const pageJumpCheckbox = shadow.querySelector('#pagejump-checkbox');
        const showStatsCheckbox = shadow.querySelector('#showstats-checkbox');
        const modelDetailsCheckbox = shadow.querySelector('#generation-model-details-checkbox');
        const compactStatsCheckbox = shadow.querySelector('#compact-stats-checkbox');
        const showTimestampCheckbox = shadow.querySelector('#showtimestamp-checkbox');
        const timestampFormatCheckbox = shadow.querySelector('#timestamp-format-checkbox');
        const timestampHourFormatCheckbox = shadow.querySelector('#timestamp-hour-format-checkbox');
        const showMessageIdsCheckbox = shadow.querySelector('#show-message-ids-checkbox');
        const highlightModelChangesCheckbox = shadow.querySelector('#highlight-model-changes-checkbox');
        const autoRegenMismatchCheckbox = shadow.querySelector('#auto-regen-mismatch-checkbox');
        const autoRegenShortCheckbox = shadow.querySelector('#auto-regen-short-checkbox');
        const autoRegenMaxSelect = shadow.querySelector('#auto-regen-max-select');
        const autoRegenMismatchRow = shadow.querySelector('#auto-regen-mismatch-row');
        const autoRegenShortRow = shadow.querySelector('#auto-regen-short-row');
        const autoRegenMaxRow = shadow.querySelector('#auto-regen-max-row');
        const showChatNameInTitleCheckbox = shadow.querySelector('#showchatnametitle-checkbox');
        const nsfwToggleCheckbox = shadow.querySelector('#nsfwtoggle-checkbox');
        const messageRecoveryCheckbox = shadow.querySelector('#message-recovery-checkbox');
        const hideCreatorCheckbox = shadow.querySelector('#hide-creator-checkbox');
        const enableGenerationProfilesCheckbox = shadow.querySelector('#generation-profiles-checkbox');
        const generationProfilesRow = shadow.querySelector('#generation-profiles-row');
        const modelDetailsRow = shadow.querySelector('#generation-model-details-row');
        const compactStatsRow = shadow.querySelector('#compact-stats-row');
        const timestampFormatRow = shadow.querySelector('#timestamp-format-row');
        const timestampHourFormatRow = shadow.querySelector('#timestamp-hour-format-row');
        const compactGenerationRow = shadow.querySelector('#compact-generation-row');
        const sidebarMinWidthRow = shadow.querySelector('#sidebar-min-width-row');
        const sidebarMinWidthInput = shadow.querySelector('#sidebar-min-width-input');
        const backgroundImageInput = shadow.querySelector('#background-image-input');
        const clearBackgroundImageBtn = shadow.querySelector('#clear-background-image-btn');
        const memoryDotEnabledCheckbox = shadow.querySelector('#memory-dot-enabled-checkbox');
        const memoryDotColorInput = shadow.querySelector('#memory-dot-color');
        const previewMemoryDotColor = shadow.querySelector('#preview-memory-dot-color');
        const versionText = shadow.querySelector('#version-text');
        const viewWhatsNewBtn = shadow.querySelector('#view-whats-new-btn');
        const debugFiltersSection = shadow.querySelector('#debug-filters-section');

        // Keep the displayed version in sync with the actual installed version
        // instead of a hardcoded string that goes stale after every release.
        if (versionText) {
            const _api = typeof browser !== 'undefined' ? browser : chrome;
            versionText.textContent = 'v' + _api.runtime.getManifest().version;
        }

        const memorialSection = shadow.querySelector('#memorial-section');
        const memorialImg = shadow.querySelector('#memorial-img');
        if (memorialImg) {
            const _api = typeof browser !== 'undefined' ? browser : chrome;
            memorialImg.src = _api.runtime.getURL('images/mari.jpg');
        }

        if (viewWhatsNewBtn) {
            viewWhatsNewBtn.addEventListener('click', () => showChangelogHistoryModal());
        }
        
        // Debug filter checkboxes
        const debugFilterCheckboxes = {
            Core: shadow.querySelector('#debug-filter-core'),
            Stats: shadow.querySelector('#debug-filter-stats'),
            Memories: shadow.querySelector('#debug-filter-memories'),
            Export: shadow.querySelector('#debug-filter-export'),
            NSFW: shadow.querySelector('#debug-filter-nsfw'),
            ChatTitle: shadow.querySelector('#debug-filter-chattitle'),
            Profile: shadow.querySelector('#debug-filter-profile'),
            Model: shadow.querySelector('#debug-filter-model'),
            Cache: shadow.querySelector('#debug-filter-cache'),
            Migration: shadow.querySelector('#debug-filter-migration'),
            Custom: shadow.querySelector('#debug-filter-custom'),
            Compact: shadow.querySelector('#debug-filter-compact'),
            Sync: shadow.querySelector('#debug-filter-sync'),
            AutoRegen: shadow.querySelector('#debug-filter-autoregen'),
            MsgRecovery: shadow.querySelector('#debug-filter-msgrecovery')
        };
        
        // Refresh in-memory filters from storage (source of truth) before initializing the
        // checkboxes — so reopening the modal reflects what was actually persisted, not a
        // possibly-stale in-memory object.
        try {
            const storedFilters = await storage.get('debugLogFilters', null);
            if (storedFilters && typeof storedFilters === 'object') {
                debugLogFilters = { ...debugLogFilters, ...storedFilters };
            }
        } catch (_) { /* keep in-memory */ }

        // Initialize debug filter checkboxes from current state.
        // NOTE: persistence binds BOTH 'change' AND 'click'. On WebKit/Orion the synthesized
        // `change` from a <label>-nested checkbox inside a shadow root is unreliable (same
        // event-synthesis fragility as the WYSIWYG iOS issue), and — unlike every other
        // setting — debug filters have no Save-time fallback (Save & Refresh never reads
        // them). `click` fires reliably on tap/keyboard after the native toggle; the de-dupe
        // guard makes binding both harmless.
        for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
            if (checkbox) {
                checkbox.checked = debugLogFilters[category] !== false;
                const applyDebugFilter = async () => {
                    if (debugLogFilters[category] === checkbox.checked) return; // de-dupe (both events / no real change)
                    debugLogFilters[category] = checkbox.checked;               // flips the live debugLog() check immediately
                    await storage.set('debugLogFilters', debugLogFilters);
                    console.log(`[Core] Debug filter "${category}" ${checkbox.checked ? 'enabled' : 'disabled'}`);
                };
                checkbox.addEventListener('change', applyDebugFilter);
                // WebKit/Orion fallback: defer one tick so checkbox.checked has settled to its
                // post-toggle value before we read it.
                checkbox.addEventListener('click', () => { setTimeout(applyDebugFilter, 0); });
            }
        }
        
        // Secret model override: Quad-click (4 times within 2s) on the "Model" debug filter label
        // Forces inference_model to user-specified value for all chat/story POST requests
        // Section with textbox is only visible while override is active (orange text)
        const modelCheckbox = debugFilterCheckboxes.Model;
        const modelLabel = modelCheckbox ? modelCheckbox.closest('label') : null;
        const modelOverrideSection = shadow.querySelector('#model-override-section');
        const modelOverrideInput = shadow.querySelector('#model-override-input');
        if (modelCheckbox && modelLabel && modelOverrideSection && modelOverrideInput) {
            // Load initial state from storage and sync to interceptor
            Promise.all([
                storage.get('modelOverrideEnabled', false),
                storage.get('modelOverrideName', '')
            ]).then(([enabled, modelName]) => {
                if (modelName) modelOverrideInput.value = modelName;
                if (enabled) {
                    modelLabel.style.color = '#ff8c00';
                    modelOverrideSection.style.display = '';
                    window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: modelName || null }, '*');
                }
            });

            // Live-update interceptor as user types the model name
            modelOverrideInput.addEventListener('input', async (e) => {
                const name = e.target.value.trim();
                await storage.set('modelOverrideName', e.target.value);
                const isEnabled = await storage.get('modelOverrideEnabled', false);
                if (isEnabled) {
                    window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: name || null }, '*');
                }
            });

            // Quad-click on Model label to toggle override
            let overrideTapCount = 0;
            let overrideTapTimer = null;
            modelLabel.addEventListener('click', async (e) => {
                if (!e.isTrusted) return;
                overrideTapCount++;
                clearTimeout(overrideTapTimer);
                overrideTapTimer = setTimeout(() => { overrideTapCount = 0; }, 2000);

                if (overrideTapCount === 4) {
                    overrideTapCount = 0;
                    clearTimeout(overrideTapTimer);

                    const currentlyEnabled = await storage.get('modelOverrideEnabled', false);
                    const newState = !currentlyEnabled;
                    const modelName = modelOverrideInput.value.trim() ||
                                      await storage.get('modelOverrideName', '');

                    await storage.set('modelOverrideEnabled', newState);
                    if (modelName) await storage.set('modelOverrideName', modelName);

                    if (newState) {
                        modelLabel.style.color = '#ff8c00';
                        modelOverrideSection.style.display = '';
                        if (modelName) modelOverrideInput.value = modelName;
                        window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: modelName || null }, '*');
                        // Suppress mismatch auto-regen for the first response (model change is expected)
                        window.__suppressMismatchNext = true;
                        debugLog('[Model] Model override ENABLED:', modelName);
                    } else {
                        modelLabel.style.color = '';
                        modelOverrideSection.style.display = 'none';
                        window.postMessage({ type: 'SAI_SET_MODEL_OVERRIDE', model: null }, '*');
                        window.__suppressMismatchNext = false;
                        debugLog('[Model] Model override DISABLED');
                    }
                }
            });
        }
        
        // ---- Background page experiment (Debug Mode only) ----
        const bridgeEnabledCheckbox = shadow.querySelector('#bridge-enabled-checkbox');
        const bgCheckBtn = shadow.querySelector('#bg-check-btn');
        const bgReviveBtn = shadow.querySelector('#bg-revive-btn');
        const bgReloadBtn = shadow.querySelector('#bg-reload-btn');
        const bgExperimentOutput = shadow.querySelector('#bg-experiment-output');
        const showBgResult = (title, obj) => {
            bgExperimentOutput.textContent = new Date().toLocaleTimeString() + ' — ' + title + '\n' + JSON.stringify(obj, null, 1);
            debugLog('[Core] Background experiment:', title, obj);
        };
        const runBgAction = async (btn, title, fn) => {
            btn.disabled = true;
            bgExperimentOutput.textContent = title + '…';
            try { showBgResult(title, await fn()); }
            catch (err) { showBgResult(title + ' failed', { error: err && err.message }); }
            btn.disabled = false;
        };
        try {
            const s = await runtimeAPI.storage.local.get(BRIDGE_ENABLED_KEY);
            bridgeEnabledCheckbox.checked = s[BRIDGE_ENABLED_KEY] === true;
        } catch (_) {}
        // Saved immediately (like the debug filters): it changes behaviour without a reload.
        bridgeEnabledCheckbox.onchange = async (e) => {
            await runtimeAPI.storage.local.set({ [BRIDGE_ENABLED_KEY]: e.target.checked });
            showBgResult('Bridge fallback ' + (e.target.checked ? 'ON' : 'OFF'), { experimentalBridge: e.target.checked });
        };
        bgCheckBtn.onclick = (e) => {
            e.stopPropagation();
            runBgAction(bgCheckBtn, 'Check background', async () => {
                const out = { browser: isOrionOnIOS() ? 'Orion on iOS' : 'other', extensionUrl: runtimeAPI.runtime.getURL('') };
                out.backgroundAnswersPing = await probeBackground();
                out.heldStatsWaiting = Object.keys(await readHeldStats()).length;
                out.lastAutomaticCheck = _lastBackgroundHealth;
                out.bridge = (await bridgeEnabled()) ? await bridgeCall('diagnose') : 'off (tick the box above to test it)';
                return out;
            });
        };
        bgReviveBtn.onclick = (e) => {
            e.stopPropagation();
            runBgAction(bgReviveBtn, 'Try revive', async () => {
                const before = await probeBackground();
                const alive = await reviveBackground(true);
                const out = { before, after: alive, details: _lastBackgroundHealth };
                if (alive) out.heldStatsDelivered = await flushHeldStats();
                return out;
            });
        };
        bgReloadBtn.onclick = (e) => {
            e.stopPropagation();
            if (!confirm('Restart the extension through the bridge page?\n\nThis page will lose its connection to the extension and need a refresh.')) return;
            runBgAction(bgReloadBtn, 'Restart extension', async () => {
                if (!(await bridgeEnabled())) return { error: 'Tick "Use extension-page fallback" first — restart goes through the bridge page.' };
                return await bridgeCall('reload');
            });
        };

        // Debug filter "Enable All" button
        const debugFilterAllBtn = shadow.querySelector('#debug-filter-all-btn');
        if (debugFilterAllBtn) {
            debugFilterAllBtn.addEventListener('click', async () => {
                for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
                    if (checkbox) {
                        checkbox.checked = true;
                        debugLogFilters[category] = true;
                    }
                }
                await storage.set('debugLogFilters', debugLogFilters);
                console.log('[Core] All debug filters enabled');
            });
        }
        
        // Debug filter "Disable All" button
        const debugFilterNoneBtn = shadow.querySelector('#debug-filter-none-btn');
        if (debugFilterNoneBtn) {
            debugFilterNoneBtn.addEventListener('click', async () => {
                for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
                    if (checkbox) {
                        checkbox.checked = false;
                        debugLogFilters[category] = false;
                    }
                }
                await storage.set('debugLogFilters', debugLogFilters);
                console.log('[Core] All debug filters disabled');
            });
        }
        
        // Show/hide debug filters section based on DEBUG_MODE
        function updateDebugFiltersVisibility() {
            if (debugFiltersSection) {
                if (DEBUG_MODE) {
                    debugFiltersSection.classList.remove('hidden');
                } else {
                    debugFiltersSection.classList.add('hidden');
                }
            }
            // Mari's tribute is only shown while Debug Mode is on
            if (memorialSection) {
                memorialSection.classList.toggle('hidden', !DEBUG_MODE);
            }
        }
        updateDebugFiltersVisibility();
        
        // Easter egg: Shift+click or 4 quick taps on version text toggles DEBUG_MODE
        if (versionText) {
            // Set initial color based on current DEBUG_MODE state
            if (DEBUG_MODE) {
                versionText.style.color = '#4ade80'; // light green when debug is on
            }
            
            versionText.style.cursor = 'pointer';
            // iOS: rapid taps on plain text get treated as double-tap-to-zoom /
            // text-selection gestures, and Safari then coalesces them into fewer
            // `click` events - so 4 taps often only registered as 2-3.
            // manipulation disables the double-tap gesture; the rest stops the
            // selection callout from eating taps.
            versionText.style.touchAction = 'manipulation';
            versionText.style.userSelect = 'none';
            versionText.style.webkitUserSelect = 'none';
            versionText.style.webkitTouchCallout = 'none';
            versionText.style.padding = '0.5rem 0'; // bigger target than 11px text

            const toggleDebugMode = async () => {
                DEBUG_MODE = !DEBUG_MODE;
                await storage.set('debugMode', DEBUG_MODE);
                window.__SAI_DEBUG_MODE__ = DEBUG_MODE;
                if (DEBUG_MODE) {
                    versionText.style.color = '#4ade80'; // light green
                    console.log('[Core] 🐛 Debug mode ENABLED (saved)');
                    generationProfilesRow.classList.remove('hidden');
                } else {
                    versionText.style.color = ''; // reset to default
                    console.log('[Core] Debug mode disabled (saved)');
                    generationProfilesRow.classList.add('hidden');
                }
                await updateGenerationProfilesVisibility();
                updateDebugFiltersVisibility();
            };

            // Multi-tap detection
            let tapCount = 0;
            let tapTimer = null;

            // Count on pointerup, not click: pointerup fires once per physical
            // tap on iOS even when Safari suppresses the synthesized click.
            versionText.addEventListener('pointerup', async (e) => {
                if (e.shiftKey || (e.pointerType === 'mouse' && e.button !== 0)) return;
                tapCount++;
                clearTimeout(tapTimer);
                tapTimer = setTimeout(() => { tapCount = 0; }, 2000);
                if (tapCount === 4) {
                    tapCount = 0;
                    clearTimeout(tapTimer);
                    await toggleDebugMode();
                }
            });

            // Shift+click immediately toggles debug mode (desktop shortcut)
            versionText.addEventListener('click', async (e) => {
                if (!e.shiftKey) return;
                tapCount = 0;
                clearTimeout(tapTimer);
                await toggleDebugMode();
            });
        }
        
        // Set checkbox states programmatically (safer than innerHTML with dynamic values)
        sidebarCheckbox.checked = sidebarEnabled;
        compactGenerationCheckbox.checked = compactGenerationEnabled;
        roundedProfileImagesCheckbox.checked = roundedProfileImagesEnabled;
        swapCheckboxPositionCheckbox.checked = swapCheckboxPositionEnabled;
        squareMessageEdgesCheckbox.checked = squareMessageEdgesEnabled;
        memoryDotEnabledCheckbox.checked = memoryDotEnabled;
        memoryDotColorInput.value = memoryDotColor || '#ff3b3b';
        hideForYouCheckbox.checked = hideForYouEnabled;
        pageJumpCheckbox.checked = pageJumpEnabled;
        showStatsCheckbox.checked = showStatsEnabled;
        modelDetailsCheckbox.checked = showModelDetailsEnabled;
        compactStatsCheckbox.checked = compactStatsEnabled;
        showTimestampCheckbox.checked = showTimestampEnabled;
        highlightModelChangesCheckbox.checked = highlightModelChangesEnabled;
        autoRegenMismatchCheckbox.checked = autoRegenOnMismatchEnabled;
        autoRegenShortCheckbox.checked = autoRegenOnShortEnabled;
        autoRegenMaxSelect.value = String(autoRegenMaxAttempts || 1);
        // Show/hide sub-options based on highlight model changes state
        const updateAutoRegenVisibility = () => {
            const showSubs = highlightModelChangesCheckbox.checked;
            autoRegenMismatchRow.classList.toggle('hidden', !showSubs);
            autoRegenShortRow.classList.toggle('hidden', !showSubs);
            // Show max attempts only if either auto-regen option is checked
            const showMax = showSubs && (autoRegenMismatchCheckbox.checked || autoRegenShortCheckbox.checked);
            autoRegenMaxRow.classList.toggle('hidden', !showMax);
        };
        updateAutoRegenVisibility();
        timestampFormatCheckbox.checked = timestampDateFirst;
        timestampHourFormatCheckbox.checked = timestamp24Hour;
        showMessageIdsCheckbox.checked = showMessageIdsEnabled;
        showChatNameInTitleCheckbox.checked = showChatNameInTitleEnabled;
        nsfwToggleCheckbox.checked = nsfwToggleEnabled;
        messageRecoveryCheckbox.checked = messageRecoveryEnabled;
        hideCreatorCheckbox.checked = hideCreatorEnabled;
        enableGenerationProfilesCheckbox.checked = enableGenerationProfilesEnabled;
        
        // Update generation profiles checkbox when it changes
        if (enableGenerationProfilesCheckbox) {
            enableGenerationProfilesCheckbox.addEventListener('change', async () => {
                await updateGenerationProfilesVisibility();
            });
        }
        
        // Show/hide generation profiles setting based on debug mode
        if (DEBUG_MODE) {
            generationProfilesRow.classList.remove('hidden');
        } else {
            generationProfilesRow.classList.add('hidden');
        }
        
        // Show/hide model details row based on showStats setting
        if (showStatsEnabled) {
            modelDetailsRow.classList.remove('hidden');
            compactStatsRow.classList.remove('hidden');
        } else {
            modelDetailsRow.classList.add('hidden');
            compactStatsRow.classList.add('hidden');
        }
        
        // Show/hide timestamp format rows based on showTimestamp setting
        if (showTimestampEnabled) {
            timestampFormatRow.classList.remove('hidden');
            timestampHourFormatRow.classList.remove('hidden');
        } else {
            timestampFormatRow.classList.add('hidden');
            timestampHourFormatRow.classList.add('hidden');
        }
        
        // Show/hide compact generation row based on sidebar setting
        if (sidebarEnabled) {
            compactGenerationRow.classList.remove('hidden');
            sidebarMinWidthRow.classList.remove('hidden');
        } else {
            compactGenerationRow.classList.add('hidden');
            sidebarMinWidthRow.classList.add('hidden');
        }
        
        // Set sidebar minimum width input value
        sidebarMinWidthInput.value = sidebarMinWidthValue;
        
        debugLog('[Core] Checkbox states set programmatically');
        
        // CRITICAL: Install event barrier at shadow root to prevent events from escaping to React
        // Use BUBBLE phase (false) so events reach our handlers first, THEN get stopped from escaping
        debugLog('[Core] Installing comprehensive event barrier at shadow root (bubble phase)');
        const eventTypes = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 
                           'touchstart', 'touchend', 'keydown', 'keyup', 'input', 'change'];
        eventTypes.forEach(async eventType => {
            shadow.addEventListener(eventType, (e) => {
                debugLog('[Core] Event barrier stopping propagation:', eventType, 'target:', e.target.id || e.target.className);
                e.stopPropagation();  // Prevent event from escaping shadow DOM
            }, false); // Bubble phase - runs AFTER our handlers, stops events from leaving shadow DOM
        });
        debugLog('[Core] Event barrier installed (bubble phase) for:', eventTypes.join(', '));
        
        // Tab switching logic
        const tabBtns = shadow.querySelectorAll('.tab-btn');
        const tabContents = shadow.querySelectorAll('.tab-content');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                debugLog('[Core] Tab switched to:', targetTab);
                
                // Update active states
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                
                btn.classList.add('active');
                const targetContent = shadow.querySelector(`#tab-${targetTab}`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }
            });
        });
        debugLog('[Core] Tab switching initialized');
        
        // Get button and other elements within shadow DOM
        const cancelBtn = shadow.querySelector('#cancel-btn');
        const saveBtn = shadow.querySelector('#save-btn');
        const exportProfilesBtn = shadow.querySelector('#export-profiles-btn');
        const importProfilesBtn = shadow.querySelector('#import-profiles-btn');
        const deleteProfilesBtn = shadow.querySelector('#delete-profiles-btn');
        const generationProfilesSection = shadow.querySelector('#generation-profiles-section');
        const exportAllBtn = shadow.querySelector('#export-all-btn');
        const importAllBtn = shadow.querySelector('#import-all-btn');
        const clearAllBtn = shadow.querySelector('#clear-all-btn');
        const driveSyncBtn = shadow.querySelector('#drive-sync-btn');
        const driveDisconnectBtn = shadow.querySelector('#drive-disconnect-btn');
        const driveReconnectBtn = shadow.querySelector('#drive-reconnect-btn');
        const driveSyncStatus = shadow.querySelector('#drive-sync-status');
        const syncStatsToggle = shadow.querySelector('#sync-stats-toggle');
        const syncSettingsToggle = shadow.querySelector('#sync-settings-toggle');
        const syncStyleToggle = shadow.querySelector('#sync-style-toggle');
        const driveBackupSection = shadow.querySelector('#drive-backup-section');
        const driveCreateBackupBtn = shadow.querySelector('#drive-create-backup-btn');
        const driveOpenFolderBtn = shadow.querySelector('#drive-open-folder-btn');
        const driveBackupStatus = shadow.querySelector('#drive-backup-status');
        const driveBackupList = shadow.querySelector('#drive-backup-list');
        const autoSyncToggle = shadow.querySelector('#auto-sync-toggle');
        const autoSyncIntervalSelect = shadow.querySelector('#auto-sync-interval');

        // Check if this is first run (onboarding) - disable cancel if so
        const hasSeenOnboarding = await storage.get('hasSeenOnboarding', false);
        if (!hasSeenOnboarding) {
            debugLog('[Core] First run - disabling Cancel button');
            cancelBtn.disabled = true;
            cancelBtn.style.opacity = '0.5';
            cancelBtn.style.cursor = 'not-allowed';
            cancelBtn.title = 'Please save your settings or refresh the page manually';
        }
        
        debugLog('[Core] Button query results:');
        debugLog('[Core]   cancelBtn:', cancelBtn);
        debugLog('[Core]   saveBtn:', saveBtn);
        debugLog('[Core]   exportAllBtn:', exportAllBtn);
        debugLog('[Core]   importAllBtn:', importAllBtn);
        
        if (!exportAllBtn) {
            console.error('[Core] ERROR: exportAllBtn not found in shadow DOM!');
        }
        if (!importAllBtn) {
            console.error('[Core] ERROR: importAllBtn not found in shadow DOM!');
        }
        
        // Helper function to update generation profiles visibility
        async function updateGenerationProfilesVisibility() {
            const profiles = await loadProfiles();
            const hasProfiles = Object.keys(profiles).length > 0;
            const forceEnabled = enableGenerationProfilesCheckbox.checked;
            
            // Show section if: has profiles OR (debug mode AND legacy setting enabled)
            const showSection = hasProfiles || (DEBUG_MODE && forceEnabled);
            
            if (generationProfilesSection) {
                if (showSection) {
                    generationProfilesSection.style.display = '';
                } else {
                    generationProfilesSection.style.display = 'none';
                }
            }
            
            // Show Import button only if debug mode AND legacy setting enabled
            if (importProfilesBtn) {
                if (DEBUG_MODE && forceEnabled) {
                    importProfilesBtn.style.display = '';
                } else {
                    importProfilesBtn.style.display = 'none';
                }
            }
        }
        
        // Initial visibility update
        await updateGenerationProfilesVisibility();
        
        // Checkbox change handlers track state
        sidebarCheckbox.onchange = (e) => {
            debugLog('[Core] SIDEBAR CHECKBOX CHANGED');
            sidebarEnabled = e.target.checked;
            debugLog('[Core] Sidebar:', sidebarEnabled);
            
            // Toggle compact generation and min width sub-settings visibility
            if (sidebarEnabled) {
                compactGenerationRow.classList.remove('hidden');
                sidebarMinWidthRow.classList.remove('hidden');
            } else {
                compactGenerationRow.classList.add('hidden');
                sidebarMinWidthRow.classList.add('hidden');
                // Also disable compact generation when sidebar is disabled
                compactGenerationEnabled = false;
                compactGenerationCheckbox.checked = false;
            }
        };
        
        // Sidebar minimum width input handler
        sidebarMinWidthInput.oninput = (e) => {
            debugLog('[Core] SIDEBAR MIN WIDTH INPUT CHANGED');
            const value = parseInt(e.target.value, 10);
            // If empty or invalid, will be set to default on save
            if (!isNaN(value) && value >= 600 && value <= 2000) {
                sidebarMinWidthValue = value;
            }
            debugLog('[Core] Sidebar Min Width:', sidebarMinWidthValue);
        };
        
        compactGenerationCheckbox.onchange = (e) => {
            debugLog('[Core] COMPACT GENERATION CHECKBOX CHANGED');
            compactGenerationEnabled = e.target.checked;
            debugLog('[Core] Compact Generation:', compactGenerationEnabled);
        };
        
        roundedProfileImagesCheckbox.onchange = (e) => {
            debugLog('[Core] ROUNDED PROFILE IMAGES CHECKBOX CHANGED');
            roundedProfileImagesEnabled = e.target.checked;
            debugLog('[Core] Rounded Profile Images:', roundedProfileImagesEnabled);
        };
        
        swapCheckboxPositionCheckbox.onchange = (e) => {
            debugLog('[Core] SWAP CHECKBOX POSITION CHECKBOX CHANGED');
            swapCheckboxPositionEnabled = e.target.checked;
            debugLog('[Core] Swap Checkbox Position:', swapCheckboxPositionEnabled);
        };
        
        squareMessageEdgesCheckbox.onchange = (e) => {
            debugLog('[Core] SQUARE MESSAGE EDGES CHECKBOX CHANGED');
            squareMessageEdgesEnabled = e.target.checked;
            debugLog('[Core] Square Message Edges:', squareMessageEdgesEnabled);
        };

        // ---- Style tab: individual color overrides (Light + Dark each) ----
        // Empty = SpicyChat's own color. Values are read back on Save & Refresh.
        const styleBotBgLightInput  = shadow.querySelector('#style-bot-bg-light');
        const styleBotBgDarkInput   = shadow.querySelector('#style-bot-bg-dark');
        const styleUserBgLightInput = shadow.querySelector('#style-user-bg-light');
        const styleUserBgDarkInput  = shadow.querySelector('#style-user-bg-dark');
        const styleHoverLightInput  = shadow.querySelector('#style-hover-light');
        const styleHoverDarkInput   = shadow.querySelector('#style-hover-dark');
        const bindStyleColorInput = (input, value) => {
            if (!input) return;
            input.value = value || '';
            const swatch = shadow.querySelector(`#${input.id}-preview`);
            const paint = () => { if (swatch) swatch.style.background = input.value.trim() || 'transparent'; };
            paint();
            input.oninput = paint;
        };
        bindStyleColorInput(styleBotBgLightInput,  styleOverrides.botMessageBg.light);
        bindStyleColorInput(styleBotBgDarkInput,   styleOverrides.botMessageBg.dark);
        bindStyleColorInput(styleUserBgLightInput, styleOverrides.userMessageBg.light);
        bindStyleColorInput(styleUserBgDarkInput,  styleOverrides.userMessageBg.dark);
        bindStyleColorInput(styleHoverLightInput,  styleOverrides.buttonHover.light);
        bindStyleColorInput(styleHoverDarkInput,   styleOverrides.buttonHover.dark);

        // "Custom Message Colors" checkbox: shows the fields and, when switched
        // on, fills any that are still empty with the default colors. Switching
        // it off keeps the values but stops applying them (after Save & Refresh).
        const styleColorsEnabledCheckbox = shadow.querySelector('#style-colors-enabled');
        const styleColorsFields = shadow.querySelector('#style-colors-fields');
        const fillEmptyStyleColors = () => {
            [[styleBotBgLightInput,  STYLE_COLOR_DEFAULTS.botMessageBg.light],
             [styleBotBgDarkInput,   STYLE_COLOR_DEFAULTS.botMessageBg.dark],
             [styleUserBgLightInput, STYLE_COLOR_DEFAULTS.userMessageBg.light],
             [styleUserBgDarkInput,  STYLE_COLOR_DEFAULTS.userMessageBg.dark],
             [styleHoverLightInput,  STYLE_COLOR_DEFAULTS.buttonHover.light],
             [styleHoverDarkInput,   STYLE_COLOR_DEFAULTS.buttonHover.dark]].forEach(([input, def]) => {
                if (input && !input.value.trim()) { input.value = def; if (input.oninput) input.oninput(); }
            });
        };
        styleColorsEnabledCheckbox.checked = styleOverrides.enabled;
        styleColorsFields.classList.toggle('hidden', !styleOverrides.enabled);
        styleColorsEnabledCheckbox.onchange = (e) => {
            styleColorsFields.classList.toggle('hidden', !e.target.checked);
            if (e.target.checked) fillEmptyStyleColors();
        };

        // Memory dot color input handler
        if (previewMemoryDotColor) previewMemoryDotColor.style.background = memoryDotColor || '#ff3b3b';
        memoryDotColorInput.oninput = (e) => {
            memoryDotColor = e.target.value;
            if (previewMemoryDotColor) previewMemoryDotColor.style.background = e.target.value || '#ff3b3b';
        };

        // ---- Background image ----
        const backgroundImageStatus = shadow.querySelector('#background-image-status');
        const updateBackgroundImageStatus = () => {
            if (backgroundImageStatus) {
                backgroundImageStatus.textContent = styleOverrides.backgroundImage ? 'An image is set.' : 'No image set.';
            }
        };
        updateBackgroundImageStatus();

        backgroundImageInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                alert('Please select an image file');
                backgroundImageInput.value = '';
                return;
            }
            // Convert to data URL for storage
            const reader = new FileReader();
            reader.onload = (event) => {
                styleOverrides.backgroundImage = event.target.result;
                updateBackgroundImageStatus();
                debugLog('[Core] Background image loaded:', styleOverrides.backgroundImage.substring(0, 50) + '...');
            };
            reader.onerror = () => {
                alert('Error reading image file');
                backgroundImageInput.value = '';
            };
            reader.readAsDataURL(file);
        };

        clearBackgroundImageBtn.onclick = (e) => {
            e.stopPropagation();
            styleOverrides.backgroundImage = '';
            backgroundImageInput.value = '';
            updateBackgroundImageStatus();
            debugLog('[Core] Background image cleared');
        };

        // ---- Legacy Custom Style: export to SpicyChat / clear ----
        // Shown only while old Custom Style data still exists in storage.
        // Once cleared, the section stays hidden for good.
        const legacyCustomStyleSection = shadow.querySelector('#legacy-custom-style-section');
        const exportCustomStyleUrlBtn  = shadow.querySelector('#export-custom-style-url-btn');
        const clearCustomStyleDataBtn  = shadow.querySelector('#clear-custom-style-data-btn');
        const customStyleUrlResult     = shadow.querySelector('#custom-style-url-result');

        const legacyCustomStyle = await storage.getMultiple({ [CUSTOM_STYLE_KEY]: null, [CUSTOM_STYLE_VALUES_KEY]: null });
        if (legacyCustomStyleSection && hasLegacyCustomStyleData(legacyCustomStyle[CUSTOM_STYLE_KEY], legacyCustomStyle[CUSTOM_STYLE_VALUES_KEY])) {
            legacyCustomStyleSection.classList.remove('hidden');
        }

        if (exportCustomStyleUrlBtn) {
            exportCustomStyleUrlBtn.onclick = async (e) => {
                e.stopPropagation();
                customStyleUrlResult.replaceChildren();
                const result = buildSpicyChatStyleShareUrl(legacyCustomStyle[CUSTOM_STYLE_VALUES_KEY]);
                if (!result) {
                    customStyleUrlResult.textContent = 'Your Custom Style matches SpicyChat\'s defaults — there is nothing to export.';
                    return;
                }
                debugLog('[Core] Custom Style share URL generated:', result);

                const field = document.createElement('input');
                field.type = 'text';
                field.readOnly = true;
                field.className = 'style-input';
                field.style.cssText = 'width: 100%; margin-top: 6px;';
                field.value = result.url;
                field.onclick = () => field.select();

                const open = document.createElement('a');
                open.href = result.url;
                open.target = '_blank';
                open.rel = 'noopener';
                open.textContent = 'Open in SpicyChat ↗';
                open.style.cssText = 'display: inline-block; margin-top: 6px; color: #3b82f6; font-weight: 600;';

                const note = document.createElement('div');
                note.className = 'setting-desc';
                note.style.cssText = 'margin-top: 6px; font-size: 11px;';
                let copied = false;
                try { await navigator.clipboard.writeText(result.url); copied = true; } catch (_) {}
                note.textContent = (copied ? 'Link copied. ' : '') +
                    'Open it, then tap Save in SpicyChat\'s style preview to add it to your saved styles.' +
                    (result.notCarried.length ? ` Not supported by SpicyChat styles, so not included: ${result.notCarried.join(', ')}.` : '');

                customStyleUrlResult.append(field, open, note);
            };
        }

        if (clearCustomStyleDataBtn) {
            clearCustomStyleDataBtn.onclick = async (e) => {
                e.stopPropagation();
                if (!confirm('Delete your old Custom Style data?\n\nThis can\'t be undone. Export it to SpicyChat first if you want to keep it.\n\n(Your Message BG, Button Hover, Background Image and Memory Indicator settings are not affected.)')) return;
                await storage.remove([CUSTOM_STYLE_KEY, CUSTOM_STYLE_VALUES_KEY]);
                legacyCustomStyleSection.classList.add('hidden');
                showNotification('Custom Style data cleared');
            };
        }

        hideForYouCheckbox.onchange = (e) => {
            debugLog('[Core] HIDE FOR YOU CHECKBOX CHANGED');
            hideForYouEnabled = e.target.checked;
            debugLog('[Core] Hide For You:', hideForYouEnabled);
        };
        
        pageJumpCheckbox.onchange = (e) => {
            debugLog('[Core] PAGE JUMP CHECKBOX CHANGED');
            pageJumpEnabled = e.target.checked;
            debugLog('[Core] Page Jump:', pageJumpEnabled);
        };
        
        showStatsCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW STATS CHECKBOX CHANGED');
            showStatsEnabled = e.target.checked;
            debugLog('[Core] Show Stats:', showStatsEnabled);
            
            // Toggle model details sub-checkbox visibility
            if (showStatsEnabled) {
                modelDetailsRow.classList.remove('hidden');
                compactStatsRow.classList.remove('hidden');
            } else {
                modelDetailsRow.classList.add('hidden');
                compactStatsRow.classList.add('hidden');
            }
        };

        modelDetailsCheckbox.onchange = (e) => {
            debugLog('[Core] MODEL DETAILS CHECKBOX CHANGED');
            showModelDetailsEnabled = e.target.checked;
            debugLog('[Core] Show Model Details:', showModelDetailsEnabled);
        };

        compactStatsCheckbox.onchange = (e) => {
            debugLog('[Core] COMPACT STATS CHECKBOX CHANGED');
            compactStatsEnabled = e.target.checked;
            debugLog('[Core] Compact Stats:', compactStatsEnabled);
        };
        
        showTimestampCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW TIMESTAMP CHECKBOX CHANGED');
            showTimestampEnabled = e.target.checked;
            debugLog('[Core] Show Timestamp:', showTimestampEnabled);
            
            // Toggle timestamp format sub-checkbox visibility
            if (showTimestampEnabled) {
                timestampFormatRow.classList.remove('hidden');
                timestampHourFormatRow.classList.remove('hidden');
            } else {
                timestampFormatRow.classList.add('hidden');
                timestampHourFormatRow.classList.add('hidden');
            }
        };
        
        timestampFormatCheckbox.onchange = (e) => {
            debugLog('[Core] TIMESTAMP FORMAT CHECKBOX CHANGED');
            timestampDateFirst = e.target.checked;
            debugLog('[Core] Timestamp Format:', timestampDateFirst ? 'date@time' : 'time@date');
        };
        
        timestampHourFormatCheckbox.onchange = (e) => {
            debugLog('[Core] TIMESTAMP HOUR FORMAT CHECKBOX CHANGED');
            timestamp24Hour = e.target.checked;
            debugLog('[Core] Timestamp Hour Format:', timestamp24Hour ? '24-hour' : '12-hour');
        };

        showMessageIdsCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW MESSAGE IDS CHECKBOX CHANGED');
            showMessageIdsEnabled = e.target.checked;
            debugLog('[Core] Show Message IDs:', showMessageIdsEnabled);
        };

        highlightModelChangesCheckbox.onchange = (e) => {
            debugLog('[Core] HIGHLIGHT MODEL CHANGES CHECKBOX CHANGED');
            highlightModelChangesEnabled = e.target.checked;
            debugLog('[Core] Highlight Model Changes:', highlightModelChangesEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenMismatchCheckbox.onchange = (e) => {
            debugLog('[Core] AUTO REGEN MISMATCH CHECKBOX CHANGED');
            autoRegenOnMismatchEnabled = e.target.checked;
            debugLog('[Core] Auto Regen On Mismatch:', autoRegenOnMismatchEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenShortCheckbox.onchange = (e) => {
            debugLog('[Core] AUTO REGEN SHORT CHECKBOX CHANGED');
            autoRegenOnShortEnabled = e.target.checked;
            debugLog('[Core] Auto Regen On Short:', autoRegenOnShortEnabled);
            updateAutoRegenVisibility();
        };

        autoRegenMaxSelect.onchange = (e) => {
            debugLog('[Core] AUTO REGEN MAX SELECT CHANGED');
            autoRegenMaxAttempts = parseInt(e.target.value, 10);
            debugLog('[Core] Auto Regen Max Attempts:', autoRegenMaxAttempts);
        };

        showChatNameInTitleCheckbox.onchange = (e) => {
            debugLog('[Core] SHOW CHAT NAME IN TITLE CHECKBOX CHANGED');
            showChatNameInTitleEnabled = e.target.checked;
            debugLog('[Core] Show Chat Name In Title:', showChatNameInTitleEnabled);
        };
        
        nsfwToggleCheckbox.onchange = (e) => {
            debugLog('[Core] NSFW TOGGLE CHECKBOX CHANGED');
            nsfwToggleEnabled = e.target.checked;
            debugLog('[Core] NSFW Toggle:', nsfwToggleEnabled);
        };

        messageRecoveryCheckbox.onchange = (e) => {
            debugLog('[Core] MESSAGE RECOVERY CHECKBOX CHANGED');
            messageRecoveryEnabled = e.target.checked;
            debugLog('[Core] Message Recovery:', messageRecoveryEnabled);
        };

        hideCreatorCheckbox.onchange = (e) => {
            debugLog('[Core] HIDE CREATOR CHECKBOX CHANGED');
            hideCreatorEnabled = e.target.checked;
            debugLog('[Core] Hide Creator:', hideCreatorEnabled);
        };

        // Close modal function
        const closeModal = () => {
            syncProgressCallback = null;
            debugLog('[Core] ===== CLOSE MODAL CALLED =====');
            debugLog('[Core] Current time:', Date.now());
            debugLog('[Core] Backdrop element:', backdrop);
            debugLog('[Core] Modal element:', modal);
            debugLog('[Core] Shadow root:', shadow);
            debugLog('[Core] Document body children count:', document.body.children.length);
            
            try {
                debugLog('[Core] Setting backdrop opacity to 0');
                backdrop.style.opacity = '0';
                debugLog('[Core] Setting backdrop transition');
                backdrop.style.transition = 'opacity 0.15s';
                debugLog('[Core] Setting modal opacity to 0');
                modal.style.opacity = '0';
                debugLog('[Core] Setting modal transform');
                modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
                debugLog('[Core] Setting modal transition');
                modal.style.transition = 'all 0.15s';
                debugLog('[Core] CSS animations set successfully');
            } catch (error) {
                console.error('[Core] Error setting CSS animations:', error);
            }
            
            // Remove from DOM after animation completes
            debugLog('[Core] Scheduling removal in 200ms');
            setTimeout(() => {
                debugLog('[Core] ===== STARTING DOM REMOVAL =====');
                debugLog('[Core] Time:', Date.now());
                debugLog('[Core] About to remove backdrop');
                try {
                    backdrop.remove();
                    debugLog('[Core] Backdrop removed successfully');
                } catch (error) {
                    console.error('[Core] Error removing backdrop:', error);
                }
                
                debugLog('[Core] About to remove modal');
                try {
                    modal.remove();
                    debugLog('[Core] Modal removed successfully');
                } catch (error) {
                    console.error('[Core] Error removing modal:', error);
                }
                
                debugLog('[Core] ===== DOM REMOVAL COMPLETE =====');
                debugLog('[Core] Document body children count after removal:', document.body.children.length);
            }, 200);
            
            debugLog('[Core] closeModal function execution complete (removal scheduled)');
        };
        
        // Disable backdrop click to close (user must use Cancel or Save buttons)
        backdrop.onclick = (e) => {
            debugLog('[Core] Backdrop clicked - ignoring (use Cancel or Save buttons)');
            // Do nothing - force user to use buttons
        };
        
        // Cancel button - closes modal and syncs model override to interceptor (no page refresh needed)
        cancelBtn.onclick = async (e) => {
            debugLog('[Core] Cancel button clicked');
            e.stopPropagation();
            // Ensure model override is live in the interceptor without requiring a page reload
            const [overrideEnabled, overrideName] = await Promise.all([
                storage.get('modelOverrideEnabled', false),
                storage.get('modelOverrideName', '')
            ]);
            window.postMessage({
                type: 'SAI_SET_MODEL_OVERRIDE',
                model: overrideEnabled && overrideName ? overrideName : null
            }, '*');
            closeModal();
        };
        
        // Clear All Data button - with confirmation dialog
        clearAllBtn.onclick = async (e) => {
            debugLog('[Core] Clear All Data button clicked');
            e.stopPropagation();
            
            // Create confirmation dialog in shadow DOM
            const confirmBackdrop = document.createElement('div');
            confirmBackdrop.className = 'backdrop';
            confirmBackdrop.style.zIndex = '10000005';
            
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal';
            confirmModal.style.zIndex = '10000006';
            confirmModal.style.width = '350px';
            confirmModal.replaceChildren(parseHTMLToFragment(`
                <div class="modal-header">⚠️ Clear All Data?</div>
                <div class="modal-body">
                    <div style="text-align: center; margin-bottom: 1rem;">
                        <p style="margin-bottom: 0.5rem;">This will permanently delete:</p>
                        <ul style="text-align: left; margin: 0; padding-left: 1.5rem;">
                            <li>All settings</li>
                            <li>All generation profiles</li>
                            <li>All message stats</li>
                        </ul>
                        <p style="margin-top: 1rem; color: #ef4444; font-weight: 600;">This action cannot be undone!</p>
                    </div>
                </div>
                <div class="button-row">
                    <button class="btn-cancel" id="confirm-cancel-btn">Cancel</button>
                    <button class="btn-save" id="confirm-clear-btn" style="background: #ef4444;">Clear All Data</button>
                </div>
            `));
            
            shadow.appendChild(confirmBackdrop);
            shadow.appendChild(confirmModal);
            
            const confirmCancelBtn = shadow.querySelector('#confirm-cancel-btn');
            const confirmClearBtn = shadow.querySelector('#confirm-clear-btn');
            
            // Cancel confirmation
            confirmCancelBtn.onclick = (e) => {
                e.stopPropagation();
                confirmBackdrop.remove();
                confirmModal.remove();
            };
            
            // Confirm clear all data
            confirmClearBtn.onclick = async (e) => {
                e.stopPropagation();
                debugLog('[Core] Confirmed - clearing all data');
                
                try {
                    await storage.clear();
                    debugLog('[Core] All data cleared');
                    showNotification('All data cleared! Refreshing...');
                    setTimeout(() => {
                        window.location.reload();
                    }, 500);
                } catch (error) {
                    console.error('[Core] Error clearing data:', error);
                    alert('Error clearing data: ' + error.message);
                }
            };
            
            // Close confirmation on backdrop click
            confirmBackdrop.onclick = (e) => {
                if (e.target === confirmBackdrop) {
                    confirmBackdrop.remove();
                    confirmModal.remove();
                }
            };
        };
        
        // Drive Sync UI
        (async () => {
            let driveBackupFolderUrl = null;

            // ---- keepalive: pin the (Orion/MV2) background page for the duration of ANY
            // Drive RPC. Drive operations (sync, backup list/restore, status) can trigger
            // an interactive Google sign-in tab flow lasting many seconds; without a held
            // port the background page is OS-suspended on WebKit, which silently kills its
            // in-flight IndexedDB connection and later hangs the resync ("Merging data…").
            // Ref-counted so concurrent/nested calls (incl. the retry) share one port and
            // it closes only when the last in-flight call finishes.
            let _driveKeepalivePort = null;
            let _driveKeepaliveRefs = 0;
            let _driveHeartbeatTimer = null;
            const acquireDriveKeepalive = () => {
                _driveKeepaliveRefs++;
                if (!_driveKeepalivePort) {
                    try {
                        _driveKeepalivePort = runtimeAPI.runtime.connect({ name: 'sai-sync-keepalive' });
                        _driveKeepalivePort.onDisconnect.addListener(() => { _driveKeepalivePort = null; });
                    } catch (_) { _driveKeepalivePort = null; }
                }
                // Active heartbeat — the load-bearing keepalive on Orion/iOS. An OPEN port (above) is
                // a Chrome idle-timer mechanism and does NOT stop iOS from OS-suspending the background
                // during a message-silent window (the IndexedDB merge), which freezes its event loop
                // and ALL its watchdog timers — the "Merging data…" stall that only the 60s timer can't
                // break because the timer is frozen too. This content script stays alive in the
                // foreground; a message every ~1s delivers a wake event that keeps the background
                // scheduled so the merge runs to completion. Errors (bg briefly between wakes) are
                // ignored — the next tick retries.
                if (!_driveHeartbeatTimer) {
                    _driveHeartbeatTimer = setInterval(() => {
                        try {
                            runtimeAPI.runtime.sendMessage({ type: 'SAI_KEEPALIVE_PING' }, () => { void runtimeAPI.runtime.lastError; });
                        } catch (_) {}
                    }, 500);
                }
            };
            const releaseDriveKeepalive = () => {
                _driveKeepaliveRefs = Math.max(0, _driveKeepaliveRefs - 1);
                if (_driveKeepaliveRefs === 0) {
                    if (_driveKeepalivePort) {
                        try { _driveKeepalivePort.disconnect(); } catch (_) {}
                        _driveKeepalivePort = null;
                    }
                    if (_driveHeartbeatTimer) {
                        clearInterval(_driveHeartbeatTimer);
                        _driveHeartbeatTimer = null;
                    }
                }
            };

            // ---- shared Drive message helper ----
            // Retries once on "Receiving end does not exist" — Chrome MV3 SW may not be ready on first modal open.
            // Holds a keepalive port for each call so an interactive auth tab flow can't be suspended mid-flight.
            //
            // An EMPTY reply (undefined, no lastError) means the background page never answered:
            // every Drive handler responds with an object. Orion on iOS unloads the background
            // page when the app is backgrounded and does not always bring it back for the next
            // message. The keepalive port + 500ms heartbeat held by this call keep nudging it,
            // so wait and resend a few times before giving up with a message that says what
            // is actually wrong (instead of a generic "Sync failed").
            const BACKGROUND_WAKE_DELAYS_MS = [800, 1500, 2500];
            const BACKGROUND_UNRESPONSIVE_MSG = isOrionOnIOS()
                ? 'Orion has shut down the extension\'s background page, so Drive can\'t be reached. ' +
                  'This is a bug in the Orion app. Force-quit Orion (swipe it away in the app switcher), open it again, then retry.'
                : 'The extension\'s background page isn\'t responding, so Drive can\'t be reached. ' +
                  'Turn the S.AI Toolkit extension off and on again in your browser\'s extension settings, then retry.';
            const sendDriveMessage = (type, payload, _retries = 1, _wakeAttempt = 0) => {
                acquireDriveKeepalive();
                return new Promise((resolve, reject) => {
                    runtimeAPI.runtime.sendMessage({ type, ...payload }, (res) => {
                        const err = runtimeAPI.runtime.lastError;
                        if (err) {
                            const noReceiver = !!err.message && /Could not establish connection|Receiving end does not exist/i.test(err.message);
                            if (_retries > 0 && noReceiver) {
                                setTimeout(() => sendDriveMessage(type, payload, _retries - 1, _wakeAttempt).then(resolve).catch(reject), 300);
                            } else if (noReceiver && _wakeAttempt < BACKGROUND_WAKE_DELAYS_MS.length) {
                                // Chrome-style builds report a dead background this way (instead of an empty reply)
                                debugLog('[Sync] No receiver for', type, '— background not responding, retry', _wakeAttempt + 1, 'of', BACKGROUND_WAKE_DELAYS_MS.length);
                                setTimeout(() => sendDriveMessage(type, payload, 0, _wakeAttempt + 1).then(resolve).catch(reject),
                                    BACKGROUND_WAKE_DELAYS_MS[_wakeAttempt]);
                            } else if (noReceiver) {
                                const e = new Error(BACKGROUND_UNRESPONSIVE_MSG);
                                e.backgroundUnresponsive = true;
                                reject(e);
                            } else {
                                reject(new Error(err.message));
                            }
                        } else if (res === undefined) {
                            if (_wakeAttempt < BACKGROUND_WAKE_DELAYS_MS.length) {
                                debugLog('[Sync] Empty reply to', type, '— background not responding, retry', _wakeAttempt + 1, 'of', BACKGROUND_WAKE_DELAYS_MS.length);
                                reviveBackground(true);   // probe + fresh port while we wait
                                setTimeout(() => sendDriveMessage(type, payload, _retries, _wakeAttempt + 1).then(resolve).catch(reject),
                                    BACKGROUND_WAKE_DELAYS_MS[_wakeAttempt]);
                            } else {
                                debugLog('[Sync] Background still not responding to', type, '— giving up');
                                const e = new Error(BACKGROUND_UNRESPONSIVE_MSG);
                                e.backgroundUnresponsive = true;
                                reject(e);
                            }
                        } else {
                            resolve(res);
                        }
                    });
                }).finally(() => releaseDriveKeepalive());
            };

            // ---- status display ----
            const updateDriveStatus = async () => {
                const { driveLastSync, driveFileId } = await storage.getMultiple(['driveLastSync', 'driveFileId']);
                if (driveLastSync) {
                    driveSyncStatus.textContent = `Last synced: ${new Date(driveLastSync).toLocaleString()}`;
                    driveSyncStatus.style.color = '#10b981';
                    driveDisconnectBtn.style.display = '';
                } else if (driveFileId) {
                    driveSyncStatus.textContent = 'Connected — not yet synced this session.';
                    driveSyncStatus.style.color = '#9ca3af';
                    driveDisconnectBtn.style.display = '';
                } else {
                    driveSyncStatus.textContent = 'Not connected to Google Drive.';
                    driveSyncStatus.style.color = '#9ca3af';
                    driveDisconnectBtn.style.display = 'none';
                }
                const isConnected = !!(driveLastSync || driveFileId);
                driveReconnectBtn.style.display = 'none';
                driveBackupSection.style.display = isConnected ? '' : 'none';
                if (!isConnected) return;

                // Verify the Google sign-in in the background (not awaited: this
                // is a network round-trip and must not delay wiring the buttons).
                // Only load backups once auth is known-good — listing with a dead
                // token would otherwise pop an unexpected sign-in sheet.
                const localStatusText = driveSyncStatus.textContent;
                sendDriveMessage('SAI_DRIVE_AUTH_STATUS').then((status) => {
                    debugLog('[Sync] Auth status:', status);
                    if (status && status.state === 'expired') {
                        showDriveAuthExpired();
                    } else {
                        if (status && status.state === 'ok' && status.email &&
                            driveSyncStatus.textContent === localStatusText) {
                            driveSyncStatus.textContent = `${localStatusText} (${status.email})`;
                        }
                        loadDriveBackupList();
                    }
                }).catch((err) => {
                    if (err && err.backgroundUnresponsive) {
                        // Nothing Drive-related can work right now — say so once here
                        // instead of also failing the backup list.
                        driveSyncStatus.textContent = err.message;
                        driveSyncStatus.style.color = '#dc2626';
                        driveBackupSection.style.display = 'none';
                    } else {
                        loadDriveBackupList();
                    }
                });
            };

            // Dead sign-in: say so plainly and offer the one-tap fix.
            const showDriveAuthExpired = () => {
                driveSyncStatus.textContent = 'Google sign-in expired — tap Reconnect Google.';
                driveSyncStatus.style.color = '#dc2626';
                driveReconnectBtn.style.display = '';
                driveBackupSection.style.display = 'none';
            };
            const isAuthErrorMessage = (msg) =>
                /sign-in has expired|sign in again|access was denied|AUTH_EXPIRED|sign-in required/i.test(msg || '');

            // ---- backup list renderer ----
            const loadDriveBackupList = async () => {
                driveBackupList.replaceChildren();
                const loading = document.createElement('div');
                loading.className = 'drive-backup-loading';
                loading.textContent = 'Loading backups…';
                driveBackupList.appendChild(loading);
                try {
                    const res = await sendDriveMessage('SAI_DRIVE_LIST_BACKUPS');
                    driveBackupList.replaceChildren();
                    if (!res || !res.success) {
                        const errEl = document.createElement('div');
                        errEl.className = 'drive-backup-empty';
                        errEl.textContent = (res && res.error) || 'Failed to load backups.';
                        driveBackupList.appendChild(errEl);
                        return;
                    }
                    if (res.folderId) driveBackupFolderUrl = `https://drive.google.com/drive/folders/${res.folderId}`;
                    if (!res.backups || res.backups.length === 0) {
                        const empty = document.createElement('div');
                        empty.className = 'drive-backup-empty';
                        empty.textContent = 'No backups yet.';
                        driveBackupList.appendChild(empty);
                        return;
                    }
                    for (const backup of res.backups) {
                        const item = document.createElement('div');
                        item.className = 'drive-backup-item';
                        const dateEl = document.createElement('div');
                        dateEl.className = 'drive-backup-item-date';
                        dateEl.textContent = new Date(backup.createdTime).toLocaleString();
                        const btns = document.createElement('div');
                        btns.className = 'drive-backup-item-btns';
                        const restoreBtn = document.createElement('button');
                        restoreBtn.className = 'btn-data';
                        restoreBtn.style.cssText = 'padding:0.15rem 0.45rem;font-size:11px;';
                        restoreBtn.textContent = 'Restore';
                        restoreBtn.onclick = async (ev) => {
                            ev.stopPropagation();
                            if (!confirm(`Restore from this backup?\n\n${dateEl.textContent}\n\nSettings will be overwritten and stats merged with current data. The page will reload.`)) return;
                            restoreBtn.disabled = true;
                            restoreBtn.textContent = 'Restoring…';
                            try {
                                // Download HERE, not in the background page: a ~20 MB
                                // fetch there freezes WebKit/iOS's event loop, and the
                                // old path also pushed the whole file back through
                                // sendResponse. Background only supplies a token.
                                const downloadOnce = async (tokenRejected) => {
                                    const target = await sendDriveMessage('SAI_DRIVE_BACKUP_TARGET', { tokenOnly: true, tokenRejected });
                                    if (!target || !target.success) throw new Error((target && target.error) || 'Could not reach Google Drive.');
                                    const t0 = Date.now();
                                    const tick = setInterval(() => {
                                        restoreBtn.textContent = `Downloading… ${Math.round((Date.now() - t0) / 1000)}s`;
                                    }, 1000);
                                    const ctrl = new AbortController();
                                    const timeout = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
                                    try {
                                        const res = await fetch(
                                            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(backup.id)}?alt=media`,
                                            { headers: { Authorization: `Bearer ${target.token}` }, signal: ctrl.signal }
                                        );
                                        if (res.status === 401) return { authRejected: true };
                                        if (!res.ok) throw new Error(`Drive backup download failed (HTTP ${res.status}).`);
                                        const buffer = await res.arrayBuffer();
                                        restoreBtn.textContent = `Parsing ${(buffer.byteLength / 1048576).toFixed(1)} MB…`;
                                        const data = JSON.parse(new TextDecoder().decode(buffer));
                                        debugLog('[Sync] Backup downloaded:', buffer.byteLength, 'bytes in', Date.now() - t0, 'ms');
                                        return { data };
                                    } catch (err) {
                                        if (err.name === 'AbortError') throw new Error('Backup download timed out after 5 minutes — check your connection and try again.');
                                        throw err;
                                    } finally {
                                        clearInterval(tick);
                                        clearTimeout(timeout);
                                    }
                                };

                                restoreBtn.textContent = 'Downloading…';
                                let outcome = await downloadOnce(false);
                                if (outcome.authRejected) outcome = await downloadOnce(true);
                                if (outcome.authRejected) {
                                    showDriveAuthExpired();
                                    throw new Error('Google rejected the sign-in — tap Reconnect Google.');
                                }
                                restoreBtn.textContent = 'Applying…';
                                await applyImportedData(outcome.data);
                            } catch (err) {
                                alert(err.message || 'Restore failed.');
                                restoreBtn.disabled = false;
                                restoreBtn.textContent = 'Restore';
                            }
                        };
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'btn-data';
                        deleteBtn.style.cssText = 'padding:0.15rem 0.45rem;font-size:11px;color:#dc2626;border-color:#dc2626;';
                        deleteBtn.textContent = 'Delete';
                        deleteBtn.onclick = async (ev) => {
                            ev.stopPropagation();
                            if (!confirm(`Delete this backup?\n\n${dateEl.textContent}\n\nThis cannot be undone.`)) return;
                            deleteBtn.disabled = true;
                            deleteBtn.textContent = 'Deleting…';
                            try {
                                const delRes = await sendDriveMessage('SAI_DRIVE_DELETE_BACKUP', { fileId: backup.id });
                                if (!delRes || !delRes.success) {
                                    alert((delRes && delRes.error) || 'Delete failed.');
                                    deleteBtn.disabled = false;
                                    deleteBtn.textContent = 'Delete';
                                    return;
                                }
                                item.remove();
                                if (!driveBackupList.children.length) {
                                    const empty = document.createElement('div');
                                    empty.className = 'drive-backup-empty';
                                    empty.textContent = 'No backups yet.';
                                    driveBackupList.appendChild(empty);
                                }
                            } catch (err) {
                                alert(err.message || 'Delete failed.');
                                deleteBtn.disabled = false;
                                deleteBtn.textContent = 'Delete';
                            }
                        };
                        btns.appendChild(restoreBtn);
                        btns.appendChild(deleteBtn);
                        item.appendChild(dateEl);
                        item.appendChild(btns);
                        driveBackupList.appendChild(item);
                    }
                } catch (err) {
                    driveBackupList.replaceChildren();
                    const errEl = document.createElement('div');
                    errEl.className = 'drive-backup-empty';
                    errEl.textContent = err.message || 'Failed to load backups.';
                    driveBackupList.appendChild(errEl);
                }
            };

            // ---- apply imported/restored data (mirrors importAllBtn logic) ----
            const applyImportedData = async (imported) => {
                // Un-nest v2 grouped backups (settings/style/stats) so the flat-key reads
                // below resolve. v1/flat payloads pass through unchanged.
                imported = normalizeImportPayload(imported);
                const showProgress = (statusText, pct) => {
                    let overlay = shadow.getElementById('import-progress-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'import-progress-overlay';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                        const card = document.createElement('div');
                        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:280px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                        const titleEl = document.createElement('div');
                        titleEl.textContent = 'Restoring…';
                        titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                        const statusEl = document.createElement('div');
                        statusEl.id = 'import-progress-status';
                        statusEl.style.cssText = 'color:#9ca3af;font-size:12px;min-height:1.2em;';
                        const track = document.createElement('div');
                        track.style.cssText = 'height:4px;background:#374151;border-radius:2px;overflow:hidden;';
                        const fill = document.createElement('div');
                        fill.id = 'import-progress-fill';
                        fill.style.cssText = 'height:100%;background:#3b82f6;border-radius:2px;transition:width 0.2s ease;width:0%;';
                        track.appendChild(fill);
                        card.appendChild(titleEl); card.appendChild(statusEl); card.appendChild(track);
                        overlay.appendChild(card);
                        shadow.appendChild(overlay);
                    }
                    shadow.getElementById('import-progress-status').textContent = statusText;
                    shadow.getElementById('import-progress-fill').style.width = pct + '%';
                };

                let generationProfilesValue = imported.generationProfiles;
                let messageGenerationStatsValue = imported.messageGenerationStats;
                if (typeof generationProfilesValue === 'object' && generationProfilesValue !== null) {
                    generationProfilesValue = JSON.stringify(generationProfilesValue);
                }
                if (typeof messageGenerationStatsValue === 'object' && messageGenerationStatsValue !== null) {
                    messageGenerationStatsValue = JSON.stringify(messageGenerationStatsValue);
                }

                const updates = {};
                if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
                if (imported.sidebarMinWidth !== undefined) updates.sidebarMinWidth = imported.sidebarMinWidth;
                // Retired Custom Style data (enableCustomStyle/customStyleValues) in a backup
                // is deliberately NOT restored. For a pre-1.3.1 backup, only the settings
                // that survived (bubble BGs, button hover, background image) are derived
                // from it, the same way the load-time migration does.
                if (imported.styleOverrides !== undefined) {
                    updates[STYLE_OVERRIDES_KEY] = JSON.stringify(normalizeStyleOverrides(imported.styleOverrides));
                } else if (imported.customStyleValues !== undefined) {
                    updates[STYLE_OVERRIDES_KEY] = JSON.stringify(deriveStyleOverridesFromLegacy(imported.enableCustomStyle === true, imported.customStyleValues));
                }
                if (imported.enableCompactGeneration !== undefined) updates.enableCompactGeneration = imported.enableCompactGeneration;
                if (imported.enableHideForYou !== undefined) updates.enableHideForYou = imported.enableHideForYou;
                if (imported.enablePageJump !== undefined) updates.enablePageJump = imported.enablePageJump;
                if (imported.showGenerationStats !== undefined) updates.showGenerationStats = imported.showGenerationStats;
                if (imported.showModelDetails !== undefined) updates.showModelDetails = imported.showModelDetails;
                if (imported.compactStats !== undefined) updates.compactStats = imported.compactStats;
                if (imported.showTimestamp !== undefined) updates.showTimestamp = imported.showTimestamp;
                if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                if (imported.timestamp24Hour !== undefined) updates.timestamp24Hour = imported.timestamp24Hour;
                if (imported.showMessageIds !== undefined) updates.showMessageIds = imported.showMessageIds;
                if (imported.showChatNameInTitle !== undefined) updates.showChatNameInTitle = imported.showChatNameInTitle;
                if (imported.nsfwToggleEnabled !== undefined) updates.nsfwToggleEnabled = imported.nsfwToggleEnabled;
                if (imported.messageRecoveryEnabled !== undefined) updates.messageRecoveryEnabled = imported.messageRecoveryEnabled;
                if (imported.enableGenerationProfiles !== undefined) updates.enableGenerationProfiles = imported.enableGenerationProfiles;
                if (imported.enableRoundedProfileImages !== undefined) updates.enableRoundedProfileImages = imported.enableRoundedProfileImages;
                if (imported.swapCheckboxPosition !== undefined) updates.swapCheckboxPosition = imported.swapCheckboxPosition;
                if (imported.squareMessageEdges !== undefined) updates.squareMessageEdges = imported.squareMessageEdges;
                if (imported.highlightModelChanges !== undefined) updates.highlightModelChanges = imported.highlightModelChanges;
                if (imported.autoRegenOnMismatch !== undefined) updates.autoRegenOnMismatch = imported.autoRegenOnMismatch;
                if (imported.autoRegenOnShort !== undefined) updates.autoRegenOnShort = imported.autoRegenOnShort;
                if (imported.autoRegenMaxAttempts !== undefined) updates.autoRegenMaxAttempts = imported.autoRegenMaxAttempts;
                if (imported.memoryDotEnabled !== undefined) updates[MEMORY_DOT_ENABLED_KEY] = imported.memoryDotEnabled;
                if (imported.memoryDotColor !== undefined) updates[MEMORY_DOT_COLOR_KEY] = imported.memoryDotColor;
                if (imported.hideCreatorName !== undefined) updates[HIDE_CREATOR_KEY] = imported.hideCreatorName;
                if (generationProfilesValue !== undefined) updates.generationProfiles = generationProfilesValue;
                if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;

                const removeProgress = () => {
                    const ov = shadow.getElementById('import-progress-overlay');
                    if (ov) ov.remove();
                };

                try {
                    showProgress('Restoring settings…', 20);
                    await new Promise(r => setTimeout(r, 0));

                    if (messageGenerationStatsValue !== undefined) {
                        const importedStats = JSON.parse(messageGenerationStatsValue);
                        const botCount = Object.keys(importedStats).length;
                        showProgress(`Merging stats (${botCount} bots)…`, 45);
                        await new Promise(r => setTimeout(r, 0));
                        // Stats live in the background IndexedDB store — merge there (authoritative,
                        // collapses conversation level, never overwrites richer entries). Not written
                        // to storage.local, so keep it out of `updates`. (Page reloads after restore,
                        // so the content-side cache refreshes naturally.) Fail loudly if the merge
                        // failed — never reload as if a failed stats restore succeeded.
                        const mergeRes = await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: importedStats });
                        if (!mergeRes || !mergeRes.success) {
                            throw new Error('Stats merge failed: ' + ((mergeRes && mergeRes.error) || 'unknown error'));
                        }
                    }

                    showProgress('Saving…', 75);
                    await new Promise(r => setTimeout(r, 0));
                    await storage.setMultiple(updates);
                    showProgress('Done! Reloading…', 100);
                    await new Promise(r => setTimeout(r, 0));
                    setTimeout(() => { window.location.reload(); }, 800);
                } catch (err) {
                    removeProgress();
                    alert('Restore failed: ' + (err.message || 'Unknown error'));
                    throw err;
                }
            };

            // ---- pre-connect confirmation prompt ----
            const showPreConnectPrompt = () => new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                const card = document.createElement('div');
                card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:300px;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                const titleEl = document.createElement('div');
                titleEl.textContent = 'Connect Google Drive';
                titleEl.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                // What & why
                const explainEl = document.createElement('div');
                explainEl.textContent = 'Back up your settings and generation stats to your own Google Drive and sync them across devices.';
                explainEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;';
                // Scope reassurance (highlighted) — the single biggest trust concern
                const scopeEl = document.createElement('div');
                scopeEl.textContent = 'S.AI Toolkit can only see the one file it creates (sai-toolkit-sync.json) — never the rest of your Drive.';
                scopeEl.style.cssText = 'color:#bfdbfe;font-size:12px;line-height:1.5;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.35);border-radius:6px;padding:0.5rem 0.6rem;';
                // Expectation-setting for Google's own consent screen
                const expectEl = document.createElement('div');
                expectEl.textContent = 'Google will show its own sign-in screen next. While our app review is pending it may show the developer’s web address instead of “S.AI Toolkit” and note the app isn’t verified — that’s normal for new apps.';
                expectEl.style.cssText = 'color:#9ca3af;font-size:11px;line-height:1.5;';
                const descEl = document.createElement('div');
                descEl.textContent = 'First time connecting — would you like to download a local backup of your data before syncing?';
                descEl.style.cssText = 'color:#9ca3af;font-size:12px;line-height:1.5;margin-top:0.25rem;';
                const btns = document.createElement('div');
                btns.style.cssText = 'display:flex;flex-direction:column;gap:0.4rem;margin-top:0.25rem;';
                const downloadBtn = document.createElement('button');
                downloadBtn.textContent = 'Download Local Backup First';
                downloadBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #3b82f6;background:#1d4ed8;color:#fff;font-size:12px;cursor:pointer;';
                const skipBtn = document.createElement('button');
                skipBtn.textContent = 'Connect Without Backup';
                skipBtn.style.cssText = 'padding:0.5rem 1rem;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#9ca3af;font-size:12px;cursor:pointer;';
                const cancelEl = document.createElement('button');
                cancelEl.textContent = 'Cancel';
                cancelEl.style.cssText = 'padding:0.25rem;border:none;background:transparent;color:#6b7280;font-size:11px;cursor:pointer;text-align:center;';
                downloadBtn.onclick = () => { overlay.remove(); resolve('download'); };
                skipBtn.onclick = () => { overlay.remove(); resolve('connect'); };
                cancelEl.onclick = () => { overlay.remove(); resolve('cancel'); };
                btns.appendChild(downloadBtn);
                btns.appendChild(skipBtn);
                btns.appendChild(cancelEl);
                card.appendChild(titleEl);
                card.appendChild(explainEl);
                card.appendChild(scopeEl);
                card.appendChild(expectEl);
                card.appendChild(descEl);
                card.appendChild(btns);
                overlay.appendChild(card);
                shadow.appendChild(overlay);
            });

            // ---- init: load sync scope and auto-sync preferences ----
            const savedPrefs = await storage.getMultiple({
                driveSyncStats: true,
                driveSyncSettings: false,
                driveSyncStyle: true,
                driveAutoSync: false,
                driveAutoSyncInterval: 10
            });
            syncStatsToggle.checked    = !!savedPrefs.driveSyncStats;
            syncSettingsToggle.checked = !!savedPrefs.driveSyncSettings;
            syncStyleToggle.checked    = !!savedPrefs.driveSyncStyle;
            autoSyncToggle.checked     = !!savedPrefs.driveAutoSync;
            autoSyncIntervalSelect.value = String(savedPrefs.driveAutoSyncInterval || 10);
            autoSyncIntervalSelect.style.display = savedPrefs.driveAutoSync ? '' : 'none';

            const persistSyncPrefs = () => storage.setMultiple({
                driveSyncStats:    syncStatsToggle.checked,
                driveSyncSettings: syncSettingsToggle.checked,
                driveSyncStyle:    syncStyleToggle.checked
            });

            const applyAutoSyncPref = async () => {
                const enabled = autoSyncToggle.checked;
                const intervalMinutes = parseInt(autoSyncIntervalSelect.value, 10);
                autoSyncIntervalSelect.style.display = enabled ? '' : 'none';
                await storage.setMultiple({ driveAutoSync: enabled, driveAutoSyncInterval: intervalMinutes });
                await sendDriveMessage('SAI_DRIVE_SET_AUTO_SYNC', { enabled, intervalMinutes });
            };
            autoSyncToggle.onchange         = applyAutoSyncPref;
            autoSyncIntervalSelect.onchange = applyAutoSyncPref;
            syncStatsToggle.onchange    = persistSyncPrefs;
            syncSettingsToggle.onchange = persistSyncPrefs;
            syncStyleToggle.onchange    = persistSyncPrefs;

            await updateDriveStatus();

            // ---- event handlers ----
            const syncProgressSection = shadow.querySelector('#sync-progress-section');
            const syncProgressText    = shadow.querySelector('#sync-progress-text');
            const syncProgressBar     = shadow.querySelector('#sync-progress-bar');

            const showSyncProgress = (msg) => {
                debugLog(`[Sync] Progress update in UI: [${msg.stepNum}/${msg.totalSteps}] ${msg.step}`);
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) syncProgressText.textContent = msg.step + (msg.detail ? ` — ${msg.detail}` : '');
                if (syncProgressBar) syncProgressBar.style.width = `${Math.round((msg.stepNum / msg.totalSteps) * 100)}%`;
            };

            const hideSyncProgress = (delayMs = 1500) => {
                if (syncProgressBar) syncProgressBar.style.width = '100%';
                setTimeout(() => {
                    if (syncProgressSection) syncProgressSection.style.display = 'none';
                    if (syncProgressBar) { syncProgressBar.style.background = '#6366f1'; syncProgressBar.style.width = '0%'; }
                    if (syncProgressText) { syncProgressText.textContent = ''; syncProgressText.style.color = '#9ca3af'; }
                }, delayMs);
            };

            const showSyncError = (msg) => {
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) { syncProgressText.textContent = msg; syncProgressText.style.color = '#ef4444'; }
                if (syncProgressBar) { syncProgressBar.style.background = '#ef4444'; syncProgressBar.style.width = '100%'; }
                setTimeout(() => {
                    if (syncProgressSection) syncProgressSection.style.display = 'none';
                    if (syncProgressBar) { syncProgressBar.style.background = '#6366f1'; syncProgressBar.style.width = '0%'; }
                    if (syncProgressText) { syncProgressText.textContent = ''; syncProgressText.style.color = '#9ca3af'; }
                }, 4000);
            };

            driveSyncBtn.onclick = async (e) => {
                e.stopPropagation();
                const { driveFileId, driveLastSync } = await storage.getMultiple(['driveFileId', 'driveLastSync']);
                debugLog('[Sync] Sync Now clicked — driveFileId:', driveFileId, 'driveLastSync:', driveLastSync);
                if (!driveFileId && !driveLastSync) {
                    const choice = await showPreConnectPrompt();
                    if (choice === 'cancel') return;
                    if (choice === 'download') {
                        exportAllBtn.click();
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                driveSyncBtn.disabled = true;
                driveSyncBtn.textContent = 'Syncing…';
                driveSyncStatus.textContent = '';
                driveSyncStatus.style.color = '#9ca3af';
                // Show progress bar and wire up progress callback
                if (syncProgressSection) syncProgressSection.style.display = '';
                if (syncProgressText) syncProgressText.textContent = 'Starting…';
                if (syncProgressBar) syncProgressBar.style.width = '0%';
                syncProgressCallback = showSyncProgress;
                const syncStats    = syncStatsToggle.checked;
                const syncSettings = syncSettingsToggle.checked;
                const syncStyle    = syncStyleToggle.checked;
                debugLog('[Sync] Sending SAI_DRIVE_SYNC — syncStats:', syncStats, 'syncSettings:', syncSettings, 'syncStyle:', syncStyle);
                // Note: sendDriveMessage now holds the background-keepalive port for the
                // duration of every Drive RPC (including the auth tab flow), so no separate
                // sync-scoped keepalive is needed here.
                let _alreadyRunning = false;
                try {
                    await flushHeldStats();   // sync reads the background store; deliver parked stats first
                    const result = await sendDriveMessage('SAI_DRIVE_SYNC', {
                        syncStats, syncSettings, syncStyle
                    });
                    debugLog('[Sync] SAI_DRIVE_SYNC result:', result);
                    if (result && result.success) {
                        if (result.syncedSettings) {
                            hideSyncProgress(0);
                            driveSyncBtn.textContent = 'Synced! Reloading…';
                            window.location.reload();
                            return;
                        }
                        hideSyncProgress();
                        await updateDriveStatus();
                    } else if (result && result.alreadyRunning) {
                        // Sync is already running from a previous click — don't show a red error.
                        // Keep the progress callback live so the running sync's updates show.
                        _alreadyRunning = true;
                        syncProgressCallback = showSyncProgress;
                        if (syncProgressSection) syncProgressSection.style.display = '';
                        if (syncProgressText) { syncProgressText.textContent = 'Sync in progress — please wait…'; syncProgressText.style.color = '#9ca3af'; }
                        driveSyncStatus.textContent = 'Sync already in progress…';
                        driveSyncStatus.style.color = '#9ca3af';
                        debugLog('[Sync] Already running — reattached progress callback');
                    } else {
                        const errMsg = (result && result.error) || 'Sync failed — please try again.';
                        showSyncError(errMsg);
                        driveSyncStatus.textContent = errMsg;
                        driveSyncStatus.style.color = '#dc2626';
                        if (isAuthErrorMessage(errMsg) || errMsg === 'auth_silent_fail') showDriveAuthExpired();
                        debugLog('[Sync] Sync failed with error:', errMsg);
                    }
                } catch (err) {
                    const errMsg = err.message || 'Sync failed — please try again.';
                    showSyncError(errMsg);
                    driveSyncStatus.textContent = errMsg;
                    driveSyncStatus.style.color = '#dc2626';
                    debugLog('[Sync] Sync threw exception:', err.message);
                } finally {
                    if (!_alreadyRunning) syncProgressCallback = null;
                }
                driveSyncBtn.disabled = false;
                driveSyncBtn.textContent = 'Sync Now';
            };

            driveCreateBackupBtn.onclick = async (e) => {
                e.stopPropagation();
                driveCreateBackupBtn.disabled = true;
                driveCreateBackupBtn.textContent = 'Creating…';
                driveBackupStatus.textContent = '';
                const setBackupStatus = (text) => {
                    driveBackupStatus.textContent = text;
                    driveBackupStatus.style.color = '#9ca3af';
                };
                try {
                    setBackupStatus('Reading settings…');
                    const rawStorage = await sendDriveMessage('getSettings');
                    const exportData = { ...rawStorage };
                    if (typeof exportData.generationProfiles === 'string') {
                        try { exportData.generationProfiles = JSON.parse(exportData.generationProfiles); } catch (_) {}
                    }
                    // Stats now live in the background IndexedDB store, NOT storage.local.
                    // Pull the authoritative nested snapshot from the DB (getSettings only
                    // carries the frozen legacy blob, which would be stale/empty). If the DB
                    // read fails, ABORT the backup — never ship a silently empty-stats file.
                    setBackupStatus('Reading stats database…');
                    await flushHeldStats();   // include stats parked while the background was down
                    const statsRes = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
                    if (!statsRes || !statsRes.success) {
                        throw new Error('Could not read stats from the database — backup aborted to avoid an incomplete file.');
                    }
                    exportData.messageGenerationStats = statsRes.stats || {};
                    delete exportData.driveAccessToken;
                    delete exportData.driveRefreshToken;
                    delete exportData.driveTokenExpiry;
                    delete exportData.driveFileId;
                    delete exportData.driveLastSync;
                    delete exportData.driveBackupFolderId;
                    delete exportData.driveSyncStats;
                    delete exportData.driveSyncSettings;
                    delete exportData.driveSyncStyle;
                    delete exportData.driveAutoSync;
                    delete exportData.driveAutoSyncInterval;
                    // Retired Custom Style data never goes into new backups
                    delete exportData.enableCustomStyle;
                    delete exportData.customStyleValues;
                    delete exportData.styleOverridesMigration;   // per-device migration marker
                    delete exportData.bridgeToken;               // per-device secret for the debug bridge
                    delete exportData.experimentalBridge;
                    delete exportData.pendingStatsRecords;   // internal holding list, already flushed above

                    // Upload from HERE, not the background page. A ~20 MB body sent
                    // from the WebKit/iOS background page freezes its event loop
                    // (the same reason sync's writeDriveFile delegates to us) - that
                    // was the silent "Creating…" hang. The background only hands
                    // us a token + folder; the 20 MB never crosses runtime messaging.
                    setBackupStatus('Preparing upload…');
                    const body = JSON.stringify(exportData);
                    const sizeMB = (body.length / 1048576).toFixed(1);

                    const uploadOnce = async (tokenRejected) => {
                        const target = await sendDriveMessage('SAI_DRIVE_BACKUP_TARGET', { tokenRejected });
                        if (!target || !target.success) throw new Error((target && target.error) || 'Could not reach Google Drive.');
                        const boundary = 'sai_toolkit_backup_boundary';
                        const metadata = JSON.stringify({ name: target.fileName, mimeType: 'application/json', parents: [target.folderId] });
                        const multipart = [
                            `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', metadata,
                            `--${boundary}`, 'Content-Type: application/json', '', body,
                            `--${boundary}--`
                        ].join('\r\n');

                        // Visible progress: fetch() has no upload progress events,
                        // so show elapsed time so it never looks frozen.
                        const t0 = Date.now();
                        const tick = setInterval(() => {
                            setBackupStatus(`Uploading ${sizeMB} MB… ${Math.round((Date.now() - t0) / 1000)}s`);
                        }, 1000);
                        setBackupStatus(`Uploading ${sizeMB} MB…`);
                        const ctrl = new AbortController();
                        const timeout = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
                        try {
                            const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
                                body: multipart,
                                signal: ctrl.signal,
                            });
                            if (res.status === 401) return { authRejected: true };
                            if (!res.ok) throw new Error(`Drive backup upload failed (HTTP ${res.status}).`);
                            const created = await res.json().catch(() => ({}));
                            debugLog('[Sync] Backup created:', created.name, '→', created.id, 'in', Date.now() - t0, 'ms');
                            return { created };
                        } catch (err) {
                            if (err.name === 'AbortError') throw new Error('Backup upload timed out after 5 minutes — check your connection and try again.');
                            throw err;
                        } finally {
                            clearInterval(tick);
                            clearTimeout(timeout);
                        }
                    };

                    let outcome = await uploadOnce(false);
                    if (outcome.authRejected) {
                        // Token died between issue and use - have the background
                        // drop it and mint/prompt for a fresh one, then retry once.
                        setBackupStatus('Refreshing Google sign-in…');
                        outcome = await uploadOnce(true);
                    }
                    if (outcome.authRejected) {
                        showDriveAuthExpired();
                        throw new Error('Google rejected the sign-in — tap Reconnect Google.');
                    }

                    driveBackupStatus.textContent = 'Backup created.';
                    driveBackupStatus.style.color = '#10b981';
                    await loadDriveBackupList();
                } catch (err) {
                    driveBackupStatus.textContent = err.message || 'Backup failed.';
                    driveBackupStatus.style.color = '#dc2626';
                }
                driveCreateBackupBtn.disabled = false;
                driveCreateBackupBtn.textContent = 'Create Backup';
            };

            driveOpenFolderBtn.onclick = (e) => {
                e.stopPropagation();
                if (driveBackupFolderUrl) {
                    window.open(driveBackupFolderUrl, '_blank');
                } else {
                    driveBackupStatus.textContent = 'Folder URL not available — try reloading the backup list.';
                    driveBackupStatus.style.color = '#dc2626';
                }
            };

            driveReconnectBtn.onclick = async (e) => {
                e.stopPropagation();
                driveReconnectBtn.disabled = true;
                driveReconnectBtn.textContent = 'Opening Google…';
                driveSyncStatus.textContent = 'Waiting for Google sign-in…';
                driveSyncStatus.style.color = '#9ca3af';
                try {
                    const res = await sendDriveMessage('SAI_DRIVE_RECONNECT');
                    if (res && res.success) {
                        await updateDriveStatus();
                        driveSyncStatus.textContent = `Reconnected${res.email ? ` as ${res.email}` : ''}. Tap Sync Now to catch up.`;
                        driveSyncStatus.style.color = '#10b981';
                    } else {
                        driveSyncStatus.textContent = (res && res.error) || 'Reconnect failed — please try again.';
                        driveSyncStatus.style.color = '#dc2626';
                        driveReconnectBtn.style.display = '';
                    }
                } catch (err) {
                    driveSyncStatus.textContent = err.message || 'Reconnect failed — please try again.';
                    driveSyncStatus.style.color = '#dc2626';
                    driveReconnectBtn.style.display = '';
                }
                driveReconnectBtn.disabled = false;
                driveReconnectBtn.textContent = 'Reconnect Google';
            };

            driveDisconnectBtn.onclick = async (e) => {
                e.stopPropagation();
                // Revoke at Google first (needs the tokens we're about to delete).
                try { await sendDriveMessage('SAI_DRIVE_REVOKE'); } catch (_) {}
                await storage.remove(['driveAccessToken', 'driveRefreshToken', 'driveTokenExpiry', 'driveFileId', 'driveLastSync', 'driveBackupFolderId']);
                driveBackupFolderUrl = null;
                // Disable auto-sync and clear the alarm
                autoSyncToggle.checked = false;
                autoSyncIntervalSelect.style.display = 'none';
                await storage.setMultiple({ driveAutoSync: false });
                await sendDriveMessage('SAI_DRIVE_SET_AUTO_SYNC', { enabled: false });
                await updateDriveStatus();
            };
        })();

        // Save & Refresh button
        saveBtn.onclick = async (e) => {
            debugLog('[Core] Save & Refresh button clicked');
            e.stopPropagation();
            
            // Handle sidebar min width - revert to default if empty/invalid
            const minWidthInputValue = parseInt(sidebarMinWidthInput.value, 10);
            const finalMinWidth = (!isNaN(minWidthInputValue) && minWidthInputValue >= 600 && minWidthInputValue <= 2000) 
                ? minWidthInputValue 
                : DEFAULT_SIDEBAR_MIN_WIDTH;
            
            // Read current checkbox states
            sidebarEnabled = sidebarCheckbox.checked;
            compactGenerationEnabled = compactGenerationCheckbox.checked;
            hideForYouEnabled = hideForYouCheckbox.checked;
            pageJumpEnabled = pageJumpCheckbox.checked;
            showStatsEnabled = showStatsCheckbox.checked;
            showModelDetailsEnabled = modelDetailsCheckbox.checked;
            compactStatsEnabled = compactStatsCheckbox.checked;
            showTimestampEnabled = showTimestampCheckbox.checked;
            timestampDateFirst = timestampFormatCheckbox.checked;
            timestamp24Hour = timestampHourFormatCheckbox.checked;
            showMessageIdsEnabled = showMessageIdsCheckbox.checked;
            highlightModelChangesEnabled = highlightModelChangesCheckbox.checked;
            autoRegenOnMismatchEnabled = autoRegenMismatchCheckbox.checked;
            autoRegenOnShortEnabled = autoRegenShortCheckbox.checked;
            autoRegenMaxAttempts = parseInt(autoRegenMaxSelect.value, 10);
            showChatNameInTitleEnabled = showChatNameInTitleCheckbox.checked;
            nsfwToggleEnabled = nsfwToggleCheckbox.checked;
            messageRecoveryEnabled = messageRecoveryCheckbox.checked;
            hideCreatorEnabled = hideCreatorCheckbox.checked;
            roundedProfileImagesEnabled = roundedProfileImagesCheckbox.checked;
            swapCheckboxPositionEnabled = swapCheckboxPositionCheckbox.checked;
            squareMessageEdgesEnabled = squareMessageEdgesCheckbox.checked;
            enableGenerationProfilesEnabled = enableGenerationProfilesCheckbox.checked;
            // Style-tab colors: empty input = use SpicyChat's own color.
            // (backgroundImage is updated in place by its file picker / Clear button.)
            styleOverrides.botMessageBg = { light: styleBotBgLightInput.value.trim(), dark: styleBotBgDarkInput.value.trim() };
            styleOverrides.userMessageBg = { light: styleUserBgLightInput.value.trim(), dark: styleUserBgDarkInput.value.trim() };
            styleOverrides.buttonHover = { light: styleHoverLightInput.value.trim(), dark: styleHoverDarkInput.value.trim() };
            styleOverrides.enabled = styleColorsEnabledCheckbox.checked;
            memoryDotEnabled = memoryDotEnabledCheckbox.checked;
            memoryDotColor = memoryDotColorInput.value.trim() || '#ff3b3b';
            
            debugLog('[Core] Saving - Sidebar:', sidebarEnabled, 'SidebarMinWidth:', finalMinWidth, 'CompactGeneration:', compactGenerationEnabled, 'StyleOverrides:', styleOverrides, 'HideForYou:', hideForYouEnabled, 'PageJump:', pageJumpEnabled, 'ShowStats:', showStatsEnabled, 'ShowModelDetails:', showModelDetailsEnabled, 'ShowTimestamp:', showTimestampEnabled, 'TimestampFormat:', timestampDateFirst ? 'date@time' : 'time@date', 'ShowChatNameInTitle:', showChatNameInTitleEnabled, 'MemoryDot:', memoryDotEnabled, 'MemoryDotColor:', memoryDotColor);
            await storage.set(SIDEBAR_LAYOUT_KEY, sidebarEnabled);
            await storage.set(SIDEBAR_MIN_WIDTH_KEY, finalMinWidth);
            await storage.set(COMPACT_GENERATION_KEY, compactGenerationEnabled);
            await storage.set(STYLE_OVERRIDES_KEY, JSON.stringify(styleOverrides));
            await storage.set(HIDE_FOR_YOU_KEY, hideForYouEnabled);
            await storage.set(PAGE_JUMP_KEY, pageJumpEnabled);
            await storage.set('showGenerationStats', showStatsEnabled);
            await storage.set('showModelDetails', showModelDetailsEnabled);
            await storage.set('compactStats', compactStatsEnabled);
            await storage.set('showTimestamp', showTimestampEnabled);
            await storage.set('timestampDateFirst', timestampDateFirst);
            await storage.set('timestamp24Hour', timestamp24Hour);
            await storage.set(SHOW_MESSAGE_IDS_KEY, showMessageIdsEnabled);
            await storage.set('highlightModelChanges', highlightModelChangesEnabled);
            await storage.set('autoRegenOnMismatch', autoRegenOnMismatchEnabled);
            await storage.set('autoRegenOnShort', autoRegenOnShortEnabled);
            await storage.set('autoRegenMaxAttempts', autoRegenMaxAttempts);
            await storage.set('showChatNameInTitle', showChatNameInTitleEnabled);
            await storage.set('nsfwToggleEnabled', nsfwToggleEnabled);
            await storage.set('messageRecoveryEnabled', messageRecoveryEnabled);
            await storage.set(HIDE_CREATOR_KEY, hideCreatorEnabled);
            await storage.set(ROUNDED_PROFILE_IMAGES_KEY, roundedProfileImagesEnabled);
            await storage.set(SWAP_CHECKBOX_POSITION_KEY, swapCheckboxPositionEnabled);
            await storage.set(SQUARE_MESSAGE_EDGES_KEY, squareMessageEdgesEnabled);
            await storage.set(ENABLE_GENERATION_PROFILES_KEY, enableGenerationProfilesEnabled);
            await storage.set(MEMORY_DOT_ENABLED_KEY, memoryDotEnabled);
            await storage.set(MEMORY_DOT_COLOR_KEY, memoryDotColor);
            // Debug log filters — Save-time fallback. The per-checkbox change/click handlers are
            // unreliable on WebKit/Orion (shadow-DOM checkboxes), so reconcile straight from the
            // DOM here, exactly like every other setting above. Without this, the in-memory
            // filters and storage stay at defaults while the UI shows the user's selection — so
            // disabled categories keep logging. The storage.onChanged listener (top of file)
            // mirrors this back into the live debugLog() filter immediately.
            for (const [category, checkbox] of Object.entries(debugFilterCheckboxes)) {
                if (checkbox) debugLogFilters[category] = checkbox.checked;
            }
            await storage.set('debugLogFilters', debugLogFilters);
            // Mark onboarding as seen when user saves settings
            await storage.set('hasSeenOnboarding', true);
            debugLog('[Core] Settings saved to storage');
            showNotification('Settings saved! Refreshing...');
            setTimeout(() => {
                debugLog('[Core] Reloading page...');
                window.location.reload();
            }, 500);
        };
        
        // Export Profiles button
        if (exportProfilesBtn) {
            exportProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                try {
                    const profiles = await loadProfiles();
                    const dataStr = JSON.stringify(profiles, null, 2);
                    const dataBlob = new Blob([dataStr], { type: 'application/json' });
                    const url = URL.createObjectURL(dataBlob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'spicychat-profiles.json';
                    link.click();
                    URL.revokeObjectURL(url);
                    showNotification('Profiles exported');
                } catch (error) {
                    console.error('[Core] Error exporting profiles:', error);
                    alert('Error exporting profiles: ' + error.message);
                }
            };
        }
        
        // Import Profiles button (only visible in debug mode with legacy setting)
        if (importProfilesBtn) {
            importProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(e) {
                    const file = e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = async function(event) {
                            try {
                                const imported = JSON.parse(event.target.result);
                                const profiles = await loadProfiles();
                                Object.assign(profiles, imported);
                                await saveProfiles(profiles);
                                showNotification('Profiles imported successfully');
                                await updateGenerationProfilesVisibility();
                            } catch (err) {
                                alert('Error importing profiles: ' + err.message);
                            }
                        };
                        reader.readAsText(file);
                    }
                });
                input.click();
            };
        }
        
        // Delete Profiles button
        if (deleteProfilesBtn) {
            deleteProfilesBtn.onclick = async (e) => {
                e.stopPropagation();
                const profiles = await loadProfiles();
                const profileCount = Object.keys(profiles).length;
                
                if (profileCount === 0) {
                    showNotification('No profiles to delete');
                    return;
                }
                
                const confirmed = confirm(`Are you sure you want to delete all ${profileCount} generation profile(s)? This cannot be undone.`);
                
                if (confirmed) {
                    try {
                        await saveProfiles({});
                        showNotification('All profiles deleted');
                        await updateGenerationProfilesVisibility();
                    } catch (error) {
                        console.error('[Core] Error deleting profiles:', error);
                        alert('Error deleting profiles: ' + error.message);
                    }
                }
            };
        }
        
        // Export All Data button
        debugLog('[Core] Attaching exportAllBtn onclick handler...');
        debugLog('[Core] exportAllBtn element:', exportAllBtn);
        debugLog('[Core] exportAllBtn exists?:', !!exportAllBtn);
        
        if (exportAllBtn) {
            exportAllBtn.onclick = async (e) => {
                debugLog('[Core] ===== EXPORT ALL DATA CLICKED =====');
                debugLog('[Core] Event:', e);
                e.stopPropagation();
                
                try {
                    debugLog('[Core] Starting data fetch...');
                    debugLog('[Core] Storage object type:', typeof storage);
                    debugLog('[Core] Storage object:', storage);
                    
                    // Get all data from extension storage
                    // PERFORMANCE: Batch all export settings into a single storage read
                    const exportData = await storage.getMultiple({
                        [SIDEBAR_LAYOUT_KEY]: false,
                        [SIDEBAR_MIN_WIDTH_KEY]: DEFAULT_SIDEBAR_MIN_WIDTH,
                        [STYLE_OVERRIDES_KEY]: JSON.stringify(EMPTY_STYLE_OVERRIDES),
                        [COMPACT_GENERATION_KEY]: false,
                        [HIDE_FOR_YOU_KEY]: false,
                        [PAGE_JUMP_KEY]: false,
                        'showGenerationStats': false,
                        'showModelDetails': true,
                        'compactStats': false,
                        'showTimestamp': false,
                        'highlightModelChanges': false,
                        'autoRegenOnMismatch': false,
                        'autoRegenOnShort': false,
                        'autoRegenMaxAttempts': 1,
                        'timestampDateFirst': true,
                        'timestamp24Hour': false,
                        [SHOW_MESSAGE_IDS_KEY]: false,
                        'showChatNameInTitle': false,
                        'nsfwToggleEnabled': false,
                        'messageRecoveryEnabled': false,
                        [ENABLE_GENERATION_PROFILES_KEY]: false,
                        [ROUNDED_PROFILE_IMAGES_KEY]: false,
                        [SWAP_CHECKBOX_POSITION_KEY]: false,
                        [SQUARE_MESSAGE_EDGES_KEY]: false,
                        [MEMORY_DOT_ENABLED_KEY]: true,
                        [MEMORY_DOT_COLOR_KEY]: '#ff3b3b',
                        [HIDE_CREATOR_KEY]: false,
                        'generationProfiles': '{}',
                        'lastSelectedProfile': ''
                        // messageGenerationStats intentionally omitted — stats come from the
                        // background IndexedDB store via SAI_STATS_EXPORT_ALL below, not storage.local.
                    });
                    
                    debugLog('[Core] All values fetched. Building export object...');
                    
                    // Parse JSON strings for proper export format
                    const generationProfilesParsed = JSON.parse(exportData['generationProfiles']);
                    // Stats live in the background IndexedDB store now — pull the nested snapshot
                    // from the DB (storage.local only holds the frozen legacy blob post-migration).
                    // If the DB read fails, ABORT the export — never write a silently empty-stats file.
                    await flushHeldStats();   // include stats parked while the background was down
                    const statsRes = await sendStatsMessage('SAI_STATS_EXPORT_ALL');
                    if (!statsRes || !statsRes.success) {
                        throw new Error('Could not read stats from the database — export aborted to avoid an incomplete file.');
                    }
                    const messageGenerationStatsParsed = statsRes.stats || {};

                    // Build the export object
                    const allData = {
                        enableSidebarLayout: exportData[SIDEBAR_LAYOUT_KEY],
                        sidebarMinWidth: exportData[SIDEBAR_MIN_WIDTH_KEY],
                        // (Retired Custom Style data is intentionally not exported.)
                        styleOverrides: normalizeStyleOverrides(exportData[STYLE_OVERRIDES_KEY]),
                        enableCompactGeneration: exportData[COMPACT_GENERATION_KEY],
                        enableHideForYou: exportData[HIDE_FOR_YOU_KEY],
                        enablePageJump: exportData[PAGE_JUMP_KEY],
                        showGenerationStats: exportData['showGenerationStats'],
                        showModelDetails: exportData['showModelDetails'],
                        compactStats: exportData['compactStats'],
                        showTimestamp: exportData['showTimestamp'],
                        timestampDateFirst: exportData['timestampDateFirst'],
                        timestamp24Hour: exportData['timestamp24Hour'],
                        showMessageIds: exportData[SHOW_MESSAGE_IDS_KEY],
                        showChatNameInTitle: exportData['showChatNameInTitle'],
                        nsfwToggleEnabled: exportData['nsfwToggleEnabled'],
                        messageRecoveryEnabled: exportData['messageRecoveryEnabled'],
                        enableGenerationProfiles: exportData[ENABLE_GENERATION_PROFILES_KEY],
                        enableRoundedProfileImages: exportData[ROUNDED_PROFILE_IMAGES_KEY],
                        swapCheckboxPosition: exportData[SWAP_CHECKBOX_POSITION_KEY],
                        squareMessageEdges: exportData[SQUARE_MESSAGE_EDGES_KEY],
                        highlightModelChanges: exportData['highlightModelChanges'],
                        autoRegenOnMismatch: exportData['autoRegenOnMismatch'],
                        autoRegenOnShort: exportData['autoRegenOnShort'],
                        autoRegenMaxAttempts: exportData['autoRegenMaxAttempts'],
                        memoryDotEnabled: exportData[MEMORY_DOT_ENABLED_KEY],
                        memoryDotColor: exportData[MEMORY_DOT_COLOR_KEY],
                        hideCreatorName: exportData[HIDE_CREATOR_KEY],
                        generationProfiles: generationProfilesParsed,  // Use parsed object
                        lastSelectedProfile: exportData['lastSelectedProfile'],
                        messageGenerationStats: messageGenerationStatsParsed  // Use parsed object
                    };
                
                debugLog('[Core] Export object built:', Object.keys(allData));
                debugLog('[Core] Export object full:', allData);
                debugLog('[Core] Checking each property:');
                for (const [key, value] of Object.entries(allData)) {
                    debugLog(`[Core]   ${key}:`, typeof value, value?.constructor?.name, value);
                }
                
                debugLog('[Core] Stringifying to JSON...');
                const dataStr = JSON.stringify(allData, null, 2);
                debugLog('[Core] JSON string length:', dataStr.length);
                debugLog('[Core] JSON string sample:', dataStr.substring(0, 200));
                
                debugLog('[Core] Creating blob...');
                const dataBlob = new Blob([dataStr], { type: 'application/json' });
                debugLog('[Core] Blob created, size:', dataBlob.size);
                
                const url = URL.createObjectURL(dataBlob);
                debugLog('[Core] Object URL created:', url);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = `sai-toolkit-extension-${Date.now()}.json`;
                debugLog('[Core] Download link created, filename:', link.download);
                
                link.click();
                debugLog('[Core] Link clicked');
                
                URL.revokeObjectURL(url);
                debugLog('[Core] Object URL revoked');
                
                showNotification('All data exported successfully!\nFile includes: settings, profiles, and message stats');
                debugLog('[Core] ===== EXPORT COMPLETED SUCCESSFULLY =====');
            } catch (error) {
                console.error('[Core] ===== EXPORT ERROR =====');
                console.error('[Core] Error exporting data:', error);
                console.error('[Core] Error stack:', error.stack);
                alert('Error exporting data: ' + error.message);
            }
        };
        } else {
            console.error('[Core] Cannot attach exportAllBtn handler - button not found!');
        }
        
        // Import All Data button
        debugLog('[Core] Attaching importAllBtn onclick handler...');
        debugLog('[Core] importAllBtn element:', importAllBtn);
        debugLog('[Core] importAllBtn exists?:', !!importAllBtn);
        
        if (importAllBtn) {
            importAllBtn.onclick = async (e) => {
                debugLog('[Core] Import All Data button clicked');
                e.stopPropagation();

                // ---- progress overlay helpers ----
                const showImportProgress = (statusText, pct) => {
                    let overlay = shadow.getElementById('import-progress-overlay');
                    if (!overlay) {
                        overlay = document.createElement('div');
                        overlay.id = 'import-progress-overlay';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000005;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;pointer-events:auto;';
                        const card = document.createElement('div');
                        card.style.cssText = 'background:#1f2937;border-radius:12px;padding:1.5rem 2rem;display:flex;flex-direction:column;gap:0.75rem;min-width:280px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
                        const title = document.createElement('div');
                        title.textContent = 'Importing…';
                        title.style.cssText = 'color:#f9fafb;font-size:14px;font-weight:600;';
                        const statusEl = document.createElement('div');
                        statusEl.id = 'import-progress-status';
                        statusEl.style.cssText = 'color:#9ca3af;font-size:12px;min-height:1.2em;';
                        const track = document.createElement('div');
                        track.style.cssText = 'height:4px;background:#374151;border-radius:2px;overflow:hidden;';
                        const fill = document.createElement('div');
                        fill.id = 'import-progress-fill';
                        fill.style.cssText = 'height:100%;background:#3b82f6;border-radius:2px;transition:width 0.2s ease;width:0%;';
                        track.appendChild(fill);
                        card.appendChild(title);
                        card.appendChild(statusEl);
                        card.appendChild(track);
                        overlay.appendChild(card);
                        shadow.appendChild(overlay);
                    }
                    shadow.getElementById('import-progress-status').textContent = statusText;
                    shadow.getElementById('import-progress-fill').style.width = pct + '%';
                };
                const removeImportProgress = () => {
                    const overlay = shadow.getElementById('import-progress-overlay');
                    if (overlay) overlay.remove();
                };
                // ---- end progress helpers ----

                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.addEventListener('change', async function(event) {
                    const file = event.target.files[0];
                    if (!file) {
                        debugLog('[Core] No file selected');
                        return;
                    }
                
                debugLog('[Core] File selected:', file.name);
                const reader = new FileReader();
                reader.onload = async function(e) {
                    try {
                        // Un-nest v2 grouped files (settings/style/stats) into the flat
                        // layout the apply logic below expects; flat files pass through.
                        const imported = normalizeImportPayload(JSON.parse(e.target.result));
                        debugLog('[Core] Parsed imported data:', Object.keys(imported));
                        
                        // Handle both old (double-encoded strings) and new (proper objects) formats
                        let generationProfilesValue = imported.generationProfiles;
                        let messageGenerationStatsValue = imported.messageGenerationStats;
                        
                        // If they're strings (old format), parse them; if already objects (new format), use as-is
                        if (typeof generationProfilesValue === 'string') {
                            debugLog('[Core] generationProfiles is string (old format), parsing...');
                            generationProfilesValue = generationProfilesValue;  // Keep as string for storage
                        } else if (typeof generationProfilesValue === 'object') {
                            debugLog('[Core] generationProfiles is object (new format), stringifying for storage...');
                            generationProfilesValue = JSON.stringify(generationProfilesValue);  // Convert to string for storage
                        }
                        
                        if (typeof messageGenerationStatsValue === 'string') {
                            debugLog('[Core] messageGenerationStats is string (old format), parsing...');
                            messageGenerationStatsValue = messageGenerationStatsValue;  // Keep as string for storage
                        } else if (typeof messageGenerationStatsValue === 'object') {
                            debugLog('[Core] messageGenerationStats is object (new format), stringifying for storage...');
                            messageGenerationStatsValue = JSON.stringify(messageGenerationStatsValue);  // Convert to string for storage
                        }
                        
                        // Build updates object conditionally
                        const updates = {};
                        if (imported.enableSidebarLayout !== undefined) updates.enableSidebarLayout = imported.enableSidebarLayout;
                        if (imported.sidebarMinWidth !== undefined) updates.sidebarMinWidth = imported.sidebarMinWidth;
                        // Retired Custom Style data (enableCustomStyle/customStyleValues) in a backup
                        // is deliberately NOT restored. For a pre-1.3.1 backup, only the settings
                        // that survived (bubble BGs, button hover, background image) are derived
                        // from it, the same way the load-time migration does.
                        if (imported.styleOverrides !== undefined) {
                            updates[STYLE_OVERRIDES_KEY] = JSON.stringify(normalizeStyleOverrides(imported.styleOverrides));
                        } else if (imported.customStyleValues !== undefined) {
                            updates[STYLE_OVERRIDES_KEY] = JSON.stringify(deriveStyleOverridesFromLegacy(imported.enableCustomStyle === true, imported.customStyleValues));
                        }
                        if (imported.enableCompactGeneration !== undefined) updates.enableCompactGeneration = imported.enableCompactGeneration;
                        if (imported.enableHideForYou !== undefined) updates.enableHideForYou = imported.enableHideForYou;
                        if (imported.enablePageJump !== undefined) updates.enablePageJump = imported.enablePageJump;
                        if (imported.showGenerationStats !== undefined) updates.showGenerationStats = imported.showGenerationStats;
                        if (imported.showModelDetails !== undefined) updates.showModelDetails = imported.showModelDetails;
                        if (imported.compactStats !== undefined) updates.compactStats = imported.compactStats;
                        if (imported.showTimestamp !== undefined) updates.showTimestamp = imported.showTimestamp;
                        if (imported.timestampDateFirst !== undefined) updates.timestampDateFirst = imported.timestampDateFirst;
                        if (imported.timestamp24Hour !== undefined) updates.timestamp24Hour = imported.timestamp24Hour;
                        if (imported.showMessageIds !== undefined) updates.showMessageIds = imported.showMessageIds;
                        if (imported.showChatNameInTitle !== undefined) updates.showChatNameInTitle = imported.showChatNameInTitle;
                        if (imported.nsfwToggleEnabled !== undefined) updates.nsfwToggleEnabled = imported.nsfwToggleEnabled;
                        if (imported.messageRecoveryEnabled !== undefined) updates.messageRecoveryEnabled = imported.messageRecoveryEnabled;
                        if (imported.enableGenerationProfiles !== undefined) updates.enableGenerationProfiles = imported.enableGenerationProfiles;
                        if (imported.enableRoundedProfileImages !== undefined) updates.enableRoundedProfileImages = imported.enableRoundedProfileImages;
                        if (imported.swapCheckboxPosition !== undefined) updates.swapCheckboxPosition = imported.swapCheckboxPosition;
                        if (imported.squareMessageEdges !== undefined) updates.squareMessageEdges = imported.squareMessageEdges;
                        if (imported.highlightModelChanges !== undefined) updates.highlightModelChanges = imported.highlightModelChanges;
                        if (imported.autoRegenOnMismatch !== undefined) updates.autoRegenOnMismatch = imported.autoRegenOnMismatch;
                        if (imported.autoRegenOnShort !== undefined) updates.autoRegenOnShort = imported.autoRegenOnShort;
                        if (imported.autoRegenMaxAttempts !== undefined) updates.autoRegenMaxAttempts = imported.autoRegenMaxAttempts;
                        if (imported.memoryDotEnabled !== undefined) updates[MEMORY_DOT_ENABLED_KEY] = imported.memoryDotEnabled;
                        if (imported.memoryDotColor !== undefined) updates[MEMORY_DOT_COLOR_KEY] = imported.memoryDotColor;
                        if (imported.hideCreatorName !== undefined) updates[HIDE_CREATOR_KEY] = imported.hideCreatorName;
                        if (generationProfilesValue !== undefined) updates.generationProfiles = generationProfilesValue;
                        if (imported.lastSelectedProfile !== undefined) updates.lastSelectedProfile = imported.lastSelectedProfile;
                        debugLog('[Core] Importing keys:', Object.keys(updates));

                        showImportProgress('Parsing import file…', 10);
                        await new Promise(r => setTimeout(r, 0));

                        // Merge stats rather than overwrite — preserve any entries in
                        // current storage that are not in (or are newer than) the backup.
                        // Stats live in the background IndexedDB store; merge there
                        // (authoritative, collapses conversation level, never overwrites
                        // richer entries). Not written to storage.local, so keep it out of
                        // `updates`. (Page reloads after import, so the cache refreshes.)
                        if (messageGenerationStatsValue !== undefined) {
                            const importedStats = JSON.parse(messageGenerationStatsValue);
                            const botCount = Object.keys(importedStats).length;
                            showImportProgress(`Merging stats (${botCount} bots)…`, 35);
                            await new Promise(r => setTimeout(r, 0));

                            const mergeRes = await sendStatsMessage('SAI_STATS_IMPORT_MERGE', { stats: importedStats });
                            if (!mergeRes || !mergeRes.success) {
                                throw new Error('Stats merge failed: ' + ((mergeRes && mergeRes.error) || 'unknown error'));
                            }

                            debugLog('[Core] Stats merge requested:', botCount, 'bots');
                        }

                        showImportProgress('Saving to storage…', 70);
                        await new Promise(r => setTimeout(r, 0));

                        // Apply all updates
                        await storage.setMultiple(updates);
                        debugLog('[Core] All data imported successfully');

                        showImportProgress('Done! Reloading…', 100);
                        await new Promise(r => setTimeout(r, 0));

                        setTimeout(() => {
                            removeImportProgress();
                            debugLog('[Core] Reloading page…');
                            window.location.reload();
                        }, 800);
                    } catch (error) {
                        removeImportProgress();
                        console.error('[Core] Error importing data:', error);
                        alert('Error importing data: ' + error.message);
                    }
                };
                reader.readAsText(file);
            });
            input.click();
        };
        } else {
            console.error('[Core] Cannot attach importAllBtn handler - button not found!');
        }
        
        // Escape key to close
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                debugLog('[Core] Escape key pressed');
                closeModal();
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);
        
        debugLog('[Core] ===== MODAL SETUP COMPLETE =====');
    }

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                     TOOLKIT SPECIFIC CODE - END                      ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================


    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                    INITIALIZATION & OBSERVERS                        ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================

    // CHECK ONBOARDING FIRST - before initializing anything else
    // Get all storage to check if it's truly empty or has any toolkit settings
    const allStorage = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get(null);
    const storageKeys = Object.keys(allStorage);
    
    debugLog('[Core] ===== ONBOARDING CHECK (BEFORE INIT) =====');
    debugLog('[Core] All storage keys:', storageKeys);
    debugLog('[Core] Storage contents:', allStorage);
    
    // Check if this is first run: no hasSeenOnboarding key OR it's explicitly false.
    // (Used to also re-show onboarding when the Classic Style key was missing as an
    // "updated from an old version" heuristic. Classic Style is gone and its key is
    // cleaned up on load, so that check would now re-onboard every existing user.)
    const hasSeenOnboarding = allStorage.hasSeenOnboarding;

    debugLog('[Core] Onboarding check - hasSeenOnboarding:', hasSeenOnboarding);

    const shouldShowOnboarding = hasSeenOnboarding === undefined ||
                                  hasSeenOnboarding === false;
    debugLog('[Core] Should show onboarding?', shouldShowOnboarding);
    
    // Initialize styles on page load
    await initializeStyles();

    // Background cleanup: remove legacy null-only stats entries (fire-and-forget)
    pruneNullStats();
    // Deliver any stats parked while the background page was unavailable
    flushHeldStats();

    // Initialize Message Recovery: read the user's opt-in state from storage
    // and forward it to the page-context interceptor. Idempotent — safe to
    // call before/after initializeStyles.
    await initMessageRecovery();
    
    // Expose a helper function to reset onboarding (for testing)
    // Since content scripts can't expose functions to page context, we use custom events
    window.addEventListener('SAI_RESET_ONBOARDING', async function() {
        debugLog('[Core] Reset onboarding event received');
        // Clear the onboarding flag
        await storage.remove('hasSeenOnboarding');
        // Also clear all settings to simulate a truly fresh install
        await storage.remove(SIDEBAR_LAYOUT_KEY);
        await storage.remove(COMPACT_GENERATION_KEY);
        await storage.remove(HIDE_FOR_YOU_KEY);
        await storage.remove(PAGE_JUMP_KEY);
        await storage.remove('showGenerationStats');
        await storage.remove('timestampDateFirst');
        debugLog('[Core] Onboarding and all settings reset! Reload the page to see the onboarding modal.');
        setTimeout(() => location.reload(), 1000);
    });
    
    // Note: resetSAIToolkitOnboarding() function is injected via page-context.js
    
    if (shouldShowOnboarding) {
        debugLog('[Core] First run detected - will show onboarding modal');
        // Don't mark as seen yet - only mark when user clicks "Save & Refresh"
        // Wait for page to fully load and toolkit icon to be injected before showing modal
        setTimeout(() => {
            debugLog('[Core] Triggering onboarding modal...');
            try {
                showToolkitSettingsModal();
            } catch (error) {
                console.error('[Core] Error showing onboarding modal:', error);
            }
        }, 3000); // Increased delay to ensure page is fully loaded
    } else {
        debugLog('[Core] Not first run - skipping onboarding modal');
    }

    // Track button check interval to prevent multiple intervals (memory leak fix)
    let buttonCheckInterval = null;

    // Resize protection to prevent React 185 error during sidebar collapse/expand transitions
    let lastResizeTime = 0;
    let pendingButtonInjection = null;
    const RESIZE_DEBOUNCE_MS = 500; // Increased from 300ms
    // isResizing and resizeEndTimer are hoisted to the top of the IIFE — see early-declared state.

    // Track all pending injection timeouts so we can cancel them on resize
    let pendingInjectionTimeouts = [];
    
    // Helper to schedule injection with cancellation support
    function scheduleInjection(fn, delay) {
        const timeoutId = setTimeout(() => {
            // Remove from tracking array
            pendingInjectionTimeouts = pendingInjectionTimeouts.filter(id => id !== timeoutId);
            // Double-check resize state before executing
            if (!isResizing && !sidebarWidthTransitionPending) {
                fn();
            }
        }, delay);
        pendingInjectionTimeouts.push(timeoutId);
        return timeoutId;
    }
    
    // Cancel all pending injection timeouts
    function cancelAllPendingInjections() {
        pendingInjectionTimeouts.forEach(id => clearTimeout(id));
        pendingInjectionTimeouts = [];
    }
    
    // Pre-emptive resize detection using mousedown on window edges
    // This removes elements BEFORE resize starts, avoiding React conflicts
    let resizeStartPending = false;
    // BUGFIX: any click within edgeThreshold of the viewport's right/bottom edge
    // (a send button, a scrollbar, anything near the edge — not just an actual
    // resize drag) sets isResizing=true below. If no real window 'resize' event
    // follows, nothing else ever clears it — the 'mouseup' handler deliberately
    // leaves that to the resize-end timer, which never gets scheduled. Once
    // stuck, scheduleInjection() skips every button re-injection until reload.
    // This timer self-heals: if no genuine resize shows up shortly after the
    // mousedown, we recover exactly as the real resize-end path would.
    let mousedownResizeFallbackTimer = null;

    document.addEventListener('mousedown', function(e) {
        // Detect if mouse is near window edge (potential resize drag)
        const edgeThreshold = 10;
        const nearRightEdge = e.clientX >= window.innerWidth - edgeThreshold;
        const nearBottomEdge = e.clientY >= window.innerHeight - edgeThreshold;

        if (nearRightEdge || nearBottomEdge) {
            debugLog('[Core] RESIZE START DETECTED (mousedown near edge)');
            resizeStartPending = true;
            isResizing = true;
            sidebarWidthTransitionPending = true;
            cancelAllPendingInjections();

            // Remove button IMMEDIATELY before any resize events fire
            const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
            if (sidebarBtn) {
                const wrapper = sidebarBtn.closest('div.w-full');
                if (wrapper) {
                    wrapper.remove();
                    debugLog('[Core] RESIZE START - pre-emptively removed sidebar button');
                } else {
                    sidebarBtn.remove();
                }
            }

            // Self-healing fallback: if this wasn't actually a resize (no genuine
            // 'resize' event follows), recover instead of staying stuck forever.
            if (mousedownResizeFallbackTimer) clearTimeout(mousedownResizeFallbackTimer);
            mousedownResizeFallbackTimer = setTimeout(function() {
                if (!isResizing) return; // a real resize already took over cleanup
                debugLog('[Core] RESIZE FALSE ALARM - no resize event followed edge mousedown, recovering');
                isResizing = false;
                sidebarWidthTransitionPending = false;
                if (window.innerWidth >= 600) {
                    injectToolkitSidebarButton();
                }
            }, RESIZE_DEBOUNCE_MS);
        }
    }, true); // Use capture phase to run before other handlers
    
    document.addEventListener('mouseup', function() {
        if (resizeStartPending) {
            resizeStartPending = false;
            // Don't reset isResizing here - let the resize end timer handle it
        }
    });
    
    // Track last-known window width so we can ignore height-only resize events.
    // On Firefox Android PWA (standalone display-mode), opening the soft keyboard
    // resizes the layout viewport (height shrinks, width unchanged) and fires a
    // window 'resize' event. React-185 avoidance only depends on width
    // breakpoints, so height-only changes are safe to skip here.
    let lastResizeWidth = window.innerWidth;
    window.addEventListener('resize', function() {
        const width = window.innerWidth;
        if (width === lastResizeWidth) {
            debugLog('[Core] RESIZE EVENT (height-only, ignored) - width:', width);
            return;
        }
        lastResizeWidth = width;
        debugLog('[Core] RESIZE EVENT - width:', width, 'wasResizing:', isResizing);
        lastResizeTime = Date.now();

        // A genuine resize is happening — the resize-end timer below now owns
        // recovery, so cancel the mousedown false-alarm fallback to avoid a race.
        if (mousedownResizeFallbackTimer) {
            clearTimeout(mousedownResizeFallbackTimer);
            mousedownResizeFallbackTimer = null;
        }

        // If we didn't catch the resize start via mousedown, do removal now
        if (!isResizing) {
            isResizing = true;
            sidebarWidthTransitionPending = true;
            cancelAllPendingInjections();

            // Remove button immediately
            const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
            if (sidebarBtn) {
                debugLog('[Core] RESIZE - removing sidebar button');
                const wrapper = sidebarBtn.closest('div.w-full');
                if (wrapper) {
                    wrapper.remove();
                } else {
                    sidebarBtn.remove();
                }
            }
        }
        
        // Clear any pending injection during resize
        if (pendingButtonInjection) {
            clearTimeout(pendingButtonInjection);
            pendingButtonInjection = null;
        }
        
        // Reset sidebar width tracking so next injection will succeed
        lastKnownSidebarWidth = null;
        
        // Mark resize as ended after debounce period
        if (resizeEndTimer) clearTimeout(resizeEndTimer);
        resizeEndTimer = setTimeout(function() {
            isResizing = false;
            sidebarWidthTransitionPending = false; // Allow sidebar injection again
            debugLog('[Core] RESIZE END - width:', window.innerWidth, 'will re-inject if needed');
            
            // Re-inject button after resize settles
            if (window.innerWidth >= 600) {
                setTimeout(() => {
                    if (!isResizing) {
                        injectToolkitSidebarButton();
                    }
                }, 100);
            }
        }, RESIZE_DEBOUNCE_MS);
    });

    // =============================================================================
    // SIDEBAR LAYOUT BODY-CLASS OBSERVER
    // =============================================================================
    // Maintains a small set of state classes on document.body that the Sidebar
    // Layout CSS reads instead of `body:has(...)` selectors. The original ~30
    // chained `:has()` rules forced the style engine to re-test the entire body
    // subtree on every DOM mutation — catastrophic on older CPUs (8s+ forced
    // reflows during typing). With body classes, each rule is O(1) to match.
    //
    // Classes managed (all gated on `body`):
    //   sai-mm-sidebar-modal-open  → any Memories/Gen Settings modal is open
    //   sai-mm-image-modal-open    → image lightbox is open
    //   sai-mm-toolkit-modal-open  → our own settings modal is open
    //   sai-mm-gen-settings-open   → Generation Settings modal is open
    //   sai-mm-memories-open       → Memories modal is open
    //   sai-mm-nav-collapsed       → left nav is at the 54px collapsed width
    //
    // The observer is intentionally cheap: it only RE-RUNS the cached selector
    // checks when an added/removed node could plausibly be a modal or nav
    // (pre-filtered against the same patterns the old `:has()` rules used).
    // Updates are coalesced into a single requestAnimationFrame callback so
    // bursts of React mutations only produce one classList toggle pass.
    // (sidebarLayoutBodyObserver and sidebarLayoutBodyClassRafPending are
    // hoisted to the top of the IIFE — see the early-declared state block.)

    function updateSidebarLayoutBodyClasses() {
        if (!document.body) return;
        const cl = document.body.classList;

        const hasSidebarModal = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2:not(.size-full):not(.toolkit-modal-container)'
        );
        const hasImageModal = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.size-full'
        );
        const hasToolkitModal = !!document.querySelector('#toolkit-modal-root .backdrop');
        const hasGenSettings = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.max-h-\\[600px\\]:not(.h-full):not(.size-full), ' +
            'div.fixed.left-1\\/2.top-1\\/2.max-h-\\[700px\\]:not(.h-full):not(.size-full)'
        );
        const hasMemories = !!document.querySelector(
            'div.fixed.left-1\\/2.top-1\\/2.h-full:not(.size-full):not(.toolkit-modal-container)'
        );
        const navCollapsed = !!document.querySelector('nav[style*="width: 54px"]');

        cl.toggle('sai-mm-sidebar-modal-open', hasSidebarModal);
        cl.toggle('sai-mm-image-modal-open', hasImageModal);
        cl.toggle('sai-mm-toolkit-modal-open', hasToolkitModal);
        cl.toggle('sai-mm-gen-settings-open', hasGenSettings);
        cl.toggle('sai-mm-memories-open', hasMemories);
        cl.toggle('sai-mm-nav-collapsed', navCollapsed);
        // Combined: any centered modal exists (sidebar OR image). Used by the
        // chat-width adjustment rules that need to react to either.
        cl.toggle('sai-mm-any-center-modal-open', hasSidebarModal || hasImageModal);
    }

    function scheduleSidebarLayoutBodyClassUpdate() {
        if (sidebarLayoutBodyClassRafPending) return;
        sidebarLayoutBodyClassRafPending = true;
        requestAnimationFrame(() => {
            sidebarLayoutBodyClassRafPending = false;
            updateSidebarLayoutBodyClasses();
        });
    }

    // A mutation is interesting only if it could change the result of one of
    // the selectors above. We pre-filter on tagName/class patterns so we don't
    // re-run the queries on every keystroke-induced text node change.
    function mutationCouldAffectModalState(mutation) {
        if (mutation.type === 'attributes') {
            // Style changes on nav (collapse/expand) or class flips on modals
            const t = mutation.target;
            if (!t || t.nodeType !== 1) return false;
            if (t.tagName === 'NAV') return true;
            if (t.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            return false;
        }
        if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) return false;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
        for (const n of nodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'NAV' || n.querySelector?.('nav')) return true;
            if (n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            if (n.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]')) return true;
            if (n.id === 'toolkit-modal-root' || n.querySelector?.('#toolkit-modal-root')) return true;
            if (n.classList?.contains('backdrop') && n.closest?.('#toolkit-modal-root')) return true;
        }
        return false;
    }

    function startSidebarLayoutBodyClassObserver() {
        if (sidebarLayoutBodyObserver) return; // already running

        sidebarLayoutBodyObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (mutationCouldAffectModalState(m)) {
                    scheduleSidebarLayoutBodyClassUpdate();
                    return;
                }
            }
        });

        const attach = () => {
            if (!document.body) {
                // Body not ready yet — retry on next tick. (Early-inject is called
                // before <body> exists; without this we'd race React rendering modals
                // into the DOM before the observer ever attached.)
                setTimeout(attach, 50);
                return;
            }
            sidebarLayoutBodyObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
            // Critical: sweep AFTER body exists and observer is attached.
            // The previous version ran the sweep before attach() — which meant
            // it bailed when body didn't exist yet, then the observer never saw
            // the modals React had already mounted. Result: body classes never
            // got set on pages that load with a modal already open, and all of
            // the class-based sidebar CSS sat inert.
            updateSidebarLayoutBodyClasses();
            debugLog('[Core] Sidebar Layout body-class observer attached and swept');
        };
        attach();
    }

    function stopSidebarLayoutBodyClassObserver() {
        if (sidebarLayoutBodyObserver) {
            sidebarLayoutBodyObserver.disconnect();
            sidebarLayoutBodyObserver = null;
        }
        if (document.body) {
            document.body.classList.remove(
                'sai-mm-sidebar-modal-open',
                'sai-mm-image-modal-open',
                'sai-mm-toolkit-modal-open',
                'sai-mm-gen-settings-open',
                'sai-mm-memories-open',
                'sai-mm-nav-collapsed',
                'sai-mm-any-center-modal-open'
            );
        }
    }

    // Watch sidebar element for width changes using ResizeObserver
    // This catches sidebar width transitions that happen without a window resize event
    let sidebarResizeObserver = null;
    let lastObservedSidebarWidth = null;
    let sidebarResizeTimer = null;
    
    function setupSidebarResizeObserver() {
        if (sidebarResizeObserver) {
            sidebarResizeObserver.disconnect();
        }
        
        const sidebar = document.querySelector('nav.flex.flex-col');
        if (!sidebar) {
            debugLog('[Core] Sidebar not found for ResizeObserver');
            return;
        }
        
        lastObservedSidebarWidth = sidebar.offsetWidth;
        debugLog('[Core] Setting up sidebar ResizeObserver, initial width:', lastObservedSidebarWidth);
        
        sidebarResizeObserver = new ResizeObserver((entries) => {
            // CRITICAL: Skip entirely if window resize is in progress
            // The window resize handler already handles button removal
            if (isResizing) {
                // Just update tracked width silently, don't do anything else
                for (const entry of entries) {
                    lastObservedSidebarWidth = entry.contentRect.width;
                }
                return;
            }
            
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                
                if (lastObservedSidebarWidth !== null && lastObservedSidebarWidth !== newWidth) {
                    debugLog('[Core] Sidebar width changed (not during resize):', lastObservedSidebarWidth, '->', newWidth);
                    
                    // Mark as transitioning
                    sidebarWidthTransitionPending = true;
                    
                    // Remove sidebar button during transition to avoid React conflicts
                    const sidebarBtn = document.getElementById('sai-toolkit-sidebar-btn');
                    if (sidebarBtn) {
                        debugLog('[Core] Removing sidebar button during width transition');
                        const wrapper = sidebarBtn.closest('div.w-full');
                        if (wrapper) {
                            wrapper.remove();
                        } else {
                            sidebarBtn.remove();
                        }
                    }
                    
                    // Reset transition flag after debounce and re-inject
                    if (sidebarResizeTimer) clearTimeout(sidebarResizeTimer);
                    sidebarResizeTimer = setTimeout(() => {
                        sidebarWidthTransitionPending = false;
                        debugLog('[Core] Sidebar transition complete, new width:', newWidth);
                        
                        // Re-inject button if width supports it
                        if (window.innerWidth >= 600 && !isResizing) {
                            setTimeout(() => {
                                if (!sidebarWidthTransitionPending && !isResizing) {
                                    injectToolkitSidebarButton();
                                }
                            }, 100);
                        }
                    }, 400);
                }
                
                lastObservedSidebarWidth = newWidth;
            }
        });
        
        sidebarResizeObserver.observe(sidebar);
    }
    
    // Set up observer after a delay to ensure sidebar exists
    setTimeout(setupSidebarResizeObserver, 1000);
    
    // Debounced button injection to prevent React re-render loops
    function debouncedButtonInjection() {
        // Skip entirely if currently resizing or sidebar is transitioning
        if (isResizing || sidebarWidthTransitionPending) {
            return;
        }
        
        // Skip if resize just happened (sidebar may be in transition)
        const timeSinceResize = Date.now() - lastResizeTime;
        if (timeSinceResize < RESIZE_DEBOUNCE_MS) {
            // Schedule a delayed check after resize settles
            if (!pendingButtonInjection) {
                pendingButtonInjection = setTimeout(function() {
                    pendingButtonInjection = null;
                    // Double-check we're not resizing when timer fires
                    if (!isResizing && !sidebarWidthTransitionPending && window.innerWidth >= 600) {
                        injectToolkitSidebarButton();
                    }
                }, RESIZE_DEBOUNCE_MS);
            }
            return;
        }
        
        // Safe to inject
        injectToolkitSidebarButton();
    }

    // Cache the one-shot CSS injection state so we don't query the DOM on every batch.
    let toolkitButtonCssInjected = false;

    // Observe for modal appearance / button host elements appearing
    const observer = new MutationObserver(function(mutations) {
        // Skip all processing during resize or sidebar transition to prevent React 185 error
        if (isResizing || sidebarWidthTransitionPending) {
            return;
        }

        // Perf: pre-filter mutations. The vast majority of body mutations during
        // streaming are message-bubble updates that have nothing to do with the
        // sidebar, modals, or our injection targets. Only run the (expensive)
        // full pass when an element is added/removed that could be one of our hosts.
        let relevant = false;
        for (const m of mutations) {
            if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
            const nodes = [...m.addedNodes, ...m.removedNodes];
            for (const n of nodes) {
                if (n.nodeType !== 1) continue;
                if (
                    n.tagName === 'NAV' || n.querySelector?.('nav') ||
                    n.matches?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                    n.querySelector?.('div[class*="fixed"][class*="left-1/2"][class*="top-1/2"]') ||
                    n.matches?.('button[aria-label="ThumbsUp-button"]') ||
                    n.querySelector?.('button[aria-label="ThumbsUp-button"]') ||
                    n.matches?.('svg.lucide-info') ||
                    n.querySelector?.('svg.lucide-info')
                ) {
                    relevant = true;
                    break;
                }
            }
            if (relevant) break;
        }
        if (!relevant) return;

        // Look specifically for the Generation Settings modal (supports both old and new UI)
        const modal = findGenerationSettingsModal();

        if (modal && !modal.querySelector('#profile-controls')) {
            // Wait a bit for the modal to fully render
            setTimeout(createProfileControls, 100);
        }

        // Try to inject sidebar button (watches for sidebar to load) - debounced to prevent React 185
        debouncedButtonInjection();

        // Inject CSS to hide toolkit button text when sidebar is collapsed (only once)
        if (!toolkitButtonCssInjected) {
            const toolkitButtonCSS = document.createElement('style');
            toolkitButtonCSS.id = 'sai-toolkit-button-css';
            toolkitButtonCSS.textContent = `
/* Ensure tooltip wrapper doesn't break width */
#sai-toolkit-sidebar-btn[data-tooltip-id],
div.w-full > [data-tooltip-id]:has(#sai-toolkit-sidebar-btn) {
    display: block !important;
    width: 100%;
}

/* Hide S.AI Toolkit button text when sidebar is collapsed */
nav[style*="width: 54px"] #sai-toolkit-sidebar-btn .toolkit-button-text,
nav[style*="width: 54px"] #sai-toolkit-sidebar-btn p {
    display: none !important;
}

/* Ensure text is visible when sidebar is expanded */
nav:not([style*="width: 54px"]) #sai-toolkit-sidebar-btn .toolkit-button-text,
nav:not([style*="width: 54px"]) #sai-toolkit-sidebar-btn p {
    display: inline !important;
}
`;
            document.head.appendChild(toolkitButtonCSS);
            toolkitButtonCssInjected = true;
            debugLog('[Core] Button CSS injected');
        }

        // Try to inject mobile button (watches for Like button to appear)
        injectToolkitMobileButton();

        // Try to inject chat export button (only on chat pages)
        injectChatExportButton();

        // Try to inject NSFW toggle button (only on chat pages, after export button)
        injectNSFWToggleButton();

        // Try to inject the Auto Story Mode toggle (only on Story Mode pages)
        injectAutoStoryToggleButton();

        // NOTE: previously we scheduled 20 retry setTimeouts (5 delays × 4 buttons) on
        // every mutation batch. The buttonCheckInterval below already re-injects any
        // missing buttons every 2s, so those retries were redundant churn. Removed.

        // Instead of heavy MutationObservers, use lightweight periodic checks
        // Check every 2 seconds if buttons still exist and text element is present
        // Only create interval once to prevent memory leak from multiple intervals
        if (!buttonCheckInterval) {
            buttonCheckInterval = setInterval(() => {
            // Skip ALL checks during resize to prevent React conflicts
            if (isResizing || sidebarWidthTransitionPending) {
                return;
            }
            
            // Skip sidebar button checks on mobile - sidebar doesn't exist below 600px
            if (window.innerWidth >= 600) {
                const sidebarButton = document.getElementById('sai-toolkit-sidebar-btn');
                if (sidebarButton) {
                    // Check if text element exists, if not re-add it
                    const iconContainer = sidebarButton.querySelector('.flex.items-center.gap-2');
                    if (iconContainer && !iconContainer.querySelector('.toolkit-button-text')) {
                        let textElement = document.createElement('p');
                        textElement.className = 'font-sans text-decoration-skip-ink-none text-underline-position-from-font text-label-lg font-regular text-left truncate toolkit-button-text';
                        textElement.textContent = 'S.AI Toolkit';
                        iconContainer.appendChild(textElement);
                        debugLog('[Core] Text element re-added after React removed it');
                    }
                } else {
                    // Button missing, try to re-inject (debounced for resize safety)
                    const helpIcon = document.querySelector('svg.lucide-info');
                    if (helpIcon) {
                        debouncedButtonInjection();
                    }
                }
            }
            
            // Check mobile button
            const mobileButton = document.getElementById('sai-toolkit-mobile-btn');
            if (!mobileButton) {
                const likeButton = document.querySelector('button[aria-label="ThumbsUp-button"]');
                if (likeButton) {
                    injectToolkitMobileButton();
                }
            }
            
            // Check export button (only on chat pages - supports both /chat/ and /{language}/chat/)
            if (isOnChatPage()) {
                const exportButton = document.getElementById('sai-export-btn');
                if (!exportButton) {
                    injectChatExportButton();
                }

                // Check NSFW toggle button
                const nsfwButton = document.getElementById('sai-nsfw-btn');
                if (!nsfwButton) {
                    injectNSFWToggleButton();
                }

                // Message Recovery: if the "Oops!" banner is on screen and
                // we have a saved failed message, offer the recover button.
                // Cheap no-op when the feature is off or the banner is gone.
                injectRecoverButtonIfNeeded();
            }

            // Check Auto Story Mode toggle + export button (only on Story Mode pages)
            if (isStoryMode()) {
                const autoStoryButton = document.getElementById('sai-auto-story-btn');
                if (!autoStoryButton) {
                    injectAutoStoryToggleButton();
                }

                const storyExportButton = document.getElementById('sai-export-btn');
                if (!storyExportButton) {
                    injectChatExportButton();
                }
            }
            }, TIMING.PERIODIC_CHECK); // Check periodically instead of on every DOM mutation
        }
    });

    // Wait for body before starting observer (fixes middle-click new tab issue)
    waitForBody().then((body) => {
        debugLog('[Core] document.body available, starting main observer');
        observer.observe(body, {
            childList: true,
            subtree: true
        });
        
        // Trigger initial button injection now that body exists
        injectToolkitSidebarButton();
        injectToolkitMobileButton();
        injectChatExportButton();
        injectNSFWToggleButton();
        injectAutoStoryToggleButton();

        // Also schedule retry attempts in case page content loads slowly
        // Use scheduleInjection so these can be cancelled on resize
        TIMING.BUTTON_INJECT_RETRIES.forEach(delay => {
            scheduleInjection(() => {
                injectToolkitSidebarButton();
                injectToolkitMobileButton();
                injectChatExportButton();
                injectNSFWToggleButton();
                injectAutoStoryToggleButton();
            }, delay);
        });
    }).catch((err) => {
        console.error('[Core] Failed to wait for body:', err);
        // Last resort: try anyway after a delay
        setTimeout(() => {
            if (document.body) {
                debugLog('[Core] Retrying observer setup after error');
                observer.observe(document.body, { childList: true, subtree: true });
                injectToolkitSidebarButton();
                injectToolkitMobileButton();
                injectChatExportButton();
                injectNSFWToggleButton();
                injectAutoStoryToggleButton();
            }
        }, 2000);
    });

    // Observer to add generation stats to messages
    // Debounce to prevent excessive processing during rapid DOM changes
    let statsProcessingTimeout = null;
    let pendingMutations = false;
    
    const messageObserver = new MutationObserver(async function(mutations) {
        // Quick check: Only process if we see relevant mutations (message wrappers)
        let hasRelevantMutation = false;
        for (const mutation of mutations) {
            // Only care about added nodes that could be message wrappers
            if (mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && (node.classList?.contains('mb-lg') || node.querySelector?.('.mb-lg'))) {
                        hasRelevantMutation = true;
                        break;
                    }
                }
            }
            if (hasRelevantMutation) break;
        }
        
        if (!hasRelevantMutation) return;
        
        // Debounce: Only process after 150ms of no mutations (Issue #12)
        pendingMutations = true;
        if (statsProcessingTimeout) {
            clearTimeout(statsProcessingTimeout);
        }
        
        statsProcessingTimeout = setTimeout(() => {
            pendingMutations = false;
            processMessagesForStats(true);
        }, TIMING.MUTATION_DEBOUNCE);
    });

    // Special function to insert stats for a regenerated message
    // This is needed because regenerations REPLACE the message content, not add a new element
    // So processMessagesForStats can't find them by DOM index
    // Note: statsInsertedForMessageIds and statsInsertionInProgress are defined earlier in the file
    // Note: statsFailedForWrappers is declared next to statsInsertedForMessageIds (it's reassigned by the SAI_MESSAGES_LOADED handler)
    let lastConversationIdForStatsSet = null;

    // Memory optimization: Maximum tracked message IDs to prevent unbounded growth
    const MAX_STATS_TRACKING = 200;

    // Helper to limit Set size - removes oldest entries when over limit
    function limitSetSize(set, maxSize) {
        if (set.size > maxSize) {
            // Only remove enough to get back to maxSize (Sets maintain insertion order)
            const excess = set.size - maxSize;
            const iterator = set.values();
            for (let i = 0; i < excess; i++) {
                set.delete(iterator.next().value);
            }
        }
    }
    
    // Sequential retry wrapper - prevents race conditions from browser timer throttling
    // When a tab is in background, multiple setTimeout calls can fire at once on restore
    async function insertStatsWithRetry(messageId, model, settings, createdAt, attempt = 1) {
        const maxAttempts = 4;
        // First attempt is immediate (0ms delay), then use increasing delays for retries
        // This ensures we try to insert stats BEFORE processMessagesForStats runs (150ms debounce)
        const delays = [0, 500, 1000, 1500]; // Delay before each attempt

        if (attempt > maxAttempts) {
            debugLog('[Stats RETRY] Max attempts reached for message:', messageId?.substring(0, 8));
            // Decrement pending count since we're done trying (failed)
            if (pendingNewMessageCount > 0) {
                pendingNewMessageCount--;
                debugLog('[Stats RETRY] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
            }
            return;
        }

        // Wait before attempting (first attempt is immediate with 0ms delay)
        const delay = delays[attempt - 1] || 500;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Check if already successfully inserted (by this or another call)
        if (statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats RETRY] Already inserted, stopping retries for:', messageId?.substring(0, 8));
            // Decrement pending count since insertion is complete
            if (pendingNewMessageCount > 0) {
                pendingNewMessageCount--;
                debugLog('[Stats RETRY] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
            }
            return;
        }
        
        // Try to insert
        const success = await insertStatsForRegeneratedMessage(messageId, model, settings, createdAt);
        
        // If failed and not yet inserted, retry
        if (!success && !statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats RETRY] Attempt', attempt, 'failed, will retry for:', messageId?.substring(0, 8));
            insertStatsWithRetry(messageId, model, settings, createdAt, attempt + 1);
        }
    }
    
    async function insertStatsForRegeneratedMessage(messageId, model, settings, createdAt) {
        debugLog('[Stats REGEN] Attempting to insert stats for regenerated message:', messageId?.substring(0, 8));
        
        // Clear the sets if we're in a different conversation (handles page navigation)
        if (currentConversationId && currentConversationId !== lastConversationIdForStatsSet) {
            debugLog('[Stats REGEN] Conversation changed, clearing insertion tracking sets');
            statsInsertedForMessageIds.clear();
            statsInsertionInProgress.clear();
            pendingNewMessageCount = 0; // Reset pending count on conversation change
            lastConversationIdForStatsSet = currentConversationId;
        }
        
        // Skip if already successfully inserted
        if (statsInsertedForMessageIds.has(messageId)) {
            debugLog('[Stats REGEN] Stats already inserted for this message ID, skipping');
            return true; // Already done, consider it a success
        }
        
        // Skip if another call is currently processing this message (prevents parallel execution)
        if (statsInsertionInProgress.has(messageId)) {
            debugLog('[Stats REGEN] Another call is already processing this message ID, skipping');
            return false; // Let the other call handle it
        }
        
        // Mark as in-progress to prevent parallel calls
        statsInsertionInProgress.add(messageId);
        
        const cache = window.__toolkitStorageCache;
        const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
        const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
        const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);
        const compactStats = cache ? await cache.get('compactStats', false) : await storage.get('compactStats', false);
        const showMessageIds = cache ? await cache.get(SHOW_MESSAGE_IDS_KEY, false) : await storage.get(SHOW_MESSAGE_IDS_KEY, false);

        // Cache the highlight model changes setting globally for synchronous access
        window.__highlightModelChanges = cache ? await cache.get('highlightModelChanges', false) : await storage.get('highlightModelChanges', false);
        
        // Cache auto-regeneration settings globally for synchronous access
        window.__autoRegenOnMismatch = cache ? await cache.get('autoRegenOnMismatch', false) : await storage.get('autoRegenOnMismatch', false);
        window.__autoRegenOnShort = cache ? await cache.get('autoRegenOnShort', false) : await storage.get('autoRegenOnShort', false);
        window.__autoRegenMaxAttempts = cache ? await cache.get('autoRegenMaxAttempts', 1) : await storage.get('autoRegenMaxAttempts', 1);

        if (!statsEnabled && !timestampEnabled && !showMessageIds) {
            debugLog('[Stats REGEN] Neither stats, timestamp, nor message IDs enabled, skipping');
            // Remove from in-progress so future attempts can try again if settings change
            statsInsertionInProgress.delete(messageId);
            return true; // Not an error, just nothing to do
        }
        
        let targetBubble = null;
        let targetCounterEl = null;
        const wrappers = Array.from(document.querySelectorAll('div.w-full.flex.mb-lg'));
        const candidates = [];
        for (const wrapper of wrappers) {
            const counter = findVersionCounter(wrapper);
            if (counter ? resolveVersionMessageId(counter) === messageId : verifiedDomMessageId(wrapper) === messageId) {
                candidates.push({ wrapper, counter });
            }
        }
        if (candidates.length === 1) {
            const { wrapper, counter } = candidates[0];
            targetCounterEl = counter;
            targetBubble = wrapper.querySelector('div[class*="bg-gray-4"][class*="rounded"], div[class*="px-\\[13px\\]"]');
        }
        // Never assign a new ID to the last/highest-version bubble by guessing.
        // The regular scan can backfill an unversioned message from the history map.

        if (!targetBubble) {
            debugLog('[Stats REGEN] Could not find target message bubble (neither version counter nor fallback worked)');
            // Remove from in-progress so later retry attempts can try again
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        debugLog('[Stats REGEN] Found target bubble for message');

        const messageWrapper = targetBubble.closest('div.w-full.flex.mb-lg');

        // Find the header container (supports both gap-md and gap-0)
        const headerContainer = targetBubble.querySelector('div.flex.justify-between.items-center.gap-md, div.flex.justify-between.items-center.gap-0, div.flex.justify-between.items-center');
        if (!headerContainer) {
            debugLog('[Stats REGEN] Could not find header container');
            // Remove from in-progress so later retry attempts can try again
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        // Check if stats already exist in DOM
        let statsDiv = headerContainer.querySelector('.generation-stats');
        
        // Build display lines
        let displayLines = [];
        
        // Get full stats from storage (has the flattened settings)
        const fullStats = await getStatsForMessage(messageId);
        debugLog('[Stats REGEN] Full stats from storage:', fullStats);
        
        const hasSettings = fullStats?.max_tokens !== null && fullStats?.max_tokens !== undefined;
        const hasModel = fullStats?.model || model;
        const hasTimestamp = fullStats?.timestamp || createdAt;
        
        if (statsEnabled && hasModel) {
            let modelDisplay = fullStats?.model || model;
            if (!showModelDetails && modelDisplay && modelDisplay.includes('→')) {
                modelDisplay = modelDisplay.split('→')[0].trim();
            }
            
            if (hasSettings) {
                displayLines.push(modelDisplay);
                displayLines.push(compactStats
                    ? `${fullStats.max_tokens} | ${fullStats.temperature.toFixed(2)} | ${fullStats.top_p} | ${fullStats.top_k}`
                    : `Tokens: ${fullStats.max_tokens} | Temp: ${fullStats.temperature.toFixed(2)} | Top P: ${fullStats.top_p} | Top K: ${fullStats.top_k}`);
            } else if (modelDisplay) {
                displayLines.push(modelDisplay);
            }
        }
        
        if (timestampEnabled && hasTimestamp) {
            const timestamp = await formatTimestamp(fullStats?.timestamp || createdAt);
            if (timestamp) {
                displayLines.push(withStoryMessageNumber(timestamp, messageId));
            }
        }

        if (showMessageIds && messageId) {
            displayLines.push(`ID: ${messageId}`);
        }

        if (displayLines.length === 0) {
            debugLog('[Stats REGEN] No displayable data');
            // Remove from in-progress, allow retries (data might not be in storage yet)
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        
        const displayText = displayLines.join('<br>');

        // The awaits above let processMessagesForStats insert its own block after we
        // took our first look. If the user switched this message to an older version in
        // the meantime, this request is stale: writing it now would relabel the block
        // that belongs to the version they are now viewing. Leave that to the scan.
        if (targetCounterEl) {
            const liveMatch = targetCounterEl.isConnected && targetCounterEl.textContent.trim().match(/^(\d+)\/(\d+)$/);
            if (!liveMatch) {
                // React re-rendered the counter (or it is mid-update): we can't verify the
                // displayed version, so let insertStatsWithRetry try again rather than
                // treating this as done.
                debugLog('[Stats REGEN] Version counter not verifiable yet, will retry');
                statsInsertionInProgress.delete(messageId);
                return false;
            }
            if (resolveVersionMessageId(targetCounterEl) !== messageId) {
                debugLog('[Stats REGEN] Displayed version changed while awaiting storage, abandoning stale insert');
                statsInsertionInProgress.delete(messageId);
                if (pendingNewMessageCount > 0) pendingNewMessageCount--;
                return true;
            }
        }

        if (!targetBubble.isConnected || !headerContainer.isConnected ||
            (!targetCounterEl && verifiedDomMessageId(messageWrapper || targetBubble) !== messageId)) {
            statsInsertionInProgress.delete(messageId);
            return false;
        }
        // Re-read the live DOM so we update the block that is actually attached
        // (not a stale or removed one) instead of duplicating.
        statsDiv = headerContainer.querySelector('.generation-stats');

        if (!statsDiv) {
            // Create new stats div
            statsDiv = document.createElement('div');
            statsDiv.className = 'generation-stats';

            // Check if we're in story mode for different positioning
            const inStoryMode = isStoryMode();
            
            if (inStoryMode) {
                // In story mode: position above the message, inside the container
                statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 4px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                // Find the inner flex-col container and insert inside it
                const innerContainer = headerContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                if (innerContainer) {
                    // Insert stats as first child inside the container
                    innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                } else {
                    // Fallback: insert at the top of header
                    headerContainer.insertBefore(statsDiv, headerContainer.firstChild);
                }
            } else {
                // Normal mode: position to the right in the header
                statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                
                // Insert before the menu button container
                const menuButtonContainer = headerContainer.querySelector('.relative');
                if (menuButtonContainer) {
                    // menuButtonContainer may be a nested descendant; insertBefore needs a direct child
                    headerContainer.insertBefore(
                        statsDiv,
                        [...headerContainer.children].find(
                            child => child.contains(menuButtonContainer)
                        ) || null
                    );
                    headerContainer.style.setProperty('gap', '4px', 'important');
                } else {
                    headerContainer.appendChild(statsDiv);
                }
            }
        }
        
        // Set the content and version ID
        statsDiv.dataset.versionId = messageId;
        safeSetHTML(statsDiv, displayText);
        
        // Apply model change indicators after this new message is inserted
        applyModelChangeIndicators();
        
        // Mark as successfully inserted (prevents future retries)
        statsInsertedForMessageIds.add(messageId);
        limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
        // Remove from in-progress
        statsInsertionInProgress.delete(messageId);
        // Decrement pending count since insertion is complete
        if (pendingNewMessageCount > 0) {
            pendingNewMessageCount--;
            debugLog('[Stats REGEN] Decremented pendingNewMessageCount to:', pendingNewMessageCount);
        }

        debugLog('[Stats REGEN] Successfully inserted/updated stats for regenerated message');
        return true;
    }

    // Separate function to process messages (can be called multiple times)
    // This unified function handles all stats injection to avoid duplication and inconsistency
    // skipVersionCounterMessages: if true, skip messages with version counters (for new message handling)
    //                             if false, process all messages (for initial page load)
    // Map a "current/total" version counter element to the message ID of the version
    // it is displaying, via alternativeMessageGroups. Returns null if unresolvable.
    // A version count is not a message identity. Only resolve a group from a
    // known message ID, or a history position corroborated by native DOM IDs.
    function versionGroupForId(id) {
        if (!id) return null;
        let found = null;
        for (const [prevId, group] of Object.entries(alternativeMessageGroups)) {
            if (!group.some(entry => entry.id === id)) continue;
            if (found !== null && found !== prevId) return null;
            found = prevId;
        }
        return found;
    }

    function findVersionCounter(wrapper) {
        return Array.from(wrapper.querySelectorAll('p.text-label-md')).find(
            node => /^\d+\/\d+$/.test(node.textContent.trim())) || null;
    }

    function verifiedDomMessageId(wrapper) {
        if (!wrapper) return null;
        const ids = new Set();
        const own = wrapper.getAttribute('data-message-id');
        if (own) ids.add(own);
        for (const node of wrapper.querySelectorAll('[data-message-id]')) {
            const id = node.getAttribute('data-message-id');
            if (id) ids.add(id);
        }
        // Only exact message objects attached to this wrapper, not arbitrary
        // UUIDs extracted from handler source or unrelated ancestors.
        for (const key of Object.keys(wrapper)) {
            if (!/^__react(?:Props|InternalInstance|Fiber)/.test(key)) continue;
            const props = wrapper[key];
            for (const message of [props?.message, props?.children?.props?.message, props?.memoizedProps?.message]) {
                if (typeof message?.id === 'string') ids.add(message.id);
            }
        }
        return ids.size === 1 ? ids.values().next().value : ids.size > 1 ? false : null;
    }

    function verifiedHistoryId(wrapper) {
        // React's private props aren't always visible from an isolated world.
        // Permit the existing history-index fallback only if all available DOM
        // anchors agree with that alignment and at least one anchor exists.
        const wrappers = Array.from(document.querySelectorAll('div.w-full.flex.mb-lg'));
        const index = wrappers.indexOf(wrapper);
        const count = Object.keys(messageIdToIndexMap).length;
        if (index < 0 || wrappers.length > count || pendingNewMessageCount > 0) return null;
        const offset = count - wrappers.length;
        let anchors = 0;
        for (let i = 0; i < wrappers.length; i++) {
            const actual = verifiedDomMessageId(wrappers[i]);
            if (actual === false) return null;
            if (!actual) continue;
            const expected = messageIdToIndexMap[offset + i];
            if (!expected) return null;
            if (actual !== expected) {
                const actualGroup = versionGroupForId(actual);
                if (!actualGroup || actualGroup !== versionGroupForId(expected)) return null;
            }
            anchors++;
        }
        return anchors ? messageIdToIndexMap[offset + index] || null : null;
    }

    function resolveVersionMessageId(versionCounter) {
        const match = versionCounter?.textContent.trim().match(/^(\d+)\/(\d+)$/);
        if (!match) return null;
        const current = Number(match[1]);
        const total = Number(match[2]);
        if (current < 1 || current > total || total < 1) return null;
        const wrapper = versionCounter.closest('div.w-full.flex.mb-lg');
        if (!wrapper) return null;
        const routeId = getCurrentConversationId();
        if (routeId && currentConversationId && routeId !== currentConversationId) return null;
        const explicitId = verifiedDomMessageId(wrapper);
        if (explicitId === false) return null;
        if (total === 1) return explicitId || verifiedHistoryId(wrapper);
        let groupKey = versionGroupForId(explicitId);
        if (!groupKey && !explicitId) groupKey = versionGroupForId(verifiedHistoryId(wrapper));
        if (!groupKey) return null;
        const group = alternativeMessageGroups[groupKey];
        // Require the complete group to be known. Do not infer missing versions.
        if (!Array.isArray(group) || group.length !== total) return null;
        return group[current - 1]?.id || null;
    }

    async function processMessagesForStats(skipVersionCounterMessages = false) {
        debugLog('[Stats DISPLAY] ========== processMessagesForStats CALLED ==========');
        debugLog('[Stats DISPLAY] skipVersionCounterMessages:', skipVersionCounterMessages);
        debugLog('[Stats DISPLAY] Call stack:', new Error().stack);
        
        // Perf: only read the three settings needed to decide whether to bail.
        // Defer the rest until we know we're actually going to process messages —
        // this is a hot path called on every batch of message-wrapper mutations.
        const cache = window.__toolkitStorageCache;
        const statsEnabled = cache ? await cache.get('showGenerationStats', false) : await storage.get('showGenerationStats', false);
        const timestampEnabled = cache ? await cache.get('showTimestamp', false) : await storage.get('showTimestamp', false);
        const showMessageIds = cache ? await cache.get(SHOW_MESSAGE_IDS_KEY, false) : await storage.get(SHOW_MESSAGE_IDS_KEY, false);

        // If none are enabled, no need to process
        if (!statsEnabled && !timestampEnabled && !showMessageIds) return;

        const showModelDetails = cache ? await cache.get('showModelDetails', true) : await storage.get('showModelDetails', true);
        const compactStats = cache ? await cache.get('compactStats', false) : await storage.get('compactStats', false);

        // Cache the highlight model changes setting globally for synchronous access
        window.__highlightModelChanges = cache ? await cache.get('highlightModelChanges', false) : await storage.get('highlightModelChanges', false);

        // Cache auto-regeneration settings globally for synchronous access
        window.__autoRegenOnMismatch = cache ? await cache.get('autoRegenOnMismatch', false) : await storage.get('autoRegenOnMismatch', false);
        window.__autoRegenOnShort = cache ? await cache.get('autoRegenOnShort', false) : await storage.get('autoRegenOnShort', false);
        window.__autoRegenMaxAttempts = cache ? await cache.get('autoRegenMaxAttempts', 1) : await storage.get('autoRegenMaxAttempts', 1);

        debugLog('[Stats DISPLAY] Stats enabled:', statsEnabled, 'Timestamp enabled:', timestampEnabled, 'Model details:', showModelDetails, 'Message IDs:', showMessageIds, 'Highlight model changes:', window.__highlightModelChanges);
        
        const messageWrappers = document.querySelectorAll('div.w-full.flex.mb-lg');

        debugLog('[Stats] Found message wrappers:', messageWrappers.length);

        // Calculate total messages in the combined index map
        const totalMessages = Object.keys(messageIdToIndexMap).length;
        debugLog('[Stats] Total messages in combined index map:', totalMessages);

        // Calculate offset: if page shows fewer messages than stored, offset to the end
        const messagesOnPage = messageWrappers.length;
        const storageOffset = Math.max(0, totalMessages - messagesOnPage);
        debugLog('[Stats] Messages on page:', messagesOnPage, 'Storage offset:', storageOffset);

        // Process messages in reverse order (bottom to top, newest first)
        // This ensures the most recent messages get correct stats even if there's an index issue
        const wrappersArray = Array.from(messageWrappers).reverse();
        let messageIndex = messagesOnPage - 1; // Start from the last message

        for (const wrapper of wrappersArray) {
            // Skip wrappers that we've already failed to extract IDs from
            // This prevents endless retries on messages that don't have IDs yet
            if (statsFailedForWrappers.has(wrapper) && !findVersionCounter(wrapper)) {
                debugLog('[Stats] Skipping wrapper that previously failed ID extraction');
                messageIndex--;
                continue;
            }

            // Check if this is a bot message (has character link) or user message
            // In Story Mode, there's no chatbot link, so we need alternative detection
            // Use contains selector to support localized URLs like /pt/chatbot/
            const characterLink = wrapper.querySelector('a[href*="/chatbot/"]');
            let isBotMessage = !!characterLink;
            
            // Story Mode fallback: check for bot-specific UI elements or message styling
            // Bot messages in Story Mode have different styling (e.g., rounded corners)
            if (!isBotMessage && isStoryMode()) {
                // In Story Mode, check message bubble styling to detect bot vs user
                // Bot messages typically have left-aligned rounded corners, user has right-aligned
                const messageBubble = wrapper.querySelector('.rounded-\\[4px_20px_20px_20px\\]');
                if (messageBubble) {
                    isBotMessage = true;
                }
            }
            debugLog('[Stats] Processing message, isBotMessage:', isBotMessage, 'messageIndex:', messageIndex);

            // Skip messages with version counters when processing new messages
            // (they're handled by insertStatsForRegeneratedMessage in that case)
            // But on initial page load, we need to process them here
            const versionCounter = findVersionCounter(wrapper);
            const hasVersionCounter = versionCounter && /^\d+\/\d+$/.test(versionCounter.textContent.trim());
            const displayedVersionId = hasVersionCounter ? resolveVersionMessageId(versionCounter) : null;
            if (hasVersionCounter) isBotMessage = true;

            // Update selector to match new DOM structure - action container has gap-0 and may have flex-row-reverse
            const actionContainer = wrapper.querySelector('.flex.justify-between.items-center.gap-0, .flex.justify-between.items-center');
            
            if (!actionContainer) {
                debugLog('[Stats] No action container found!');
                messageIndex--;
                continue;
            }
            
            // Check if stats already exist. In Story Mode the stats div is
            // inserted into an ANCESTOR container (see the insertion below),
            // not inside actionContainer, so also look there — otherwise this
            // guard never sees an existing Story Mode block and a later pass
            // inserts a duplicate. That second pass happens easily during a
            // live auto-run: the in-memory statsInsertedForMessageIds guard
            // misses whenever extractMessageId falls back to the index map and
            // the growing map shifts storageOffset, resolving an old wrapper to
            // a different id. Detecting the actual DOM node is resolution-proof.
            let existingStatsDiv = actionContainer.querySelector('.generation-stats');
            if (!existingStatsDiv && isStoryMode()) {
                const storyStatsContainer = actionContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                if (storyStatsContainer) {
                    existingStatsDiv = storyStatsContainer.querySelector(':scope > .generation-stats');
                }
            }
            const existingNumber = existingStatsDiv?.dataset.versionId && getMessageNumber(existingStatsDiv.dataset.versionId);
            const staleStoryNumber = isStoryMode() && timestampEnabled && existingNumber && existingStatsDiv && Number(existingStatsDiv.textContent.match(/[|] #([0-9]+)/)?.[1]) !== existingNumber;
            if (staleStoryNumber || (hasVersionCounter && (!displayedVersionId || (existingStatsDiv && existingStatsDiv.dataset.versionId !== displayedVersionId)))) {
                if (existingStatsDiv?.dataset.versionId) {
                    statsInsertedForMessageIds.delete(existingStatsDiv.dataset.versionId);
                    existingStatsDiv.remove();
                    existingStatsDiv = null;
                }
                delete actionContainer.dataset.statsFinalized;
            }
            if (hasVersionCounter && !displayedVersionId) {
                messageIndex--;
                continue;
            }
            if (existingStatsDiv) {
                debugLog('[Stats] Found existing stats div');
                
                // OPTIMIZATION: If stats are marked as finalized (with arrow format), skip entirely
                // This prevents unnecessary storage reads for every message on every mutation
                if (actionContainer.dataset.statsFinalized === 'true') {
                    debugLog('[Stats] Stats already finalized, skipping without storage check');
                    messageIndex--;
                    continue;
                }
                
                // Check if we need to update the stats (e.g., from partial to full model format)
                if (isBotMessage) {
                    let messageId = displayedVersionId || extractMessageId(wrapper);
                    debugLog('[Stats] Bot message, messageId:', messageId);
                    
                    // Try fallback to index map if extraction failed
                    if (!messageId) {
                        // Calculate the correct index: page shows newest messages, so offset from end of storage
                        // Use cached storageOffset calculated at start of function
                        const correctedIndex = storageOffset + messageIndex;
                        
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            messageId = messageIdToIndexMap[correctedIndex];
                            debugLog('[Stats] Using fallback messageId from index map:', messageId);
                        }
                    }
                    
                    if (messageId) {
                        const latestStats = await getStatsForMessage(messageId);
                        debugLog('[Stats] Latest stats from storage:', latestStats);
                        if (latestStats?.model && latestStats.model.includes('→')) {
                            // We have full format in storage but need to check if it's displayed
                            const existingText = existingStatsDiv.textContent;
                            if (DEBUG_MODE) {
                                console.log('[Stats] Storage has arrow format:', latestStats.model);
                                console.log('[Stats] Display shows:', existingText);
                            }
                            if (!existingText.includes('→')) {
                                // Stats are outdated - remove and re-insert
                                debugLog('[Stats] OUTDATED! Removing old stats div and re-inserting...');
                                // Forget the removed block's IDs too, otherwise the
                                // "already handled" guard below skips re-insertion and
                                // the message is left with no stats at all.
                                statsInsertedForMessageIds.delete(messageId);
                                if (existingStatsDiv.dataset.versionId) {
                                    statsInsertedForMessageIds.delete(existingStatsDiv.dataset.versionId);
                                }
                                // The re-insert below resolves the displayed version through
                                // the version counter, which can pick yet another ID.
                                if (hasVersionCounter && versionCounter) {
                                    const displayedVersionId = resolveVersionMessageId(versionCounter);
                                    if (displayedVersionId) statsInsertedForMessageIds.delete(displayedVersionId);
                                }
                                existingStatsDiv.remove();
                                // Don't skip - let it fall through to re-insert
                            } else {
                                // Mark as finalized so we don't check again
                                actionContainer.dataset.statsFinalized = 'true';
                                debugLog('[Stats] Stats already up-to-date, marking as finalized');
                                messageIndex--;
                                continue;
                            }
                        } else {
                            debugLog('[Stats] Storage does not have arrow format, skipping update');
                            debugLog('[Stats] Stats already present, skipping');
                            messageIndex--;
                            continue;
                        }
                    } else {
                        debugLog('[Stats] No messageId extracted, skipping');
                        debugLog('[Stats] Stats already present, skipping');
                        messageIndex--;
                        continue;
                    }
                } else {
                    debugLog('[Stats] User message, skipping');
                    debugLog('[Stats] Stats already present, skipping');
                    messageIndex--;
                    continue;
                }
            }
            
            if (actionContainer.dataset.statsProcessing) {
                debugLog('[Stats] Already being processed (race condition), skipping');
                messageIndex--;
                continue;
            }
            
            // Mark as processing immediately to prevent race conditions
            actionContainer.dataset.statsProcessing = 'true';
            
            // Wrap entire processing in try/catch to ensure cleanup on errors
            try {
                // In Story Mode, we may misdetect bot messages as user messages due to DOM differences
                // We'll do a preliminary check here and potentially correct isBotMessage later based on stored role
                let effectiveIsBotMessage = isBotMessage;
                
                // Story Mode: If we can extract a messageId and check its role, use that for detection
                if (!isBotMessage && isStoryMode()) {
                    let preCheckMessageId = extractMessageId(wrapper);
                    if (!preCheckMessageId) {
                        const correctedIndex = storageOffset + messageIndex;
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            preCheckMessageId = messageIdToIndexMap[correctedIndex];
                        }
                    }
                    if (preCheckMessageId) {
                        const preCheckStats = await getStatsForMessage(preCheckMessageId);
                        // If in-memory bot set, stored role, or generation settings say bot — treat as bot message
                        if (botMessageIds.has(preCheckMessageId) || preCheckStats?.role === 'bot' || (preCheckStats?.max_tokens !== null && preCheckStats?.max_tokens !== undefined)) {
                            effectiveIsBotMessage = true;
                            debugLog('[Stats] Story Mode: Corrected isBotMessage to true based on stored role/stats');
                        }
                    }
                }
                
                if (effectiveIsBotMessage) {
                // Bot message - show full stats
                let messageId = extractMessageId(wrapper);
                
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] ========== PROCESSING BOT MESSAGE ==========');
                    debugLog('[Stats DISPLAY] Extracted messageId:', messageId);
                    debugLog('[Stats DISPLAY] messageIndex:', messageIndex);
                    debugLog('[Stats DISPLAY] hasVersionCounter:', hasVersionCounter);
                }
                
                // A versioned message must resolve to its verified group and version.
                if (hasVersionCounter) messageId = displayedVersionId;

                // Calculate the correct index: page shows newest messages, so offset from end of storage
                if (!messageId) {
                    // Use cached storageOffset calculated at start of function
                    const correctedIndex = storageOffset + messageIndex;
                    
                    if (DEBUG_MODE) {
                        debugLog('[Stats DISPLAY] Fallback - correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    }
                    debugLog('[Stats] Extracted messageId:', messageId, 'messageIndex:', messageIndex, 'correctedIndex:', correctedIndex, 'map has:', messageIdToIndexMap[correctedIndex]);
                    if (messageIdToIndexMap[correctedIndex] !== undefined) {
                        messageId = messageIdToIndexMap[correctedIndex];
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] Using mapped messageId:', messageId);
                        }
                        debugLog('[Stats] Using mapped messageId:', messageId);
                    }
                }
                
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Final messageId to lookup:', messageId);
                }
                
                // Skip if this message was already handled or is being handled by insertStatsWithRetry
                // This prevents duplicate stats when both paths try to insert
                if (messageId && ((!hasVersionCounter && statsInsertedForMessageIds.has(messageId)) || statsInsertionInProgress.has(messageId))) {
                    debugLog('[Stats DISPLAY] Message already handled or in progress by insertStatsForRegeneratedMessage, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Retrieved from storage:', generationStats);
                    debugLog('[Stats DISPLAY] Timestamp from storage:', generationStats?.timestamp);
                    debugLog('[Stats DISPLAY] Timestamp as Date:', generationStats?.timestamp ? new Date(generationStats.timestamp).toISOString() : 'null');
                }
                debugLog('[Stats] Got stats from storage:', generationStats);
                if (!hasVersionCounter && !generationStats && pendingMessageStats) generationStats = pendingMessageStats;
                if (!hasVersionCounter && !generationStats && lastGenerationSettings) generationStats = lastGenerationSettings;
                debugLog('[Stats] Final stats:', generationStats);
                
                if (!generationStats) {
                    debugLog('[Stats] No stats found, skipping message');
                    // If we couldn't extract a messageId, mark this wrapper as failed
                    // to prevent endless retries on every mutation
                    // BUT: Only mark as failed if there are no pending new messages
                    // New messages may not have their data-message-id set yet
                    if (!messageId && pendingNewMessageCount === 0) {
                        statsFailedForWrappers.add(wrapper);
                        debugLog('[Stats] Marked wrapper as failed (no message ID)');
                    } else if (!messageId) {
                        debugLog('[Stats] Not marking wrapper as failed - there are', pendingNewMessageCount, 'pending new messages');
                    }
                    // Clear the processing flag so it can be retried later if messageId becomes available
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                debugLog('[Stats] Creating stats div...');
                const statsDiv = document.createElement('div');
                statsDiv.className = 'generation-stats';
                
                // Check if we're in story mode for different positioning
                const inStoryMode = isStoryMode();
                
                if (inStoryMode) {
                    // In story mode: position above the message
                    statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 8px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                } else {
                    // Normal mode: position to the right in the header
                    statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                }
                
                // Add data-version-id to prevent being hidden by the regeneration switcher CSS
                if (messageId) {
                    statsDiv.dataset.versionId = messageId;
                }
                
                debugLog('[Stats] Checking stats content:', generationStats);
                
                // Check for model and settings (new flat format with max_tokens)
                const hasSettings = generationStats.max_tokens !== null && generationStats.max_tokens !== undefined;
                const hasModel = generationStats.model;
                const hasTimestamp = generationStats.timestamp;
                
                // Build display components based on settings
                let displayLines = [];
                
                if (statsEnabled && hasSettings && hasModel) {
                    debugLog('[Stats] Has full stats with settings');
                    const maxTokens = generationStats.max_tokens;
                    const temperature = generationStats.temperature;
                    const topP = generationStats.top_p;
                    const topK = generationStats.top_k;
                    
                    // Process model name based on showModelDetails setting
                    let modelDisplay = generationStats.model;
                    if (!showModelDetails && modelDisplay.includes('→')) {
                        // Truncate to just the requested model (before the arrow)
                        modelDisplay = modelDisplay.split('→')[0].trim();
                    }

                    displayLines.push(modelDisplay);
                    displayLines.push(compactStats
                        ? `${maxTokens} | ${temperature.toFixed(2)} | ${topP} | ${topK}`
                        : `Tokens: ${maxTokens} | Temp: ${temperature.toFixed(2)} | Top P: ${topP} | Top K: ${topK}`);
                }
                
                if (timestampEnabled && hasTimestamp) {
                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (DEBUG_MODE) {
                        debugLog('[Stats DISPLAY] Formatted timestamp:', timestamp);
                        debugLog('[Stats DISPLAY] Input to formatTimestamp was:', generationStats.timestamp);
                    }
                    if (timestamp) {
                        displayLines.push(withStoryMessageNumber(timestamp, messageId));
                    }
                }

                if (showMessageIds && messageId) {
                    displayLines.push(`ID: ${messageId}`);
                }

                // If we have nothing to display, skip
                if (displayLines.length === 0) {
                    debugLog('[Stats] No displayable data, skipping');
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                // Join lines with <br>
                const displayText = displayLines.join('<br>');
                safeSetHTML(statsDiv, displayText);
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Stats div content:', statsDiv.textContent);
                }
                debugLog('[Stats] Stats div innerHTML:', statsDiv.innerHTML);
                
                if (!wrapper.isConnected || !actionContainer.isConnected || (hasVersionCounter &&
                    resolveVersionMessageId(findVersionCounter(wrapper)) !== messageId)) {
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                let leftRacedStatsUntouched = false; // Set when another path's block for a different version is kept
                // Insert positioning based on story mode
                if (inStoryMode) {
                    // In story mode: insert INSIDE the message container as first child
                    // This keeps the stats within the same width constraints as the message
                    const innerContainer = actionContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                    if (innerContainer) {
                        // Belt-and-suspenders against duplicates: if this container
                        // already holds a Story Mode stats block, replace it in place
                        // rather than prepending a second one. The broadened guard
                        // near the top of the loop should already have skipped us, but
                        // this makes a duplicate structurally impossible regardless of
                        // which upstream path (mutation re-run, retry, live event) got
                        // here.
                        const priorStoryStats = innerContainer.querySelector(':scope > .generation-stats');
                        if (priorStoryStats) priorStoryStats.remove();
                        // Insert stats as first child inside the flex-col container
                        statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 4px; width: 100%;';
                        innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] ========== INSERTING STATS DIV (STORY MODE) ==========');
                            debugLog('[Stats DISPLAY] Stats div content before insert:', statsDiv.textContent);
                            debugLog('[Stats DISPLAY] Inserted inside message container as first child');
                        }
                    } else {
                        // Fallback: insert in action container
                        actionContainer.appendChild(statsDiv);
                    }
                } else {
                    // Normal mode: insert in the action container header
                    const menuButtonContainer = actionContainer.querySelector('.relative');
                    debugLog('[Stats] Menu button container:', menuButtonContainer);
                    const racedStatsDiv = actionContainer.querySelector('.generation-stats');
                    if (racedStatsDiv) {
                        // insertStatsForRegeneratedMessage added a block while we awaited
                        // storage. Never add a second one. If it is for the same message (or
                        // unlabeled) refresh it with our content; if it is labeled for a
                        // different version, our snapshot may be stale, so leave it alone
                        // and don't finalize, letting a later scan correct it if needed.
                        const racedVersionId = racedStatsDiv.dataset.versionId;
                        if (!racedVersionId || !messageId || racedVersionId === messageId) {
                            debugLog('[Stats] Stats div appeared during processing, updating it instead of duplicating');
                            safeSetHTML(racedStatsDiv, displayText);
                            if (messageId) {
                                racedStatsDiv.dataset.versionId = messageId;
                            }
                        } else {
                            debugLog('[Stats] Stats div for another version appeared during processing, leaving it untouched');
                            leftRacedStatsUntouched = true;
                        }
                    } else if (menuButtonContainer) {
                        if (DEBUG_MODE) {
                            debugLog('[Stats DISPLAY] ========== INSERTING STATS DIV ==========');
                            debugLog('[Stats DISPLAY] Stats div content before insert:', statsDiv.textContent);
                            debugLog('[Stats DISPLAY] Inserting into action container');
                        }
                        debugLog('[Stats] Inserting stats div...');
                        // menuButtonContainer may be a nested descendant; insertBefore needs a direct child
                        actionContainer.insertBefore(
                            statsDiv,
                            [...actionContainer.children].find(
                                child => child.contains(menuButtonContainer)
                            ) || null
                        );
                        actionContainer.style.setProperty('gap', '4px', 'important');
                    } else {
                        actionContainer.appendChild(statsDiv);
                    }
                }
                
                // Mark this message as having stats inserted to prevent duplicates
                if (messageId) {
                    statsInsertedForMessageIds.add(messageId);
                    limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                    debugLog('[Stats] Added messageId to statsInsertedForMessageIds:', messageId);
                }
                
                // OPTIMIZATION: Mark stats as finalized if they have arrow format
                // This prevents unnecessary storage checks on future mutations
                if (!leftRacedStatsUntouched && generationStats.model && generationStats.model.includes('→')) {
                    actionContainer.dataset.statsFinalized = 'true';
                    debugLog('[Stats] Marked stats as finalized (has arrow format)');
                }
                
                delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                if (DEBUG_MODE) {
                    debugLog('[Stats DISPLAY] Stats div inserted! Final content:', statsDiv.textContent);
                    debugLog('[Stats DISPLAY] Stats div is in DOM:', document.contains(statsDiv));
                    debugLog('[Stats DISPLAY] ===========================================');
                }
                debugLog('[Stats] Stats div inserted successfully!');

                messageIndex--;
            } else {
                // User message - show only timestamp if enabled
                if (!timestampEnabled) {
                    delete actionContainer.dataset.statsProcessing;
                    messageIndex--;
                    continue;
                }
                
                let messageId = extractMessageId(wrapper);
                debugLog('[Stats] User message - extracted messageId:', messageId, 'messageIndex:', messageIndex);
                    
                    // Fallback to combined index map if extraction failed
                    if (!messageId) {
                        const correctedIndex = storageOffset + messageIndex;
                        if (messageIdToIndexMap[correctedIndex] !== undefined) {
                            messageId = messageIdToIndexMap[correctedIndex];
                            debugLog('[Stats] User message - using fallback from combined index map:', messageId);
                        }
                    }
                    
                    let generationStats = messageId ? await getStatsForMessage(messageId) : null;
                    debugLog('[Stats] User message - generationStats:', generationStats);
                    
                    // Skip if this message was already handled or is being handled
                    if (messageId && (statsInsertedForMessageIds.has(messageId) || statsInsertionInProgress.has(messageId))) {
                        debugLog('[Stats] User message already handled or in progress, skipping');
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    // Only display if we have a valid timestamp
                    if (!generationStats?.timestamp) {
                        debugLog('[Stats] User message - no timestamp, skipping');
                        // If we couldn't extract a messageId, mark this wrapper as failed
                        // BUT: Only mark as failed if there are no pending new messages
                        if (!messageId && pendingNewMessageCount === 0) {
                            statsFailedForWrappers.add(wrapper);
                            debugLog('[Stats] Marked user message wrapper as failed (no message ID)');
                        } else if (!messageId) {
                            debugLog('[Stats] Not marking user wrapper as failed - there are', pendingNewMessageCount, 'pending new messages');
                        }
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    const timestamp = await formatTimestamp(generationStats.timestamp);
                    if (!timestamp) {
                        delete actionContainer.dataset.statsProcessing;
                        messageIndex--;
                        continue;
                    }

                    // Create timestamp div for user messages
                    const statsDiv = document.createElement('div');
                    statsDiv.className = 'generation-stats';
                    
                    // Check if we're in story mode for different positioning
                    const inStoryMode = isStoryMode();
                    
                    if (inStoryMode) {
                        // In story mode: position above the message
                        statsDiv.style.cssText = 'display: block; color: #6b7280; font-size: 10px; line-height: 1.4; text-align: right; margin-bottom: 8px; width: 100%; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                    } else {
                        // Normal mode: position to the right in the header
                        statsDiv.style.cssText = 'color: #6b7280; font-size: 10px; margin-left: auto; margin-right: 0; flex-shrink: 0; line-height: 1.4; text-align: right; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;';
                    }
                    
                    // Add data-version-id to prevent being hidden by the regeneration switcher CSS
                    if (messageId) {
                        statsDiv.dataset.versionId = messageId;
                    }

                    // Build display content for user messages
                    let displayLines = [withStoryMessageNumber(timestamp, messageId)];

                    // Add message ID if enabled
                    if (showMessageIds && messageId) {
                        displayLines.push(`ID: ${messageId}`);
                    }

                    safeSetHTML(statsDiv, displayLines.join('<br>'));
                    
                    // Insert positioning based on story mode
                    if (inStoryMode) {
                        // In story mode: insert INSIDE the message container as first child
                        const innerContainer = actionContainer.closest('div.flex.flex-col.gap-0, div.flex.flex-col.gap-md');
                        if (innerContainer) {
                            // Insert stats as first child inside the container
                            innerContainer.insertBefore(statsDiv, innerContainer.firstChild);
                            // Mark this message as having stats inserted
                            if (messageId) {
                                statsInsertedForMessageIds.add(messageId);
                                limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                            }
                            delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                            debugLog('[Stats] User message - timestamp inserted successfully (story mode)');
                        } else {
                            delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                        }
                    } else {
                        // Normal mode: insert in the action container header
                        const menuButtonContainer = actionContainer.querySelector('.relative');
                        if (menuButtonContainer) {
                            // menuButtonContainer may be a nested descendant; insertBefore needs a direct child
                            actionContainer.insertBefore(
                                statsDiv,
                                [...actionContainer.children].find(
                                    child => child.contains(menuButtonContainer)
                                ) || null
                            );
                            actionContainer.style.setProperty('gap', '4px', 'important');
                            // Mark this message as having stats inserted
                            if (messageId) {
                                statsInsertedForMessageIds.add(messageId);
                                limitSetSize(statsInsertedForMessageIds, MAX_STATS_TRACKING); // Memory optimization
                            }
                            delete actionContainer.dataset.statsProcessing; // Remove flag after successful insertion
                            debugLog('[Stats] User message - timestamp inserted successfully');
                        } else {
                            delete actionContainer.dataset.statsProcessing; // Remove flag if insertion fails
                        }
                    }
                    messageIndex--;
                }
            } catch (error) {
                // Ensure cleanup on any error during stats processing
                console.error('[Core] Error processing message stats:', error);
                delete actionContainer.dataset.statsProcessing;
                messageIndex--;
            }
        }
        
        // After all stats are inserted, apply model change indicators
        applyModelChangeIndicators();
    }

    // Initialize: Build index map from stored stats for imported/old messages
    debugLog('[Stats] About to call buildIndexMapFromStats...');
    buildIndexMapFromStats()
        .then(() => {
            debugLog('[Stats] Initialization complete, starting message observer');
        })
        .catch((error) => {
            console.error('[Stats] Error building index map:', error);
        });

    // Perf (Round 3): scope messageObserver to the chat thread container instead of
    // document.body. The container is `[class*="flex-col"][class*="items-center"]`
    // (same selector used elsewhere in this file). When the SPA navigates between
    // chat pages the container unmounts and a new one mounts, so we reattach on
    // location changes. If we can't find the container, we fall back to body —
    // worst case is the pre-Round-3 behavior. The startup setTimeouts at
    // INITIAL_STATS_CHECK / DELAYED_STATS_CHECK call processMessagesForStats
    // directly, so even if a reattach is briefly missed, stats still land.
    let _messageObserverHost = null;

    function findChatContainerForObserver() {
        // Same selector family used by the post-regen reapply observer.
        // Pick the outermost candidate that actually contains message wrappers —
        // this returns the chat scroller, which survives individual message
        // renders. If no wrappers exist yet (empty conversation), prefer the
        // scroller-shaped element with overflow-auto so we still observe the
        // right region. Fall back to document.body as a last resort.
        const candidates = document.querySelectorAll('[class*="flex-col"][class*="items-center"]');
        for (const c of candidates) {
            if (c.querySelector?.('div.w-full.flex.mb-lg')) return c;
        }
        for (const c of candidates) {
            const cls = c.className || '';
            if (typeof cls === 'string' && cls.includes('overflow-auto')) return c;
        }
        return candidates[0] || document.body;
    }

    function attachMessageObserver() {
        const host = findChatContainerForObserver();
        if (host === _messageObserverHost) return;
        try { messageObserver.disconnect(); } catch (_) {}
        _messageObserverHost = host;
        messageObserver.observe(host, { childList: true, subtree: true });
        debugLog('[Stats] messageObserver attached to', host === document.body ? 'document.body (fallback)' : 'chat container');
    }

    // Reattach on SPA navigation. We delay the reattach a tick so React has a
    // chance to mount the new container.
    function scheduleReattachAfterNav() {
        setTimeout(() => {
            // If the current host is detached from the document, or we've moved
            // pages, find the new container and rebind.
            if (!_messageObserverHost || !_messageObserverHost.isConnected) {
                attachMessageObserver();
                return;
            }
            // Even if still connected, prefer a more specific container if one
            // appeared on this page (e.g. arriving on /chat/ from /).
            const candidate = findChatContainerForObserver();
            if (candidate !== _messageObserverHost) {
                attachMessageObserver();
            }
        }, 50);
        // Second pass for slow mounts
        setTimeout(() => {
            if (!_messageObserverHost || !_messageObserverHost.isConnected) {
                attachMessageObserver();
            }
        }, 500);
    }

    // Originally patched history.pushState/replaceState + listened for popstate to
    // detect SPA navigation. Confirmed live (switching from one chat to another via
    // a real in-app link) that this never actually fired: the old container's host
    // node was disconnected from the document, but a wrapper installed on
    // history.pushState here never saw it happen, because SpicyChat's own router
    // reassigns history.pushState after this content script runs. With the
    // "Periodic check to ensure stats are inserted" fallback below disabled, that
    // meant the message observer could get permanently stuck watching a detached
    // node after switching chats, silently breaking stats/timestamps/message IDs
    // until a full page reload. Polling location.href is slightly delayed but
    // doesn't depend on how the framework changes the URL.
    (function installNavHooks() {
        let lastHref = window.location.href;
        setInterval(() => {
            const currentHref = window.location.href;
            if (currentHref !== lastHref) {
                lastHref = currentHref;
                scheduleReattachAfterNav();
            }
        }, 300);
    })();

    // Initial attach: wait for body, then bind to chat container if present.
    waitForBody().then(() => {
        debugLog('[Stats] document.body available, starting message observer');
        attachMessageObserver();
        // The chat container often mounts shortly after body. Re-check once more
        // so we upgrade from the body fallback to the real container.
        scheduleReattachAfterNav();
    }).catch((err) => {
        console.error('[Stats] Failed to wait for body:', err);
        setTimeout(() => {
            if (document.body) {
                debugLog('[Stats] Retrying message observer setup after error');
                attachMessageObserver();
            }
        }, 2000);
    });

    // Periodic check to ensure stats are inserted even if mutations are missed
    // DISABLED FOR DEBUGGING - flooding logs
    /*
    setInterval(async () => {
        const statsEnabled = await storage.get('showGenerationStats', false);
        if (statsEnabled) {
            processMessagesForStats();
        }
    }, 2000); // Check every 2 seconds
    */

    // Alias for backward compatibility - both names call the same unified function
    const insertStatsForAllMessages = processMessagesForStats;

    // Initial check for existing messages after page load
    debugLog('[Stats] Scheduling initial check at', TIMING.INITIAL_STATS_CHECK, 'ms');
    setTimeout(insertStatsForAllMessages, TIMING.INITIAL_STATS_CHECK);
    
    // Also check again after a longer delay in case messages load slowly
    debugLog('[Stats] Scheduling delayed check at', TIMING.DELAYED_STATS_CHECK, 'ms');
    setTimeout(insertStatsForAllMessages, TIMING.DELAYED_STATS_CHECK);

    // =============================================================================
    // ===          REGENERATION SWITCHER HANDLER (Stats Update)               ===
    // =============================================================================
    // When user switches between message regenerations (< 1/2 > buttons or arrow keys),
    // update the displayed stats to match the currently visible version
    
    // A version switch can replace its React nodes. Reconcile the live wrappers
    // through the verified identity resolver instead of searching by counter text.
    let versionSwitchTimers = [];
    function handleVersionSwitch() {
        for (const timer of versionSwitchTimers) clearTimeout(timer);
        versionSwitchTimers = [80, 300, 900].map(delay => setTimeout(() => {
            processMessagesForStats(false).catch(error => debugLog('[Stats] Version refresh failed:', error));
        }, delay));
    }

    // Detect manual model changes via SpicyChat's own Generation Settings UI
    // Covers: (a) "Set Model" confirmation button in new UI, (b) direct model-option selection
    // in old UI, and (c) SpicyChat's native generation presets that swap the model.
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;

        // New UI: user clicked the "Set Model" confirmation button
        const confirmBtn = target.closest('button[aria-label="Set Model"]') ||
            target.closest('button');
        if (confirmBtn) {
            const btnText = confirmBtn.textContent && confirmBtn.textContent.trim();
            if (btnText === 'Set Model') {
                window.__suppressMismatchNext = true;
                debugLog('[Model] "Set Model" button clicked — suppressing next mismatch auto-regen');
                return;
            }
        }

        // Old UI: model option selected directly in the model picker list
        // The picker has a heading containing "Select a model" / "Choose Model" / "Select Model"
        const pickerOption = target.closest('li, div[role="option"]');
        if (pickerOption) {
            const modal = pickerOption.closest('div.fixed, div[class*="fixed"]');
            if (modal) {
                const modalText = modal.textContent || '';
                if (modalText.includes('Select a model') || modalText.includes('Choose Model') || modalText.includes('Select Model')) {
                    window.__suppressMismatchNext = true;
                    debugLog('[Model] Model option selected in picker — suppressing next mismatch auto-regen');
                }
            }
        }
    }, true); // capture phase so we fire before React

    // Click handler for regeneration switcher buttons
    document.addEventListener('click', async (e) => {
        // Check if click was on a regeneration switcher button (prev/next chevron)
        const button = e.target.closest('button[aria-label="previous"], button[aria-label="next"]');
        if (!button) return;
        
        // Verify it's the regeneration switcher (has sibling with X/Y format)
        const container = button.closest('.flex.items-center');
        if (!container) return;
        
        const counterText = container.querySelector('p');
        if (!counterText || !/^\d+\/\d+$/.test(counterText.textContent.trim())) return;
        
        // Parse the CURRENT version before the click updates the UI
        const [currentVersion, totalVersions] = counterText.textContent.trim().split('/').map(Number);
        const isNext = button.getAttribute('aria-label') === 'next';
        
        debugLog('[Core] Regeneration switcher clicked!', {
            button: button.getAttribute('aria-label'),
            currentVersion,
            totalVersions,
            alternativeGroupsCount: Object.keys(alternativeMessageGroups).length
        });
        
        await handleVersionSwitch(currentVersion, totalVersions, isNext);
    }, true); // Use capture phase to catch event early
    
    // Keyboard handler for arrow keys (left/right) to switch regeneration versions
    document.addEventListener('keydown', async (e) => {
        // Only handle left/right arrow keys
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        
        // Don't interfere if user is typing in an input or textarea
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
            return;
        }
        
        if (document.querySelector('div.w-full.flex.mb-lg p.text-label-md')) handleVersionSwitch();
    }, true); // Use capture phase

    // Initial check in case modal is already open
    setTimeout(createProfileControls, 1000);

    // Watch for model name changes in Generation Settings modal (SpicyChat's own presets)
    startGenerationSettingsModelWatcher();

    // =============================================================================
    // ===                   MEMORY MANAGER AUTO-REFRESH                        ===
    // =============================================================================
    
    let memoryRefreshInterval = null;
    let memoryRefreshInProgress = false; // Guard to prevent concurrent refresh operations
    
    /**
     * Extracts conversation ID from current URL
     */
    function getConversationId() {
        // Use the conversation ID captured from the messages GET request
        // This is more reliable than parsing the URL
        return currentConversationId;
    }
    
    /**
     * Fetches fresh memory data from the API by injecting into page context
     */
    async function refreshMemoryContent() {
        // Guard against concurrent refresh operations which can cause React conflicts
        if (memoryRefreshInProgress) {
            debugLog('[Memories] Memory refresh already in progress, skipping...');
            return false;
        }
        memoryRefreshInProgress = true;
        
        try {
            return await doRefreshMemoryContent();
        } finally {
            // Always reset the flag, even if an error occurs
            memoryRefreshInProgress = false;
        }
    }
    
    /**
     * Internal implementation of memory refresh
     */
    async function doRefreshMemoryContent() {
        debugLog('[Memories] Refreshing Memory Manager content via API...');
        
        // Find the Memories modal specifically by its unique z-index
        // Use Array.from to check all modals and find the one with "Memories" heading
        const allModals = document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2');
        let memoryModal = null;
        
        for (const modal of allModals) {
            const heading = modal.querySelector('p.text-heading-6');
            if (heading && heading.textContent.trim() === 'Memories') {
                memoryModal = modal;
                break;
            }
        }
        
        if (!memoryModal) {
            debugLog('[Memories] Memory modal not found');
            return false;
        }
        
        // Get conversation ID from captured API data
        const conversationId = getConversationId();
        if (!conversationId) {
            debugLog('[Memories] Could not get conversation ID (not yet captured from messages API)');
            return false;
        }
        debugLog('[Memories] Using conversation ID:', conversationId);
        
        try {
            // Use postMessage to communicate with page-context.js instead of inline script
            // This avoids CSP issues with inline script injection
            const responsePromise = new Promise((resolve) => {
                const handler = (event) => {
                    // Only handle our specific response
                    if (event.source !== window) return;
                    if (event.data.type !== 'SAI_MEMORY_REFRESH_RESPONSE') return;
                    
                    window.removeEventListener('message', handler);
                    resolve(event.data);
                };
                window.addEventListener('message', handler);
                
                // Timeout after 10 seconds
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve({ success: false, error: 'timeout' });
                }, 10000);
            });
            
            // Send request to page-context.js
            window.postMessage({
                type: 'SAI_MEMORY_REFRESH_REQUEST',
                conversationId: conversationId
            }, '*');
            
            // Wait for the response
            const result = await responsePromise;
            
            if (!result.success) {
                if (result.error === 'timeout') {
                    debugLog('[Memories] API fetch timed out, falling back to close/reopen approach');
                } else {
                    console.error('[Memories] Failed to fetch memories:', result.status || result.error);
                    if (result.status === 401) {
                        console.error('[Memories] Authentication failed - token may be invalid or expired. Auth token present:', result.hasAuth);
                    }
                }
                // Don't return false here - fall through to close/reopen approach
            } else {
                debugLog(`[Memories] Fetched ${result.count} memories from API`);
            }
            
            // Try multiple approaches to trigger React re-render
            debugLog('[Memories] Attempting to trigger React re-render...');
            debugLog('[Memories] Memory modal element:', memoryModal);
            
            // NEW Approach: Try to find and click the "Load More Memories" button
            const loadMoreButton = Array.from(memoryModal.querySelectorAll('button'))
                .find(btn => btn.textContent?.includes('Load More'));
            
            if (loadMoreButton) {
                debugLog('[Memories] Found Load More button, clicking it');
                loadMoreButton.click();
                await new Promise(resolve => setTimeout(resolve, 500));
                debugLog('[Memories] Load More clicked, checking if memories updated');
                // The button click might trigger a refetch which would update the UI
                // Fall through to close/reopen if this doesn't work
            }
            
            // Approach 1: Find React component and manipulate state directly
            try {
                // Try the modal itself first
                let elementToCheck = memoryModal;
                let depth = 0;
                
                while (elementToCheck && depth < 5) {
                    const allKeys = Object.keys(elementToCheck);
                    const reactKeys = allKeys.filter(key => 
                        key.startsWith('__react') || key.includes('react') || key.includes('fiber')
                    );
                    
                    if (reactKeys.length > 0) {
                        debugLog('[Memories] Found React keys at depth', depth, ':', reactKeys);
                        
                        const reactKey = reactKeys[0];
                        const reactObj = elementToCheck[reactKey];
                        
                        // Walk the fiber tree
                        let current = reactObj;
                        let attempts = 0;
                        while (current && attempts < 30) {
                            if (current.stateNode && typeof current.stateNode.forceUpdate === 'function') {
                                debugLog('[Memories] Found forceUpdate at level', attempts, '- skipping to avoid React conflicts');
                                // DISABLED: forceUpdate can cause React error #185 (Maximum update depth exceeded)
                                // Instead, fall through to the close/reopen approach which is safer
                                // current.stateNode.forceUpdate();
                                // await new Promise(resolve => setTimeout(resolve, 1000));
                                // debugLog('[Memories] Memory refresh completed (via forceUpdate)');
                                // return true;
                                break; // Skip forceUpdate, use close/reopen instead
                            }
                            current = current.return;
                            attempts++;
                        }
                        break;
                    }
                    
                    elementToCheck = elementToCheck.parentElement;
                    depth++;
                }
                
                debugLog('[Memories] No React fiber found after checking', depth, 'parent levels');
            } catch (e) {
                console.error('[Memories] React manipulation failed:', e);
            }
            
            // Approach 2: Close and reopen (most reliable)
            debugLog('[Memories] Attempting close/reopen approach...');
            
            // Try multiple close button selectors - use aria-label="X-button"
            let closeButton = memoryModal.querySelector('button[aria-label="X-button"]');
            if (!closeButton) {
                closeButton = memoryModal.querySelector('button[aria-label="Close"]');
            }
            if (!closeButton) {
                // Look for button with X icon
                const buttons = Array.from(memoryModal.querySelectorAll('button'));
                debugLog('[Memories] Searching through', buttons.length, 'buttons for close button');
                closeButton = buttons.find(btn => {
                    const svg = btn.querySelector('svg');
                    if (!svg) return false;
                    // Close buttons typically have an X icon with crossing paths
                    const paths = svg.querySelectorAll('path');
                    return paths.length >= 2;
                });
            }
            
            if (closeButton) {
                debugLog('[Memories] Found close button, closing modal...');
                
                // TRICK: Create a simple invisible placeholder div to hold the sidebar space
                // This is cleaner than opening Generation Settings
                let placeholderDiv = null;
                
                // Check if Generation Settings is already open
                const allModals = Array.from(document.querySelectorAll('div.fixed'));
                const hasGenerationSettings = allModals.some(modal => {
                    const heading = modal.querySelector('p.text-heading-6');
                    return heading && heading.textContent.includes('Generation Settings');
                });
                
                if (!hasGenerationSettings) {
                    debugLog('[Memories] Creating invisible placeholder to hold sidebar space');
                    
                    // Create a simple placeholder that looks like a sidebar to the layout engine
                    placeholderDiv = document.createElement('div');
                    placeholderDiv.id = 'sai-sidebar-placeholder';
                    placeholderDiv.style.cssText = `
                        position: fixed;
                        top: 0;
                        right: 0;
                        width: 400px;
                        height: 100vh;
                        pointer-events: none;
                        z-index: 1;
                        background: transparent;
                    `;
                    
                    document.body.appendChild(placeholderDiv);
                    debugLog('[Memories] Placeholder div created');
                }
                
                // Now close the Memories modal
                closeButton.click();
                closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                closeButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                closeButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                
                // Wait just long enough for close
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Reopen quickly - search more thoroughly for the Memory Manager button
                debugLog('[Memories] Looking for Memory Manager button to reopen...');
                
                // First, try to find and open the chat dropdown menu
                const menuButton = document.querySelector('button[aria-label="chat-dropdown"]');
                if (menuButton) {
                    debugLog('[Memories] Found chat dropdown menu button, opening it...');
                    menuButton.click();
                    await new Promise(resolve => setTimeout(resolve, 30));
                } else {
                    debugLog('[Memories] Chat dropdown button not found');
                }
                
                // Try multiple selectors for the Manage Memories button
                debugLog('[Memories] Looking for Manage Memories button...');
                let memoryButton = document.querySelector('button[aria-label="Manage Memories"]');
                debugLog('[Memories] Direct selector result:', !!memoryButton);
                
                if (!memoryButton) {
                    // Look through all buttons for one with "Manage Memories" text
                    const allButtons = Array.from(document.querySelectorAll('button'));
                    debugLog('[Memories] Searching through', allButtons.length, 'buttons on page');
                    
                    const memoryButtons = allButtons.filter(btn => {
                        const text = btn.textContent || '';
                        const ariaLabel = btn.getAttribute('aria-label') || '';
                        return text.toLowerCase().includes('manage memor') || ariaLabel.toLowerCase().includes('manage memor');
                    });
                    
                    debugLog('[Memories] Found', memoryButtons.length, 'buttons with "manage memor" in text/aria-label');
                    if (memoryButtons.length > 0) {
                        memoryButtons.forEach((btn, i) => {
                            debugLog(`[Memories] Memory button ${i}:`, {
                                text: btn.textContent?.substring(0, 50),
                                ariaLabel: btn.getAttribute('aria-label'),
                                visible: btn.offsetParent !== null,
                                displayed: window.getComputedStyle(btn).display !== 'none'
                            });
                        });
                    }
                    
                    // Use the first one found
                    memoryButton = memoryButtons[0];
                }
                
                if (memoryButton) {
                    debugLog('[Memories] Found Memory Manager button:', memoryButton.textContent || memoryButton.getAttribute('aria-label'));
                    memoryButton.click();
                    
                    // Wait a moment for the modal to reopen and re-style the Load More button
                    setTimeout(() => {
                        // Find the reopened Memories modal by checking all modals
                        const allModals = document.querySelectorAll('div.fixed.left-1\\/2.top-1\\/2');
                        let reopenedModal = null;
                        
                        for (const modal of allModals) {
                            const heading = modal.querySelector('p.text-heading-6');
                            if (heading && heading.textContent.trim() === 'Memories') {
                                reopenedModal = modal;
                                break;
                            }
                        }
                        
                        if (reopenedModal) {
                            styleLoadMoreButton(reopenedModal);
                        }
                        
                        // Remove the placeholder div if we created one
                        if (placeholderDiv) {
                            placeholderDiv.remove();
                            debugLog('[Memories] Removed placeholder div');
                        }
                    }, 500);
                    
                    debugLog('[Memories] Memory refresh completed (via close/reopen)');
                    return true;
                } else {
                    debugLog('[Memories] Could not find Memory Manager button to reopen');
                    debugLog('[Memories] Tried aria-label and text content searches');
                }
            } else {
                debugLog('[Memories] Could not find close button');
                // Log the modal structure to help debug
                debugLog('[Memories] Modal HTML structure:', memoryModal.outerHTML.substring(0, 500));
            }
            
            // Clean up overlay and spacer if they still exist
            const overlay = document.getElementById('sai-refresh-overlay');
            const spacer = document.getElementById('sai-refresh-spacer');
            if (overlay) overlay.remove();
            if (spacer) spacer.remove();
            
            debugLog('[Memories] All refresh approaches attempted');
            return true;
            
        } catch (error) {
            console.error('[Memories] Error refreshing memories:', error);
            
            // Clean up placeholder div if it exists
            if (placeholderDiv) {
                placeholderDiv.remove();
                debugLog('[Memories] Removed placeholder div after error');
            }
            
            return false;
        }
    }
    
    /**
     * Starts the auto-refresh interval for the Memory Manager modal
     * DISABLED: Auto-refresh is currently disabled to prevent issues
     */
    function startMemoryRefresh() {
        // Auto-refresh disabled - use manual refresh button instead
        debugLog('[Memories] Memory Manager auto-refresh is disabled');
        return;
        
        // Clear any existing interval first
        if (memoryRefreshInterval) {
            clearInterval(memoryRefreshInterval);
        }
        
        debugLog('[Memories] Memory Manager auto-refresh started (120 seconds)');
        
        // Set up interval to refresh every 120 seconds
        memoryRefreshInterval = setInterval(() => {
            // Check if modal is still open
            const memoryModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2[class*="z-\\[900000\\]"]');
            if (memoryModal) {
                const memoryHeading = memoryModal.querySelector('p.text-heading-6');
                if (memoryHeading && memoryHeading.textContent.trim() === 'Memories') {
                    refreshMemoryContent();
                } else {
                    // Modal is open but it's not the Memory Manager, stop the interval
                    debugLog('[Memories] Memory Manager closed, stopping auto-refresh');
                    clearInterval(memoryRefreshInterval);
                    memoryRefreshInterval = null;
                }
            } else {
                // Modal is no longer open, stop the interval
                debugLog('[Memories] Memory Manager closed, stopping auto-refresh');
                clearInterval(memoryRefreshInterval);
                memoryRefreshInterval = null;
            }
        }, 120000); // 120 seconds = 120000 milliseconds
    }
    
    /**
     * Stops the auto-refresh interval
     */
    function stopMemoryRefresh() {
        if (memoryRefreshInterval) {
            clearInterval(memoryRefreshInterval);
            memoryRefreshInterval = null;
            debugLog('[Memories] Memory Manager auto-refresh stopped');
        }
    }
    
    /**
     * Adds a manual refresh button to the Memory Manager modal
     */
    function addManualRefreshButton(modal) {
        // Mark modal as being processed to prevent duplicate calls
        if (modal.dataset.saiButtonProcessing) {
            debugLog('[Memories] Refresh button already being added');
            return;
        }
        modal.dataset.saiButtonProcessing = 'true';
        
        // Check if button already exists
        if (modal.querySelector('[data-sai-refresh-button]')) {
            debugLog('[Memories] Refresh button already exists');
            delete modal.dataset.saiButtonProcessing;
            return;
        }
        
        // Wait a bit for React to fully render the modal buttons
        setTimeout(() => {
            // Find the button container (with the + and ... buttons)
            // Try multiple selectors as the class order might vary
            let buttonContainer = modal.querySelector('.flex.justify-end.items-undefined.m-0');
            if (!buttonContainer) {
                // Try without m-0 in case that class was removed
                buttonContainer = modal.querySelector('.flex.justify-end.items-undefined');
            }
            if (!buttonContainer) {
                debugLog('[Memories] Could not find button container with primary selectors');
                debugLog('[Memories] Trying alternate selectors...');
                
                // Try finding any flex container with buttons near the heading
                buttonContainer = modal.querySelector('.flex.justify-end.items-center');
                if (!buttonContainer) {
                    // Look for any flex container with justify-end that contains a square-plus button
                    const allFlexContainers = modal.querySelectorAll('.flex.justify-end');
                    for (const container of allFlexContainers) {
                        if (container.querySelector('svg.lucide-square-plus')) {
                            buttonContainer = container;
                            debugLog('[Memories] Found container via square-plus icon');
                            break;
                        }
                    }
                }
                
                if (buttonContainer) {
                    debugLog('[Memories] Found alternate container:', buttonContainer.className);
                } else {
                    debugLog('[Memories] No button container found at all');
                    delete modal.dataset.saiButtonProcessing;
                    return;
                }
            }
            
            debugLog('[Memories] Found button container:', buttonContainer.className);
            debugLog('[Memories] Container children:', buttonContainer.children.length);
            
            // Find the + button (first button with lucide-square-plus SVG)
            let addButton = buttonContainer.querySelector('svg.lucide-square-plus')?.closest('button');
            
            // If not found, try alternate approach
            if (!addButton) {
                debugLog('[Memories] Trying alternate add button selector...');
                // Look for any button in the container
                const buttons = buttonContainer.querySelectorAll('button');
                debugLog('[Memories] Found buttons:', buttons.length);
                
                if (buttons.length > 0) {
                    // Assume first button is the add button
                    addButton = buttons[0];
                    debugLog('[Memories] Using first button as reference');
                } else {
                    debugLog('[Memories] No buttons found in container');
                    debugLog('[Memories] Container HTML:', buttonContainer.outerHTML.substring(0, 500));
                    return;
                }
            }
            
            debugLog('[Memories] Found reference button, creating refresh button');
            
            // Create refresh button with the same styling as existing buttons
            const refreshButton = document.createElement('button');
            refreshButton.setAttribute('data-sai-refresh-button', 'true');
            refreshButton.className = addButton.className; // Copy exact classes from add button
            refreshButton.type = 'button';
            refreshButton.title = 'Refresh memories';
            refreshButton.setAttribute('default', '');
            refreshButton.appendChild(makeSVG({
                xmlns: SVG_NS, width: '16', height: '16', viewBox: '0 0 24 24',
                fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
                'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                class: 'lucide lucide-refresh-cw inline-flex items-center justify-center'
            }, [
                ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
                ['path', { d: 'M21 3v5h-5' }],
                ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
                ['path', { d: 'M3 21v-5h5' }]
            ]));
            const refreshLabelSpan = document.createElement('span');
            refreshLabelSpan.className = 'flex items-center justify-center text-center gap-1.5';
            refreshButton.appendChild(refreshLabelSpan);
            
            // Add click handler
            refreshButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                debugLog('[Memories] Manual refresh triggered');
                
                // Visual feedback - spin the icon
                const svg = refreshButton.querySelector('svg');
                if (svg) {
                    svg.style.transition = 'transform 0.5s ease';
                    svg.style.transform = 'rotate(360deg)';
                    setTimeout(() => {
                        svg.style.transform = 'rotate(0deg)';
                    }, 500);
                }
                
                // Trigger refresh
                await refreshMemoryContent();
            });
            
            // Insert before the add button
            buttonContainer.insertBefore(refreshButton, addButton);
            
            debugLog('[Memories] Manual refresh button added to Memory Manager');
            debugLog('[Memories] Button visible in DOM:', !!modal.querySelector('[data-sai-refresh-button]'));
            delete modal.dataset.saiButtonProcessing;
        }, 500); // Wait 500ms for React to render
    }
    
    /**
     * Styles the "Load More Memories" button when sidebar layout is enabled
     */
    function styleLoadMoreButton(memoryModal) {
        if (!memoryModal) return;
        
        const applyStyles = () => {
            // Find the Load More Memories button
            const buttons = memoryModal.querySelectorAll('button');
            const loadMoreButton = Array.from(buttons).find(btn => 
                btn.textContent?.includes('Load More Memories')
            );
            
            if (loadMoreButton && !loadMoreButton.dataset.saiStyled) {
                // Use !important to override React's inline styles
                loadMoreButton.style.setProperty('margin-top', '0.5rem', 'important');
                loadMoreButton.style.setProperty('margin-bottom', '1.5rem', 'important');
                loadMoreButton.dataset.saiStyled = 'true';
                debugLog('[Memories] Styled Load More Memories button for sidebar layout');
                
                // Watch for attribute changes in case React resets the style
                // Use debouncing to prevent infinite loops with React's reconciliation
                let styleDebounceTimer = null;
                const buttonObserver = new MutationObserver(() => {
                    // Debounce to prevent rapid re-application causing React conflicts
                    if (styleDebounceTimer) clearTimeout(styleDebounceTimer);
                    styleDebounceTimer = setTimeout(() => {
                        if (!loadMoreButton.style.marginTop || !loadMoreButton.style.marginBottom) {
                            loadMoreButton.style.setProperty('margin-top', '0.5rem', 'important');
                            loadMoreButton.style.setProperty('margin-bottom', '1.5rem', 'important');
                        }
                    }, 100); // 100ms debounce
                });
                
                buttonObserver.observe(loadMoreButton, {
                    attributes: true,
                    attributeFilter: ['style']
                });
                
                return true; // Success
            }
            return false; // Button not found yet
        };
        
        // Try immediately
        if (!applyStyles()) {
            // Button not rendered yet, wait and try again
            setTimeout(() => {
                if (!applyStyles()) {
                    // Still not found, set up observer to watch for it
                    const modalObserver = new MutationObserver((mutations) => {
                        if (applyStyles()) {
                            modalObserver.disconnect();
                        }
                    });
                    
                    modalObserver.observe(memoryModal, {
                        childList: true,
                        subtree: true
                    });
                    
                    // Disconnect after 5 seconds to avoid memory leak
                    setTimeout(() => modalObserver.disconnect(), 5000);
                }
            }, 500);
        }
    }
    
    /**
     * Monitors for Memory Manager modal opening
     */
    // Store observer reference to prevent duplicate observers (memory leak fix)
    let memoryModalObserver = null;
    let memoryModalDebounceTimer = null; // Debounce timer to prevent rapid firing

    function monitorMemoryModal() {
        // Disconnect existing observer if any to prevent accumulation
        if (memoryModalObserver) {
            memoryModalObserver.disconnect();
        }

        memoryModalObserver = new MutationObserver((mutations) => {
            // Skip processing during resize to prevent React 185 error
            const timeSinceResize = Date.now() - lastResizeTime;
            if (timeSinceResize < RESIZE_DEBOUNCE_MS) {
                return; // Skip entirely during resize
            }
            
            // Debounce to prevent rapid firing which can conflict with React
            if (memoryModalDebounceTimer) clearTimeout(memoryModalDebounceTimer);
            memoryModalDebounceTimer = setTimeout(() => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Early exit for nodes that can't be the Memory Manager modal
                            // Only div elements with 'fixed' class can be the modal
                            const nodeTag = node.tagName?.toLowerCase();
                            if (nodeTag !== 'div') {
                                continue; // Skip non-div elements entirely
                            }
                            
                            let foundModal = null;
                            
                            // Check if this is the Memory Manager modal
                            if (node.classList && node.classList.contains('fixed')) {
                                const heading = node.querySelector('p.text-heading-6');
                                if (heading && heading.textContent.trim() === 'Memories') {
                                    foundModal = node;
                                    debugLog('[Memories] Matched Memories modal directly');
                                }
                            }
                            
                            // Also check children in case modal was added in a container
                            if (!foundModal) {
                                // Look for div.fixed that contains the "Memories" heading
                                const allFixedDivs = node.querySelectorAll?.('div.fixed');
                                if (allFixedDivs && allFixedDivs.length > 0) {
                                    for (const fixedDiv of allFixedDivs) {
                                        const heading = fixedDiv.querySelector('p.text-heading-6');
                                        if (heading && heading.textContent.trim() === 'Memories') {
                                            foundModal = fixedDiv;
                                            debugLog('[Memories] Matched Memories modal in child');
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // If we found the modal, add button and start refresh
                            if (foundModal) {
                                debugLog('[Memories] Memory Manager detected, starting auto-refresh');
                                addManualRefreshButton(foundModal);
                                styleLoadMoreButton(foundModal);
                                startMemoryRefresh();
                                break; // Stop processing this mutation batch
                            }
                        }
                    }
                    
                    // Check for removed nodes to stop the interval if modal is closed
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.classList && node.classList.contains('fixed')) {
                                const heading = node.querySelector?.('p.text-heading-6');
                                if (heading && heading.textContent.trim() === 'Memories') {
                                    debugLog('[Memories] Memory Manager removed from DOM');
                                    stopMemoryRefresh();
                                }
                            }
                        }
                    }
                }
            }, 50); // 50ms debounce
        });

        memoryModalObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        debugLog('[Memories] Memory Manager auto-refresh monitor initialized');
    }
    
    // Initialize the memory modal monitor
    monitorMemoryModal();
    
    // Check if Memory Manager is already open on page load
    setTimeout(() => {
        const existingModal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2');
        if (existingModal) {
            const heading = existingModal.querySelector('p.text-heading-6');
            if (heading && heading.textContent.trim() === 'Memories') {
                debugLog('[Memories] Memory Manager already open on page load');
                addManualRefreshButton(existingModal);
                styleLoadMoreButton(existingModal);
                startMemoryRefresh();
            }
        }
    }, 2000);
    
    // Fallback: Periodically check for Memory Manager modal in case observer misses it
    // This handles cases where React portals or complex DOM changes aren't caught
    let memoryModalFallbackInterval = null;
    let memoryModalFallbackActive = false;
    
    function startMemoryModalFallback() {
        if (memoryModalFallbackInterval) return; // Already running

        // Track whether the modal was present on the previous poll so we only
        // act / log on transitions (open → present → closed) rather than every
        // single tick. The previous version checked a `dataset.saiRefreshButton`
        // flag that was never actually set, so every poll fell through to
        // addManualRefreshButton + styleLoadMoreButton + startMemoryRefresh —
        // each of which logged "already exists" / "auto-refresh disabled".
        // Result: ~6 log lines per second of pure noise.
        let modalPresentLastTick = false;

        memoryModalFallbackInterval = setInterval(() => {
            // Look for the Memory Manager modal using multiple selectors
            let modal = document.querySelector('div.fixed.left-1\\/2.top-1\\/2');
            if (!modal) {
                // Try alternate selectors
                const allFixedModals = document.querySelectorAll('div.fixed');
                for (const fixedDiv of allFixedModals) {
                    const heading = fixedDiv.querySelector('p.text-heading-6');
                    if (heading && heading.textContent.trim() === 'Memories') {
                        modal = fixedDiv;
                        break;
                    }
                }
            }

            // Confirm it's actually the Memory Manager modal (heading text match)
            const isMemoryManager = modal &&
                modal.querySelector('p.text-heading-6')?.textContent?.trim() === 'Memories';
            const modalPresentNow = !!isMemoryManager;

            if (modalPresentNow) {
                // Only act when the modal first appears, OR if our button is
                // missing (React may have torn it out after a re-render).
                // Querying the actual button is the source of truth — no more
                // relying on a dataset flag that nothing ever sets.
                const buttonExists = !!modal.querySelector('[data-sai-refresh-button]');
                if (!modalPresentLastTick || !buttonExists) {
                    debugLog('[Memories] Memory Manager detected via fallback check' +
                        (modalPresentLastTick ? ' (button missing — re-adding)' : ''));
                    addManualRefreshButton(modal);
                    styleLoadMoreButton(modal);
                    if (!modalPresentLastTick) {
                        startMemoryRefresh();
                        memoryModalFallbackActive = true;
                    }
                }
            } else if (modalPresentLastTick) {
                // Modal was open but now closed
                debugLog('[Memories] Memory Manager closed (fallback detection)');
                stopMemoryRefresh();
                memoryModalFallbackActive = false;
            }

            modalPresentLastTick = modalPresentNow;
        }, 2000); // Check every 2 seconds — the primary MutationObserver catches
                   // most transitions; this fallback only exists for React-portal
                   // cases the observer misses, where a 2s delay is fine.

        debugLog('[Memories] Memory Manager fallback checker started');
    }
    
    // Start the fallback checker
    startMemoryModalFallback();

    // =============================================================================
    // =============================================================================
    // =============================================================================
    // ===                                                                       ===
    // ===                      END OF INITIALIZATION                           ===
    // ===                                                                       ===
    // =============================================================================
    // =============================================================================
    // =============================================================================
    
    } // End of initializeMainCode function
    
    // =============================================================================
    // NEW TAB AUTO-RELOAD - Handle race condition
    // =============================================================================
    // When middle-clicking to open a bot in a new tab, sometimes the page loads
    // before our extension fully initializes. Detect this and auto-reload once.
    // =============================================================================
    
    const RELOAD_FLAG_KEY = 'sai-toolkit-reloaded-for-init';
    const hasAlreadyReloaded = sessionStorage.getItem(RELOAD_FLAG_KEY) === 'true';

    // =============================================================================
    // ===              CHANGELOG DATA + MODAL SHELL (shared)                   ===
    // =============================================================================
    // Release notes live in changelog.json (one small, easy-to-edit file) instead
    // of being hardcoded here. Add a new version entry there on every release.
    // NOTE: These must be defined OUTSIDE initializeMainCode so they can be called
    // from checkForUpdateNotification and the onMessage listener (which also run
    // outside initializeMainCode).
    let _changelogCache = null;
    let _lastRenderedUpdateVersion = null;

    async function loadChangelogData() {
        if (_changelogCache) return _changelogCache;
        try {
            const api = typeof browser !== 'undefined' ? browser : chrome;
            const res = await fetch(api.runtime.getURL('changelog.json'));
            const data = await res.json();
            _changelogCache = Array.isArray(data) ? data : [];
        } catch (err) {
            console.error('[Core] Failed to load changelog.json:', err);
            _changelogCache = [];
        }
        return _changelogCache;
    }

    function buildFallbackChangelogEntry(version) {
        return {
            version,
            date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            features: ["Release notes for this version haven't been published yet — check back soon."]
        };
    }

    // Shared shadow-DOM shell (backdrop + modal + styles) used by both the
    // single-version update toast and the multi-version history viewer below.
    function createChangelogModalShell() {
        let root = document.getElementById('update-notification-root');
        if (root) {
            root.remove(); // Remove if already exists
        }

        root = document.createElement('div');
        root.id = 'update-notification-root';
        root.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 10000005;';
        document.body.appendChild(root);

        const shadow = root.attachShadow({ mode: 'open' });

        // Styles
        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; }

            .backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(4px);
                z-index: 10000005;
                pointer-events: auto;
                animation: fadeIn 0.2s ease-out;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -45%);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%);
                }
            }

            .modal {
                position: fixed;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border-radius: 16px;
                width: 480px;
                max-width: 95vw;
                max-height: 85vh;
                z-index: 10000006;
                pointer-events: auto;
                display: flex;
                flex-direction: column;
                padding: 0;
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                animation: slideIn 0.3s ease-out;
            }

            @media (max-width: 480px) {
                .modal {
                    width: 100%;
                    max-width: 100vw;
                    max-height: 100vh;
                    /* iOS Safari: 100vh includes the area under the toolbar, which
                       pushed the footer's Close button off-screen. dvh tracks the
                       actually-visible viewport; vh above stays as the fallback. */
                    max-height: 100dvh;
                    border-radius: 0;
                }
                .modal-footer {
                    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
                }
            }

            /* Always-reachable dismiss control. On phones the modal covers the
               whole backdrop, so tap-outside-to-close isn't available there. */
            .modal-x {
                position: absolute;
                top: calc(0.5rem + env(safe-area-inset-top, 0px));
                right: 0.5rem;
                width: 40px;
                height: 40px;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: #6b7280;
                font-size: 1.5rem;
                line-height: 1;
                cursor: pointer;
                touch-action: manipulation;
                z-index: 1;
            }
            .modal-x:hover { background: rgba(0, 0, 0, 0.06); }
            @media (prefers-color-scheme: dark) {
                .modal-x { color: #9ca3af; }
                .modal-x:hover { background: rgba(255, 255, 255, 0.08); }
            }

            @media (prefers-color-scheme: dark) {
                .modal {
                    background: #1a1a1a;
                    color: white;
                }
            }

            .modal-header {
                padding: 1.5rem 1.5rem 1rem 1.5rem;
                border-bottom: 1px solid #e5e7eb;
                text-align: center;
            }

            @media (prefers-color-scheme: dark) {
                .modal-header {
                    border-color: #404040;
                }
            }

            .update-icon {
                width: 48px;
                height: 48px;
                margin: 0 auto 0.75rem auto;
                background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
            }

            .modal-title {
                font-size: 1.25rem;
                font-weight: 700;
                margin-bottom: 0.25rem;
                color: #111827;
            }

            @media (prefers-color-scheme: dark) {
                .modal-title {
                    color: #f9fafb;
                }
            }

            .modal-date {
                font-size: 0.875rem;
                color: #6b7280;
            }

            @media (prefers-color-scheme: dark) {
                .modal-date {
                    color: #9ca3af;
                }
            }

            .modal-body {
                padding: 1.5rem;
                overflow-y: auto;
                flex: 1;
            }

            .changelog-title {
                font-size: 0.875rem;
                font-weight: 600;
                color: #6b7280;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 0.75rem;
            }

            @media (prefers-color-scheme: dark) {
                .changelog-title {
                    color: #9ca3af;
                }
            }

            .changelog-list {
                list-style: none;
                padding: 0;
                margin: 0;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }

            .changelog-item {
                padding-left: 1.5rem;
                position: relative;
                font-size: 0.9375rem;
                line-height: 1.6;
                color: #374151;
            }

            @media (prefers-color-scheme: dark) {
                .changelog-item {
                    color: #d1d5db;
                }
            }

            .changelog-item::before {
                content: "✓";
                position: absolute;
                left: 0;
                color: #10b981;
                font-weight: bold;
            }

            .modal-footer {
                padding: 1rem 1.5rem;
                border-top: 1px solid #e5e7eb;
                display: flex;
                justify-content: center;
                flex-wrap: wrap;
                gap: 0.75rem;
            }

            @media (prefers-color-scheme: dark) {
                .modal-footer {
                    border-color: #404040;
                }
            }

            .btn-close {
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 0.625rem 2rem;
                font-size: 0.9375rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }

            .btn-close:hover {
                background: #2563eb;
                transform: translateY(-1px);
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }

            .btn-close:active {
                transform: translateY(0);
            }

            .btn-secondary {
                background: transparent;
                color: #374151;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                padding: 0.625rem 1.25rem;
                font-size: 0.9375rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }

            .btn-secondary:hover {
                background: #f3f4f6;
                border-color: #9ca3af;
            }

            @media (prefers-color-scheme: dark) {
                .btn-secondary {
                    color: #d1d5db;
                    border-color: #4b5563;
                }
                .btn-secondary:hover {
                    background: #374151;
                }
            }

            .history-version-block {
                text-align: left;
                padding-bottom: 1rem;
                margin-bottom: 1rem;
                border-bottom: 1px solid #e5e7eb;
            }

            .history-version-block:last-child {
                border-bottom: none;
                margin-bottom: 0;
                padding-bottom: 0;
            }

            @media (prefers-color-scheme: dark) {
                .history-version-block {
                    border-color: #404040;
                }
            }

            .history-version-title {
                font-size: 1rem;
                font-weight: 700;
                margin-bottom: 0.125rem;
                color: #111827;
            }

            @media (prefers-color-scheme: dark) {
                .history-version-title {
                    color: #f9fafb;
                }
            }
        `;

        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.addEventListener('click', (e) => e.stopPropagation());

        const xBtn = document.createElement('button');
        xBtn.className = 'modal-x';
        xBtn.type = 'button';
        xBtn.setAttribute('aria-label', 'Close');
        xBtn.textContent = '×';
        modal.appendChild(xBtn);

        shadow.appendChild(style);
        shadow.appendChild(backdrop);
        shadow.appendChild(modal);

        return { root, backdrop, modal, xBtn };
    }

    function closeChangelogModal(root, backdrop, modal) {
        backdrop.style.animation = 'fadeIn 0.2s ease-out reverse';
        modal.style.animation = 'slideIn 0.2s ease-out reverse';
        setTimeout(() => root.remove(), 200);
    }

    // Single-version "toast" shown right after an update. Marks the version as
    // seen in storage on dismiss, so it won't show again for this version.
    async function showUpdateNotificationModal(version) {
        debugLog('[Core] Showing update notification for version:', version);

        // Guard against the load-time check and the background push message
        // both trying to render the same version's modal within a moment of
        // each other.
        if (_lastRenderedUpdateVersion === version && document.getElementById('update-notification-root')) {
            debugLog('[Core] Update modal already showing for', version, '- skipping duplicate');
            return;
        }
        _lastRenderedUpdateVersion = version;

        const changelog = await loadChangelogData();
        const entry = changelog.find(e => e.version === version) || buildFallbackChangelogEntry(version);

        const { root, backdrop, modal, xBtn } = createChangelogModalShell();

        // Create modal header
        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        // Add "S.AI Toolkit updated!" at the top
        const updateAnnouncement = document.createElement('div');
        updateAnnouncement.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: #3b82f6; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;';
        updateAnnouncement.textContent = 'S.AI Toolkit updated!';

        const updateIcon = document.createElement('div');
        updateIcon.className = 'update-icon';
        updateIcon.textContent = '🎉';

        const modalTitle = document.createElement('div');
        modalTitle.className = 'modal-title';
        modalTitle.textContent = `Version ${entry.version}`;

        const modalDate = document.createElement('div');
        modalDate.className = 'modal-date';
        modalDate.textContent = entry.date;

        modalHeader.appendChild(updateAnnouncement);
        modalHeader.appendChild(updateIcon);
        modalHeader.appendChild(modalTitle);
        modalHeader.appendChild(modalDate);

        // Create modal body
        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';

        const changelogTitle = document.createElement('div');
        changelogTitle.className = 'changelog-title';
        changelogTitle.textContent = "What's New";

        const changelogList = document.createElement('ul');
        changelogList.className = 'changelog-list';

        (entry.features || []).forEach(feature => {
            const li = document.createElement('li');
            li.className = 'changelog-item';
            li.textContent = feature;
            changelogList.appendChild(li);
        });

        modalBody.appendChild(changelogTitle);
        modalBody.appendChild(changelogList);

        // Create modal footer
        const modalFooter = document.createElement('div');
        modalFooter.className = 'modal-footer';

        const viewChangelogBtn = document.createElement('button');
        viewChangelogBtn.className = 'btn-secondary';
        viewChangelogBtn.id = 'view-changelog-btn';
        viewChangelogBtn.textContent = 'View Changelog';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.id = 'close-btn';
        closeBtn.textContent = 'Got it!';

        modalFooter.appendChild(viewChangelogBtn);
        modalFooter.appendChild(closeBtn);

        modal.appendChild(modalHeader);
        modal.appendChild(modalBody);
        modal.appendChild(modalFooter);

        async function closeModal() {
            // Mark this version as seen
            await storage.set('lastSeenVersion', version);
            debugLog('[Core] Update notification dismissed, marked version as seen:', version);
            closeChangelogModal(root, backdrop, modal);
        }

        closeBtn.addEventListener('click', closeModal);
        xBtn.addEventListener('click', closeModal);
        backdrop.addEventListener('click', closeModal);

        // Give the user a way to see previous releases' notes too, not just
        // this one. Counts as acknowledging the update (marks lastSeenVersion)
        // so the toast doesn't come back on the next page load - it just
        // hands off straight into the history viewer instead of animating
        // closed first (createChangelogModalShell tears down this modal's
        // root for us when the history modal builds its own).
        viewChangelogBtn.addEventListener('click', async () => {
            await storage.set('lastSeenVersion', version);
            debugLog('[Core] Update notification dismissed via View Changelog, marked version as seen:', version);
            showChangelogHistoryModal();
        });
    }

    // Multi-version "browse anytime" history viewer. Purely a read action -
    // never touches lastSeenVersion, so it can be opened repeatedly without
    // affecting the update-toast logic above.
    async function showChangelogHistoryModal(limit = 5) {
        debugLog('[Core] Showing changelog history modal');

        const changelog = await loadChangelogData();
        const entries = changelog.slice(0, limit);

        const { root, backdrop, modal, xBtn } = createChangelogModalShell();

        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        const headerLabel = document.createElement('div');
        headerLabel.style.cssText = 'font-size: 0.875rem; font-weight: 600; color: #3b82f6; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;';
        headerLabel.textContent = 'S.AI Toolkit';

        const updateIcon = document.createElement('div');
        updateIcon.className = 'update-icon';
        updateIcon.textContent = '📋';

        const modalTitle = document.createElement('div');
        modalTitle.className = 'modal-title';
        modalTitle.textContent = "What's New";

        modalHeader.appendChild(headerLabel);
        modalHeader.appendChild(updateIcon);
        modalHeader.appendChild(modalTitle);

        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'changelog-item';
            empty.style.paddingLeft = '0';
            empty.textContent = 'No release notes available yet.';
            modalBody.appendChild(empty);
        } else {
            entries.forEach(entry => {
                const block = document.createElement('div');
                block.className = 'history-version-block';

                const versionTitle = document.createElement('div');
                versionTitle.className = 'history-version-title';
                versionTitle.textContent = `Version ${entry.version}`;

                const versionDate = document.createElement('div');
                versionDate.className = 'modal-date';
                versionDate.style.marginBottom = '0.5rem';
                versionDate.textContent = entry.date;

                const list = document.createElement('ul');
                list.className = 'changelog-list';

                (entry.features || []).forEach(feature => {
                    const li = document.createElement('li');
                    li.className = 'changelog-item';
                    li.textContent = feature;
                    list.appendChild(li);
                });

                block.appendChild(versionTitle);
                block.appendChild(versionDate);
                block.appendChild(list);
                modalBody.appendChild(block);
            });
        }

        const modalFooter = document.createElement('div');
        modalFooter.className = 'modal-footer';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.textContent = 'Close';

        modalFooter.appendChild(closeBtn);

        modal.appendChild(modalHeader);
        modal.appendChild(modalBody);
        modal.appendChild(modalFooter);

        function closeModal() {
            closeChangelogModal(root, backdrop, modal);
        }

        closeBtn.addEventListener('click', closeModal);
        xBtn.addEventListener('click', closeModal);
        backdrop.addEventListener('click', closeModal);
    }

    // =============================================================================
    // ===                 UPDATE NOTIFICATION CHECK                            ===
    // =============================================================================
    // Check for update notification on page load
    async function checkForUpdateNotification() {
        try {
            // Read directly from storage (bypass cache) to get fresh values set by background script
            const result = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get({
                'showUpdateNotification': false,
                'updatedToVersion': null,
                'lastSeenVersion': null
            });
            
            const showUpdate = result.showUpdateNotification;
            const newVersion = result.updatedToVersion;
            const lastSeenVersion = result.lastSeenVersion;

            debugLog('[Core] Update check - showUpdate:', showUpdate, 'newVersion:', newVersion, 'lastSeenVersion:', lastSeenVersion);

            if (showUpdate) {
                // Only show if user hasn't seen this version yet
                if (newVersion && newVersion !== lastSeenVersion) {
                    // Small delay to let page load first
                    setTimeout(() => showUpdateNotificationModal(newVersion), 1000);
                } else {
                    debugLog('[Core] User has already seen version:', newVersion);
                }

                // Clear the flag regardless
                await storage.remove('showUpdateNotification');
            } else {
                debugLog('[Core] No update notification pending');
                
                // Retry check after a short delay in case background script is still writing
                // This handles the race condition when extension just updated
                setTimeout(async () => {
                    try {
                        const retryResult = await (typeof browser !== 'undefined' ? browser : chrome).storage.local.get({
                            'showUpdateNotification': false,
                            'updatedToVersion': null,
                            'lastSeenVersion': null
                        });
                        
                        if (retryResult.showUpdateNotification) {
                            debugLog('[Core] Retry: Found update notification on second check');
                            const retryVersion = retryResult.updatedToVersion;
                            const retryLastSeen = retryResult.lastSeenVersion;
                            
                            if (retryVersion && retryVersion !== retryLastSeen) {
                                showUpdateNotificationModal(retryVersion);
                            }
                            
                            await storage.remove('showUpdateNotification');
                        }
                    } catch (err) {
                        // Ignore retry errors
                    }
                }, 2000);
            }
        } catch (err) {
            console.error('[Core] Error checking for update notification:', err);
        }
    }

    // For new tab detection: check if this is a fresh navigation (not a reload)
    // Use newer PerformanceNavigationTiming API with fallback to deprecated API
    function getNavigationType() {
        // Try modern API first
        const navEntries = performance.getEntriesByType('navigation');
        if (navEntries && navEntries.length > 0) {
            return navEntries[0].type; // 'navigate', 'reload', 'back_forward', 'prerender'
        }
        // Fallback to deprecated API
        if (window.performance && window.performance.navigation) {
            const types = ['navigate', 'reload', 'back_forward', 'reserved'];
            return types[window.performance.navigation.type] || 'navigate';
        }
        return 'navigate';
    }
    
    const navigationType = getNavigationType();
    const isNewTab = !hasAlreadyReloaded && navigationType === 'navigate';
    
    debugLog('[Core] ==== NEW TAB CHECK ====');
    debugLog('[Core] URL:', location.href);
    debugLog('[Core] hasAlreadyReloaded:', hasAlreadyReloaded);
    debugLog('[Core] navigationType:', navigationType);
    debugLog('[Core] isNewTab:', isNewTab);
    debugLog('[Core] readyState:', document.readyState);
    
    async function checkAndReloadIfNeeded() {
        await initializeMainCode();

        debugLog('[Core] initializeMainCode completed');

        // Check for update notification after initialization
        await checkForUpdateNotification();

        // If the popup asked us to show the changelog history (opened via
        // "What's New" while no SpicyChat tab was open), do it once the page
        // has settled.
        try {
            const api = typeof browser !== 'undefined' ? browser : chrome;
            const { openChangelogHistoryOnLoad } = await api.storage.local.get({ openChangelogHistoryOnLoad: false });
            if (openChangelogHistoryOnLoad) {
                await storage.remove('openChangelogHistoryOnLoad');
                setTimeout(() => showChangelogHistoryModal(), 1200);
            }
        } catch (err) {
            debugLog('[Core] Error checking openChangelogHistoryOnLoad flag:', err);
        }

        // Only check on chat pages
        const isChatPage = location.href.includes('/chat') || location.href.includes('/messages');
        debugLog('[Core] isChatPage:', isChatPage);
        
        if (!isChatPage) {
            debugLog('[Core] Not a chat page, skipping reload check');
            return;
        }
        
        // Check if our toolkit UI was actually injected
        const toolkitInjected = document.querySelector('sai-toolkit-modal') !== null;
        debugLog('[Core] toolkitInjected:', toolkitInjected);
        
        // If this is a new tab (fresh navigation) and we haven't reloaded yet, do it
        // OR if the toolkit wasn't injected properly
        if ((isNewTab || !toolkitInjected) && !hasAlreadyReloaded) {
            debugLog('[Core] NEW TAB DETECTED or toolkit not injected - Setting reload flag and reloading...');
            sessionStorage.setItem(RELOAD_FLAG_KEY, 'true');
            // Use a small delay to ensure sessionStorage is written
            setTimeout(() => {
                debugLog('[Core] RELOADING NOW');
                location.reload();
            }, 100);
        } else {
            debugLog('[Core] Not a new tab or already reloaded, proceeding normally');
        }
    }
    
    // Handle visibility changes - for prerendered pages or tabs opened in background
    let hasInitialized = false;
    
    async function initWhenVisible() {
        if (hasInitialized) return;
        
        if (document.visibilityState === 'visible') {
            hasInitialized = true;
            debugLog('[Core] Page is visible, initializing...');
            await checkAndReloadIfNeeded();
        } else {
            debugLog('[Core] Page not visible yet, waiting...');
            document.addEventListener('visibilitychange', async function onVisible() {
                if (document.visibilityState === 'visible' && !hasInitialized) {
                    hasInitialized = true;
                    debugLog('[Core] Page became visible, initializing...');
                    document.removeEventListener('visibilitychange', onVisible);
                    await checkAndReloadIfNeeded();
                }
            });
        }
    }
    
    // Drive sync complete: background has merged new stats into the IndexedDB store.
    // Invalidate the per-character cache and re-render visible message stats.
    const _runtimeAPI = typeof browser !== 'undefined' ? browser : chrome;
    if (_runtimeAPI?.runtime?.onMessage) {
        _runtimeAPI.runtime.onMessage.addListener((message) => {
            if (message.type === 'SAI_EXTENSION_UPDATED') {
                debugLog('[Core] SAI_EXTENSION_UPDATED received for version:', message.version);
                showUpdateNotificationModal(message.version);
            }
            if (message.type === 'SAI_SHOW_CHANGELOG_HISTORY') {
                debugLog('[Core] SAI_SHOW_CHANGELOG_HISTORY received');
                showChangelogHistoryModal();
            }
            if (message.type === 'SAI_DRIVE_SYNC_COMPLETE') {
                debugLog('[Sync] SAI_DRIVE_SYNC_COMPLETE received — invalidating cache and re-rendering stats');
                if (typeof invalidateStatsCache === 'function') invalidateStatsCache();
                if (typeof processMessagesForStats === 'function') {
                    setTimeout(() => processMessagesForStats(false), 300);
                }
            }
            if (message.type === 'SAI_DRIVE_AUTH_REQUIRED') {
                debugLog('[Sync] SAI_DRIVE_AUTH_REQUIRED received — showing auth modal');
                driveAuthErrorMessage = 'Drive sync: sign-in required';
                const sb = document.getElementById('sai-toolkit-sidebar-btn');
                const mb = document.getElementById('sai-toolkit-mobile-btn');
                if (sb) sb.style.color = '#dc2626';
                if (mb) mb.style.color = '#dc2626';
                showDriveAuthModal();
            }
            if (message.type === 'SAI_SYNC_PROGRESS') {
                debugLog(`[Sync] Progress [${message.stepNum}/${message.totalSteps}]: ${message.step}${message.detail ? ' — ' + message.detail : ''}`);
                if (syncProgressCallback) syncProgressCallback(message);
            }

            // Drive download delegated from background page.
            // The background page's fetch() freezes the JS event loop on Orion/WebKit
            // iOS when a request stalls, making timeouts impossible. The background
            // delegates large downloads here instead.
            if (message.type === 'SAI_DRIVE_DOWNLOAD_REQ') {
                const { token, fileId, storageKey } = message;
                const t0 = Date.now();
                const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

                const sendProgress = (detail) => {
                    _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_DOWNLOAD_PROGRESS', detail }).catch(() => {});
                    if (syncProgressCallback) syncProgressCallback({ type: 'SAI_SYNC_PROGRESS', step: 'Downloading from Drive…', stepNum: 3, totalSteps: 5, detail });
                };

                (async () => {
                    try {
                        sendProgress('fetching…');
                        const res = await fetch(url, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                        if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
                        sendProgress('reading response…');
                        const buffer = await res.arrayBuffer();
                        const totalBytes = buffer.byteLength;
                        sendProgress(`parsing ${(totalBytes / 1048576).toFixed(1)} MB…`);
                        const fullText = new TextDecoder().decode(buffer);
                        const data = JSON.parse(fullText);

                        await _runtimeAPI.storage.local.set({ [storageKey]: data });
                        await _runtimeAPI.runtime.sendMessage({
                            type: 'SAI_DRIVE_DOWNLOAD_DONE',
                            bytes: totalBytes,
                            durationMs: Date.now() - t0,
                        });
                    } catch (err) {
                        debugLog('[Sync] content download error:', err.message);
                        await _runtimeAPI.runtime.sendMessage({
                            type: 'SAI_DRIVE_DOWNLOAD_ERROR',
                            error: err.message,
                        });
                    }
                })();
            }

            if (message.type === 'SAI_DRIVE_UPLOAD_REQ') {
                const { token, fileId, folderId, fileName, storageKey } = message;
                const t0 = Date.now();

                const sendProgress = (detail) => {
                    _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_PROGRESS', detail }).catch(() => {});
                    if (syncProgressCallback) syncProgressCallback({ type: 'SAI_SYNC_PROGRESS', step: 'Uploading to Drive…', stepNum: 5, totalSteps: 5, detail });
                };

                (async () => {
                    try {
                        sendProgress('reading payload…');
                        const stored = await _runtimeAPI.storage.local.get(storageKey);
                        const data = stored[storageKey];
                        if (!data) throw new Error('Upload payload missing from storage');
                        const body = JSON.stringify(data);
                        sendProgress(`uploading ${(body.length / 1048576).toFixed(1)} MB…`);

                        let newFileId;
                        if (fileId) {
                            const res = await fetch(
                                `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                                { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }
                            );
                            if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                            if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
                            newFileId = fileId;
                        } else {
                            const boundary = 'sai_toolkit_drive_boundary';
                            const metaObj = { name: fileName, mimeType: 'application/json' };
                            if (folderId) metaObj.parents = [folderId];
                            const multipart = [
                                `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
                                JSON.stringify(metaObj),
                                `--${boundary}`, 'Content-Type: application/json', '',
                                body,
                                `--${boundary}--`
                            ].join('\r\n');
                            const res = await fetch(
                                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
                                { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }
                            );
                            if (res.status === 401) throw new Error('DRIVE_AUTH_EXPIRED');
                            if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
                            const created = await res.json();
                            newFileId = created.id;
                        }

                        sendProgress(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
                        await _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_DONE', newFileId });
                    } catch (err) {
                        debugLog('[Sync] content upload error:', err.message);
                        await _runtimeAPI.runtime.sendMessage({ type: 'SAI_DRIVE_UPLOAD_ERROR', error: err.message });
                    }
                })();
            }
        });
    }

    // Optional, read-only capability contract for other SpicyChat extensions.
    // It contains booleans and the extension version only, never stored values.
    function initToolkitCapabilities() {
        const api = typeof browser !== 'undefined' ? browser : chrome;
        const defaults = {
            showGenerationStats: false, showTimestamp: false, showMessageIds: false,
            enableGenerationProfiles: false, generationProfiles: '{}', enableHideForYou: false,
            messageRecoveryEnabled: false, enableSidebarLayout: false, styleOverrides: null,
            enableRoundedProfileImages: false, enableSquareMessageEdges: false
        };
        const attribute = 'data-sai-toolkit-capabilities';
        let revision = 0;
        let timer;
        async function publish() {
            const mine = ++revision;
            try {
                const settings = await api.storage.local.get(defaults);
                if (mine !== revision) return;
                let profiles = settings.generationProfiles;
                if (typeof profiles === 'string') {
                    try { profiles = JSON.parse(profiles); } catch (_) { profiles = null; }
                }
                const hasProfiles = !!profiles && typeof profiles === 'object' && !Array.isArray(profiles) && Object.keys(profiles).length > 0;
                const style = normalizeStyleOverrides(settings.styleOverrides);
                const colors = style.enabled && styleOverridesHaveColors(style);
                const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
                const payload = JSON.stringify({
                    schemaVersion: 1,
                    version: api.runtime.getManifest().version,
                    features: {
                        generationStats: settings.showGenerationStats === true,
                        timestamps: settings.showTimestamp === true,
                        messageIds: settings.showMessageIds === true,
                        generationProfiles: hasProfiles || settings.enableGenerationProfiles === true,
                        hideForYou: settings.enableHideForYou === true,
                        failedMessageRecovery: settings.messageRecoveryEnabled === true,
                        sidebarLayout: settings.enableSidebarLayout === true,
                        customMessageColors: !!colors,
                        botMessageColors: !!(style.enabled && style.botMessageBg[theme]),
                        userMessageColors: !!(style.enabled && style.userMessageBg[theme]),
                        buttonHoverColors: !!(style.enabled && style.buttonHover[theme]),
                        backgroundImage: !!style.backgroundImage,
                        roundedProfileImages: settings.enableRoundedProfileImages === true,
                        squareMessageEdges: settings.enableSquareMessageEdges === true
                    }
                });
                const root = document.documentElement;
                if (root.getAttribute(attribute) !== payload) {
                    root.setAttribute(attribute, payload);
                    root.dispatchEvent(new Event('sai-toolkit-capabilities-changed', { bubbles: true }));
                }
            } catch (_) {
                if (mine !== revision) return;
                const root = document.documentElement;
                if (root?.hasAttribute(attribute)) {
                    root.removeAttribute(attribute);
                    root.dispatchEvent(new Event('sai-toolkit-capabilities-changed', { bubbles: true }));
                }
            }
        }
        function schedule() {
            ++revision;
            clearTimeout(timer);
            timer = setTimeout(publish, 50);
        }
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && Object.keys(changes).some(key => Object.hasOwn(defaults, key))) schedule();
        });
        // Observe only the root class (native Light/Dark changes), not the page subtree.
        new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('pageshow', schedule);
        publish();
    }
    if (document.documentElement) initToolkitCapabilities();
    else document.addEventListener('DOMContentLoaded', initToolkitCapabilities, { once: true });

    // Call initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenVisible);
    } else {
        // DOM is already loaded
        initWhenVisible();
    }

})(); // End of async IIFE
