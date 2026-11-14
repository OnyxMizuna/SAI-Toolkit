/**
 * Background service worker for S.AI Toolkit
 * Handles extension-wide tasks and Drive sync
 */

const storageAPI = typeof browser !== 'undefined' ? browser : chrome;

// =============================================================================
// DRIVE SYNC
// =============================================================================
//
// Setup (one-time, per developer):
//   1. Google Cloud Console → create a project → enable the Drive API
//   2. APIs & Services → Credentials → Create OAuth client ID
//      Type: Web application
//      Authorised redirect URIs:
//        Chrome: https://<YOUR_CHROME_EXTENSION_ID>.chromiumapp.org/
//        Firefox: https://<YOUR_FIREFOX_EXTENSION_ID>.extensions.allizom.org/
//        (call browser.identity.getRedirectURL() at runtime to get the exact URI)
//   3. Paste the client ID below.
//   4. OAuth consent screen → set scope to drive.file (non-sensitive — no verification needed).
//
// The extension stores one file in the user's Drive: sai-toolkit-sync.json
// Only files created by this extension are visible to it (drive.file scope).

const DRIVE_CLIENT_ID       = '398869461517-v31635ukag9i28skpmf1e093dab9b37o.apps.googleusercontent.com';
const DRIVE_SCOPE           = 'https://www.googleapis.com/auth/drive.file';
// Relay redirect URI for the tab-based code flow (browsers where launchWebAuthFlow doesn't work, e.g. iOS).
// Must match an Authorised Redirect URI in Google Cloud Console.
const PKCE_RELAY_URL        = 'https://oauth-relay.onyxmizuna.eu/oauth-callback';
// OAuth token broker (Cloudflare Worker) that holds the client_secret and runs the
// authorization-code / refresh-token exchanges server-side. See spicychat/token-broker/.
// TODO: set this to your deployed Worker URL after `wrangler deploy`.
const TOKEN_BROKER_URL      = 'https://sai-token-broker.onyxmizuna-oauth-relay.workers.dev';
const DRIVE_FILE_NAME       = 'sai-toolkit-sync.json';
const STATS_KEY             = 'messageGenerationStats';
const BACKUP_FOLDER_NAME    = 'S.AI Toolkit';
const BACKUP_FILE_PREFIX    = 'sai-toolkit-backup-';
const AUTO_SYNC_ALARM_NAME  = 'driveAutoSync';

// Keys included in each sync section
const SETTINGS_SYNC_KEYS = [
    'enableSidebarLayout', 'sidebarMinWidth',
    'enableCompactGeneration', 'enableHideForYou', 'enablePageJump',
    'showGenerationStats', 'showModelDetails', 'showTimestamp',
    'timestampDateFirst', 'timestamp24Hour', 'showMessageIds',
    'showChatNameInTitle', 'nsfwToggleEnabled', 'messageRecoveryEnabled',
    'enableGenerationProfiles', 'enableRoundedProfileImages',
    'enableSwapCheckboxPosition', 'enableSquareMessageEdges',
    'highlightModelChanges', 'autoRegenOnMismatch', 'autoRegenOnShort',
    'autoRegenMaxAttempts',
    'memoryDotEnabled', 'memoryDotColor', 'hideCreatorName',
    'generationProfiles', 'lastSelectedProfile'
];
// Style tab's individual overrides (bubble BGs, button hover, background image).
// The retired Custom Style keys (enableCustomStyle/customStyleValues) are NOT
// synced: they're kept per-device only until the user exports + clears them,
// and pulling them back down from Drive would resurrect cleared data. Any copy
// already in the Drive file is dropped the next time Style is synced.
const STYLE_SYNC_KEYS = ['styleOverrides'];

function pickKeys(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

// ---- Stat-record merge helper ----
// Merges one {model,max_tokens,temperature,top_p,top_k,role} leaf: the "→" arrow
// (request → response) model wins; otherwise field-level merge. Used by mergeRecords
// for the IndexedDB store (both the per-message live write and the Drive-sync collapse).

function mergeMessageEntry(local, remote) {
    const localArrow  = !!local.model?.includes('→');
    const remoteArrow = !!remote.model?.includes('→');
    if (localArrow && !remoteArrow) return local;
    if (remoteArrow && !localArrow) return remote;
    return {
        model:       local.model       || remote.model       || null,
        max_tokens:  local.max_tokens  ?? remote.max_tokens  ?? null,
        temperature: local.temperature ?? remote.temperature ?? null,
        top_p:       local.top_p       ?? remote.top_p       ?? null,
        top_k:       local.top_k       ?? remote.top_k       ?? null,
        role:        local.role        || remote.role        || null
    };
}

// =============================================================================
// INDEXEDDB STATS STORE  (extension origin — the single owner of message stats)
// =============================================================================
//
// Why here: IndexedDB is partitioned by origin. The background (MV2 background
// page / MV3 service worker) runs at the EXTENSION origin; content scripts run
// at the spicychat.ai PAGE origin. Only the background's IndexedDB is the
// durable, shared extension-origin store, so the background OWNS the data and
// the content script reaches it via SAI_STATS_* runtime messages.
//
// Schema: store "stats" keyed by messageId (globally unique), with a
// "by_character" index. Records: { messageId, characterId, model, max_tokens,
// temperature, top_p, top_k, role }. conversationId is DROPPED — a cloned chat
// reuses message IDs under a new conversation, and stats are intrinsic to the
// message's generation, so messageId is the natural key.
//
// The Drive WIRE format stays nested (characterId -> conversationId -> messageId)
// for cross-version compatibility: import collapses the conversation level via
// mergeMessageEntry; export writes everything under a single "_default" bucket
// per character.

const IDB_NAME       = 'sai_toolkit_stats';
const IDB_VERSION    = 1;
const IDB_STORE      = 'stats';
const IDB_CHAR_INDEX = 'by_character';
const IDB_EXPORT_BUCKET = '_default';   // synthetic conversation bucket for the nested wire format
const STATS_MIGRATION_FLAG = 'statsMigratedToIDB';
const IDB_WRITE_CHUNK = 1000;           // bulk-write batch size — keeps iOS/WebKit transactions small
const STATS_OPEN_TIMEOUT_MS = 8000;     // a healthy indexedDB.open resolves in ms; on Orion a
                                        // post-suspend open can hang forever with NO event firing
const STATS_MIGRATION_TIMEOUT_MS = 120000; // one-time first-run migration of the legacy blob can be
                                        // large; it gets its OWN generous cap (separate from the
                                        // per-op backstop) so a slow-but-progressing migration is
                                        // never killed — but a HUNG one still rejects + resets its gate
const STATS_RETRY_BACKOFF_MS = [250, 750]; // backoffs for getLiveStatsDB reopen + the merge-step retry

let _statsDbPromise = null;

function openStatsDB() {
    if (_statsDbPromise) return _statsDbPromise;
    const openPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(IDB_NAME, IDB_VERSION);
        } catch (e) {
            reject(e);
            return;
        }
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                const store = db.createObjectStore(IDB_STORE, { keyPath: 'messageId' });
                store.createIndex(IDB_CHAR_INDEX, 'characterId', { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // Drop the cached connection if THIS handle is force-closed (background teardown) or
            // superseded by a version change, so the next op reopens fresh — but only if it is
            // still the cached one. closeStatsDB() can close an OLD handle after a newer connection
            // has already been cached; without this identity guard the old handle's late onclose
            // would null the healthy new cache (benign — just an extra reopen — but avoidable).
            const dropIfCurrent = () => {
                if (!_statsDbPromise) return;
                _statsDbPromise.then(d => { if (d === db) _statsDbPromise = null; }).catch(() => {});
            };
            db.onclose = dropIfCurrent;
            db.onversionchange = () => { try { db.close(); } catch (_) {} dropIfCurrent(); };
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    });
    // Time-box the open itself. The open is awaited OUTSIDE statsOp's per-op timeout, so a hung
    // open (Orion post-suspend: no onsuccess/onerror ever fires) would otherwise wedge the
    // serialized stats queue forever. On timeout/error, clear the cache so the next op reopens.
    _statsDbPromise = withStatsTimeout(openPromise, STATS_OPEN_TIMEOUT_MS, 'open')
        .catch(err => { _statsDbPromise = null; throw err; });
    return _statsDbPromise;
}

// Drop the cached IDB connection so it cannot straddle an OS-suspend window (the long Orion
// sign-in tab flow) and come back a zombie whose transactions never fire. Nulling the cache
// synchronously guarantees the next openStatsDB() opens fresh on the awake page; the old handle
// is closed best-effort (IndexedDB defers the actual close until in-flight txns finish).
function closeStatsDB() {
    const p = _statsDbPromise;
    _statsDbPromise = null;
    if (p) p.then(db => { try { db.close(); } catch (_) {} }).catch(() => {});
}

// A stat leaf carries data worth keeping iff it has a model or any non-null param.
// This is the single prune predicate used by idbExportNested and idbPrune.
function statLeafHasData(e) {
    return !!(e && (e.model || e.max_tokens != null || e.temperature != null
        || e.top_p != null || e.top_k != null));
}

// Build a normalised IDB record (the 6 stat fields + keys) from a nested-wire leaf.
function recordFromLeaf(messageId, characterId, leaf) {
    return {
        messageId:   messageId,
        characterId: characterId || null,
        model:       leaf.model       || null,
        max_tokens:  leaf.max_tokens  ?? null,
        temperature: leaf.temperature ?? null,
        top_p:       leaf.top_p       ?? null,
        top_k:       leaf.top_k       ?? null,
        role:        leaf.role        || null
    };
}

// Merge two records for the SAME messageId (used when collapsing/importing).
// Reuses mergeMessageEntry for the stat fields (arrow-model wins, field-level merge),
// then re-attaches the keys.
function mergeRecords(prev, incoming) {
    const m = mergeMessageEntry(prev, incoming);
    // Build a FRESH object — mergeMessageEntry returns one of its args by reference in
    // the arrow-model branches, and we must not mutate the shared in-memory snapshot.
    return {
        messageId:   incoming.messageId,
        characterId: incoming.characterId || prev.characterId || null,
        model:       m.model,
        max_tokens:  m.max_tokens,
        temperature: m.temperature,
        top_p:       m.top_p,
        top_k:       m.top_k,
        role:        m.role
    };
}

// Read every record into a { [messageId]: record } map (one getAll — safe vs the
// async-in-transaction auto-commit gotcha on WebKit).
function idbGetAllMap(db) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        // A transaction can be aborted by the engine (storage pressure, forced close on
        // WebKit/SW teardown) without the request's onerror firing — reject so callers
        // (and statsOp/handlers) fail rather than hang forever.
        tx.onabort = () => reject(tx.error || new Error('idbGetAllMap aborted'));
        tx.onerror = () => reject(tx.error);
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => {
            const map = {};
            for (const r of req.result) map[r.messageId] = r;
            resolve(map);
        };
        req.onerror = () => reject(req.error);
    });
}

// Stats for one character as { [messageId]: {model,max_tokens,temperature,top_p,top_k,role} }
// (the exact shape getStatsForMessage expects). Uses the by_character index.
function idbGetCharacter(db, characterId) {
    return new Promise((resolve, reject) => {
        if (!characterId) { resolve({}); return; }
        const tx  = db.transaction(IDB_STORE, 'readonly');
        tx.onabort = () => reject(tx.error || new Error('idbGetCharacter aborted'));
        tx.onerror = () => reject(tx.error);
        const idx = tx.objectStore(IDB_STORE).index(IDB_CHAR_INDEX);
        const req = idx.getAll(IDBKeyRange.only(characterId));
        req.onsuccess = () => {
            const map = {};
            for (const r of req.result) {
                map[r.messageId] = {
                    model: r.model, max_tokens: r.max_tokens, temperature: r.temperature,
                    top_p: r.top_p, top_k: r.top_k, role: r.role
                };
            }
            resolve(map);
        };
        req.onerror = () => reject(req.error);
    });
}

// Synchronous put-loop in ONE transaction (avoids async-in-txn auto-commit).
// Bulk upsert in CHUNKED transactions. iOS/WebKit chokes — and the whole sync APPEARS
// FROZEN — on a single transaction holding tens of thousands of synchronous put()s (e.g.
// the one-time migration of the legacy ~11 MB blob). Each chunk is its own transaction
// (synchronous put-loop inside, WebKit-safe), and awaiting between chunks yields the event
// loop so the page, keepalive port and progress UI stay responsive.
async function idbPutAll(db, records) {
    if (!records.length) return 0;
    for (let i = 0; i < records.length; i += IDB_WRITE_CHUNK) {
        const batch = records.slice(i, i + IDB_WRITE_CHUNK);
        await new Promise((resolve, reject) => {
            const tx    = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            for (const r of batch) store.put(r);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
            tx.onabort    = () => reject(tx.error || new Error('idbPutAll batch aborted'));
        });
    }
    return records.length;
}

// Merge for a LIVE single-message write. The incoming record reflects a fresh
// observation and is authoritative field-by-field — EXCEPT we never let a non-arrow
// model overwrite an existing "request → response" arrow model (the one field a stale
// content read could regress if a concurrent Drive sync merged the arrow in between the
// read and this write), and we never null out a param the store already knows. role
// takes the INCOMING value so a corrupted-marker repair (role 'user' → 'bot',
// content.js MESSAGES_LOADED) still applies — a prev-biased merge would wrongly keep the
// corrupt 'user'. (The sync/import path uses prev-biased mergeRecords instead.)
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

// Upsert ONE record, merging with any existing record for the same messageId via
// mergeLiveWrite. Merging (not raw overwriting) guarantees a stale content-side read can
// never clobber a richer arrow-model entry that a concurrent Drive-sync merge landed in
// the gap between the content read and this PUT. The get + put run in ONE transaction,
// with the put issued synchronously inside the get's onsuccess, so the transaction never
// auto-commits between them (WebKit-safe).
function idbMergePut(db, record) {
    return new Promise((resolve, reject) => {
        const tx     = db.transaction(IDB_STORE, 'readwrite');
        const store  = tx.objectStore(IDB_STORE);
        const getReq = store.get(record.messageId);
        getReq.onsuccess = () => {
            const prev = getReq.result;
            store.put(prev ? mergeLiveWrite(prev, record) : record);
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new Error('idbMergePut aborted'));
    });
}

function idbDelete(db, messageId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(messageId);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new Error('idbDelete aborted'));
    });
}

function idbClear(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new Error('idbClear aborted'));
    });
}

// True iff two records carry identical stat fields + characterId (messageId is the key).
function recordsEqual(a, b) {
    return a.model === b.model
        && a.max_tokens === b.max_tokens
        && a.temperature === b.temperature
        && a.top_p === b.top_p
        && a.top_k === b.top_k
        && a.role === b.role
        && a.characterId === b.characterId;
}

// Merge a nested-wire stats object (characterId -> conversationId -> messageId -> leaf)
// into the store, COLLAPSING the conversation level by messageId. Never overwrites a
// richer entry — uses mergeMessageEntry semantics against the existing record. The merge
// is computed in memory, then ONLY records that are new or actually changed are written.
// Skipping unchanged records is essential on the first sync after migration: the remote
// is ~identical to what migration just imported, so this writes near-zero records instead
// of rewriting tens of thousands (which froze iOS/WebKit).
async function idbBulkMergeNested(db, nested) {
    if (!nested || typeof nested !== 'object') return 0;
    const existing = await idbGetAllMap(db);
    const touched = {};
    for (const characterId of Object.keys(nested)) {
        const convs = nested[characterId];
        if (!convs || typeof convs !== 'object') continue;
        for (const convId of Object.keys(convs)) {
            const msgs = convs[convId];
            if (!msgs || typeof msgs !== 'object') continue;
            for (const messageId of Object.keys(msgs)) {
                const leaf = msgs[messageId];
                if (!statLeafHasData(leaf)) continue;
                const incoming = recordFromLeaf(messageId, characterId, leaf);
                const prev = touched[messageId] || existing[messageId];
                touched[messageId] = prev ? mergeRecords(prev, incoming) : incoming;
            }
        }
    }
    const toWrite = [];
    for (const id of Object.keys(touched)) {
        const cur = existing[id];
        if (!cur || !recordsEqual(cur, touched[id])) toWrite.push(touched[id]);
    }
    await idbPutAll(db, toWrite);
    return toWrite.length;
}

// Assemble the nested wire format from the store, pruning empty leaves and writing
// everything under one synthetic conversation bucket per character.
async function idbExportNested(db) {
    const map = await idbGetAllMap(db);
    const out = {};
    for (const messageId of Object.keys(map)) {
        const r = map[messageId];
        if (!statLeafHasData(r)) continue;
        const characterId = r.characterId || IDB_EXPORT_BUCKET;
        if (!out[characterId]) out[characterId] = {};
        if (!out[characterId][IDB_EXPORT_BUCKET]) out[characterId][IDB_EXPORT_BUCKET] = {};
        out[characterId][IDB_EXPORT_BUCKET][messageId] = {
            model: r.model || null,
            max_tokens: r.max_tokens ?? null,
            temperature: r.temperature ?? null,
            top_p: r.top_p ?? null,
            top_k: r.top_k ?? null,
            role: r.role || null
        };
    }
    return out;
}

// Drop records that carry no meaningful data (legacy null-only entries).
async function idbPrune(db) {
    const map = await idbGetAllMap(db);
    const deadKeys = Object.keys(map).filter(id => !statLeafHasData(map[id]));
    if (!deadKeys.length) return 0;
    await new Promise((resolve, reject) => {
        const tx    = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        for (const id of deadKeys) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
        tx.onabort    = () => reject(tx.error || new Error('idbPrune aborted'));
    });
    return deadKeys.length;
}

// ---- One-time migration: storage.local JSON blob -> IndexedDB ----
// Idempotent and gated by a flag. Every stats handler (and the Drive sync stats
// branch) awaits this before touching the store, so the DB is always populated
// before first access. The legacy blob under STATS_KEY is intentionally RETAINED
// one release as a safety net (a later release removes it).
let _statsMigrationPromise = null;
function ensureStatsMigrated() {
    if (_statsMigrationPromise) return _statsMigrationPromise;
    _statsMigrationPromise = withStatsTimeout((async () => {
        const flag = await storageAPI.storage.local.get(STATS_MIGRATION_FLAG);
        if (flag[STATS_MIGRATION_FLAG]) return;
        const t0 = Date.now();
        const stored = await storageAPI.storage.local.get(STATS_KEY);
        const raw = stored[STATS_KEY];
        let blob = {};
        if (raw) {
            try { blob = JSON.parse(raw); } catch (e) { blob = {}; }
        }
        const botCount = Object.keys(blob).length;
        if (botCount) {
            const db = await getLiveStatsDB();
            // The legacy-blob migration is a long, message-silent bulk merge — the same suspendable
            // window as the Drive merge — but it runs at startup with no sync tabId. Resolve a (prefer
            // active) SpicyChat tab so a content-script heartbeat can keep the bg awake through it.
            // Best-effort: if none is open, runWithMergeHeartbeat proceeds and the withStatsTimeout cap
            // is the only backstop. Covers first-run / first-upgrade-from-pre-IDB on Orion.
            let _migTab = null;
            try {
                const tabs = await storageAPI.tabs.query({ url: '*://spicychat.ai/*' });
                const live = (tabs || []).find(t => t.active) || (tabs || [])[0];
                _migTab = live ? live.id : null;
            } catch (_) {}
            const n = await runWithMergeHeartbeat(_migTab, () => idbBulkMergeNested(db, blob));
            console.log(`[Stats IDB] migrated ${n} message records from ${botCount} bots in ${Date.now() - t0} ms`);
        } else {
            console.log('[Stats IDB] migration: no legacy blob to import');
        }
        await storageAPI.storage.local.set({ [STATS_MIGRATION_FLAG]: true });
    })(), STATS_MIGRATION_TIMEOUT_MS, 'migrate').catch(err => {
        // Reset the gate so a later access rebuilds migration on a fresh connection. The
        // withStatsTimeout above is what makes this reset reliable: a HUNG migration (a zombie
        // txn mid-putAll after an OS suspend) now REJECTS at the cap instead of leaving this
        // promise pending forever — which would otherwise wedge every later stats op at the
        // per-op cap (the same hang, re-skinned). A slow-but-progressing migration is unaffected.
        _statsMigrationPromise = null;
        console.warn('[Stats IDB] migration failed:', err && err.message);
        throw err;
    });
    return _statsMigrationPromise;
}

// Kick off migration at startup so it is ready before the first message/sync.
ensureStatsMigrated().catch(() => {});

// Serialise ALL stats DB operations so a Drive-sync bulk merge (getAll snapshot ->
// putAll) can never interleave with a concurrent live PUT/DELETE for the same
// messageId. This closes the only write race the per-record model would otherwise
// leave open (the prior whole-blob clobber race is already gone). Reads run through
// the same queue so they observe a consistent post-write snapshot. Migration runs
// OUTSIDE this queue (statsOp awaits it first), so there is no deadlock.
let _statsOpQueue = Promise.resolve();

// A stats DB op must never hang forever. On Orion the MV2 background page can be
// OS-suspended mid-transaction; on resume WebKit may silently invalidate the cached
// IndexedDB connection WITHOUT firing db.onclose, so a transaction created on it fires
// no oncomplete/onerror/onabort and its Promise never settles. Because every op is
// serialized through _statsOpQueue, one such dead op would wedge the queue forever
// (this caused the "Merging data…" hang on Drive disconnect→reconnect: the long sign-in
// tab flow lets the page suspend with a live cached connection that then goes stale).
// The guards below make the layer self-healing.

const STATS_PROBE_TIMEOUT_MS = 4000;    // a live connection answers a trivial txn in ms
const STATS_OP_TIMEOUT_MS    = 60000;   // backstop only — real ops (incl. large chunked writes) finish well under this

// Invariant: getLiveStatsDB's worst-case open+probe retry budget must stay UNDER the per-op cap,
// or a slow-but-recovering post-suspend connection would be killed as a spurious op-timeout
// instead of recovering. Today: (8000+4000)*3 + (250+750) = 37000 < 60000. This guard fires only
// if a future tuning of any of these constants breaks that headroom — it never fires as shipped.
if ((STATS_OPEN_TIMEOUT_MS + STATS_PROBE_TIMEOUT_MS) * (STATS_RETRY_BACKOFF_MS.length + 1)
    + STATS_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0) >= STATS_OP_TIMEOUT_MS) {
    console.warn('[Stats IDB] config: getLiveStatsDB retry budget >= STATS_OP_TIMEOUT_MS — slow post-suspend recoveries may be killed as op-timeouts; raise STATS_OP_TIMEOUT_MS or lower the open/probe/backoff values.');
}

function withStatsTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('stats op timed out: ' + label)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Prove the connection is alive with a trivial, time-boxed transaction. A connection
// killed by an OS suspend hangs here (no event ever fires) and is rejected by the probe
// timeout, rather than hanging the real op forever.
function probeStatsDB(db) {
    return withStatsTimeout(new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(IDB_STORE, 'readonly'); }
        catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(true);
        tx.onabort    = () => reject(tx.error || new Error('probe aborted'));
        tx.onerror    = () => reject(tx.error);
        try { tx.objectStore(IDB_STORE).count(); } catch (e) { reject(e); }
    }), STATS_PROBE_TIMEOUT_MS, 'probe');
}

function statsDelay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Open the DB and verify it actually responds. A post-suspend zombie connection (cached OR
// freshly opened) answers no events; probe it, and on failure reopen and RE-PROBE with a short
// backoff — because immediately post-resume even a just-reopened handle can still be stale until
// WebKit's storage subsystem recovers. Retrying here turns a second consecutive zombie into a
// ~few-second recovery instead of a 60s op-timeout, which is what lets the merge succeed on (or
// near) the first attempt on Orion rather than failing and needing a manual re-tap.
async function getLiveStatsDB() {
    let lastErr;
    for (let attempt = 0; attempt <= STATS_RETRY_BACKOFF_MS.length; attempt++) {
        let db = null;
        try {
            db = await openStatsDB();
            await probeStatsDB(db);
            return db;
        } catch (e) {
            lastErr = e;
            console.warn('[Stats IDB] connection check failed — reopening (attempt ' + (attempt + 1) + '):', e && e.message);
            if (db) { try { db.close(); } catch (_) {} }
            _statsDbPromise = null;
            if (attempt < STATS_RETRY_BACKOFF_MS.length) await statsDelay(STATS_RETRY_BACKOFF_MS[attempt]);
        }
    }
    throw lastErr;
}

// Run a stats DB operation: wait for migration, get a verified-live connection, then run
// fn(db) under a watchdog — all strictly ordered behind any prior op. The watchdog
// guarantees `run` always settles, so a never-settling transaction can no longer wedge
// the queue permanently; on failure the cached connection is dropped so the next op
// reopens fresh. Errors are isolated so one failure can't wedge the queue.
function statsOp(fn) {
    // Time-box the connection open/probe AND fn(db). On Orion a post-suspend `indexedDB.open`, or
    // a transaction on a zombie connection, can hang with NO event ever firing; because every op
    // is serialized through _statsOpQueue, an un-time-boxed hang here would wedge the queue forever
    // (the "Merging data…" hang — the merge op queues behind a dead op and never even starts, so no
    // probe/op-timeout log ever appears). Migration is the ONE thing run outside this race — see
    // below — because it has its own (longer) cap and capping it twice would re-introduce the wedge.
    const run = _statsOpQueue.catch(() => {}).then(async () => {
        // Run migration to completion BEFORE starting the per-op clock. A legitimate one-time
        // first-run migration of a large legacy blob can exceed STATS_OP_TIMEOUT_MS, and it is
        // already time-boxed by its own generous cap inside ensureStatsMigrated(). Boxing it here
        // too would kill a slow-but-valid migration AND leave its promise pending — re-wedging
        // every later op. (ensureStatsMigrated() can no longer hang, so awaiting it here is safe.)
        // Past migration, time-box open+probe+fn — the real never-settle hang targets.
        await ensureStatsMigrated();
        return withStatsTimeout((async () => {
            const db = await getLiveStatsDB();
            try {
                return await fn(db);
            } catch (err) {
                try { db.close(); } catch (_) {}
                throw err;
            }
        })(), STATS_OP_TIMEOUT_MS, 'op');
    }).catch(err => {
        // Any failure/timeout: drop the cached connection so the next op reopens a fresh one
        // instead of reusing a (possibly dead) handle, and so the queue is never left chained to a
        // wedged op. Also clear a stuck migration gate on timeout — belt-and-suspenders so a
        // hung/abandoned migration is rebuilt next time rather than re-awaited forever.
        _statsDbPromise = null;
        if (err && /timed out/.test(err.message)) _statsMigrationPromise = null;
        throw err;
    });
    _statsOpQueue = run.catch(() => {});
    return run;
}

// ---- OAuth token management ----
//
// Authorization Code + PKCE flow. We obtain a long-lived refresh token once and
// then mint short-lived access tokens silently via the token broker — no tab,
// no SSO-cookie dependence — so renewals work the same on Chrome, Firefox and
// Orion/iOS. The client_secret lives only in the Worker (see TOKEN_BROKER_URL
// and spicychat/token-broker/).

// PKCE helpers
function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

async function computeCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64UrlEncode(digest);
}

// Build the Google authorization URL for the code flow. access_type=offline +
// prompt=consent guarantee Google returns a refresh_token (it otherwise omits it
// on repeat authorizations for a client the user has already approved).
function buildAuthUrl(redirectURL, codeChallenge) {
    const params = new URLSearchParams({
        client_id:             DRIVE_CLIENT_ID,
        response_type:         'code',
        redirect_uri:          redirectURL,
        scope:                 DRIVE_SCOPE,
        code_challenge:        codeChallenge,
        code_challenge_method: 'S256',
        access_type:           'offline',
        // select_account: always show Google's account chooser, so a stale
        // Google session cookie in Safari's auth sheet can't silently pin the
        // flow to a dead/wrong session (previously only clearing cookies fixed it).
        prompt:                'select_account consent',
    });
    return `https://accounts.google.com/o/oauth2/auth?${params}`;
}

// Persist a Google token response. Refresh responses omit refresh_token, so only
// overwrite the stored refresh token when a new one is actually present.
async function storeTokenResponse(data) {
    const expiresIn = parseInt(data.expires_in || '3600', 10);
    const toStore = {
        driveAccessToken: data.access_token,
        driveTokenExpiry: Date.now() + (expiresIn - 60) * 1000,
    };
    if (data.refresh_token) toStore.driveRefreshToken = data.refresh_token;
    await storageAPI.storage.local.set(toStore);
    return data.access_token;
}

// Exchange an authorization code for tokens via the broker (which adds the secret).
async function brokerExchange(code, codeVerifier, redirectUri) {
    const res = await fetch(`${TOKEN_BROKER_URL}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        throw new Error(`Token exchange failed: ${data.error || ('HTTP ' + res.status)}`);
    }
    return data;
}

// Mint a fresh access token from a stored refresh token via the broker. Marks
// err.invalidGrant when the refresh token is dead (revoked / expired / password
// change) so the caller knows to fall back to interactive sign-in.
async function brokerRefresh(refreshToken) {
    const res = await fetch(`${TOKEN_BROKER_URL}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        const err = new Error(`Token refresh failed: ${data.error || ('HTTP ' + res.status)}`);
        err.invalidGrant = data.error === 'invalid_grant' || res.status === 400 || res.status === 401;
        throw err;
    }
    return data;
}

// Tab-based code flow — fallback for browsers where launchWebAuthFlow doesn't work (e.g. Orion iOS).
// Opens Google sign-in in a tab, watches for the redirect, extracts ?code= and exchanges it via the broker.
async function getAccessTokenTabFlow() {
    const redirectURL  = PKCE_RELAY_URL;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    const authUrl = buildAuthUrl(redirectURL, codeChallenge);

    return new Promise((resolve, reject) => {
        let authTabId;

        const cleanup = () => {
            storageAPI.tabs.onUpdated.removeListener(onUpdated);
            storageAPI.tabs.onRemoved.removeListener(onRemoved);
        };

        const onUpdated = async (tabId, changeInfo, tab) => {
            if (tabId !== authTabId) return;
            const url = tab.url || '';
            console.log('[Sync] tabFlow onUpdated — status:', changeInfo.status || '(none)', '| url starts with relay?', url.startsWith(redirectURL));
            if (!url.startsWith(redirectURL)) return;
            console.log('[Sync] tabFlow: redirect URL matched — extracting code');
            cleanup();
            storageAPI.tabs.remove(tabId).catch(() => {});
            const urlObj = new URL(url);
            const code   = urlObj.searchParams.get('code');
            const error  = urlObj.searchParams.get('error');
            if (error) {
                console.warn('[Sync] tabFlow: Google returned error:', error);
                reject(new Error('Google sign-in was cancelled or failed.'));
                return;
            }
            if (!code) {
                console.warn('[Sync] tabFlow: redirect matched but no code in query. Query keys:', [...urlObj.searchParams.keys()]);
                reject(new Error('Google sign-in was cancelled or failed.'));
                return;
            }
            try {
                console.log('[Sync] tabFlow: code obtained — exchanging via broker');
                const data  = await brokerExchange(code, codeVerifier, redirectURL);
                const token = await storeTokenResponse(data);
                console.log('[Sync] tabFlow: tokens stored', data.refresh_token ? '(got refresh token)' : '(NO refresh token!)');
                resolve(token);
            } catch (e) {
                console.error('[Sync] tabFlow: code exchange failed:', e.message);
                reject(e);
            }
        };

        const onRemoved = (tabId) => {
            if (tabId !== authTabId) return;
            console.log('[Sync] tabFlow: auth tab was closed by user before completing');
            cleanup();
            reject(new Error('Google sign-in was cancelled.'));
        };

        storageAPI.tabs.onUpdated.addListener(onUpdated);
        storageAPI.tabs.onRemoved.addListener(onRemoved);

        console.log('[Sync] tabFlow: opening Google sign-in tab — redirect URI:', redirectURL);
        // Suspend-window guard: drop any cached IDB connection BEFORE the multi-second sign-in tab,
        // during which Orion can OS-suspend the background page. With no live handle open across the
        // suspend, nothing can come back a zombie — the merge afterwards opens a fresh connection on
        // the awake page. This is the "reliable from the get-go" move: prevent the straddle that
        // causes the post-resume zombie rather than only recovering from it.
        try { closeStatsDB(); } catch (_) {}
        storageAPI.tabs.create({ url: authUrl })
            .then(tab => { authTabId = tab.id; console.log('[Sync] tabFlow: auth tab created, id:', tab.id); })
            .catch(err => { console.error('[Sync] tabFlow: failed to create auth tab:', err.message); cleanup(); reject(err); });
    });
}

async function getAccessToken(interactive) {
    const stored = await storageAPI.storage.local.get(['driveAccessToken', 'driveTokenExpiry', 'driveRefreshToken']);

    // 1) Valid cached access token (60s buffer before expiry).
    if (stored.driveAccessToken && stored.driveTokenExpiry && Date.now() < stored.driveTokenExpiry) {
        console.log('[Sync] getAccessToken: using cached token (expires in', Math.round((stored.driveTokenExpiry - Date.now()) / 1000), 's)');
        return stored.driveAccessToken;
    }

    // 2) Silent renewal via refresh token — no UI, works on every browser incl. Orion/iOS.
    if (stored.driveRefreshToken) {
        try {
            console.log('[Sync] getAccessToken: refreshing access token via broker');
            const data = await brokerRefresh(stored.driveRefreshToken);
            console.log('[Sync] getAccessToken: refreshed access token silently');
            return await storeTokenResponse(data);
        } catch (err) {
            console.warn('[Sync] getAccessToken: refresh failed —', err.message);
            if (err.invalidGrant) {
                // Refresh token is dead (revoked / 7-day testing expiry / password change).
                // Drop it so we re-run interactive consent below / on the next interactive call.
                await storageAPI.storage.local.remove(['driveRefreshToken', 'driveAccessToken', 'driveTokenExpiry']);
            } else if (!interactive) {
                // Transient broker/network error on a silent call — don't force a prompt.
                return null;
            }
            // else: fall through to interactive sign-in
        }
    }

    if (!interactive) {
        console.log('[Sync] getAccessToken: no valid token and not interactive — returning null');
        return null;
    }

    // 3) Interactive Authorization Code + PKCE sign-in (first run or after revocation).
    const redirectURL   = storageAPI.identity.getRedirectURL();
    const codeVerifier  = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);

    let responseURL;
    try {
        console.log('[Sync] getAccessToken: launching launchWebAuthFlow (code flow)');
        responseURL = await storageAPI.identity.launchWebAuthFlow({
            url: buildAuthUrl(redirectURL, codeChallenge),
            interactive: true
        });
        console.log('[Sync] getAccessToken: launchWebAuthFlow returned a response URL');
    } catch (err) {
        console.log('[Sync] getAccessToken: launchWebAuthFlow threw:', err.message);
        console.log('[Sync] getAccessToken: falling back to tab-based code flow');
        return getAccessTokenTabFlow();
    }

    const code = new URL(responseURL).searchParams.get('code');
    if (!code) throw new Error('No authorization code in OAuth response.');
    console.log('[Sync] getAccessToken: code obtained — exchanging via broker');
    const data = await brokerExchange(code, codeVerifier, redirectURL);
    console.log('[Sync] getAccessToken: tokens stored', data.refresh_token ? '(got refresh token)' : '(NO refresh token!)');
    return await storeTokenResponse(data);
}

// ---- Drive file operations ----

// Sentinel thrown when Drive returns 401 so runDriveSync can retry with fresh auth
const AUTH_EXPIRED = 'DRIVE_AUTH_EXPIRED';

// Prevent concurrent syncs (auto-sync firing while a manual sync is in progress, or vice versa)
let syncInProgress = false;

// Promise controllers for content-script-assisted Drive download.
// On Orion/WebKit iOS the background page's fetch() freezes the entire JS event
// loop when the request stalls, making timer-based timeouts impossible.
// We delegate the large file download to the content script (which has stable
// fetch behaviour), store the result in storage.local, and resolve these when
// the content script signals completion.
let _downloadResolve = null;
let _downloadReject  = null;
let _uploadResolve   = null;
let _uploadReject    = null;

// Bracket a background-only IndexedDB merge with a content-script heartbeat. On Orion/iOS the
// background page is OS-suspended during a message-silent compute window (the merge), freezing its
// event loop AND its watchdog timers — only an INCOMING message from the always-alive foreground
// content script wakes it (a manual page refresh is what used to rescue it). We ask a content tab to
// ping us for the duration, so the merge runs to completion for EVERY path — manual sync, auto-sync,
// restore, import — not just the manual UI path. Best-effort: if no tab answers BEGIN we proceed
// anyway (statsOp's retry remains the backstop); END is always sent (finally) so the tab stops.
async function runWithMergeHeartbeat(tabId, fn) {
    let begun = false;
    if (tabId != null) {
        try { await storageAPI.tabs.sendMessage(tabId, { type: 'SAI_MERGE_HEARTBEAT_BEGIN' }); begun = true; } catch (_) {}
    }
    try {
        return await fn();
    } finally {
        if (begun) {
            try { await storageAPI.tabs.sendMessage(tabId, { type: 'SAI_MERGE_HEARTBEAT_END' }); } catch (_) {}
        }
    }
}

function friendlyError(err) {
    const msg = (err && err.message) ? err.message : String(err);
    if (msg.includes('timed out') || msg.includes('timeout'))
        return 'Sync timed out — please check your connection and try again.';
    if (msg.includes('XHR network error') || msg.includes('network error'))
        return 'Network error — please check your connection and try again.';
    if (msg === AUTH_EXPIRED || msg.includes('auth expired') || msg.includes('Auth expired'))
        return 'Your Google sign-in has expired — please sync again to re-authenticate.';
    if (msg.includes('cancelled') || msg.includes('canceled'))
        return 'Google sign-in was cancelled.';
    if (msg.includes('already in progress') || msg.includes('already running'))
        return 'A sync is already running — please wait a moment and try again.';
    if (msg.includes('401') || msg.includes('403') || msg.includes('access denied'))
        return 'Google Drive access was denied — please sign in again.';
    if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('429'))
        return 'Google Drive is temporarily unavailable (rate limit) — please try again in a minute.';
    if (msg.includes('Drive read failed') || msg.includes('Drive update failed') || msg.includes('Drive create failed'))
        return `Google Drive error — please try again. (${msg})`;
    return msg;
}

async function clearCachedToken() {
    await storageAPI.storage.local.remove(['driveAccessToken', 'driveTokenExpiry', 'driveBackupFolderId']);
}

// Best-effort revoke at Google so Disconnect really severs the grant (otherwise
// Google keeps the old consent around and the next sign-in can reuse it).
async function revokeDriveTokens() {
    const { driveRefreshToken, driveAccessToken } =
        await storageAPI.storage.local.get(['driveRefreshToken', 'driveAccessToken']);
    const tok = driveRefreshToken || driveAccessToken; // revoking the refresh token kills both
    if (!tok) return;
    try {
        await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: tok }),
        });
        console.log('[Sync] revokeDriveTokens: revoke request sent');
    } catch (err) {
        console.warn('[Sync] revokeDriveTokens: revoke failed (ignored) —', err.message);
    }
}

// Non-interactive health check used by the Data tab to detect a dead sign-in
// BEFORE the user hits Sync. Returns:
//   { state: 'none' }                 — never connected / disconnected
//   { state: 'ok', email }            — token works against Drive
//   { state: 'expired', reason }      — had tokens, but none work silently
//   { state: 'unknown', reason }      — network/broker trouble; don't alarm the user
async function checkDriveAuthStatus() {
    const stored = await storageAPI.storage.local.get(['driveAccessToken', 'driveRefreshToken', 'driveFileId', 'driveLastSync']);
    const hadConnection = !!(stored.driveAccessToken || stored.driveRefreshToken || stored.driveFileId || stored.driveLastSync);
    if (!hadConnection) return { state: 'none' };

    const probe = async (token) => {
        const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
            { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) return { auth: false };
        if (!res.ok) return { auth: null, status: res.status };
        const data = await res.json().catch(() => ({}));
        return { auth: true, email: data.user && data.user.emailAddress };
    };

    // getAccessToken(false) returns null both for a dead refresh token (which it
    // deletes) and for a transient broker/network error (which leaves it in place).
    const noTokenState = async (reason) => {
        const { driveRefreshToken } = await storageAPI.storage.local.get('driveRefreshToken');
        return driveRefreshToken ? { state: 'unknown', reason: 'refresh temporarily failed' }
                                 : { state: 'expired', reason };
    };

    try {
        let token = await getAccessToken(false);
        if (!token) return await noTokenState('no usable token');
        let r = await probe(token);
        if (r.auth === false) {
            // Cached access token was rejected (revoked early, or Google's
            // clock disagrees). Drop it and try one silent refresh.
            await clearCachedToken();
            token = await getAccessToken(false);
            if (!token) return await noTokenState('refresh failed');
            r = await probe(token);
        }
        if (r.auth === true)  return { state: 'ok', email: r.email || null };
        if (r.auth === false) return { state: 'expired', reason: 'token rejected by Drive' };
        return { state: 'unknown', reason: `Drive HTTP ${r.status}` };
    } catch (err) {
        return { state: 'unknown', reason: err.message };
    }
}

async function findDriveFile(token, folderId) {
    console.log('[Sync] findDriveFile: checking cached file ID');
    const cached = await storageAPI.storage.local.get('driveFileId');
    if (cached.driveFileId) {
        console.log('[Sync] findDriveFile: cached ID found, verifying it still exists:', cached.driveFileId);
        const check = await fetch(
            `https://www.googleapis.com/drive/v3/files/${cached.driveFileId}?fields=id,parents`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (check.ok) {
            const info = await check.json();
            // Migrate file into toolkit folder if it lives elsewhere
            if (folderId && !(info.parents || []).includes(folderId)) {
                console.log('[Sync] findDriveFile: file not in toolkit folder — migrating');
                const currentParents = (info.parents || []).join(',');
                await fetch(
                    `https://www.googleapis.com/drive/v3/files/${cached.driveFileId}?addParents=${folderId}${currentParents ? `&removeParents=${currentParents}` : ''}`,
                    { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
                ).catch(() => {});
                console.log('[Sync] findDriveFile: migration complete');
            }
            console.log('[Sync] findDriveFile: resolved via cache →', cached.driveFileId);
            return cached.driveFileId;
        }
        console.log('[Sync] findDriveFile: cached ID no longer valid (HTTP', check.status, ') — clearing cache');
        await storageAPI.storage.local.remove('driveFileId');
    }

    // Search within toolkit folder
    console.log('[Sync] findDriveFile: searching within toolkit folder');
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
        const fileId = data.files[0].id;
        console.log('[Sync] findDriveFile: found in toolkit folder →', fileId);
        await storageAPI.storage.local.set({ driveFileId: fileId });
        return fileId;
    }

    // Fallback: search anywhere (catches files created before folder consolidation)
    console.log('[Sync] findDriveFile: not found in folder — running global search');
    const q2 = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const res2 = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q2}&fields=files(id,parents)&pageSize=1`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res2.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!res2.ok) throw new Error(`Drive search failed: ${res2.status}`);
    const data2 = await res2.json();
    if (data2.files && data2.files.length > 0) {
        const fileId = data2.files[0].id;
        console.log('[Sync] findDriveFile: found via global search →', fileId, '— migrating to toolkit folder');
        const currentParents = (data2.files[0].parents || []).join(',');
        // Move into toolkit folder
        await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}${currentParents ? `&removeParents=${currentParents}` : ''}`,
            { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
        ).catch(() => {});
        await storageAPI.storage.local.set({ driveFileId: fileId });
        return fileId;
    }

    console.log('[Sync] findDriveFile: no existing sync file found — will create on first write');
    return null;
}

async function readDriveFile(token, fileId, tabId) {
    const isMV2BackgroundPage = typeof XMLHttpRequest !== 'undefined';
    const t0 = Date.now();

    let parsed, bytes;

    if (isMV2BackgroundPage) {
        // On Orion/WebKit iOS, fetch() inside the background page freezes the entire
        // JS event loop when a request stalls — timers stop, AbortController can't fire,
        // nothing unblocks it. The fix: delegate the download to the content script,
        // whose fetch() is stable. The background stays idle (event loop free) and
        // polls storage every second until the content script delivers the result.
        const STORAGE_KEY = 'driveSyncTempDownload';

        // Clean up any stale result from a previous failed sync
        await storageAPI.storage.local.remove(STORAGE_KEY);

        // Wire up a Promise that the onMessage handler will resolve when the
        // content script calls back with SAI_DRIVE_DOWNLOAD_DONE / _ERROR
        const downloadPromise = new Promise((resolve, reject) => {
            _downloadResolve = resolve;
            _downloadReject  = reject;
        });

        // Tell the content script to start downloading
        console.log('[Sync] readDriveFile: delegating download to content script (tabId:', tabId, ')');
        sendSyncProgress(tabId, 'Downloading from Drive…', 3, 5, 'starting…');
        await storageAPI.tabs.sendMessage(tabId, {
            type:       'SAI_DRIVE_DOWNLOAD_REQ',
            token,
            fileId,
            storageKey: STORAGE_KEY,
        });

        // Wait — background is now idle (no fetch in flight), so the event loop is
        // free to receive the SAI_DRIVE_DOWNLOAD_DONE message from the content script.
        // The 6-minute outer timeout is a last-resort guard; content script has its
        // own per-chunk timeouts.
        const TIMEOUT_MS = 6 * 60 * 1000;
        let timeoutId;
        const timeoutPromise = new Promise((_, rej) => {
            timeoutId = setTimeout(() => rej(new Error('Drive download timed out — no response from content script (6 min)')), TIMEOUT_MS);
        });

        let downloadResult;
        try {
            downloadResult = await Promise.race([downloadPromise, timeoutPromise]);
        } catch (err) {
            clearTimeout(timeoutId);
            _downloadResolve = null;
            _downloadReject  = null;
            await storageAPI.storage.local.remove(STORAGE_KEY);
            // The content script saw a 401. Drop the cached access token, or the
            // AUTH_EXPIRED retry in runDriveSync gets the same dead token back
            // from getAccessToken() (it's still "unexpired" locally) and fails
            // again — for up to an hour.
            if (err.message === AUTH_EXPIRED) await clearCachedToken();
            throw err;
        }
        clearTimeout(timeoutId);

        if (downloadResult.error) {
            await storageAPI.storage.local.remove(STORAGE_KEY);
            throw new Error(downloadResult.error);
        }

        // Read the parsed data the content script stored
        const stored = await storageAPI.storage.local.get(STORAGE_KEY);
        parsed = stored[STORAGE_KEY];
        await storageAPI.storage.local.remove(STORAGE_KEY);
        if (!parsed) throw new Error('Drive download result missing from storage');

        bytes = downloadResult.bytes || JSON.stringify(parsed).length;

    } else {
        // Chrome MV3 service worker: single fetch, large responses handled fine.
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        console.log('[Sync] readDriveFile: single fetch download of', fileId);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
        if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
        const cl = parseInt(res.headers.get('content-length') || '0', 10);
        parsed = await res.json();
        bytes  = cl || JSON.stringify(parsed).length;
    }

    const durationMs = Date.now() - t0;
    const format    = parsed._format || 'v1 (legacy)';
    const statsKeys = parsed.stats ? Object.keys(parsed.stats).length : 0;
    const sizeMB    = (bytes / 1048576).toFixed(2);
    const speedMBs  = durationMs > 0 ? (bytes / 1048576 / (durationMs / 1000)).toFixed(2) : '—';
    console.log(`[Sync] readDriveFile: complete — ~${sizeMB} MB in ${durationMs} ms (~${speedMBs} MB/s) | format: ${format} | bot-count: ${statsKeys}`);
    sendSyncProgress(tabId, 'Downloading from Drive…', 3, 5, `~${sizeMB} MB @ ~${speedMBs} MB/s`);
    return { data: parsed, bytes, durationMs };
}

async function writeDriveFile(token, fileId, data, folderId, tabId) {
    const isMV2BackgroundPage = typeof XMLHttpRequest !== 'undefined';

    if (isMV2BackgroundPage) {
        // On WebKit/Orion, XHR with a large body hangs the background event loop just like
        // fetch() does. Delegate the upload to the content script, whose fetch() is stable.
        const STORAGE_KEY = 'driveSyncTempUpload';
        const sizeKB = (JSON.stringify(data).length / 1024).toFixed(1);
        console.log('[Sync] writeDriveFile: delegating upload to content script —', sizeKB, 'KB (tabId:', tabId, ')');
        await storageAPI.storage.local.set({ [STORAGE_KEY]: data });
        const uploadPromise = new Promise((resolve, reject) => {
            _uploadResolve = resolve;
            _uploadReject  = reject;
        });
        await storageAPI.tabs.sendMessage(tabId, {
            type: 'SAI_DRIVE_UPLOAD_REQ',
            token, fileId, folderId,
            fileName: DRIVE_FILE_NAME,
            storageKey: STORAGE_KEY,
        });
        const TIMEOUT_MS = 10 * 60 * 1000;
        let timeoutId;
        const timeoutPromise = new Promise((_, rej) => {
            timeoutId = setTimeout(() => rej(new Error('Drive upload timed out — no response from content script (10 min)')), TIMEOUT_MS);
        });
        let uploadResult;
        try {
            uploadResult = await Promise.race([uploadPromise, timeoutPromise]);
        } catch (err) {
            clearTimeout(timeoutId);
            _uploadResolve = null; _uploadReject = null;
            await storageAPI.storage.local.remove(STORAGE_KEY);
            if (err.message === AUTH_EXPIRED) await clearCachedToken(); // see readDriveFile
            throw err;
        }
        clearTimeout(timeoutId);
        await storageAPI.storage.local.remove(STORAGE_KEY);
        if (uploadResult.error) throw new Error(uploadResult.error);
        if (uploadResult.newFileId && !fileId) {
            await storageAPI.storage.local.set({ driveFileId: uploadResult.newFileId });
        }
        return uploadResult.newFileId || fileId;
    }

    // Chrome MV3: fetch with a body works fine in service workers
    const body = JSON.stringify(data);
    const sizeKB = (body.length / 1024).toFixed(1);
    console.log('[Sync] writeDriveFile: payload', sizeKB, 'KB — fetch —', fileId ? 'updating ' + fileId : 'creating new file in folder ' + folderId);

    if (fileId) {
        console.log('[Sync] writeDriveFile: sending PATCH request…');
        const t0 = Date.now();
        const res = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
            { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body }
        );
        const durationMs = Date.now() - t0;
        console.log('[Sync] writeDriveFile: PATCH response HTTP', res.status, 'in', durationMs, 'ms');
        if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
        if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
        return fileId;
    }

    // Create new file via multipart upload
    const boundary = 'sai_toolkit_drive_boundary';
    const metaObj = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
    if (folderId) metaObj.parents = [folderId];
    const multipart = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
        JSON.stringify(metaObj),
        `--${boundary}`, 'Content-Type: application/json', '',
        body,
        `--${boundary}--`
    ].join('\r\n');

    console.log('[Sync] writeDriveFile: sending POST (create) request…');
    const t0create = Date.now();
    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }
    );
    const durationMs = Date.now() - t0create;
    console.log('[Sync] writeDriveFile: POST response HTTP', res.status, 'in', durationMs, 'ms');
    if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
    const created = await res.json();
    await storageAPI.storage.local.set({ driveFileId: created.id });
    console.log('[Sync] writeDriveFile: created new file →', created.id);
    return created.id;
}

// ---- Drive backup folder and backup files ----

async function getOrCreateToolkitFolder(token) {
    const cached = await storageAPI.storage.local.get('driveBackupFolderId');
    if (cached.driveBackupFolderId) {
        console.log('[Sync] getOrCreateToolkitFolder: verifying cached folder ID', cached.driveBackupFolderId);
        const check = await fetch(
            `https://www.googleapis.com/drive/v3/files/${cached.driveBackupFolderId}?fields=id`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (check.ok) {
            console.log('[Sync] getOrCreateToolkitFolder: folder OK →', cached.driveBackupFolderId);
            return cached.driveBackupFolderId;
        }
        console.log('[Sync] getOrCreateToolkitFolder: cached folder not found (HTTP', check.status, ') — searching');
        await storageAPI.storage.local.remove('driveBackupFolderId');
    }

    const q = encodeURIComponent(`name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!res.ok) throw new Error(`Drive folder search failed: ${res.status}`);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
        console.log('[Sync] getOrCreateToolkitFolder: found existing folder →', data.files[0].id);
        await storageAPI.storage.local.set({ driveBackupFolderId: data.files[0].id });
        return data.files[0].id;
    }

    console.log('[Sync] getOrCreateToolkitFolder: folder not found — creating "' + BACKUP_FOLDER_NAME + '"');
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (createRes.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!createRes.ok) throw new Error(`Drive folder create failed: ${createRes.status}`);
    const folder = await createRes.json();
    await storageAPI.storage.local.set({ driveBackupFolderId: folder.id });
    console.log('[Sync] getOrCreateToolkitFolder: created new folder →', folder.id);
    return folder.id;
}

async function listDriveBackups(token) {
    const folderId = await getOrCreateToolkitFolder(token);
    const q = encodeURIComponent(`'${folderId}' in parents and name contains '${BACKUP_FILE_PREFIX}' and trashed=false`);
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&orderBy=name+desc&pageSize=100`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (!res.ok) throw new Error(`Drive backup list failed: ${res.status}`);
    const listed = await res.json();
    return { backups: listed.files || [], folderId };
}

function makeBackupFileName() {
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
    return `${BACKUP_FILE_PREFIX}${ts}.json`;
}

async function deleteDriveBackup(token, fileId) {
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 401) { await clearCachedToken(); throw new Error(AUTH_EXPIRED); }
    if (res.status !== 204 && !res.ok) throw new Error(`Drive backup delete failed: ${res.status}`);
}

// ---- Sync progress reporting ----

function sendSyncProgress(tabId, step, stepNum, totalSteps, detail = '') {
    const message = { type: 'SAI_SYNC_PROGRESS', step, stepNum, totalSteps, detail };
    console.log(`[Sync] Progress [${stepNum}/${totalSteps}]: ${step}${detail ? ' — ' + detail : ''}`);
    if (tabId != null) {
        storageAPI.tabs.sendMessage(tabId, message).catch(() => {});
    } else {
        storageAPI.tabs.query({ url: '*://spicychat.ai/*' }, tabs => {
            for (const tab of tabs) {
                storageAPI.tabs.sendMessage(tab.id, message).catch(() => {});
            }
        });
    }
}

// ---- Main sync orchestrator ----

async function _doSync(interactive, syncOptions, tabId) {
    const { syncStats = true, syncSettings = false, syncStyle = false } = syncOptions || {};
    console.log('[Sync] _doSync start — syncStats:', syncStats, 'syncSettings:', syncSettings, 'syncStyle:', syncStyle, 'tabId:', tabId);

    sendSyncProgress(tabId, 'Authenticating with Google…', 1, 5);
    const token = await getAccessToken(interactive);
    if (!token) {
        console.log('[Sync] _doSync: no token — auth silent fail');
        return { success: false, error: 'auth_silent_fail' };
    }
    console.log('[Sync] _doSync: token obtained');

    sendSyncProgress(tabId, 'Locating Drive folder…', 2, 5);
    const folderId = await getOrCreateToolkitFolder(token);
    console.log('[Sync] _doSync: toolkit folder resolved →', folderId);

    sendSyncProgress(tabId, 'Finding sync file…', 3, 5);
    const fileId = await findDriveFile(token, folderId);
    console.log('[Sync] _doSync: sync file resolved →', fileId || '(none — first sync)');

    // Read remote file once
    let remote = null;
    if (fileId) {
        sendSyncProgress(tabId, 'Downloading from Drive…', 3, 5);
        const { data, bytes, durationMs } = await readDriveFile(token, fileId, tabId);
        remote = data;
        const sizeMB   = (bytes / 1048576).toFixed(2);
        const speedMBs = durationMs > 0 ? (bytes / 1048576 / (durationMs / 1000)).toFixed(2) : '—';
        sendSyncProgress(tabId, 'Downloading from Drive…', 3, 5, `~${sizeMB} MB @ ~${speedMBs} MB/s`);
    } else {
        console.log('[Sync] _doSync: no existing remote file — this is the first upload (create)');
    }
    const isV2 = remote && remote._format === 'v2';
    if (remote) {
        const remoteStatsBotCount = remote.stats ? Object.keys(remote.stats).length : (isV2 ? 0 : Object.keys(remote).filter(k => k !== '_format').length);
        console.log('[Sync] _doSync: remote file format:', remote._format || 'v1 (legacy)',
            '| stats bots:', remoteStatsBotCount,
            '| has settings:', !!(remote.settings),
            '| has style:', !!(remote.style));
    }

    // Build new file — always v2 format
    const newFile = { _format: 'v2' };

    sendSyncProgress(tabId, 'Merging data…', 4, 5);

    // ---- Stats ----
    if (syncStats) {
        // Old-format file: entire file was the raw stats object
        const remoteStats = isV2 ? (remote ? remote.stats || {} : {}) : (remote || {});
        const remoteBots = Object.keys(remoteStats).length;
        // Merge remote into the local IndexedDB store (per-message, collapsing the conversation
        // level; mergeMessageEntry semantics never clobber a richer entry) and assemble the upload
        // snapshot — with ONE invisible retry on a fresh connection. On Orion the page can be
        // OS-suspended mid-merge AFTER the connection probe already passed, leaving a transaction
        // that never fires; statsOp then times out. Rather than failing the whole sync and making
        // the user re-tap, drop the stale handle and retry once. Safe because idbBulkMergeNested is
        // idempotent (writes only changed records — near-zero the second time); the AUTH_EXPIRED
        // retry path in runDriveSync is unchanged.
        // Held awake by a content-script heartbeat for the whole merge window (see
        // runWithMergeHeartbeat) — this is what makes auto-sync/restore work, not just the manual path.
        const merged = await runWithMergeHeartbeat(tabId, async () => {
            let m = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    if (fileId) {
                        const tMerge = Date.now();
                        const written = await statsOp(db => idbBulkMergeNested(db, remoteStats));
                        console.log('[Sync] _doSync: merged remote stats into IDB in', Date.now() - tMerge,
                            'ms — remote bots:', remoteBots, '| records upserted:', written);
                    }
                    // Assemble the (pruned) nested wire format from the DB for upload. The store is the
                    // source of truth; we no longer keep an 11 MB JSON blob in storage.local.
                    const tExport = Date.now();
                    m = await statsOp(db => idbExportNested(db));
                    console.log('[Sync] _doSync: assembled stats from IDB in', Date.now() - tExport, 'ms');
                    break;
                } catch (e) {
                    if (attempt >= 2) throw e;
                    console.warn('[Sync] _doSync: stats merge failed — retrying once on a fresh connection:', e && e.message);
                    closeStatsDB();
                    await statsDelay(500);
                }
            }
            return m;
        });
        const mergedBots = Object.keys(merged).length;
        const mergedMsgs = Object.values(merged).reduce((b, chats) =>
            b + Object.values(chats).reduce((c, msgs) => c + Object.keys(msgs).length, 0), 0);
        console.log('[Sync] _doSync: stats snapshot —', mergedBots, 'bots |', mergedMsgs, 'messages total');
        newFile.stats = merged;
    } else {
        // Preserve whatever stats already exist in Drive
        if (isV2 && remote && remote.stats) { newFile.stats = remote.stats; console.log('[Sync] _doSync: stats not synced — preserving remote stats'); }
        else if (!isV2 && remote)           { newFile.stats = remote; console.log('[Sync] _doSync: stats not synced — migrating v1 remote to v2 format'); }
        else                                { console.log('[Sync] _doSync: stats not synced and no remote stats to preserve'); }
    }

    // ---- Settings ----
    if (syncSettings) {
        const localStored = await storageAPI.storage.local.get(SETTINGS_SYNC_KEYS);
        const localSettings = {};
        for (const key of SETTINGS_SYNC_KEYS) {
            if (localStored[key] !== undefined) localSettings[key] = localStored[key];
        }
        const remoteSettings = (isV2 && remote && remote.settings) ? remote.settings : {};
        // Merge: remote as base, local overwrites (local changes take precedence)
        const merged = { ...remoteSettings, ...localSettings };
        console.log('[Sync] _doSync: settings merge — local keys:', Object.keys(localSettings).length,
            '| remote keys:', Object.keys(remoteSettings).length,
            '| merged keys:', Object.keys(merged).length);
        newFile.settings = merged;
        // Only write back keys this version still uses — a remote file from an older
        // version can carry settings for removed features (Classic Layout, WYSIWYG, ...).
        const toApply = pickKeys(merged, SETTINGS_SYNC_KEYS);
        if (Object.keys(toApply).length > 0) {
            await storageAPI.storage.local.set(toApply);
        }
    } else if (isV2 && remote && remote.settings) {
        newFile.settings = remote.settings; // preserve
        console.log('[Sync] _doSync: settings not synced — preserving remote settings');
    }

    // ---- Style ----
    if (syncStyle) {
        const localStored = await storageAPI.storage.local.get(STYLE_SYNC_KEYS);
        const localStyle = {};
        for (const key of STYLE_SYNC_KEYS) {
            if (localStored[key] !== undefined) localStyle[key] = localStored[key];
        }
        const remoteStyle = (isV2 && remote && remote.style) ? remote.style : {};
        const merged = { ...remoteStyle, ...localStyle };
        console.log('[Sync] _doSync: style merge — local keys:', Object.keys(localStyle).length,
            '| remote keys:', Object.keys(remoteStyle).length,
            '| merged keys:', Object.keys(merged).length);
        // Write only current style keys: this also drops retired Custom Style data
        // that an older version left in the Drive file.
        const toApply = pickKeys(merged, STYLE_SYNC_KEYS);
        newFile.style = toApply;
        if (Object.keys(toApply).length > 0) {
            await storageAPI.storage.local.set(toApply);
        }
    } else if (isV2 && remote && remote.style) {
        newFile.style = remote.style; // preserve
        console.log('[Sync] _doSync: style not synced — preserving remote style');
    }

    const uploadPayloadKB = (JSON.stringify(newFile).length / 1024).toFixed(1);
    console.log('[Sync] _doSync: upload payload', uploadPayloadKB, 'KB — sections:', Object.keys(newFile).filter(k => k !== '_format').join(', ') || 'none');
    sendSyncProgress(tabId, 'Uploading to Drive…', 5, 5);
    const newFileId = await writeDriveFile(token, fileId, newFile, folderId, tabId);
    await storageAPI.storage.local.set({ driveLastSync: Date.now() });
    console.log('[Sync] _doSync: complete — fileId:', newFileId);

    return { success: true, fileId: newFileId, syncedSettings: syncSettings || syncStyle };
}

async function runDriveSync(interactive, syncOptions, tabId) {
    if (syncInProgress) {
        console.warn('[Sync] runDriveSync: already in progress, skipping', interactive ? '(manual)' : '(auto)');
        return { success: false, alreadyRunning: true, error: 'Sync already in progress — please wait…' };
    }
    if (!DRIVE_CLIENT_ID || DRIVE_CLIENT_ID.startsWith('YOUR_')) {
        return { success: false, error: 'Google Drive sync is not configured. Please contact support.' };
    }
    if (!TOKEN_BROKER_URL || TOKEN_BROKER_URL.includes('YOUR-SUBDOMAIN')) {
        return { success: false, error: 'Google Drive sync is not configured (token broker URL not set). Please contact support.' };
    }
    if (!storageAPI.identity || !storageAPI.identity.launchWebAuthFlow) {
        return { success: false, error: 'Sign-in is not available on this browser. Try the desktop version.' };
    }

    syncInProgress = true;
    console.log('[Sync] runDriveSync: lock acquired', interactive ? '(manual)' : '(auto)');
    try {
        try {
            return await _doSync(interactive, syncOptions, tabId);
        } catch (err) {
            if (err.message === AUTH_EXPIRED) {
                console.warn('[Sync] Token expired/revoked, re-authenticating...');
                return await _doSync(true, syncOptions, tabId);
            }
            throw err;
        }
    } catch (err) {
        const msg = friendlyError(err);
        console.error('[Sync] runDriveSync: failed —', err.message, '→ user message:', msg);
        return { success: false, error: msg };
    } finally {
        syncInProgress = false;
        console.log('[Sync] runDriveSync: lock released');
    }
}

// ---- Notify SpicyChat tabs that stats have been updated ----

function notifySpicyChatTabs() {
    storageAPI.tabs.query({ url: '*://spicychat.ai/*' }, tabs => {
        for (const tab of tabs) {
            storageAPI.tabs.sendMessage(tab.id, { type: 'SAI_DRIVE_SYNC_COMPLETE' }).catch(() => {});
        }
    });
}

function notifyAuthRequired() {
    storageAPI.tabs.query({ url: '*://spicychat.ai/*' }, tabs => {
        for (const tab of tabs) {
            storageAPI.tabs.sendMessage(tab.id, { type: 'SAI_DRIVE_AUTH_REQUIRED' }).catch(() => {});
        }
    });
}

// ---- Notify already-open SpicyChat tabs that the extension just updated ----
// Best-effort: an already-injected content script's messaging context can be
// invalidated by the browser on update (same class of issue storage-wrapper.js's
// isContextValid() guards against). This push just gets the correct, fresh
// changelog notes in front of the user immediately when it lands; the
// load-time checkForUpdateNotification() path in content.js remains the
// reliable fallback for whenever it doesn't (no tab open, or delivery fails).
function notifyTabsOfExtensionUpdate(version) {
    storageAPI.tabs.query({ url: '*://spicychat.ai/*' }, tabs => {
        for (const tab of tabs) {
            storageAPI.tabs.sendMessage(tab.id, { type: 'SAI_EXTENSION_UPDATED', version }).catch(() => {});
        }
    });
}

// ---- Auto-sync alarm ----

storageAPI.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== AUTO_SYNC_ALARM_NAME) return;
    const stored = await storageAPI.storage.local.get(['driveFileId', 'driveAutoSync']);
    if (!stored.driveAutoSync || !stored.driveFileId) return;
    try {
        // Resolve a spicychat tab to delegate the Drive HTTP through. On MV2/Orion the
        // background can't fetch large payloads itself (it freezes), so readDriveFile/
        // writeDriveFile delegate to a content tab — without a tabId that delegation
        // rejects and auto-sync silently does nothing. On Chrome MV3 the direct-fetch
        // path ignores tabId, so passing it (or null) is harmless there.
        const tabId = await new Promise(resolve => {
            storageAPI.tabs.query({ url: '*://spicychat.ai/*' }, tabs => {
                // Prefer an ACTIVE (foreground) tab: its content script is alive and can drive the
                // merge heartbeat (runWithMergeHeartbeat). A backgrounded tab on Orion is itself
                // frozen and can't ping, so auto-sync's merge would run unprotected — picking the
                // active tab gives it the best chance. Falls back to any tab for HTTP delegation.
                const list = tabs || [];
                const live = list.find(t => t.active) || list[0];
                resolve(live ? live.id : null);
            });
        });
        const result = await runDriveSync(false, { syncStats: true, syncSettings: false, syncStyle: false }, tabId);
        if (result && result.success) notifySpicyChatTabs();
        else if (result && result.error === 'auth_silent_fail') notifyAuthRequired();
    } catch (err) {
        console.warn('[Drive Auto-Sync] Failed:', err.message);
    }
});

// =============================================================================
// INSTALLATION / UPDATE EVENTS
// =============================================================================

storageAPI.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        await storageAPI.storage.local.set({
            'enableSidebarLayout':      false,
            'enableHideForYou':         true,
            'enablePageJump':           true,
            'showGenerationStats':      false,
            'timestampDateFirst':       true,
            'lastSeenVersion':          null,
            'driveAutoSync':            false,
            'driveAutoSyncInterval':    10
        });
        console.log('[Core] Extension installed');
    } else if (details.reason === 'update') {
        const currentVersion = storageAPI.runtime.getManifest().version;
        console.log('[Core] Extension updated to version:', currentVersion);
        await storageAPI.storage.local.set({
            'showUpdateNotification': true,
            'updatedToVersion':       currentVersion
        });
        console.log('[Core] Update notification flag set successfully');
        notifyTabsOfExtensionUpdate(currentVersion);
    }
});

// =============================================================================
// KEEPALIVE PORT (Safari / Orion iOS)
// =============================================================================
// On WebKit-based iOS browsers (Safari, Orion), the OS suspends MV2 background
// pages after ~30 s of inactivity even when `persistent` is unset (which defaults
// to true for MV2). An open runtime.connect() port prevents suspension. The
// content script opens this port before triggering sync and closes it on
// completion, keeping the background alive for the full sync duration.

storageAPI.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sai-sync-keepalive') return;
    console.log('[Sync] keepalive port opened — background will stay alive until port closes');
    port.onDisconnect.addListener(() => {
        console.log('[Sync] keepalive port closed — background lifecycle no longer pinned');
    });
});

// =============================================================================
// MESSAGE LISTENER
// =============================================================================

storageAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getSettings') {
        storageAPI.storage.local.get(null).then(sendResponse);
        return true;
    }

    if (message.type === 'ping') {
        sendResponse({ pong: true });
        return true;
    }

    // Heartbeat from the (foreground, always-alive) content script during a Drive sync. On Orion/iOS
    // an OPEN keepalive port does NOT stop the OS from suspending the background page during a
    // message-silent window — notably the IndexedDB merge — which freezes its event loop AND its
    // watchdog timers (a 5-min stall with the 60s 'op' timeout never firing, only resuming after a
    // page refresh). Delivering this message wakes the page; receiving one every ~1s keeps it
    // scheduled so the merge actually runs to completion. The handler only needs to exist + respond.
    if (message.type === 'SAI_KEEPALIVE_PING') {
        sendResponse({ alive: true });
        return true;
    }

    if (message.type === 'SAI_DRIVE_SYNC') {
        const syncOptions = {
            syncStats:    message.syncStats    !== false,
            syncSettings: !!message.syncSettings,
            syncStyle:    !!message.syncStyle
        };
        const originTabId = sender.tab ? sender.tab.id : null;
        console.log('[Sync] SAI_DRIVE_SYNC received — originTabId:', originTabId, 'options:', syncOptions);
        runDriveSync(true, syncOptions, originTabId)
            .then(result => {
                console.log('[Sync] SAI_DRIVE_SYNC complete — result:', result);
                sendResponse(result);
                if (result.success) notifySpicyChatTabs();
            })
            .catch(err => {
                console.error('[Sync] SAI_DRIVE_SYNC error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // Callbacks from the content-script-assisted download path
    if (message.type === 'SAI_DRIVE_DOWNLOAD_DONE') {
        console.log('[Sync] SAI_DRIVE_DOWNLOAD_DONE received — bytes:', message.bytes);
        if (_downloadResolve) { _downloadResolve({ bytes: message.bytes }); _downloadResolve = null; _downloadReject = null; }
        return false;
    }
    if (message.type === 'SAI_DRIVE_DOWNLOAD_ERROR') {
        console.warn('[Sync] SAI_DRIVE_DOWNLOAD_ERROR received —', message.error);
        if (_downloadReject) { _downloadReject(new Error(message.error)); _downloadResolve = null; _downloadReject = null; }
        return false;
    }
    if (message.type === 'SAI_DRIVE_DOWNLOAD_PROGRESS') {
        const tabId = sender.tab ? sender.tab.id : null;
        sendSyncProgress(tabId, 'Downloading from Drive…', 3, 5, message.detail);
        return false;
    }

    // Callbacks from the content-script-assisted upload path
    if (message.type === 'SAI_DRIVE_UPLOAD_DONE') {
        console.log('[Sync] SAI_DRIVE_UPLOAD_DONE received — newFileId:', message.newFileId);
        if (_uploadResolve) { _uploadResolve({ newFileId: message.newFileId }); _uploadResolve = null; _uploadReject = null; }
        return false;
    }
    if (message.type === 'SAI_DRIVE_UPLOAD_ERROR') {
        console.warn('[Sync] SAI_DRIVE_UPLOAD_ERROR received —', message.error);
        if (_uploadReject) { _uploadReject(new Error(message.error)); _uploadResolve = null; _uploadReject = null; }
        return false;
    }
    if (message.type === 'SAI_DRIVE_UPLOAD_PROGRESS') {
        const tabId = sender.tab ? sender.tab.id : null;
        sendSyncProgress(tabId, 'Uploading to Drive…', 5, 5, message.detail);
        return false;
    }

    if (message.type === 'SAI_DRIVE_SET_AUTO_SYNC') {
        (async () => {
            try {
                if (message.enabled && message.intervalMinutes) {
                    storageAPI.alarms.create(AUTO_SYNC_ALARM_NAME, { periodInMinutes: message.intervalMinutes });
                } else {
                    storageAPI.alarms.clear(AUTO_SYNC_ALARM_NAME);
                }
                sendResponse({ success: true });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'SAI_DRIVE_LIST_BACKUPS') {
        (async () => {
            try {
                let token = await getAccessToken(false);
                if (!token) token = await getAccessToken(true);
                try {
                    sendResponse({ success: true, ...(await listDriveBackups(token)) });
                } catch (err) {
                    if (err.message !== AUTH_EXPIRED) throw err;
                    token = await getAccessToken(true);
                    sendResponse({ success: true, ...(await listDriveBackups(token)) });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'SAI_DRIVE_AUTH_STATUS') {
        checkDriveAuthStatus().then(sendResponse);
        return true;
    }

    // Wipe local tokens, revoke at Google, then run a fresh interactive sign-in
    // (account chooser forced). This is the in-app replacement for "clear cookies".
    if (message.type === 'SAI_DRIVE_RECONNECT') {
        (async () => {
            try {
                await revokeDriveTokens();
                await storageAPI.storage.local.remove(['driveAccessToken', 'driveRefreshToken', 'driveTokenExpiry', 'driveBackupFolderId']);
                const token = await getAccessToken(true);
                if (!token) throw new Error('Google sign-in did not complete.');
                const status = await checkDriveAuthStatus();
                sendResponse({ success: status.state === 'ok', email: status.email || null,
                               error: status.state === 'ok' ? undefined : 'Signed in, but Drive still rejected the token.' });
            } catch (err) {
                sendResponse({ success: false, error: friendlyError(err) });
            }
        })();
        return true;
    }

    if (message.type === 'SAI_DRIVE_REVOKE') {
        revokeDriveTokens().then(() => sendResponse({ success: true }));
        return true;
    }

    // Create Backup on WebKit/iOS: the background page must not push a ~20 MB
    // body itself (XHR/fetch with a large body freezes its event loop - same
    // reason writeDriveFile delegates). Hand the content script a token + folder
    // and let it upload directly.
    if (message.type === 'SAI_DRIVE_BACKUP_TARGET') {
        (async () => {
            try {
                if (message.tokenRejected) await clearCachedToken();
                let token = await getAccessToken(true);
                if (!token) throw new Error('Google sign-in did not complete.');
                // Restore only needs a token (it downloads a known fileId).
                if (message.tokenOnly) { sendResponse({ success: true, token }); return; }
                let folderId;
                try {
                    folderId = await getOrCreateToolkitFolder(token);
                } catch (err) {
                    if (err.message !== AUTH_EXPIRED) throw err;
                    token = await getAccessToken(true);
                    folderId = await getOrCreateToolkitFolder(token);
                }
                sendResponse({ success: true, token, folderId, fileName: makeBackupFileName() });
            } catch (err) {
                sendResponse({ success: false, error: friendlyError(err) });
            }
        })();
        return true;
    }

    if (message.type === 'SAI_DRIVE_DELETE_BACKUP') {
        (async () => {
            try {
                let token = await getAccessToken(false);
                if (!token) token = await getAccessToken(true);
                try {
                    await deleteDriveBackup(token, message.fileId);
                    sendResponse({ success: true });
                } catch (err) {
                    if (err.message !== AUTH_EXPIRED) throw err;
                    token = await getAccessToken(true);
                    await deleteDriveBackup(token, message.fileId);
                    sendResponse({ success: true });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // ---- Stats store (IndexedDB, extension origin) ----
    // Content scripts cannot see the extension-origin IndexedDB, so all stats
    // reads/writes are funnelled here. Every handler awaits migration first.

    if (message.type === 'SAI_STATS_GET_CHARACTER') {
        statsOp(db => idbGetCharacter(db, message.characterId))
            .then(stats => sendResponse({ success: true, stats }))
            .catch(err => sendResponse({ success: false, error: err.message, stats: {} }));
        return true;
    }

    if (message.type === 'SAI_STATS_PUT') {
        statsOp(db => idbMergePut(db, message.record))
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'SAI_STATS_DELETE') {
        statsOp(db => idbDelete(db, message.messageId))
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'SAI_STATS_IMPORT_MERGE') {
        // Restore-from-backup / file-import run the SAME background-only merge as Drive sync, so they
        // need the same suspend guard. Drive it from the originating tab.
        const _importTab = sender && sender.tab ? sender.tab.id : null;
        runWithMergeHeartbeat(_importTab, () => statsOp(db => idbBulkMergeNested(db, message.stats || {})))
            .then(written => sendResponse({ success: true, written }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'SAI_STATS_EXPORT_ALL') {
        statsOp(db => idbExportNested(db))
            .then(stats => sendResponse({ success: true, stats }))
            .catch(err => sendResponse({ success: false, error: err.message, stats: {} }));
        return true;
    }

    if (message.type === 'SAI_STATS_PRUNE') {
        statsOp(db => idbPrune(db))
            .then(removed => sendResponse({ success: true, removed }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'SAI_STATS_CLEAR') {
        statsOp(db => idbClear(db))
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    return false;
});
