// =============================================================================
// S.AI Toolkit — extension bridge page (EXPERIMENTAL, Debug Mode only)
// =============================================================================
// Loaded by the content script in a hidden <iframe> on spicychat.ai. Because it
// is an extension page, it runs at the EXTENSION origin — the same origin as the
// background page — so it can reach things a content script can't:
//   - the stats IndexedDB database (sai_toolkit_stats), directly
//   - runtime.getBackgroundPage() / runtime.reload()
// Purpose: find out whether, on browsers that kill the background page and don't
// bring it back (Orion on iOS), an extension page can (a) save stats without the
// background and/or (b) revive it.
//
// SECURITY: any script on the host page can postMessage this frame, so:
//   1. messages are only accepted from https://spicychat.ai;
//   2. every message must carry a token the content script wrote to
//      storage.local — page scripts can't read extension storage;
//   3. nothing runs unless Debug Mode AND the bridge experiment are both on;
//   4. the only write it performs is a stats merge-put (same rule as background).
// =============================================================================
'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const HOST_ORIGIN = 'https://spicychat.ai';
const IDB_NAME = 'sai_toolkit_stats';
const IDB_STORE = 'stats';
const BRIDGE_TOKEN_KEY = 'bridgeToken';
const BRIDGE_ENABLED_KEY = 'experimentalBridge';

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + ' ms')), ms); })
    ]).finally(() => clearTimeout(timer));
}

function storageGet(keys) {
    return withTimeout(Promise.resolve(api.storage.local.get(keys)), 4000, 'storage.get');
}

// Open the EXISTING stats database. Never create or upgrade it here: schema
// ownership stays with background.js. If it doesn't exist yet, abort the implicit
// creation so no empty database is left behind.
function openStatsDb() {
    return withTimeout(new Promise((resolve, reject) => {
        let created = false;
        const req = indexedDB.open(IDB_NAME);
        req.onupgradeneeded = () => { created = true; try { req.transaction.abort(); } catch (_) {} };
        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); reject(new Error('stats store not found')); return; }
            resolve(db);
        };
        req.onerror = () => reject(created ? new Error('stats database does not exist yet') : (req.error || new Error('open failed')));
        req.onblocked = () => reject(new Error('open blocked'));
    }), 6000, 'indexedDB.open');
}

// Same merge rule as background.js mergeLiveWrite(): an "→" (request → response)
// model is never replaced by a plain one; other fields are filled, not blanked.
function mergeLiveWrite(prev, incoming) {
    const prevArrow = !!(prev.model && prev.model.includes('→'));
    const incArrow  = !!(incoming.model && incoming.model.includes('→'));
    return {
        messageId:   incoming.messageId,
        characterId: incoming.characterId || prev.characterId || null,
        model:       (prevArrow && !incArrow) ? prev.model : (incoming.model || prev.model || null),
        max_tokens:  incoming.max_tokens  ?? prev.max_tokens  ?? null,
        temperature: incoming.temperature ?? prev.temperature ?? null,
        top_p:       incoming.top_p       ?? prev.top_p       ?? null,
        top_k:       incoming.top_k       ?? prev.top_k       ?? null,
        role:        incoming.role || prev.role || null
    };
}

function cleanRecord(r) {
    if (!r || typeof r.messageId !== 'string' || !r.messageId) throw new Error('bad record');
    const pick = (v) => (v === undefined ? null : v);
    return {
        messageId: r.messageId,
        characterId: typeof r.characterId === 'string' ? r.characterId : null,
        model: pick(r.model), max_tokens: pick(r.max_tokens), temperature: pick(r.temperature),
        top_p: pick(r.top_p), top_k: pick(r.top_k), role: pick(r.role)
    };
}

async function putStats(record) {
    const rec = cleanRecord(record);
    const db = await openStatsDb();
    try {
        await withTimeout(new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const getReq = store.get(rec.messageId);
            getReq.onsuccess = () => { store.put(getReq.result ? mergeLiveWrite(getReq.result, rec) : rec); };
            getReq.onerror = () => reject(getReq.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('put aborted'));
        }), 6000, 'stats put');
    } finally {
        try { db.close(); } catch (_) {}
    }
    return { stored: true };
}

function pingBackground() {
    return withTimeout(new Promise((resolve) => {
        try {
            api.runtime.sendMessage({ type: 'SAI_KEEPALIVE_PING' }, (res) => {
                const err = api.runtime.lastError;
                resolve(err ? { alive: false, error: err.message } : { alive: !!(res && res.alive), reply: res === undefined ? 'empty' : 'ok' });
            });
        } catch (e) { resolve({ alive: false, error: e.message }); }
    }), 3000, 'background ping').catch((e) => ({ alive: false, error: e.message }));
}

// runtime.getBackgroundPage() is documented to start a non-persistent background
// page that isn't running. Whether it does so here is what we want to learn.
async function getBackgroundPage() {
    if (!api.runtime.getBackgroundPage) return { available: false };
    try {
        const page = await withTimeout(new Promise((resolve, reject) => {
            try {
                const maybe = api.runtime.getBackgroundPage((p) => {
                    const err = api.runtime.lastError;
                    if (err) reject(new Error(err.message)); else resolve(p);
                });
                if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
            } catch (e) { reject(e); }
        }), 4000, 'getBackgroundPage');
        return { available: true, gotPage: !!page };
    } catch (e) {
        return { available: true, gotPage: false, error: e.message };
    }
}

async function diagnose() {
    const out = { origin: location.origin, apis: { runtime: !!(api && api.runtime), storage: !!(api && api.storage) } };
    try { const db = await openStatsDb(); out.database = { opened: true }; db.close(); }
    catch (e) { out.database = { opened: false, error: e.message }; }
    out.backgroundBefore = await pingBackground();
    return out;
}

async function revive() {
    const out = { before: await pingBackground() };
    out.getBackgroundPage = await getBackgroundPage();
    await new Promise(r => setTimeout(r, 600));
    out.after = await pingBackground();
    return out;
}

async function authorised(token) {
    const s = await storageGet(['debugMode', BRIDGE_ENABLED_KEY, BRIDGE_TOKEN_KEY]);
    return s.debugMode === true && s[BRIDGE_ENABLED_KEY] === true &&
        typeof token === 'string' && token.length >= 16 && token === s[BRIDGE_TOKEN_KEY];
}

window.addEventListener('message', async (ev) => {
    if (ev.origin !== HOST_ORIGIN || !ev.data || ev.data.__saiBridge !== 'request') return;
    const { id, cmd, token, record } = ev.data;
    const reply = (body) => { try { ev.source.postMessage({ __saiBridge: 'reply', id, ...body }, ev.origin); } catch (_) {} };
    try {
        if (!(await authorised(token))) { reply({ ok: false, error: 'not authorised' }); return; }
        if (cmd === 'diagnose') reply({ ok: true, result: await diagnose() });
        else if (cmd === 'put') reply({ ok: true, result: await putStats(record) });
        else if (cmd === 'revive') reply({ ok: true, result: await revive() });
        else if (cmd === 'reload') { reply({ ok: true, result: { reloading: true } }); setTimeout(() => api.runtime.reload(), 150); }
        else reply({ ok: false, error: 'unknown command' });
    } catch (e) {
        reply({ ok: false, error: e && e.message ? e.message : String(e) });
    }
});

// Tell the content script the page actually loaded and ran.
try { window.parent.postMessage({ __saiBridge: 'ready' }, HOST_ORIGIN); } catch (_) {}
