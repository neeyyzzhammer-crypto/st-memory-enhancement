import { APP, USER, SYSTEM, EDITOR } from '../../core/manager.js';

/**
 * Simple RAG store persisted inside current chat metadata.
 * Structure:
 * chatMetadata.rag_store_v1 = {
 *   model: string, dim: number, items: Array<{
 *     idx: number, is_user: boolean, text: string, emb: number[], ts: number, hash: string,
 *     // optional for attachments:
 *     type?: 'attachment', attName?: string, attMime?: string, chunkIndex?: number, chunkTotal?: number
 *   }>
 * }
 */

const RAG_STORE_KEY = 'rag_store_v1';
const DEFAULT_EMBED_MODEL = 'embeddinggemma:latest';
const MAX_LEN_CHARS = 2000; // base message trimming
const TOP_K = 3;

// Attachment chunking
const CHUNK_OVERLAP_RATIO = 0.05;

// Keep attachments at large chunks
const ATTACH_CHUNK_SIZE = 2000;

// New: message chunking defaults (1000 chars windows with 15% overlap)
const MSG_CHUNK_SIZE = 1000;

function getStride(size, overlapRatio) {
    const overlap = Math.floor(size * overlapRatio);
    return Math.max(1, size - overlap);
}

function ragEnabled() {
    return USER.tableBaseSetting?.enable_rag === true;
}

function getStore() {
    const ctx = USER.getContext();
    ctx.chatMetadata = ctx.chatMetadata || {};
    ctx.chatMetadata[RAG_STORE_KEY] = ctx.chatMetadata[RAG_STORE_KEY] || {
        model: DEFAULT_EMBED_MODEL,
        dim: 0,
        items: [],
    };
    return ctx.chatMetadata[RAG_STORE_KEY];
}

// Strip sections that must not be embedded from chat messages
function stripPrivateBlocks(text) {
    if (typeof text !== 'string' || !text) return '';
    // Remove entire <critical_thinking>...</critical_thinking> blocks
    text = text.replace(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi, '');
    // Remove entire <infoblock>...</infoblock> blocks
    text = text.replace(/<infoblock>[\s\S]*?<\/infoblock>/gi, '');
    return text;
}
function getMsgText(msg) {
    if (!msg) return '';
    // Prefer 'mes' (SillyTavern chat), fallback to 'content'
    let text = typeof msg.mes === 'string' ? msg.mes : (typeof msg.content === 'string' ? msg.content : '');
    if (!text) return '';
    // Exclude private/thinking sections entirely
    text = stripPrivateBlocks(text);
    // Strip tags after removing blocks
    text = text.replace(/<[^>]+>/g, '');
    text = text.trim();
    if (text.length > MAX_LEN_CHARS) text = text.slice(0, MAX_LEN_CHARS);
    return text;
}

function getInjectionRole() {
    switch (USER.tableBaseSetting?.injection_mode) {
        case 'deep_system': return 'system';
        case 'deep_user': return 'user';
        case 'deep_assistant': return 'assistant';
        default: return 'system';
    }
}

function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let sum = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        sum += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return sum / (Math.sqrt(na) * Math.sqrt(nb));
}

// Try to determine Ollama base URL with overrides and probing
let __OLLAMA_BASE_CACHE = null;

function getOllamaOverride() {
    // User-overridable endpoints if provided in settings
    return (
        USER?.IMPORTANT_USER_PRIVACY_DATA?.ollama_base_url ||
        USER?.tableBaseSetting?.ollama_base_url ||
        null
    );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

async function probeBase(base) {
    try {
        const res = await fetchWithTimeout(`${base}/api/version`, { method: 'GET' }, 1500);
        if (res && res.ok) return true;
    } catch (_) { /* ignore */ }
    return false;
}

async function resolveOllamaBase() {
    if (__OLLAMA_BASE_CACHE) return __OLLAMA_BASE_CACHE;

    const override = getOllamaOverride();
    const candidates = Array.from(new Set([
        override,
        'http://localhost:11434',
        'http://127.0.0.1:11434',
        // keep docker-name last; browser often can't resolve it
        'http://ollama:11434',
    ].filter(Boolean)));

    for (const base of candidates) {
        if (await probeBase(base)) {
            __OLLAMA_BASE_CACHE = base;
            return base;
        }
    }

    // Fall back to last candidate (likely fails) to preserve behavior
    __OLLAMA_BASE_CACHE = candidates[candidates.length - 1] || 'http://localhost:11434';
    return __OLLAMA_BASE_CACHE;
}

async function getOllamaEmbedding(text) {
    const base = await resolveOllamaBase();
    const model = getStore().model || DEFAULT_EMBED_MODEL;
    try {
        const res = await fetch(`${base}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
        });
        if (!res.ok) {
            const e = await res.text().catch(() => res.statusText);
            throw new Error(`Ollama embeddings error: ${res.status} ${e}`);
        }
        const json = await res.json();
        if (Array.isArray(json?.embedding)) {
            return json.embedding;
        }
        throw new Error('Unexpected Ollama embeddings response format.');
    } catch (e) {
        // Browser-side failures could be DNS or CORS. Add a hint once.
        console.warn('[RAG] Embedding fetch failed (Ollama):', e?.message || e);
        EDITOR.warning('[RAG] Embedding fetch failed (Ollama).', e.message || '');
        return null;
    }
}

function hasHashAlready(store, hash) {
    return store.items.some(x => x.hash === hash);
}

/* ===================== Attachments support ===================== */

function getMsgAttachments(msg) {
    const atts = [];
    if (Array.isArray(msg?.attachments)) atts.push(...msg.attachments);
    if (Array.isArray(msg?.files)) atts.push(...msg.files);
    if (Array.isArray(msg?.extra?.attachments)) atts.push(...msg.extra.attachments);
    return atts.filter(a => !/^image\//i.test(a?.mime || a?.type || ''));
}

function getAttachmentName(att) {
    return att?.name || att?.filename || att?.title || att?.fileName || 'attachment';
}
function getAttachmentMime(att) {
    return att?.mime || att?.type || '';
}
function getAttachmentUrl(att) {
    return att?.url || att?.path || att?.href || att?.src || '';
}
function getAttachmentTextField(att) {
    return typeof att?.text === 'string' ? att.text : null;
}

function isProbablyHtml(name, mime) {
    return /text\/html|application\/xhtml\+xml/i.test(mime) || /\.html?$/i.test(name || '');
}
function isTextLikeMime(mime) {
    return /^text\//i.test(mime) || /application\/(json|xml|xhtml\+xml)$/i.test(mime);
}
function isMd(name, mime) { return /markdown/i.test(mime) || /\.md$/i.test(name || ''); }
function isCsv(name, mime) { return /csv/i.test(mime) || /\.csv$/i.test(name || ''); }

function extractTextFromHtml(html) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const text = doc?.body?.innerText || doc?.body?.textContent || '';
        return text.trim();
    } catch {
        return html;
    }
}

async function fallbackFetchText(att) {
    const url = getAttachmentUrl(att);
    if (!url) return null;
    try {
        const res = await fetch(url);
        const mime = res.headers.get('Content-Type') || getAttachmentMime(att);
        const raw = await res.text();
        if (isProbablyHtml(url, mime)) return extractTextFromHtml(raw);
        return raw;
    } catch (e) {
        console.warn('[RAG] Failed to fetch attachment:', url, e);
        return null;
    }
}

/**
 * Attempt to use SillyTavern vector extension extractor if present, else fallback to simple text/html/csv/md.
 */
async function extractAttachmentText(att) {
    try {
        const ext =
            window?.SillyTavern?.extensions?.vectors ||
            window?.STVectors ||
            window?.Vectors;
        if (ext?.extractAttachmentText) {
            const txt = await ext.extractAttachmentText(att);
            if (txt && typeof txt === 'string' && txt.trim()) return txt;
        }
    } catch (e) {
        console.warn('[RAG] ST Vectors extractor failed; using fallback:', e);
    }

    const pre = getAttachmentTextField(att);
    if (pre && pre.trim()) return pre.trim();

    const name = getAttachmentName(att);
    const mime = getAttachmentMime(att);
    if (isTextLikeMime(mime) || isMd(name, mime) || isCsv(name, mime) || isProbablyHtml(name, mime)) {
        const data = await fallbackFetchText(att);
        if (typeof data === 'string' && data.trim()) {
            if (isProbablyHtml(name, mime)) return extractTextFromHtml(data);
            return data.trim();
        }
    }

    EDITOR.warning(`[RAG] Skipped unsupported attachment without vector extension: ${name}`);
    return null;
}

function* chunkText(text, size = ATTACH_CHUNK_SIZE, overlapRatio = CHUNK_OVERLAP_RATIO) {
    const len = text.length;
    const stride = getStride(size, overlapRatio);
    let start = 0;
    while (start < len) {
        yield text.slice(start, Math.min(start + size, len));
        if (start + size >= len) break;
        start += stride;
    }
}

async function vectorizeAttachmentsForMessage(idx) {
    if (!ragEnabled()) return;
    const chat = USER.getContext()?.chat || [];
    const msg = chat[idx];
    if (!msg) return;

    const atts = getMsgAttachments(msg);
    if (!atts || atts.length === 0) return;

    for (const att of atts) {
        try {
            const name = getAttachmentName(att);
            const mime = getAttachmentMime(att);
            const text = await extractAttachmentText(att);
            if (!text || typeof text !== 'string') continue;

            let chunks = Array.from(chunkText(text, ATTACH_CHUNK_SIZE, CHUNK_OVERLAP_RATIO));
            const total = chunks.length;

            for (let i = 0; i < total; i++) {
                const chunk = chunks[i].trim();
                if (!chunk) continue;

                const store = getStore();
                const hash = SYSTEM.calculateStringHash(`${name}|att|${i}|${chunk}`);
                if (hasHashAlready(store, hash)) continue;

                const emb = await getOllamaEmbedding(chunk);
                if (!emb) continue;
                if (!store.dim) store.dim = emb.length;

                store.items.push({
                    idx,
                    is_user: !!msg.is_user,
                    text: chunk,
                    emb,
                    ts: Date.now(),
                    hash,
                    type: 'attachment',
                    attName: name,
                    attMime: mime,
                    chunkIndex: i,
                    chunkTotal: total,
                });
            }
        } catch (e) {
            console.warn('[RAG] Attachment vectorization failed:', e);
        }
    }

    try { USER.saveChat && USER.saveChat(); } catch { /* ignore */ }
}

/* ===================== Message vectorization ===================== */

async function vectorizeMessageByIndex(idx) {
    if (!ragEnabled()) return;
    const chat = USER.getContext()?.chat || [];
    if (idx < 0 || idx >= chat.length) return;

    const msg = chat[idx];
    const text = getMsgText(msg);
    if (text) {
        const chunks = Array.from(chunkText(text, MSG_CHUNK_SIZE, CHUNK_OVERLAP_RATIO));
        const total = chunks.length;

        for (let i = 0; i < total; i++) {
            const chunk = chunks[i].trim();
            if (!chunk) continue;

            const store = getStore();
            const hash = SYSTEM.calculateStringHash(`${idx}|msg|${i}|${chunk}`);
            if (hasHashAlready(store, hash)) continue;

            const emb = await getOllamaEmbedding(chunk);
            if (!emb) continue;
            if (!store.dim) store.dim = emb.length;

            store.items.push({
                idx,
                is_user: !!msg.is_user,
                text: chunk,
                emb,
                ts: Date.now(),
                hash,
                type: 'message',
                chunkIndex: i,
                chunkTotal: total,
            });
        }

        try { USER.saveChat && USER.saveChat(); } catch { /* ignore */ }
    }

    await vectorizeAttachmentsForMessage(idx);
}

async function vectorizeAllIfEmpty() {
    if (!ragEnabled()) return;
    const store = getStore();
    if (store.items.length > 0) return;

    const chat = USER.getContext()?.chat || [];
    for (let i = 0; i < chat.length; i++) {
        await vectorizeMessageByIndex(i);
    }
}

function searchSimilarByEmbedding(queryEmb, threshold, topK = TOP_K) {
    const store = getStore();
    if (!Array.isArray(store.items) || store.items.length === 0 || !Array.isArray(queryEmb)) return [];
    const scored = store.items.map((it, i) => {
        const score = cosineSim(queryEmb, it.emb);
        return { ...it, score, _i: i };
    });
    const filtered = scored
        .filter(x => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    return filtered;
}

// Bag expansion search (unique results across the bag)
async function bagSearchByText(text, threshold, topK, depth) {
    let cleaned = (text || '').trim();
    cleaned = stripPrivateBlocks(cleaned);
    if (!cleaned) return [];
    const emb = await getOllamaEmbedding(cleaned);
    if (!emb) return [];

    const k = Number.isFinite(topK) ? Math.max(1, topK) : (USER.tableBaseSetting?.rag_top_k ?? TOP_K);
    const d = Number.isFinite(depth) ? Math.max(1, depth) : (USER.tableBaseSetting?.rag_depth ?? 1);
    const thr = typeof threshold === 'number' ? threshold : (USER.tableBaseSetting?.rag_similarity ?? 0.25);

    const bag = new Map();
    const addUnique = (items) => {
        for (const it of items || []) {
            if (!bag.has(it.hash)) bag.set(it.hash, it);
        }
    };

    let frontier = searchSimilarByEmbedding(emb, thr, k);
    addUnique(frontier);

    for (let iter = 0; iter < d; iter++) {
        if (!frontier.length) break;
        const nextFrontier = [];
        for (const node of frontier) {
            const neigh = searchSimilarByEmbedding(node.emb, thr, k);
            for (const n of neigh) {
                if (!bag.has(n.hash)) {
                    bag.set(n.hash, n);
                    nextFrontier.push(n);
                }
            }
        }
        frontier = nextFrontier;
    }

    // Re-score vs. the original query
    const allItems = Array.from(bag.values()).map(it => ({
        ...it,
        score: cosineSim(emb, it.emb),
    }));

    // Deduplicate by normalized text content; keep the highest-scoring item per text
    const normalizeText = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const bestByText = new Map();
    for (const it of allItems) {
        const key = normalizeText(it.text);
        if (!key) continue;
        const prev = bestByText.get(key);
        if (!prev || it.score > prev.score) bestByText.set(key, it);
    }

    const deduped = Array.from(bestByText.values());
    deduped.sort((a, b) => b.score - a.score);
    return deduped;
}

// Backward-compatible entry point
async function searchSimilarByText(text, threshold) {
    return bagSearchByText(text, threshold);
}

/* ============ Maintenance helpers (per-chat store) ============ */

function purgeMessageEmbeddings(idx) {
    const store = getStore();
    const before = store.items.length;
    store.items = store.items.filter(it => it.idx !== idx);
    try { USER.saveChat && USER.saveChat(); } catch {}
    return before - store.items.length;
}

function adjustIndicesAfterDeletion(deletedIdx) {
    const store = getStore();
    for (const it of store.items) {
        if (it.idx > deletedIdx) it.idx -= 1;
    }
    try { USER.saveChat && USER.saveChat(); } catch {}
}

/* ============ Public API ============ */

// Important: no event listeners here; index.js drives RAG.
window.ST_RAG = {
    vectorizeAllIfNeeded: vectorizeAllIfEmpty,
    vectorizeMessageByIndex,
    purgeMessageEmbeddings,
    adjustIndicesAfterDeletion,
    searchSimilarByText,
    bagSearchByText,
};