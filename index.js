import { APP, BASE, DERIVED, EDITOR, SYSTEM, USER } from './core/manager.js';
import { openTableRendererPopup, updateSystemMessageTableStatus } from "./scripts/renderer/tablePushToChat.js";
import { loadSettings } from "./scripts/settings/userExtensionSetting.js";
import { ext_getAllTables, ext_exportAllTablesAsJson } from './scripts/settings/standaloneAPI.js';
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

console.log("______________________记忆插件：开始加载______________________")

const VERSION = '3.2.0'

const editErrorInfo = {
    forgotCommentTag: false,
    functionNameError: false,
};

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

// REPLACE the existing onChatCompletionPromptReady with the original (restored) behavior

async function onChatCompletionPromptReady(eventData) {
    try {
        // Step-by-step mode: ONLY inject a single read-only table snapshot (old behavior), then exit
        if (USER.tableBaseSetting.step_by_step === true) {
            if (USER.tableBaseSetting.isExtensionAble === true &&
                USER.tableBaseSetting.isAiReadTable === true &&
                USER.tableBaseSetting.injection_mode !== "injection_off") {

                const tableData = getTablePrompt(eventData, true); // pure data (title + headers + rows)
                if (tableData) {
                    const finalPrompt =
                        `以下是通过表格记录的当前场景信息以及历史记录信息，你需要以此为参考进行思考：\n${tableData}`;
                    if (USER.tableBaseSetting.deep === 0) {
                        eventData.chat.push({ role: getMesRole(), content: finalPrompt });
                    } else {
                        eventData.chat.splice(
                            -USER.tableBaseSetting.deep,
                            0,
                            { role: getMesRole(), content: finalPrompt }
                        );
                    }
                }
            }
            return; // (Old logic) Do NOT inject message_template or thinking_template in step-by-step mode
        }

        // Guard conditions (unchanged from original)
        if (eventData.dryRun === true ||
            USER.tableBaseSetting.isExtensionAble === false ||
            USER.tableBaseSetting.isAiReadTable === false ||
            USER.tableBaseSetting.injection_mode === "injection_off") {
            return;
        }

        // Original simple behavior: build thinking + message templates and inject together
        const thinkingContent = initThinkingData(eventData); // thinking_template (with <previous_thinking>)
        const promptContent = initTableData(eventData);      // message_template (with {{tableData}} substitution)
        const role = getMesRole();
        const inserts = [];

        if (thinkingContent && thinkingContent.trim().length > 0) {
            inserts.push({ role, content: thinkingContent });
        }
        if (promptContent && promptContent.trim().length > 0) {
            inserts.push({ role, content: promptContent });
        }

        if (inserts.length > 0) {
            if (USER.tableBaseSetting.deep === 0) {
                eventData.chat.push(...inserts);
            } else {
                eventData.chat.splice(-USER.tableBaseSetting.deep, 0, ...inserts);
            }
        }

        // Keep legacy sheet/status refresh
        updateSheetsView();
    } catch (error) {
        EDITOR.error(`记忆插件：表格数据注入失败\n原因：`, error.message, error);
    }
    console.log("注入表格总体提示词 + 思考提示词 (restored legacy behavior)", eventData.chat);
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

function initThinkingData(eventData) {
    try {
        let tpl = USER.tableBaseSetting?.thinking_template || '';
        if (!tpl || typeof tpl !== 'string') return '';
        const prev = getLatestAssistantCriticalThinkingSection();
        return replaceUserTag(tpl.replace('<previous_thinking>', prev));
    } catch (error) {
        EDITOR.error('记忆插件：思考提示词注入失败\n原因：', error.message, error);
        return '';
    }
}

/**
 * 消息编辑事件
 */
async function onMessageEdited(this_edit_mes_id) {
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
 * 消息接收时触发
 */
async function onMessageReceived(chat_id) {
    if (USER.tableBaseSetting.isExtensionAble === false) return;
    if (USER.tableBaseSetting.step_by_step === true && USER.getContext().chat.length > 2) {
        TableTwoStepSummary("auto");
    } else {
        if (USER.tableBaseSetting.isAiWriteTable === false) return;
        const chat = USER.getContext().chat[chat_id];
        try {
            handleEditStrInMessage(chat);
        } catch (error) {
            EDITOR.error("记忆插件：表格自动更改失败\n原因：", error.message, error);
        }
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
    } catch (error) {
        EDITOR.error("记忆插件：处理聊天变更失败\n原因：", error.message, error);
    }
}

async function onMessageSwiped(chat_id) {
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

    // 原本的版本检查（如需改为安全模式，可替换为 try/catch 包裹）
    fetch("http://api.muyoo.com.cn/check-version", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientVersion: VERSION, user: USER.getContext().name1 })
    }).then(res => res.json()).then(res => {
        if (res.success) {
            if (!res.isLatest) {
                $("#tableUpdateTag").show();
                $("#setting_button_new_tag").show();
            }
            if (res.toastr) EDITOR.warning(res.toastrText);
            if (res.message) $("#table_message_tip").html(res.message);
        }
    }).catch(e => console.warn('[Memory Enhancement] 版本检查失败:', e));

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
    APP.eventSource.on(APP.event_types.MESSAGE_DELETED, onChatChanged);

    console.log("______________________记忆插件：加载完成______________________")
});