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
const DEFAULT_EMBED_MODEL = 'embeddinggemma';
const MAX_LEN_CHARS = 2000; // base message trimming
const TOP_K = 12;

// Attachment chunking
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP_RATIO = 0.15;
const CHUNK_OVERLAP = Math.floor(CHUNK_SIZE * CHUNK_OVERLAP_RATIO); // 300
const CHUNK_STRIDE = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP);       // 1700

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

// Try to determine Ollama base URL
function guessOllamaBase() {
    // Allow future integration from runtime settings here if needed
    // Fallback to local ollama
    return 'http://ollama:11434';
}

async function getOllamaEmbedding(text) {
    const base = guessOllamaBase();
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
        EDITOR.warning('[RAG] Embedding fetch failed (Ollama).', e.message);
        return null;
    }
}

function hasHashAlready(store, hash) {
    return store.items.some(x => x.hash === hash);
}

/* ===================== Attachments support ===================== */

function getMsgAttachments(msg) {
    // Common places where ST keeps attachments; try multiple fields defensively.
    const atts = [];
    if (Array.isArray(msg?.attachments)) atts.push(...msg.attachments);
    if (Array.isArray(msg?.files)) atts.push(...msg.files);
    if (Array.isArray(msg?.extra?.attachments)) atts.push(...msg.extra.attachments);
    // Filter out images since OCR is out of scope here
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
    // Some integrations may pre-extract or include .text
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
    // 1) If ST Vectors extension exposes an extractor, use it.
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

    // 2) Pre-extracted .text
    const pre = getAttachmentTextField(att);
    if (pre && pre.trim()) return pre.trim();

    // 3) Text-like mime => read as text
    const name = getAttachmentName(att);
    const mime = getAttachmentMime(att);
    if (isTextLikeMime(mime) || isMd(name, mime) || isCsv(name, mime) || isProbablyHtml(name, mime)) {
        const data = await fallbackFetchText(att);
        if (typeof data === 'string' && data.trim()) {
            if (isProbablyHtml(name, mime)) return extractTextFromHtml(data);
            return data.trim();
        }
    }

    // 4) Unsupported complex formats (pdf/docx/epub/etc.) w/o vector ext => skip
    EDITOR.warning(`[RAG] Skipped unsupported attachment without vector extension: ${name}`);
    return null;
}

function* chunkText(text, size = CHUNK_SIZE, stride = CHUNK_STRIDE) {
    const len = text.length;
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

            let chunks = Array.from(chunkText(text));
            const total = chunks.length;

            for (let i = 0; i < total; i++) {
                const chunk = chunks[i].trim();
                if (!chunk) continue;

                const store = getStore();
                const hash = SYSTEM.calculateStringHash(`${name}|${i}|${chunk}`);
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
        const store = getStore();
        const hash = SYSTEM.calculateStringHash(text);
        if (!hasHashAlready(store, hash)) {
            const emb = await getOllamaEmbedding(text);
            if (emb) {
                if (!store.dim) store.dim = emb.length;
                store.items.push({
                    idx,
                    is_user: !!msg.is_user,
                    text,
                    emb,
                    ts: Date.now(),
                    hash,
                });
                try { USER.saveChat && USER.saveChat(); } catch { /* ignore */ }
            }
        }
    }

    // NEW: also vectorize attachments for this message
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

async function searchSimilarByText(text, threshold) {
    let cleaned = (text || '').trim();
    cleaned = stripPrivateBlocks(cleaned);
    if (!cleaned) return [];
    const emb = await getOllamaEmbedding(cleaned);
    if (!emb) return [];
    return searchSimilarByEmbedding(emb, threshold);
}


function formatRagContext(matches) {
    if (!matches || matches.length === 0) return '';
    const lines = matches.map(m => {
        if (m.type === 'attachment') {
            const label = m.attName ? `${m.attName}` : 'attachment';
            const pos = (typeof m.chunkIndex === 'number' && typeof m.chunkTotal === 'number')
                ? `#${m.chunkIndex + 1}/${m.chunkTotal}` : '';
            const who = m.is_user ? 'User' : 'Assistant';
            return `- [${who}] [Attachment:${label}${pos ? ' ' + pos : ''}] ${m.text}`;
        } else {
            const who = m.is_user ? 'User' : 'Assistant';
            return `- [${who}] ${m.text}`;
        }
    });
    return `Retrieved context (RAG):\n${lines.join('\n')}`;
}

// Event handlers

async function handleChatChanged() {
    if (!ragEnabled()) return;
    // Opportunistically backfill vectors for any missing messages
    try {
        await vectorizeAllIfEmpty();
    } catch (e) {
        console.warn('[RAG] Backfill failed on CHAT_CHANGED:', e);
    }
}

async function handleAssistantRendered(chat_id) {
    if (!ragEnabled()) return;
    try {
        await vectorizeMessageByIndex(chat_id);
    } catch (e) {
        console.warn('[RAG] Vectorize assistant message failed:', e);
    }
}

async function handlePromptReady(eventData) {
    if (!ragEnabled()) return;

    try {
        // Ensure store exists; opportunistically backfill if entirely empty
        await vectorizeAllIfEmpty();

        // Also try to vectorize the last message in the underlying chat (if not yet done)
        const chatArr = USER.getContext()?.chat || [];
        const lastIdx = chatArr.length - 1;
        if (lastIdx >= 0) await vectorizeMessageByIndex(lastIdx);

        // Find last user message in eventData.chat to build query
        let lastUserIdx = -1;
        for (let i = eventData.chat.length - 1; i >= 0; i--) {
            if (eventData.chat[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx === -1) return;

        const userText = eventData.chat[lastUserIdx]?.content || '';
        const threshold = typeof USER.tableBaseSetting?.rag_similarity === 'number'
            ? USER.tableBaseSetting.rag_similarity
            : 0.25;

        const matches = await searchSimilarByText(userText, threshold);
        if (!matches || matches.length === 0) return;

        const ragText = formatRagContext(matches);
        if (!ragText) return;

        const role = getInjectionRole();
        const insertMsg = { role, content: ragText };

        const deep = Number(USER.tableBaseSetting?.deep || 0);
        if (deep === 0) {
            eventData.chat.push(insertMsg);
        } else {
            eventData.chat.splice(-deep, 0, insertMsg);
        }
    } catch (e) {
        console.warn('[RAG] Retrieval injection failed:', e);
    }
}

// Register event listeners
APP?.eventSource?.on?.(APP.event_types.CHAT_CHANGED, handleChatChanged);
APP?.eventSource?.on?.(APP.event_types.CHARACTER_MESSAGE_RENDERED, handleAssistantRendered);
APP?.eventSource?.on?.(APP.event_types.CHAT_COMPLETION_PROMPT_READY, handlePromptReady);

// Public API for settings toggle to trigger initial pass
window.ST_RAG = {
    vectorizeAllIfNeeded: vectorizeAllIfEmpty,
    vectorizeMessageByIndex,
    searchSimilarByText,
};