import { APP, BASE, DERIVED, EDITOR, SYSTEM, USER } from './core/manager.js';
import { openTableRendererPopup, updateSystemMessageTableStatus } from "./scripts/renderer/tablePushToChat.js";
import { loadSettings } from "./scripts/settings/userExtensionSetting.js";
import { openTableDebugLogPopup } from "./scripts/settings/devConsole.js";
import { TableTwoStepSummary } from "./scripts/runtime/separateTableUpdate.js";
import { initTest } from "./components/_fotTest.js";
import { initAppHeaderTableDrawer, openAppHeaderTableDrawer } from "./scripts/renderer/appHeaderTableBaseDrawer.js";
import { initRefreshTypeSelector } from './scripts/runtime/absoluteRefresh.js';
import { refreshTempView, updateTableContainerPosition } from "./scripts/editor/tableTemplateEditView.js";
import { functionToBeRegistered } from "./services/debugs.js";
import { parseLooseDict, replaceUserTag } from "./utils/stringUtil.js";
import { executeTranslation } from "./services/translate.js";
import applicationFunctionManager from "./services/appFuncManager.js"
import { SheetBase } from "./core/table/base.js";
import { Cell } from "./core/table/cell.js";
// === PATCH: Short-term memory window (hide messages beyond last N) ===
// Import helper to hide/unhide chat messages
import { hideChatMessageRange } from '../../../chats.js'; // adjust path if root differs

import './scripts/runtime/rag.js'; // ensure RAG runtime (listeners + window.ST_RAG) is loaded
// PATCH: extend existing import from standaloneAPI to include request helpers
import { ext_getAllTables, ext_exportAllTablesAsJson, handleMainAPIRequest, handleCustomAPIRequest } from './scripts/settings/standaloneAPI.js';
import { getCurrentChatNames } from "./utils/chatNameExtractor.js";

console.log("______________________记忆插件：开始加载______________________")

const VERSION = '3.2.0'

const editErrorInfo = {
    forgotCommentTag: false,
    functionNameError: false,
};

// Extend multi-stage state (add pendingMultiStage)
window.__stm_ms_state = {
    inProgress: false,
    consumed: false,
    controller: null,
    // NEW: data prepared at prompt-ready, consumed after default LLM finishes
    pendingMultiStage: null,
};

function __stm_markConsumed() {
    window.__stm_ms_state.inProgress = false;
    window.__stm_ms_state.consumed = true;
}

function __stm_begin() {
    window.__stm_ms_state.consumed = false;
    window.__stm_ms_state.inProgress = true;
    window.__stm_ms_state.controller = new AbortController();
    return window.__stm_ms_state.controller;
}

window.stMemoryEnhancement = window.stMemoryEnhancement || {};
window.stMemoryEnhancement.cancelMultiStage = function(reason = 'user_cancel') {
    const st = window.__stm_ms_state;
    if (st.inProgress && st.controller) {
        try { st.controller.abort(); } catch {}
        st.inProgress = false;
        console.log('[MultiStage] Aborted multi-stage generation:', reason);
    }
};

// Hard suppression hook invoked from prompt ready
function __stm_shouldSuppressDefaultLLM() {
    return window.__stm_ms_state && window.__stm_ms_state.consumed === true;
}
// Add near other small helpers (above onMessageReceived)
function __normalizeMessageIndex(arg) {
    if (Number.isFinite(arg)) return arg;
    if (arg && typeof arg === 'object') {
        if (Number.isFinite(arg.id)) return arg.id;
        if (Number.isFinite(arg.index)) return arg.index;
        if (arg.message) {
            try {
                const chat = USER.getContext()?.chat || [];
                const idx = chat.indexOf(arg.message);
                if (idx >= 0) return idx;
            } catch { }
        }
    }
    return -1;
}
// Helper: strip blocks we must not include in RAG text injection
function __stripCriticalAndInfoBlocks(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
        .replace(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi, '')
        .replace(/<infoblock>[\s\S]*?<\/infoblock>/gi, '');
}
// Place near other helpers
function __sanitizeDeepSeekOutput(raw, stage /* 'narration' | 'thinking' | 'main' */) {
    if (typeof raw !== 'string') return { text: '', stripped: '' };
    let stripped = '';

    // Collect and remove <think> blocks
    raw = raw.replace(/<think>\s*([\s\S]*?)\s*<\/think>/gi, (_, inner) => {
        stripped += (stripped ? '\n\n' : '') + inner.trim();
        return stage === 'thinking' ? inner : '';
    });

    // Collect and remove ```thinking / ```reasoning fenced blocks
    raw = raw.replace(/```(?:thinking|reasoning)\s*([\s\S]*?)```/gi, (_, inner) => {
        stripped += (stripped ? '\n\n' : '') + inner.trim();
        return stage === 'thinking' ? inner : '';
    });

    // Heuristic: some models prepend "Reasoning:"/"Thoughts:" sections
    raw = raw.replace(/^(?:\s*(Reasoning|Thoughts)\s*:\s*)[\s\S]*?(?=(?:\n+Answer\s*:|$))/i, (m) => {
        stripped += (stripped ? '\n\n' : '') + m.trim();
        return stage === 'thinking' ? '' : '';
    });

    // Clean redundant wrappers the model may add in thinking stage
    if (stage === 'thinking') {
        raw = raw.replace(/^\s*(Final Answer|Answer)\s*:\s*/i, '').trim();
    }

    return { text: raw.trim(), stripped: stripped.trim() };
}
// === NEW: Long-term summary branch store ==============================
const LT_SUMMARY_STORE_KEY = 'long_term_summary_store_v1';
// Helper: strip any <tableEdit>...</tableEdit> blocks (used by summary stage to avoid duplicate rows)
function __stripTableEditBlocks(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, '');
}
function __getSummaryStore() {
    const ctx = USER.getContext();
    ctx.chatMetadata = ctx.chatMetadata || {};
    if (!ctx.chatMetadata[LT_SUMMARY_STORE_KEY]) {
        ctx.chatMetadata[LT_SUMMARY_STORE_KEY] = {
            branches: {},         // branchId -> { summary: string, history: [{ts,narration,thinking,main,summary}] }
            activeBranchId: null, // optional override
        };
    }
    return ctx.chatMetadata[LT_SUMMARY_STORE_KEY];
}

function __getActiveBranchId() {
    // Use reference piece uid or fallback to current chat piece uid
    try {
        const piece = (BASE.getReferencePiece && BASE.getReferencePiece()) ||
            (USER.getChatPiece && USER.getChatPiece()?.piece);
        return piece?.uid || 'default_branch';
    } catch {
        return 'default_branch';
    }
}
function __getLastUserMessageIndex() {
    try {
        const chat = USER.getContext()?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user === true) return i;
        }
    } catch {}
    return -1;
}

//function __recomputeLatestSummaryFromChat() {
//    try {
//        const branchId = __getActiveBranchId();
//        const data = __getBranchData(branchId);
//        const chat = USER.getContext()?.chat || [];
//        for (let i = chat.length - 1; i >= 0; i--) {
//            const m = chat[i];
//            const s = m?.extra?.lt_summary;
//            if (typeof s === 'string' && s.trim()) {
//                data.summary = s;
//                try { USER.getContext().saveChat?.(); } catch {}
//                return;
//            }
//        }
//        // nothing left carrying a summary
//        data.summary = '';
//        try { USER.getContext().saveChat?.(); } catch {}
//    } catch (e) {
//        console.warn('[LongTermSummary] recompute from chat failed:', e);
//    }
//}
function __getBranchData(branchId) {
    const store = __getSummaryStore();
    store.branches[branchId] = store.branches[branchId] || { summary: '', history: [] };
    return store.branches[branchId];
}


// --- PATCH: Branch-aware long term summary retrieval (avoid copying post-branch summary) ---

/**
 * Locate the pivot (branch creation) message index:
 * Uses reference piece if available, else current chat piece.
 * Falls back to full chat end when not found.
 */
function __getBranchPivotIndex() {
    try {
        const chat = USER.getContext()?.chat || [];
        const piece =
            (BASE.getReferencePiece && BASE.getReferencePiece()) ||
            (USER.getChatPiece && USER.getChatPiece()?.piece);
        if (!piece || !piece.uid) return chat.length - 1;
        const idx = chat.indexOf(piece);
        return idx >= 0 ? idx : chat.length - 1;
    } catch {
        return (USER.getContext()?.chat || []).length - 1;
    }
}

/**
 * Scan backward from pivot index to find the nearest assistant/user message
 * carrying lt_summary in its extra field.
 * @param {number} pivotIdx
 * @returns {string}
 */
function __computeSummaryUpToIndex(pivotIdx) {
    try {
        const chat = USER.getContext()?.chat || [];
        const end = Math.min(pivotIdx, chat.length - 1);
        for (let i = end; i >= 0; i--) {
            const m = chat[i];
            const s = m?.extra?.lt_summary;
            if (typeof s === 'string' && s.trim()) return s.trim();
        }
    } catch { }
    return '';
}

/**
 * Recompute latest summary limited to branch pivot (used after deletions or branch switch).
 * If pivotOverride provided, restrict scan to that index; else derive pivot.
 */
function __recomputeLatestSummaryFromChat(pivotOverride) {
    try {
        const branchId = __getActiveBranchId();
        const data = __getBranchData(branchId);
        const pivotIdx = Number.isFinite(pivotOverride) ? pivotOverride : __getBranchPivotIndex();
        const fresh = __computeSummaryUpToIndex(pivotIdx);
        data.summary = fresh;
        try { USER.getContext().saveChat?.(); } catch { }
    } catch (e) {
        console.warn('[LongTermSummary] recompute (branch-aware) failed:', e);
    }
}

/**
 * Branch-aware getter:
 * Instead of always returning the last summary in the entire chat,
 * restrict lookup to the branch pivot index to avoid copying summaries
 * that were generated after the branching point.
 */
function getLongTermSummary() {
    try {
        const branchId = __getActiveBranchId();
        const data = __getBranchData(branchId);

        // If we already have a stored summary that originated at/within this branch's pivot,
        // validate it quickly; if not, recompute within pivot range.
        const pivotIdx = __getBranchPivotIndex();
        const validated = __computeSummaryUpToIndex(pivotIdx);

        if (validated && validated === data.summary) {
            return data.summary; // Stored matches latest within branch scope
        }

        if (validated && validated !== data.summary) {
            // Update branch store to keep it consistent with pivot-bounded reality
            data.summary = validated;
            try { USER.getContext().saveChat?.(); } catch { }
            return validated;
        }

        // No embedded summary found up to pivot; fall back to stored (may be empty) or ''
        return data.summary || '';
    } catch {
        return '';
    }
}

//function getLongTermSummary() {
//    const branchId = __getActiveBranchId();
//    return __getBranchData(branchId).summary || '';
//}

function updateLongTermSummary({ narration, thinking, main, summary, userMessage, assistantIndex }) {
    const branchId = __getActiveBranchId();
    const data = __getBranchData(branchId);
    const latest = (typeof summary === 'string') ? summary : '';

    // Persist "current latest"
    data.summary = latest;

    // Append full record to history
    data.history.push({
        ts: Date.now(),
        userMessage: (typeof userMessage === 'string') ? userMessage : '',
        narration: narration || '',
        thinking: thinking || '',
        main: main || '',
        summary: latest,
    });

    // Also store alongside the messages to survive deletions
    try {
        const ctx = USER.getContext();
        const chat = ctx?.chat || [];

        // Attach to last user message
        const userIdx = __getLastUserMessageIndex();
        if (userIdx !== -1 && chat[userIdx]) {
            chat[userIdx].extra = chat[userIdx].extra || {};
            chat[userIdx].extra.lt_summary = latest;
            chat[userIdx].extra.lt_summary_ts = Date.now();
        }

        // Attach to the assistant message we just created (if provided)
        if (Number.isFinite(assistantIndex) && chat[assistantIndex]) {
            chat[assistantIndex].extra = chat[assistantIndex].extra || {};
            chat[assistantIndex].extra.lt_summary = latest;
            chat[assistantIndex].extra.lt_summary_ts = Date.now();
        }
    } catch (e) {
        console.warn('[LongTermSummary] attach to messages failed:', e);
    }

    try { USER.getContext().saveChat?.(); } catch { }
}
// NEW: High-level Lorebook engine caller (tries ST's native world-info builders first)
async function __callLorebookEngine(queryText, S = {}) {
    const opts = {
        // Suggested toggles if the underlying API supports them
        useActivation: true,
        useNegative: true,
        respectProfileSettings: true,
        topK: Number.isFinite(S.lorebook_top_k) ? S.lorebook_top_k : undefined,
        minScore: typeof S.lorebook_min_score === 'number' ? S.lorebook_min_score : undefined,
    };

    // Normalize various possible result shapes into a single string
    const normalize = (res) => {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (Array.isArray(res)) {
            const parts = res
                .map(e => (e?.content ?? e?.value ?? e?.text ?? '').toString().trim())
                .filter(Boolean);
            return parts.join('\n\n');
        }
        if (typeof res === 'object') {
            if (typeof res.text === 'string') return res.text;
            if (Array.isArray(res.entries)) return normalize(res.entries);
            if (Array.isArray(res.items)) return normalize(res.items);
        }
        return '';
    };

    try {
        // Preferred dedicated adapters
        if (window.ST_LORE?.buildContextForText) {
            const res = await window.ST_LORE.buildContextForText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }
        if (window.ST_LORE?.collectForText) {
            const res = await window.ST_LORE.collectForText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }

        // Common SillyTavern world-info engines (names vary by build)
        if (typeof window.applyWorldInfoForText === 'function') {
            const res = await window.applyWorldInfoForText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }
        if (typeof window.applyWorldInfoToPrompt === 'function') {
            const res = await window.applyWorldInfoToPrompt(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }
        if (window.worldInfo?.buildContextForText) {
            const res = await window.worldInfo.buildContextForText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }
        if (window.worldInfo?.applyToText) {
            const res = await window.worldInfo.applyToText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }

        // Historic helper that may already apply triggers in some builds
        if (typeof window.getWorldInfoForText === 'function') {
            const res = await window.getWorldInfoForText(queryText, opts);
            const out = normalize(res);
            if (out) return out;
        }
    } catch (e) {
        console.warn('[Lorebook] Engine call failed:', e);
    }

    return '';
}

// Add near other helpers (e.g., after __buildPastEventsFromRag)
// Replace existing __buildLorebookAppendix with this version to call ST's lorebook engine first
async function __buildLorebookAppendix(eventData, baseText) {
    try {
        const S = USER.tableBaseSetting || {};
        //if (S.enable_lorebook_stages !== true) return '';

        // Choose query source
        let queryText = '';
        if ((S.lorebook_query_source || 'last_user') === 'stm') {
            queryText = typeof baseText === 'string' ? baseText : '';
        } else {
            if (eventData && Array.isArray(eventData.chat)) {
                for (let i = eventData.chat.length - 1; i >= 0; i--) {
                    const m = eventData.chat[i];
                    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
                        queryText = m.content;
                        break;
                    }
                }
            }
            if (!queryText) queryText = typeof baseText === 'string' ? baseText : '';
        }
        if (!queryText) return '';

        const maxChars = Number.isFinite(S.lorebook_max_chars) ? S.lorebook_max_chars : 4000;

        // 1) Try the native SillyTavern lorebook/world-info engine (applies triggers, negatives, chances, etc.)
        const engineText = await __callLorebookEngine(queryText, S);
        if (engineText) {
            return engineText.length > maxChars ? engineText.slice(0, maxChars) : engineText;
        }

        // 2) Fallback: similarity searches (does NOT replicate full lorebook logic)
        const minScore = (typeof S.lorebook_min_score === 'number') ? S.lorebook_min_score : 0.25;
        const topK = Number.isFinite(S.lorebook_top_k) ? S.lorebook_top_k : 5;

        const out = [];
        const push = (t) => {
            if (!t || typeof t !== 'string') return;
            const v = t.trim();
            if (!v) return;
            if (!out.includes(v)) out.push(v);
        };

        if (window.ST_LORE?.searchSimilarByText) {
            try {
                const results = await window.ST_LORE.searchSimilarByText(queryText, minScore, topK);
                if (Array.isArray(results)) {
                    results.forEach(r => {
                        if (r && typeof r.text === 'string') push(r.text);
                        else if (typeof r === 'string') push(r);
                    });
                }
            } catch (e) { console.warn('[Lorebook] ST_LORE.searchSimilarByText failed:', e); }
        }

        if (out.length === 0 && window.worldInfo?.searchByText) {
            try {
                const entries = await window.worldInfo.searchByText(queryText, { topK, minScore });
                if (Array.isArray(entries)) {
                    entries.forEach(e => push(e?.text || e?.content || e?.value || ''));
                }
            } catch (e) { console.warn('[Lorebook] worldInfo.searchByText failed:', e); }
        }

        if (out.length === 0 && window.Lorebook?.query) {
            try {
                const entries = await window.Lorebook.query({ text: queryText, topK, minScore });
                if (Array.isArray(entries)) {
                    entries.forEach(e => push(e?.text || e?.content || e?.value || ''));
                }
            } catch (e) { console.warn('[Lorebook] Lorebook.query failed:', e); }
        }

        if (out.length === 0) return '';

        const joined = out.join('\n\n');
        return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
    } catch (e) {
        console.warn('[Lorebook] Failed to build appendix:', e);
        return '';
    }
}

// Add near appendBlockToAssistant (new helper)
// Replace previous helper
function __createAssistantShellMessage() {
    const ctx = USER.getContext();
    const name2 = ctx?.name2 || 'Assistant';
    return {
        name: name2,
        mes: '',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        force_avatar: ctx?.current_avatar || undefined,
        swipes: [''],
        swipe_id: 0,
        extra: { gen_id: Date.now(), type: 'multi_stage' },
    };
}
// Hard cancel helper (set every flag ST checks in various builds)
function __cancelDefaultLLM(eventData) {
    eventData.cancel = true;
    eventData.skip = true;
    eventData.abort = true;
    eventData.preventDefault = true;
    eventData.skipLLM = true;
    eventData._consumedByMemoryEnhancement = true;
}
// Try to render a single message (SillyTavern internal compatibility)
function __renderMessageByIndex(idx) {
    // Newer builds expose renderMessage / renderSingleMessage
    if (typeof window.renderMessage === 'function') {
        try { window.renderMessage(idx); return true; } catch { }
    }
    if (typeof window.renderSingleMessage === 'function') {
        try { window.renderSingleMessage(idx); return true; } catch { }
    }
    // Fallback: full chat refresh
    try { APP?.eventSource?.emit?.(APP.event_types.CHAT_CHANGED); return true; } catch { }
    return false;
}
function appendBlockToAssistant(msgIndex, blockLabel, content, opts = {}) {
    const ctx = USER.getContext();
    const { eventSource, event_types, messageFormatting } = ctx;
    const S = USER.tableBaseSetting || {};
    let cleanedContent = (blockLabel !== 'main') ? content.replace(/```/gi, '') : content;
    const msg = ctx.chat[msgIndex];
    if (!msg) return;

    // Build block
    const block = (blockLabel === 'main')
        ? `<${blockLabel}>\n\n${cleanedContent}\n\n</${blockLabel}>`
        : `<${blockLabel}>\n\`\`\`\n${cleanedContent}\n\`\`\`\n</${blockLabel}>`;

    // Append
    const prev = msg.mes || '';
    const updated = prev ? (prev + '\n\n' + block) : block;
    msg.mes = updated;
    msg.swipes = Array.isArray(msg.swipes) ? msg.swipes : [''];
    msg.swipe_id = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
    msg.swipes[msg.swipe_id] = updated;

    // Keep display_text in sync for builds that use it for rendering
    msg.extra = msg.extra || {};
    msg.extra.display_text = msg.mes;

    // Optional: re‑vectorize for RAG
    if (S.enable_rag && window.ST_RAG?.purgeMessageEmbeddings && window.ST_RAG?.vectorizeMessageByIndex) {
        try {
            window.ST_RAG.purgeMessageEmbeddings(msgIndex);
            window.ST_RAG.vectorizeMessageByIndex(msgIndex);
        } catch (e) {
            console.warn('[MultiStage] RAG update failed:', e);
        }
    }

    // Table edit trigger
    if (opts.triggerTableEdit === true && S.isAiWriteTable && /<tableEdit>/.test(updated)) {
        try { handleEditStrInMessage(msg, msgIndex, true); } catch (e) { console.warn('[MultiStage] table edit parse failed:', e); }
    }

    // Formatting pass (keeps sanitizer consistent)
    if (typeof messageFormatting === 'function') {
        try {
            msg.formatted_mes = messageFormatting(
                msg.mes,
                msg.name,
                !!msg.is_system,
                !!msg.is_user,
                msgIndex,
                {},
                false
            );
        } catch (e) {
            console.warn('[MultiStage] messageFormatting failed:', e);
        }
    }

    // Best-effort streaming-like event (safe-wrapped)
    try {
        if (event_types?.STREAM_TOKEN_RECEIVED) {
            eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, {
                id: msgIndex,
                text: block,              // delta-ish content
                state: { reasoning: null, image: null },
            });
        }
    } catch (e) {
        // ignore
    }

    // Emit update events (both index and payload variants to satisfy different builds)
    try { eventSource.emit(event_types.MESSAGE_UPDATED, msgIndex); } catch { }
    try { eventSource.emit(event_types.MESSAGE_UPDATED, { id: msgIndex, message: msg }); } catch { }
    try { eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, msgIndex); } catch { }
    try { eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, { id: msgIndex, message: msg }); } catch { }

    // Hard refresh fallback if events aren’t enough
    const rendered = __renderMessageByIndex(msgIndex);
    if (!rendered) {
        try { APP?.eventSource?.emit?.(APP.event_types.CHAT_CHANGED); } catch { }
    }

    updateSystemMessageTableStatus();
}


// ADD THIS HELPER (place near other helpers, e.g. above onChatCompletionPromptReady)
function __buildStmBase(eventData, promptContent, thinkingContent, stm) {
    const S = USER.tableBaseSetting || {};
    const { userName, charName } = getCurrentChatNames();
    const fullChat = Array.isArray(USER.getContext()?.chat) ? USER.getContext().chat : [];
    const keepPairs = stm > 0 ? Math.min(stm, Math.ceil(fullChat.length / 2)) : null;

    // Build a filtered slice based on short term memory (assistant + preceding user)
    let indices = [];
    if (keepPairs === null) {
        indices = fullChat.map((_, i) => i);
    } else {
        // Walk backwards collecting assistant messages and their preceding user
        let assistants = 0;
        for (let i = fullChat.length - 1; i >= 0 && assistants < keepPairs; i--) {
            const m = fullChat[i];
            if (m && m.is_user === false) {
                assistants++;
                indices.push(i);
                // preceding user (if exists)
                if (i - 1 >= 0 && fullChat[i - 1].is_user === true) indices.push(i - 1);
            }
        }
        indices = Array.from(new Set(indices)).sort((a, b) => a - b);
    }

    // Fallback: if nothing collected, take all
    if (indices.length === 0) indices = fullChat.map((_, i) => i);

    const applyNameMacros = (s) => {
        if (typeof s !== 'string') return '';
        return s
            .replace(/{{user}}/gi, userName)
            .replace(/<user>/g, userName)
            .replace(/{{char}}/gi, charName)
            .replace(/{{character}}/gi, charName);
    };

    const stripReasoning = (text) => {
        if (typeof text !== 'string') return '';
        if (S.keep_reasoning_in_stmBase === true) return text;
        return text.replace(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi, '');
    };

    const lines = [];

    // Include any system/world-info messages from eventData.chat first (retain ordering there)
    if (Array.isArray(eventData.chat)) {
        eventData.chat.forEach(m => {
            if (m.role === 'system') {
                const body = m.content || m.mes || '';
                if (body.trim()) lines.push(body.trim());
            }
        });
    }

    // Prepend injected thinking + table prompt content (only once)
    const injectedBlocks = [thinkingContent, promptContent].filter(t => typeof t === 'string' && t.trim());
    if (injectedBlocks.length) {
        lines.push('### INJECTED CONTEXT START ###');
        injectedBlocks.forEach(b => lines.push(applyNameMacros(b.trim())));
        lines.push('### INJECTED CONTEXT END ###');
    }

    // Append conversation messages (user + assistant)
    indices.forEach(i => {
        const m = fullChat[i];
        if (!m) return;
        const raw = (typeof m.content === 'string' ? m.content : (typeof m.mes === 'string' ? m.mes : '')).trim();
        if (!raw) return;

        if (m.is_user === true) {
            lines.push(`User(${userName}): ${applyNameMacros(raw)}`);
        } else {
            lines.push(`${charName || 'Assistant'}: ${applyNameMacros(stripReasoning(raw))}`);
        }
    });

    // Add long-term summary (if exists) at tail to help stages
    try {
        const lts = getLongTermSummary();
        if (lts) lines.push(`\n[LONG_TERM_SUMMARY]\n${applyNameMacros(lts.trim())}\n[/LONG_TERM_SUMMARY]`);
    } catch { }

    // Preserve any lorebook block already added inside system messages of eventData.chat
    // (Already included above if present)

    // Final base
    const stmBase = replaceUserTag(lines.join('\n').replace(/\r/g, ''));
    return stmBase;
}
const replaceInMessages = (msgs, regex, replacement = '') =>
    msgs.map(m => ({
        ...m,
        content: typeof m.content === 'string' ? m.content.replace(regex, replacement) : m.content
    }));
const applyReplaceInPlace = (msgs, regex, replacement = '') =>
    msgs.forEach(m => {
        if (typeof m.content === 'string') m.content = m.content.replace(regex, replacement);
    });


// NEW: Inject only thinking content into the prompt we send to the LLM (no cancellation)
function __applyThinkingInjection(eventData) {
    try {
        const S = USER.tableBaseSetting || {};
        const enableThinking = S.enable_thinking_stage !== false;
        const thinkingTpl = enableThinking ? (S.thinking_template || '').trim() : '';
        if (!enableThinking || !thinkingTpl) return;

        // Build thinking content (existing helper preserves previous thinking CRM)
        const thinkingContent = initThinkingData(eventData);
        if (!thinkingContent || !thinkingContent.trim()) return;

        // Prefer prepending to last user message; fallback to insert as system
        let lastUserIdx = -1;
        for (let i = eventData.chat.length - 1; i >= 0; i--) {
            if (eventData.chat[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        applyReplaceInPlace(eventData.chat, /<_beat>[\s\S]*?<\/_beat>/gi, '');
        applyReplaceInPlace(eventData.chat, /<_sexd>[\s\S]*?<\/_sexd>/gi, '');
        applyReplaceInPlace(eventData.chat, /<_sex>[\s\S]*?<\/_sex>/gi, '');
        const wrapped = `<thinking_instructions>\n${thinkingContent.trim()}\n</thinking_instructions>`;

        if (lastUserIdx !== -1) {
            const prev = eventData.chat[lastUserIdx].content || '';
            eventData.chat[lastUserIdx].content = `${wrapped}\n\n${prev}`;
        } else {
            const role = getMesRole() || 'system';
            eventData.chat.push({ role, content: wrapped });
        }
    } catch (e) {
        console.warn('[ThinkingInjection] Failed to inject thinking content:', e);
    }
}

// NEW: Post-default multi-stage runner that updates ONLY the last assistant message
async function __runPostDefaultMultiStage(stmBase, assistantIndex) {
    const S = USER.tableBaseSetting || {};
    const enableNarration = S.enable_narration_stage !== false;
    const enableMain = S.enable_main_stage !== false;
    const enableSummary = S.enable_long_term_summary_stage !== false;

    let narrationTpl = enableNarration ? (S.narration_template || '').trim() : '';
    let mainTpl = enableMain ? (S.main_response_template || '').trim() : '';
    let longTermSummaryTpl = enableSummary ? (S.long_term_summary_template || '').trim() : '';

    const previousSummary = getLongTermSummary();
    applyReplaceInPlace(stmBase, /<thinking_instructions>[\s\S]*?<\/thinking_instructions>/gi, '');

    const expand = (tpl, ctx) => (tpl || '')
        .replace(/{{narration}}/g, ctx.narration || '')
        .replace(/{{thinking}}/g, ctx.thinking || '')
        .replace(/{{main}}/g, ctx.main || '')
        .replace(/{{previous_summary}}/g, ctx.previous_summary || '')
        .replace(/{{summary}}/g, ctx.summary || '');

    // NEW: cap retries via setting (default 1 to prevent 3-4 extra calls)
    const maxAttemptsSetting = 5;

    async function callStage(messages) {
        const useMainAPI = S.use_main_api === true;
        const tryMain = async () => {
            try {
                const raw = await handleMainAPIRequest(messages, null, true);
                return (raw === 'suspended' || typeof raw !== 'string') ? '' : raw.trim();
            } catch { return ''; }
        };
        const tryCustom = async () => {
            try {
                const raw = await handleCustomAPIRequest(messages, null, true, true);
                return (raw === 'suspended' || typeof raw !== 'string') ? '' : raw.trim();
            } catch { return ''; }
        };
        if (useMainAPI) {
            let r = await tryMain(); if (!r) r = await tryCustom(); return r || '';
        } else {
            let r = await tryCustom(); if (!r) r = await tryMain(); return r || '';
        }
    }

    async function callStageWithRetry(stageName, payload, sanitizeStage) {
        const maxAttempts = maxAttemptsSetting;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let raw = '';
            try { raw = await callStage(payload); } catch (e) {
                console.warn(`[PostMultiStage:${stageName}] Exception on attempt ${attempt}:`, e);
                raw = '';
            }
            const { text } = __sanitizeDeepSeekOutput(raw, sanitizeStage);
            if (text && text.trim()) {
                if (attempt > 1) console.log(`[PostMultiStage:${stageName}] Succeeded on retry attempt ${attempt}`);
                return { text, stripped: '' };
            }
            if (attempt < maxAttempts) {
                console.warn(`[PostMultiStage:${stageName}] Empty/failed response (attempt ${attempt}); retrying...`);
                await new Promise(r => setTimeout(r, 250 * attempt));
            } else {
                console.error(`[PostMultiStage:${stageName}] Failed after ${maxAttempts} attempts; giving up.`);
            }
        }
        return { text: '', stripped: '' };
    }

    // We already have a default LLM response at assistantIndex; append our stages onto that message
    const ctx = USER.getContext();

    // MAIN
    let mainResp = '';
    if (mainTpl) {
        let mainPrompt = [
            mainTpl // thinking is now injected upstream; no separate stage output here
        ].filter(Boolean).join('\n\n');
        mainPrompt = __applyNameMacros(mainPrompt);

        let mainPromptA = __deepCopyChat(stmBase);
        mainPromptA.push({ role: 'system', content: `<main_instructions>\n${mainPrompt}\n</main_instructions>` });

        applyReplaceInPlace(mainPromptA, /<_beat>[\s\S]*?<\/_beat>/gi, '');
        const { text } = await callStageWithRetry('main', mainPromptA, 'main');
        mainResp = text;
        if (mainResp) {
            appendBlockToAssistant(assistantIndex, 'main', mainResp, { triggerTableEdit: true });
        }
    }

    // NARRATION
    let narrationResp = '';
    if (narrationTpl) {
        let narrationPrompt = [
            expand(narrationTpl, {                
                main: __stripTableEditBlocks(mainResp)
            })
        ].filter(Boolean).join('\n\n');
        narrationPrompt = __applyNameMacros(narrationPrompt);

        let narrationPromptA = __deepCopyChat(stmBase);
        narrationPromptA.push({ role: 'system', content: `<narration_instructions>\n${narrationPrompt}\n</narration_instructions>` });

        applyReplaceInPlace(narrationPromptA, /<_sexd>[\s\S]*?<\/_sexd>/gi, '');
        const { text } = await callStageWithRetry('narration', narrationPromptA, 'narration');
        narrationResp = text;
        appendBlockToAssistant(assistantIndex, 'narration', narrationResp || '(no narration)', { triggerTableEdit: false });
    }

    // SUMMARY (store only)
    if (longTermSummaryTpl) {
        const ui = __getLastUserMessageIndex();
        const chatArr = USER.getContext()?.chat || [];
        const lastUserMessage = ui !== -1
            ? (typeof chatArr[ui]?.content === 'string'
                ? chatArr[ui].content
                : (typeof chatArr[ui]?.mes === 'string' ? chatArr[ui].mes : ''))
            : '';

        let summaryPrompt = [
            `<PREVIOUS_SUMMARY>\n${previousSummary || '(none)'}\n</PREVIOUS_SUMMARY>`,
            expand(longTermSummaryTpl, {
                narration: narrationResp,
                thinking: '', // no separate thinking stage output here
                main: __stripTableEditBlocks(mainResp)
            })
        ].filter(Boolean).join('\n\n');
        summaryPrompt = __applyNameMacros(summaryPrompt);

        let summaryPromptA = __deepCopyChat(stmBase);
        summaryPromptA.push({ role: 'system', content: `<summary_instructions>\n${summaryPrompt}\n</summary_instructions>` });

        applyReplaceInPlace(summaryPromptA, /<_beat>[\s\S]*?<\/_beat>/gi, '');
        applyReplaceInPlace(summaryPromptA, /<_sexd>[\s\S]*?<\/_sexd>/gi, '');
        applyReplaceInPlace(summaryPromptA, /<_sex>[\s\S]*?<\/_sex>/gi, '');

        const { text: summaryResp } = await callStageWithRetry('summary', summaryPromptA, 'main');
        updateLongTermSummary({
            narration: narrationResp,
            thinking: '',
            main: mainResp,
            summary: summaryResp,
            userMessage: lastUserMessage,
            assistantIndex
        });
    }

    try { await ctx.saveChat?.(); } catch { }
    try { await updateSheetsView(assistantIndex); } catch { }
}
// Build RAG "past events" text for current user message
async function __buildPastEventsFromRag(eventData) {
    try {
        if (!USER.tableBaseSetting?.enable_rag || !window.ST_RAG?.searchSimilarByText) return '';

        // Find latest user message used to build this prompt
        let lastUserIdx = -1;
        for (let i = eventData.chat.length - 1; i >= 0; i--) {
            if (eventData.chat[i]?.role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx === -1) return '';

        const userText = eventData.chat[lastUserIdx]?.content || '';
        const threshold = typeof USER.tableBaseSetting?.rag_similarity === 'number'
            ? USER.tableBaseSetting.rag_similarity
            : 0.25;

        const results = await window.ST_RAG.searchSimilarByText(userText, threshold);
        if (!Array.isArray(results) || results.length === 0) return '';

        // Concatenate only stripped text (no headers, no labels)
        const joined = results
            .map(r => __stripCriticalAndInfoBlocks(r?.text || '').trim())
            .filter(Boolean)
            .join('\n\n');

        return joined || '';
    } catch (e) {
        console.warn('[RAG] Failed to build past events block:', e);
        return '';
    }
}

// === MODIFY: initTableDataWithRag -> use stored long-term summary instead of RAG for {{long_term_memory}} ===
async function initTableDataWithRag(eventData) {
    const template = USER.tableBaseSetting.message_template || '';

    const piece =
        (BASE.getReferencePiece && BASE.getReferencePiece()) ||
        (function () {
            const chat = USER.getContext()?.chat || [];
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.hash_sheets) return chat[i];
            }
            return null;
        })();

    let tableData = '';
    if (piece) {
        tableData = _migrateAndExportFullMemoryTable(piece);
        if (!tableData) {
            tableData = getTablePromptByPiece(piece, false);
        }
    }

    // Previously: fetch ragText and inject into {{long_term_memory}}.
    // Now: use persistent long-term summary (branch-based).
    const longTermSummary = getLongTermSummary();

    let replaced = template.replace(/{{tableData}}/g, tableData);
    replaced = replaced.replace(/{{long_term_memory}}/g, longTermSummary);

    if (!template.includes('{{tableData}}')) {
        console.warn('[Memory Enhancement] message_template missing {{tableData}}.');
    } else if (!tableData) {
        console.warn('[Memory Enhancement] Memory Table export empty.');
    }
    if (template.includes('{{long_term_memory}}') && !longTermSummary) {
        console.warn('[LongTermSummary] No stored long-term summary yet for this branch.');
    }

    return replaceUserTag(replaced);
}
/**
 * 修复值中不正确的转义单引号
 */
function fixUnescapedSingleQuotes(value) {
    if (typeof value === 'string') {
        return value.replace(/\\'/g, "'");
    }
    if (typeof value === 'object' && value !== null) {
        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                value[key] = fixUnescapedSingleQuotes(value[key]);
            }
        }
    }
    return value;
}

/**
 * 通过表格索引查找表格结构
 */
export function findTableStructureByIndex(index) {
    return USER.tableBaseSetting.tableStructure[index];
}

/**
 * 检查数据是否为Sheet实例
 */
function checkPrototype(dataTable) {
    return dataTable;
}

export function buildSheetsByTemplates(targetPiece) {
    BASE.sheetsData.context = [];
    const templates = BASE.templates;
    templates.forEach(template => {
        if (template.enable === false) return;
        if (!template || !template.hashSheet || !Array.isArray(template.hashSheet) ||
            template.hashSheet.length === 0 || !Array.isArray(template.hashSheet[0]) ||
            !template.cellHistory || !Array.isArray(template.cellHistory)) {
            console.error(`[Memory Enhancement] 无效模板结构，跳过:`, template);
            return;
        }
        try {
            const newSheet = BASE.createChatSheetByTemp(template);
            newSheet.save(targetPiece);
        } catch (error) {
            EDITOR.error(`[Memory Enhancement] 创建或保存模板失败:`, error.message, error);
        }
    });
    BASE.updateSelectBySheetStatus();
    USER.saveChat();
}

/**
 * 转化旧表格为sheets
 */
export function convertOldTablesToNewSheets(oldTableList, targetPiece) {
    const sheets = [];
    for (const oldTable of oldTableList) {
        const valueSheet = [oldTable.columns, ...oldTable.content].map(row => ['', ...row]);
        const cols = valueSheet[0].length;
        const rows = valueSheet.length;
        const targetSheetUid = BASE.sheetsData.context.find(sheet => sheet.name === oldTable.tableName)?.uid;
        if (targetSheetUid) {
            const targetSheet = BASE.getChatSheet(targetSheetUid);
            targetSheet.rebuildHashSheetByValueSheet(valueSheet);
            targetSheet.save(targetPiece);
            addOldTablePrompt(targetSheet);
            sheets.push(targetSheet);
            continue;
        }
        const newSheet = BASE.createChatSheet(cols, rows);
        newSheet.name = oldTable.tableName;
        newSheet.domain = SheetBase.SheetDomain.chat;
        newSheet.type = SheetBase.SheetType.dynamic;
        newSheet.enable = oldTable.enable;
        newSheet.required = oldTable.Required;
        newSheet.tochat = true;
        newSheet.triggerSend = false;
        newSheet.triggerSendDeep = 1;

        addOldTablePrompt(newSheet);
        newSheet.data.description = `${oldTable.note}\n${oldTable.initNode}\n${oldTable.insertNode}\n${oldTable.updateNode}\n${oldTable.deleteNode}`;

        valueSheet.forEach((row, rowIndex) => {
            row.forEach((value, colIndex) => {
                const cell = newSheet.findCellByPosition(rowIndex, colIndex);
                cell.data.value = value;
            });
        });

        newSheet.save(targetPiece);
        sheets.push(newSheet);
    }
    console.log("转换旧表格数据为新表格数据", sheets);
    return sheets;
}
/**
 * Applies the short term memory window.
 * Keeps only the last `n` messages visible; hides all earlier ones.
 * When n <= 0 all messages are shown.
 * @param {number} [nOverride] Optional override (used when user changes setting)
 */
// PATCH: assistant-based short-term memory — keep ONLY last N assistant messages + their preceding user messages
// PATCH: Rewritten short-term memory window logic (robust + idempotent)
async function applyShortTermMemoryWindow(nOverride) {
    try {
        let rawN = (typeof nOverride === 'number')
            ? nOverride
            : (parseInt(USER.tableBaseSetting.short_term_memory, 10) || 0);

        const chat = USER.getContext()?.chat || [];
        if (!Array.isArray(chat) || chat.length === 0) return;

        const total = chat.length;
        const disabled = rawN < 0;

        // Translate assistant-count to rough message count (assistant + preceding user)
        let keepCount = disabled ? total : Math.min(total, rawN * 2);

        // Compute start index of window to remain visible
        const keepStartIndex = total - keepCount;

        // Idempotency: skip if same window already applied
        const cacheKey = disabled ? 'ALL' : `${keepStartIndex}:${total}`;
        if (applyShortTermMemoryWindow._lastApplied === cacheKey) return;
        applyShortTermMemoryWindow._lastApplied = cacheKey;

        const promises = [];
        for (let i = 0; i < total; i++) {
            const show = disabled || i >= keepStartIndex;
            promises.push(hideChatMessageRange(i, i, show));
        }
        await Promise.all(promises);
    } catch (e) {
        console.warn('[ShortTermMemory] Failed (assistant+preceding-user mode):', e);
    }
}
function addOldTablePrompt(sheet) {
    const tableStructure = USER.tableBaseSetting.tableStructure.find(table => table.tableName === sheet.name);
    if (!tableStructure) return false;
    const source = sheet.source;
    source.required = tableStructure.Required;
    source.data.initNode = tableStructure.initNode;
    source.data.insertNode = tableStructure.insertNode;
    source.data.updateNode = tableStructure.updateNode;
    source.data.deleteNode = tableStructure.deleteNode;
    source.data.note = tableStructure.note;
}

/**
 * 寻找下一个含有表格数据的消息
 */
export function findNextChatWhitTableData(startIndex, isIncludeStartIndex = false) {
    if (startIndex === -1) return { index: -1, chat: null };
    const chat = USER.getContext().chat;
    for (let i = isIncludeStartIndex ? startIndex : startIndex + 1; i < chat.length; i++) {
        if (chat[i].is_user === false && chat[i].dataTable) {
            checkPrototype(chat[i].dataTable);
            return { index: i, chat: chat[i] };
        }
    }
    return { index: -1, chat: null };
}
/* === PATCH: Full Memory Table injection with Cognitive Impact migration ===
   Add this block (only once) anywhere above initTableData (e.g. near other helper funcs).
*/
function _migrateAndExportFullMemoryTable(piece) {
    if (!piece?.hash_sheets) return '';
    const sheets = BASE.hashSheetsToSheets(piece.hash_sheets)
        .filter(s => s && s.name === 'Memory Table' && s.enable && s.sendToContext !== false);
    if (!sheets.length) return '';

    const ALL_LINES = [];
    sheets.forEach((sheet, si) => {
        // Header
        const headerRow = sheet.getCellsByRowIndex(0).slice(1);
        let headers = headerRow.map(c => c.data.value || '');
        let impactIndex = headers.indexOf('Cognitive Impact');
        if (impactIndex === -1) {
            headers.push('Cognitive Impact');
            impactIndex = headers.length - 1;
        }
        ALL_LINES.push(`[${si}:${sheet.name}]`);
        ALL_LINES.push(headers.join(' | '));

        // Body rows
        for (let r = 1; r < sheet.getRowCount(); r++) {
            const cells = sheet.getCellsByRowIndex(r).slice(1);
            const rowValues = cells.map(c => (c.data.value ?? '').toString());
            // Pad in case column count increased
            while (rowValues.length < headers.length) rowValues.push('');
            // Fill Cognitive Impact default if empty
            if (!rowValues[impactIndex] || !rowValues[impactIndex].trim()) {
                rowValues[impactIndex] = 'high';
                // Persist change into sheet cell if physically exists
                if (impactIndex < cells.length) {
                    cells[impactIndex].data.value = 'high';
                }
            }
            ALL_LINES.push(rowValues.join(' | '));
        }
        ALL_LINES.push('');
        // Save sheet if any modifications were applied
        sheet.save(piece, true);
    });

    return ALL_LINES.join('\n').trim();
}
/**
 * 生成表格总体提示词
 */
/* === PATCH: Replace existing initTableData with this version === */
export function initTableData(eventData) {
    const template = USER.tableBaseSetting.message_template || '';
    // Prefer reference piece, fallback to last with sheets
    const piece =
        (BASE.getReferencePiece && BASE.getReferencePiece()) ||
        (function () {
            const chat = USER.getContext()?.chat || [];
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.hash_sheets) return chat[i];
            }
            return null;
        })();

    let tableData = '';
    if (piece) {
        // Use full Memory Table export (all rows) with migration
        tableData = _migrateAndExportFullMemoryTable(piece);
        // Fallback: if memory table absent, keep previous generic behavior
        if (!tableData) {
            tableData = getTablePromptByPiece(piece, false);
        }
    }

    const replaced = template.replace(/{{tableData}}/g, tableData);
    if (!template.includes('{{tableData}}')) {
        console.warn('[Memory Enhancement] message_template missing {{tableData}}.');
    } else if (!tableData) {
        console.warn('[Memory Enhancement] Memory Table export empty (no rows or no table).');
    }
    return replaceUserTag(replaced);
}

/**
 * 获取表格提示词
 */
export function getTablePrompt(eventData, isPureData = false) {
    let piece = null;
    try {
        piece = BASE.getReferencePiece && BASE.getReferencePiece();
    } catch (_) {}
    if (!piece) {
        piece = _findFallbackSheetsPiece();
        if (!piece) {
            console.warn('[Memory Enhancement] No sheets piece found. Returning empty table prompt.');
            return '';
        }
    }
    const prompt = getTablePromptByPiece(piece, isPureData);
    if (!prompt.trim()) {
        // If structure exists but no rows, optionally synthesize headers (only once)
        try {
            const sheets = BASE.hashSheetsToSheets(piece.hash_sheets || {});
            const enabled = sheets.filter(s => s.enable && s.sendToContext !== false);
            if (enabled.length) {
                // Build a minimal header-only representation to avoid leaving {{tableData}} blank
                const headerBlocks = enabled.map((s, i) => {
                    const headers = s.getCellsByRowIndex(0).slice(1).map(c => c.data.value || '').join(' | ');
                    return `[${i}:${s.name}]\n${headers}\n(表格暂无数据 / no rows yet)`;
                }).join('\n\n');
                return headerBlocks;
            }
        } catch (e) {
            console.warn('[Memory Enhancement] Could not synthesize header-only table prompt:', e);
        }
    }
    return prompt;
}

/**
 * Internal fallback: locate a piece that still has hash_sheets when BASE.getReferencePiece() is null.
 */
function _findFallbackSheetsPiece() {
    try {
        if (USER.getChatPiece) {
            const { piece } = USER.getChatPiece() || {};
            if (piece?.hash_sheets) return piece;
        }
        const chat = USER.getContext()?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && chat[i].hash_sheets) return chat[i];
        }
    } catch (e) {
        console.warn('[Memory Enhancement] _findFallbackSheetsPiece failed:', e);
    }
    return null;
}

/**
 * Re‑added: Build table prompt text from a specific piece.
 * @param {Object} piece Chat piece containing hash_sheets
 * @param {boolean} isPureData If true, only include minimal data sections
 * @returns {string}
 */
export function getTablePromptByPiece(piece, isPureData = false) {
    if (!piece || !piece.hash_sheets) return '';
    try {
        const sheets = BASE.hashSheetsToSheets(piece.hash_sheets)
            .filter(sheet => sheet?.enable)
            .filter(sheet => sheet.sendToContext !== false);

        if (!sheets.length) return '';

        // Decide which table text sections to include
        const customParts = isPureData
            ? ['title', 'headers', 'rows']
            : ['title', 'node', 'headers', 'rows', 'editRules'];

        return sheets
            .map((sheet, index) => {
                try {
                    return sheet.getTableText(index, customParts, piece);
                } catch (e) {
                    console.warn('[Memory Enhancement] getTableText failed for sheet', sheet?.name, e);
                    return '';
                }
            })
            .filter(Boolean)
            .join('\n');
    } catch (err) {
        console.error('[Memory Enhancement] getTablePromptByPiece error:', err);
        return '';
    }
}

/**
 * 解析表格编辑函数
 */
function handleTableEditTag(matches) {
    const functionRegex = /(updateRow|insertRow|deleteRow)\(/g;
    let A = [];
    let match;
    let positions = [];
    matches.forEach(input => {
        while ((match = functionRegex.exec(input)) !== null) {
            positions.push({
                index: match.index,
                name: match[1].replace("Row", "")
            });
        }
        for (let i = 0; i < positions.length; i++) {
            const start = positions[i].index;
            const end = i + 1 < positions.length ? positions[i + 1].index : input.length;
            const fullCall = input.slice(start, end);
            const lastParenIndex = fullCall.lastIndexOf(")");
            if (lastParenIndex !== -1) {
                const sliced = fullCall.slice(0, lastParenIndex);
                const argsPart = sliced.slice(sliced.indexOf("(") + 1);
                const args = argsPart.match(/("[^"]*"|\{.*\}|[0-9]+)/g)?.map(s => s.trim());
                if (!args) continue;
                A.push({
                    type: positions[i].name,
                    param: args,
                    index: positions[i].index,
                    length: end - start
                });
            }
        }
    });
    return A;
}

function isTableEditStrChanged(chat, matches) {
    if (chat.tableEditMatches != null && chat.tableEditMatches.join('') === matches.join('')) {
        return false;
    }
    chat.tableEditMatches = matches;
    return true;
}

function clearEmpty() {
    DERIVED.any.waitingTable.forEach(table => table.clearEmpty());
}

export function handleEditStrInMessage(chat, mesIndex = -1, ignoreCheck = false) {
    parseTableEditTag(chat, mesIndex, ignoreCheck);
    updateSystemMessageTableStatus();
}

export function parseTableEditTag(piece, mesIndex = -1, ignoreCheck = false) {
    const { matches } = getTableEditTag(piece.mes);
    if (!ignoreCheck && !isTableEditStrChanged(piece, matches)) return false;
    const tableEditActions = handleTableEditTag(matches);
    tableEditActions.forEach((action, index) => tableEditActions[index].action = classifyParams(formatParams(action.param)));
    const { piece: prePiece } = mesIndex === -1 ? BASE.getLastSheetsPiece(1) : BASE.getLastSheetsPiece(mesIndex - 1, 1000, false);
    const sheets = BASE.hashSheetsToSheets(prePiece.hash_sheets).filter(sheet => sheet.enable);
    for (const EditAction of sortActions(tableEditActions)) {
        executeAction(EditAction, sheets);
    }
    sheets.forEach(sheet => sheet.save(piece, true));
    return true;
}

export function executeTableEditActions(matches, referencePiece) {
    const tableEditActions = handleTableEditTag(matches);
    tableEditActions.forEach((action, index) => tableEditActions[index].action = classifyParams(formatParams(action.param)));
    const sheets = BASE.getChatSheets().filter(sheet => sheet.enable);
    if (!sheets || sheets.length === 0) {
        console.error("executeTableEditActions: 未找到任何启用的表格实例");
        return false;
    }
    for (const EditAction of sortActions(tableEditActions)) {
        executeAction(EditAction, sheets);
    }
    const { piece: currentPiece } = USER.getChatPiece();
    if (!currentPiece) {
        console.error("executeTableEditActions: 无当前聊天片段，保存失败");
        return false;
    }
    sheets.forEach(sheet => sheet.save(currentPiece, true));
    return true;
}

function executeAction(EditAction, sheets) {
    const action = EditAction.action;
    const sheet = sheets[action.tableIndex];
    if (!sheet) {
        console.error("表格不存在", EditAction);
        return -1;
    }
    if (action.data) {
        action.data = fixUnescapedSingleQuotes(action.data);
    }
    switch (EditAction.type) {
        case 'update': {
            const rowIndex = action.rowIndex ? parseInt(action.rowIndex) : 0;
            if (rowIndex >= sheet.getRowCount() - 1) return executeAction({ ...EditAction, type: 'insert' }, sheets);
            if (!action?.data) return;
            Object.entries(action.data).forEach(([key, value]) => {
                const cell = sheet.findCellByPosition(rowIndex + 1, parseInt(key) + 1);
                if (!cell) return -1;
                cell.newAction(Cell.CellAction.editCell, { value }, false);
            });
            break;
        }
        case 'insert': {
            const cell = sheet.findCellByPosition(sheet.getRowCount() - 1, 0);
            if (!cell) return -1;
            cell.newAction(Cell.CellAction.insertDownRow, {}, false);
            const lastestRow = sheet.getRowCount() - 1;
            const cells = sheet.getCellsByRowIndex(lastestRow);
            if (!cells || !action.data) return;
            cells.forEach((cell, index) => {
                if (index === 0) return;
                cell.data.value = action.data[index - 1];
            });
            break;
        }
        case 'delete': {
            const deleteRow = parseInt(action.rowIndex) + 1;
            const cell = sheet.findCellByPosition(deleteRow, 0);
            if (!cell) return -1;
            cell.newAction(Cell.CellAction.deleteSelfRow, {}, false);
            break;
        }
    }
    return 1;
}

function sortActions(actions) {
    const priority = { update: 0, insert: 1, delete: 2 };
    return actions.sort((a, b) =>
        (priority[a.type] === 2 && priority[b.type] === 2)
            ? (b.action.rowIndex - a.action.rowIndex)
            : (priority[a.type] - priority[b.type])
    );
}

function formatParams(paramArray) {
    return paramArray.map(item => {
        const trimmed = item.trim();
        if (!isNaN(trimmed) && trimmed !== "") return Number(trimmed);
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            const parsed = parseLooseDict(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
                Object.keys(parsed).forEach(key => {
                    if (!/^\d+$/.test(key)) delete parsed[key];
                });
            }
            return parsed;
        }
        return trimmed;
    });
}

function classifyParams(param) {
    const action = {};
    for (const key in param) {
        if (typeof param[key] === 'number') {
            if (key === '0') action.tableIndex = param[key];
            else if (key === '1') action.rowIndex = param[key];
        } else if (typeof param[key] === 'object') {
            action.data = param[key];
        }
    }
    return action;
}

function executeTableEditTag(chat, mesIndex = -1, ignoreCheck = false) {
    if (mesIndex !== -1) {
        const { index, chat: nextChat } = findNextChatWhitTableData(mesIndex);
        if (index !== -1) handleEditStrInMessage(nextChat, index, true);
    }
}

function dryRunExecuteTableEditTag() { }

export function getTableEditActionsStr() {
    const tableEditActionsStr = DERIVED.any.tableEditActions
        .filter(action => action.able && action.type !== 'Comment')
        .map(tableEditAction => tableEditAction.format())
        .join('\n');
    return "\n<!--\n" + (tableEditActionsStr === '' ? '' : (tableEditActionsStr + '\n')) + '-->\n'
}

export function replaceTableEditTag(chat, newContent) {
    if (/<tableEdit>.*?<\/tableEdit>/gs.test(chat.mes)) {
        chat.mes = chat.mes.replace(/<tableEdit>(.*?)<\/tableEdit>/gs, `<tableEdit>${newContent}</tableEdit>`);
    } else {
        chat.mes += `\n<tableEdit>${newContent}</tableEdit>`;
    }
    if (chat.swipes != null && chat.swipe_id != null)
        if (/<tableEdit>.*?<\/tableEdit>/gs.test(chat.swipes[chat.swipe_id])) {
            chat.swipes[chat.swipe_id] = chat.swipes[chat.swipe_id].replace(/<tableEdit>(.*?)<\/tableEdit>/gs, `<tableEdit>\n${newContent}\n</tableEdit>`);
        } else {
            chat.swipes[chat.swipe_id] += `\n<tableEdit>${newContent}</tableEdit>`;
        }
    USER.getContext().saveChat();
}

function getMesRole() {
    switch (USER.tableBaseSetting.injection_mode) {
        case 'deep_system': return 'system';
        case 'deep_user': return 'user';
        case 'deep_assistant': return 'assistant';
    }
}

/* -----------------------------------------------------------
   RESTORED + ENHANCED PROMPT INJECTION
   - Short-term memory window (short_term_memory)
   - Critical thinking aggregation (critical_thinking_memory)
   - Injection order: CT history -> thinking_template -> message_template
   - UI messages remain intact
----------------------------------------------------------- */

function __stripCriticalThinkingBlocks(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi, '').trim();
}

function __collectLastCriticalThinkingSections(chatArr, count) {
    if (!Array.isArray(chatArr) || count <= 0) return [];
    const collected = [];
    for (let i = chatArr.length - 1; i >= 0 && collected.length < count; i--) {
        const c = chatArr[i];
        if (!c || c.is_user) continue;
        const body = typeof c.content === 'string'
            ? c.content
            : (typeof c.mes === 'string' ? c.mes : '');
        if (!body) continue;
        const matches = body.match(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi);
        if (matches) {
            for (let j = matches.length - 1; j >= 0 && collected.length < count; j--) {
                collected.push(matches[j]);
            }
        }
    }
    return collected.reverse();
}

function __buildThinkingPromptOverride(latestSection) {
    try {
        let tpl = USER.tableBaseSetting?.thinking_template || '';
        if (!tpl || typeof tpl !== 'string') return '';
        const replaced = tpl.replace('<previous_thinking>', latestSection || '');
        return replaceUserTag(replaced);
    } catch (e) {
        EDITOR.error('思考提示词构建失败', e.message, e);
        return '';
    }
}


// 3) Prevent re-entrancy and duplicate arming in onMessageReceived
async function onMessageReceived(chat_id) {
    if (USER.tableBaseSetting.isExtensionAble === false) return;

    const idx = __normalizeMessageIndex(chat_id);
    if (!Number.isFinite(idx) || idx < 0) return;

    try {
        if (USER.tableBaseSetting.enable_rag && window.ST_RAG?.vectorizeMessageByIndex) {
            await window.ST_RAG.vectorizeMessageByIndex(idx);
        }
    } catch (e) {
        console.warn('[RAG] vectorize on assistant message failed:', e);
    }

    const msg = USER.getContext().chat[idx];
    if (!msg || msg.is_user === true || typeof msg.mes !== 'string') {
        updateSheetsView();
        return;
    }
    // NEW: prepare stmBase and arm pendingMultiStage here (once)
    let stmBase = __deepCopyChat(eventData.chat);
    stmBase.forEach(m => {
        if (typeof m.content === 'string') m.content = `<previous_message>\n${m.content}\n</previous_message>`;
    });
    let lastUserIdx = -1;
    for (let i = eventData.chat.length - 1; i >= 0; i--) {
        if (eventData.chat[i]?.role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx !== -1) {
        let lastContent = eventData.chat[lastUserIdx].content.replace(/<previous_message>/g, '').replace(/<\/previous_message>/g, '');
        lastContent = `<last_user_message>\n${lastContent}\n</last_user_message>`;
        stmBase[lastUserIdx].content = lastContent;
    }

    const hasAnyStage =
        ((USER.tableBaseSetting.narration_template || '').trim().length > 0) ||
        ((USER.tableBaseSetting.main_response_template || '').trim().length > 0) ||
        ((USER.tableBaseSetting.long_term_summary_template || '').trim().length > 0);

    if (USER.tableBaseSetting.step_by_step !== true && hasAnyStage) {
        window.__stm_ms_state.pendingMultiStage = { stmBase, ts: Date.now() };
    } else {
        window.__stm_ms_state.pendingMultiStage = null;
    }
    const st = window.__stm_ms_state || {};

    // NEW: guard against re-entrancy caused by our own CHARACTER_MESSAGE_RENDERED emissions
    if (st.inProgress) return;

    // Only consume the pending work prepared at prompt time; do NOT re-arm here
    if (st.pendingMultiStage && st.pendingMultiStage.stmBase) {
        try {
            st.inProgress = true;
            await __runPostDefaultMultiStage(st.pendingMultiStage.stmBase, idx);
        } catch (e) {
            console.warn('[PostMultiStage] failed:', e);
        } finally {
            st.pendingMultiStage = null;
            st.inProgress = false;
        }
        return;
    }

    // Legacy path
    if (USER.tableBaseSetting.step_by_step === true && USER.getContext().chat.length > 2) {
        TableTwoStepSummary("auto");
    } else {
        if (USER.tableBaseSetting.isAiWriteTable === false) return;
        try {
            handleEditStrInMessage(msg, idx);
        } catch (error) {
            EDITOR.error("记忆插件：表格自动更改失败\n原因：", error.message, error);
        }
    }
    updateSheetsView();
}



// REWRITE onChatCompletionPromptReady flow:
// 1) gate/early-outs
// 2) ensure RAG for latest user (optional)
// 3) apply short_term_memory window to eventData.chat
// 4) build message_template preamble via initTableDataWithRag(eventData)
// 5) run multi-stage response (sanitized) and early-return
// 6) fallback to legacy injection when multi-stage not active
// PATCH: Reorder logic so STM pipeline (thinking + template injection) runs FIRST.
// Multi-stage now receives the full, already-injected "raw prompt" (stmBase).
// REWRITE onChatCompletionPromptReady: inject thinking only, arm post-default multi-stage, do NOT cancel default LLM
async function onChatCompletionPromptReady(eventData) {
    try {
        if (eventData.dryRun === true ||
            USER.tableBaseSetting.isExtensionAble === false ||
            USER.tableBaseSetting.isAiReadTable === false ||
            USER.tableBaseSetting.injection_mode === "injection_off") {
            return;
        }

        // RAG vectorize latest user (best effort)
        try {
            if (USER.tableBaseSetting.enable_rag && window.ST_RAG?.vectorizeMessageByIndex) {
                const chatArr = USER.getContext()?.chat || [];
                const lastIdx = chatArr.length - 1;
                if (lastIdx >= 0) await window.ST_RAG.vectorizeMessageByIndex(lastIdx);
            }
        } catch (e) { console.warn('[RAG] vectorize on prompt-ready failed:', e); }

        // Build memory for our later multi-stage only (not injected into the default call)
        const promptContent = await initTableDataWithRag(eventData); // table + long term summary
        eventData.chat.push({ role: 'system', content: `<memory>\n${promptContent}\n</memory>` });
        // Inject THINKING into outgoing chat for default LLM
        __applyThinkingInjection(eventData);

        // DO NOT cancel default LLM; allow it to proceed
        // Sheets will be updated after post-default multi-stage completes
        updateSheetsView();
    } catch (error) {
        EDITOR.error(`记忆插件：表格数据注入失败\n原因：`, error.message, error);
    }
    console.log("STM thinking injected; default call continues; post-default multistage armed (if enabled).", eventData.chat);
}


/**
 * Deep copy chat array (messages can include nested objects, Maps/Sets, Dates, etc.).
 * - Prefer structuredClone when available.
 * - Fallback supports circular refs and common built-in types.
 * - Functions, DOM Nodes, and Window are returned by reference.
 */
function __deepCopyChat(chat) {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(chat);
        }
    } catch (_) { /* ignore and use fallback */ }
    return __deepCloneFallback(chat);
}

function __deepCloneFallback(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    // DOM/Window guards (keep references)
    if (typeof Node !== 'undefined' && value instanceof Node) return value;
    if (typeof Window !== 'undefined' && value instanceof Window) return value;

    // Dates, RegExps
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);

    // Map / Set
    if (value instanceof Map) {
        const m = new Map();
        seen.set(value, m);
        value.forEach((v, k) => m.set(__deepCloneFallback(k, seen), __deepCloneFallback(v, seen)));
        return m;
    }
    if (value instanceof Set) {
        const s = new Set();
        seen.set(value, s);
        value.forEach(v => s.add(__deepCloneFallback(v, seen)));
        return s;
    }

    // ArrayBuffer / TypedArrays / DataView
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
        const ctor = value.constructor;
        return new ctor(value);
    }
    if (value instanceof DataView) {
        return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    }

    // Arrays
    if (Array.isArray(value)) {
        const arr = new Array(value.length);
        seen.set(value, arr);
        for (let i = 0; i < value.length; i++) {
            arr[i] = __deepCloneFallback(value[i], seen);
        }
        return arr;
    }

    // Plain/Object-like (preserve prototype)
    const proto = Object.getPrototypeOf(value);
    const obj = Object.create(proto);
    seen.set(value, obj);

    for (const key of Object.keys(value)) {
        obj[key] = __deepCloneFallback(value[key], seen);
    }
    for (const sym of Object.getOwnPropertySymbols(value)) {
        obj[sym] = __deepCloneFallback(value[sym], seen);
    }
    return obj;
}
/**
 * 宏获取提示词
 */
function getMacroPrompt() {
    try {
        if (USER.tableBaseSetting.isExtensionAble === false || USER.tableBaseSetting.isAiReadTable === false) return "";
        if (USER.tableBaseSetting.step_by_step === true) {
            const promptContent = replaceUserTag(getTablePrompt(undefined, true));
            return `以下是通过表格记录的当前场景信息以及历史记录信息，你需要以此为参考进行思考：\n${promptContent}`;
        }
        return initTableData();
    } catch (error) {
        EDITOR.error(`记忆插件：宏提示词注入失败\n原因：`, error.message, error);
        return "";
    }
}

/**
 * 宏获取表格数据
 */
function getMacroTablePrompt() {
    try {
        if (USER.tableBaseSetting.isExtensionAble === false || USER.tableBaseSetting.isAiReadTable === false) return "";
        if (USER.tableBaseSetting.step_by_step === true) {
            return replaceUserTag(getTablePrompt(undefined, true));
        }
        return replaceUserTag(getTablePrompt());
    } catch (error) {
        EDITOR.error(`记忆插件：宏表格提示词注入失败\n原因：`, error.message, error);
        return "";
    }
}

function trimString(str) {
    const str1 = str.trim();
    if (!str1.startsWith("<!--") || !str1.endsWith("-->")) {
        editErrorInfo.forgotCommentTag = true;
    }
    return str1.replace(/^\s*<!--|-->?\s*$/g, "").trim();
}

export function getTableEditTag(mes) {
    const regex = /<tableEdit>(.*?)<\/tableEdit>/gs;
    const matches = [];
    let match;
    while ((match = regex.exec(mes)) !== null) {
        matches.push(match[1]);
    }
    return { matches };
}

// 获取最新 critical thinking（旧逻辑保留供兼容）
function getLatestAssistantCriticalThinkingSection() {
    try {
        const chat = USER.getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const c = chat[i];
            if (c && c.is_user === false && typeof c.mes === 'string') {
                const match = c.mes.match(/<critical_thinking>[\s\S]*?<\/critical_thinking>/i);
                if (match && match[0]) return match[0];
            }
        }
    } catch (e) {
        console.error('Failed to extract latest <critical_thinking> section:', e);
    }
    return '';
}
const __applyNameMacros = (s) => {
    const { userName, charName } = getCurrentChatNames();
    return s
        .replace(/{{user}}/gi, userName)
        .replace(/{{char}}/gi, charName);
};
// PATCH: enhance thinking data to support multi previous critical thinking sections (CRM setting)
function initThinkingData(eventData) {
    try {
        const S = USER.tableBaseSetting || {};
        const enableThinking = S.enable_thinking_stage !== false;
        let thinkingTpl = enableThinking ? (S.thinking_template || '').trim() : '';
        //if (!tpl || typeof tpl !== 'string') return '';
        // Critical thinking memory (CRM) count
        const crmCount = parseInt(
            USER.tableBaseSetting?.critical_thinking_memory ??
            $('#dataTable_critical_thinking_memory').val() ??
            '0',
            10
        ) || 0;

        // Collect last N critical thinking sections from full context (even if hidden)
        let previousCombined = '';
        if (crmCount > 0) {
            const fullChat = USER.getContext()?.chat || [];
            const sections = __collectLastCriticalThinkingSections(fullChat, crmCount);
            previousCombined = sections.join('\n');
        }
        if (thinkingTpl) {
            let thinkingPrompt = [
                `<previous_thoughts>\n${previousCombined || '(none)'}\n</previous_thoughts>`,
                thinkingTpl
            ].filter(Boolean).join('\n\n');
            thinkingTpl = __applyNameMacros(thinkingPrompt); 
        }
        return thinkingTpl;
    } catch (error) {
        EDITOR.error('记忆插件：思考提示词注入失败\n原因：', error.message, error);
        return '';
    }
}

async function onMessageEdited(this_edit_mes_id) {
    // Keep the RAG store in sync for both user and assistant edits
    try {
        if (USER.tableBaseSetting.enable_rag && window.ST_RAG) {
            window.ST_RAG.purgeMessageEmbeddings(this_edit_mes_id);
            await window.ST_RAG.vectorizeMessageByIndex(this_edit_mes_id);
        }
    } catch (e) {
        console.warn('[RAG] sync on MESSAGE_EDITED failed:', e);
    }

    if (USER.tableBaseSetting.isExtensionAble === false || USER.tableBaseSetting.step_by_step === true) return;
    const chat = USER.getContext().chat[this_edit_mes_id];
    if (chat.is_user === true || USER.tableBaseSetting.isAiWriteTable === false) return;
    try {
        handleEditStrInMessage(chat, parseInt(this_edit_mes_id));
    } catch (error) {
        EDITOR.error("记忆插件：表格编辑失败\n原因：", error.message, error);
    }
    updateSheetsView();
}

/**
 * 解析 {{GET::...}} 宏
 */
function resolveTableMacros(text) {
    if (typeof text !== 'string' || !text.includes('{{GET::')) return text;
    return text.replace(/{{GET::\s*([^:]+?)\s*:\s*([A-Z]+\d+)\s*}}/g, (match, tableName, cellAddress) => {
        const sheets = BASE.getChatSheets();
        const targetTable = sheets.find(t => t.name.trim() === tableName.trim());
        if (!targetTable) return `<span style="color: red">[GET: 未找到表格 "${tableName}"]</span>`;
        try {
            const cell = targetTable.getCellFromAddress(cellAddress);
            const cellValue = cell ? cell.data.value : undefined;
            return cellValue !== undefined ? cellValue : `<span style="color: orange">[GET: 在 "${tableName}" 中未找到单元格 "${cellAddress}"]</span>`;
        } catch {
            return `<span style="color: red">[GET: 处理时出错]</span>`;
        }
    });
}

async function onChatChanged() {
    try {
        updateSheetsView();
        document.querySelectorAll('.mes_text').forEach(mes => {
            if (mes.dataset.macroProcessed) return;
            const originalHtml = mes.innerHTML;
            const newHtml = resolveTableMacros(originalHtml);
            if (originalHtml !== newHtml) {
                mes.innerHTML = newHtml;
                mes.dataset.macroProcessed = true;
            }
        });

        // RAG: opportunistically vectorize newest message (covers user-only additions)
        if (USER.tableBaseSetting.enable_rag && window.ST_RAG?.vectorizeMessageByIndex) {
            const chat = USER.getContext()?.chat || [];
            const lastIdx = chat.length - 1;
            if (lastIdx >= 0) {
                await window.ST_RAG.vectorizeMessageByIndex(lastIdx);
            }
        }
    } catch (error) {
        EDITOR.error("记忆插件：处理聊天变更失败\n原因：", error.message, error);
    }
}

async function onMessageSwiped(chat_id) {
    // RAG: purge and revectorize for the swiped assistant message
    try {
        if (USER.tableBaseSetting.enable_rag && window.ST_RAG) {
            window.ST_RAG.purgeMessageEmbeddings(chat_id);
            await window.ST_RAG.vectorizeMessageByIndex(chat_id);
        }
    } catch (e) {
        console.warn('[RAG] sync on MESSAGE_SWIPED failed:', e);
    }

    if (USER.tableBaseSetting.isExtensionAble === false || USER.tableBaseSetting.isAiWriteTable === false) return;
    const chat = USER.getContext().chat[chat_id];
    if (!chat.swipe_info[chat.swipe_id]) return;
    try {
        handleEditStrInMessage(chat);
    } catch (error) {
        EDITOR.error("记忆插件：swipe切换失败\n原因：", error.message, error);
    }

    updateSheetsView();
}

/**
 * 删除消息事件
 */
async function onMessageDeleted(chat_id) {
    // RAG: purge embeddings for deleted message and shift indices after it
    try {
        if (USER.tableBaseSetting.enable_rag && window.ST_RAG) {
            window.ST_RAG.purgeMessageEmbeddings(chat_id);
            window.ST_RAG.adjustIndicesAfterDeletion(chat_id);
        }
    } catch (e) {
        console.warn('[RAG] sync on MESSAGE_DELETED failed:', e);
    }

    // Keep previous behavior
    await onChatChanged();

    // NEW: recompute the latest long term summary from remaining messages
    try { __recomputeLatestSummaryFromChat(); } catch (e) {
        console.warn('[LongTermSummary] recompute on delete failed:', e);
    }
}

/**
 * 撤回表格
 */
export async function undoSheets(deep) {
    const { piece, deep: findDeep } = BASE.getLastSheetsPiece(deep);
    if (findDeep === -1) return;
    handleEditStrInMessage(piece, findDeep, true);
    updateSheetsView();
}

/**
 * 更新表格视图
 */
async function updateSheetsView(mesId) {
    try {
        console.log("========================================\n更新表格视图");
        refreshTempView(true);
        console.log("========================================\n更新表格内容视图");
        BASE.refreshContextView(mesId);
        updateSystemMessageTableStatus();
    } catch (error) {
        EDITOR.error("记忆插件：更新表格视图失败\n原因：", error.message, error);
    }
}

export function openDrawer() {
    const drawer = $('#table_database_settings_drawer .drawer-toggle');
    if (isDrawerNewVersion()) {
        applicationFunctionManager.doNavbarIconClick.call(drawer);
    } else {
        return openAppHeaderTableDrawer();
    }
}

export function isDrawerNewVersion() {
    return !!applicationFunctionManager.doNavbarIconClick;
}

jQuery(async () => {
    window.stMemoryEnhancement = {
        ext_getAllTables,
        ext_exportAllTablesAsJson,
        VERSION,
    };

    //// 原本的版本检查（如需改为安全模式，可替换为 try/catch 包裹）
    //fetch("http://api.muyoo.com.cn/check-version", {
    //    method: 'POST',
    //    headers: { 'Content-Type': 'application/json' },
    //    body: JSON.stringify({ clientVersion: VERSION, user: USER.getContext().name1 })
    //}).then(res => res.json()).then(res => {
    //    if (res.success) {
    //        if (!res.isLatest) {
    //            $("#tableUpdateTag").show();
    //            $("#setting_button_new_tag").show();
    //        }
    //        if (res.toastr) EDITOR.warning(res.toastrText);
    //        if (res.message) $("#table_message_tip").html(res.message);
    //    }
    //}).catch(e => console.warn('[Memory Enhancement] 版本检查失败:', e));

    $('.extraMesButtons').append('<div title="查看表格" class="mes_button open_table_by_id">表格</div>');

    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        console.log("手机端");
    } else {
        console.log("电脑端");
        initTest();
    }

    $('#translation_container').after(await SYSTEM.getTemplate('index'));
    $('#extensions-settings-button').after(await SYSTEM.getTemplate('appHeaderTableDrawer'));

    loadSettings();

    $(document).on('click', '.open_table_by_id', function () {
        const messageId = parseInt($(this).closest('.mes').attr('mesid'));
        if (USER.getContext().chat[messageId].is_user === true) {
            toastr.warning('用户消息不支持表格编辑');
            return;
        }
        BASE.refreshContextView(messageId);
        openDrawer();
    });

    USER.getContext().registerMacro("tablePrompt", () => getMacroPrompt());
    USER.getContext().registerMacro("tableData", () => getMacroTablePrompt());
    USER.getContext().registerMacro("GET_ALL_TABLES_JSON", () => {
        try {
            const jsonData = ext_exportAllTablesAsJson();
            return Object.keys(jsonData).length === 0 ? "{}" : JSON.stringify(jsonData);
        } catch (error) {
            EDITOR.error("导出所有表格数据时出错。", "", error);
            return "{}";
        }
    });

    if (isDrawerNewVersion()) {
        $('#table_database_settings_drawer .drawer-toggle').on('click', applicationFunctionManager.doNavbarIconClick);
    } else {
        $('#table_drawer_content').attr('data-slide-toggle', 'hidden').css('display', 'none');
        $('#table_database_settings_drawer .drawer-toggle').on('click', openAppHeaderTableDrawer);
    }

    $(document).on('click', '.tableEditor_renderButton', function () {
        openTableRendererPopup();
    });

    $(document).on('click', '#table_debug_log_button', function () {
        openTableDebugLogPopup();
    });

    $(document).on('click', '.open_table_by_id', function () {
        const messageId = $(this).closest('.mes').attr('mesid');
        initRefreshTypeSelector();
    });

    $(document).on('change', '.tableEditor_switch', function () {
        let index = $(this).data('index');
        const tableStructure = findTableStructureByIndex(index);
        tableStructure.enable = $(this).prop('checked');
    });

    initAppHeaderTableDrawer().then();
    functionToBeRegistered();
    executeTranslation();

    APP.eventSource.on(APP.event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    APP.eventSource.on(APP.event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    APP.eventSource.on(APP.event_types.CHAT_CHANGED, onChatChanged);
    APP.eventSource.on(APP.event_types.MESSAGE_EDITED, onMessageEdited);
    APP.eventSource.on(APP.event_types.MESSAGE_SWIPED, onMessageSwiped);
    // Replace generic handler with a specialized one for deletions
    APP.eventSource.on(APP.event_types.MESSAGE_DELETED, onMessageDeleted);

    console.log("______________________记忆插件：加载完成______________________")
});

// Hook: after initial settings load & chat presence
(async function __initShortTermMemoryWindowHook() {
    // Defer until current event loop settles (ensures chat loaded)
    setTimeout(() => applyShortTermMemoryWindow(), 0);
})();

// Re-apply when chat structurally changes (new messages loaded / history switch)
APP?.eventSource?.on?.(APP.event_types.CHAT_CHANGED, () => applyShortTermMemoryWindow());
APP?.eventSource?.on?.(APP.event_types.CHARACTER_MESSAGE_RENDERED, () => applyShortTermMemoryWindow());

// PATCH: dynamic listener for correct STm input id (dataTable_short_term_memory)
$(document).on('change', '#dataTable_short_term_memory', function () {
    const val = parseInt(this.value);
    USER.tableBaseSetting.short_term_memory = isNaN(val) ? 0 : val;
    USER.saveSettings && USER.saveSettings();
    applyShortTermMemoryWindow(USER.tableBaseSetting.short_term_memory);
});

// Optional: expose for debugging / console use
window.applyShortTermMemoryWindow = applyShortTermMemoryWindow;