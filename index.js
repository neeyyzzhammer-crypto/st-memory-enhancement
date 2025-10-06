import { APP, BASE, DERIVED, EDITOR, SYSTEM, USER } from './core/manager.js';
import { openTableRendererPopup, updateSystemMessageTableStatus } from "./scripts/renderer/tablePushToChat.js";
import { loadSettings } from "./scripts/settings/userExtensionSetting.js";
import { ext_getAllTables, ext_exportAllTablesAsJson } from './scripts/settings/standaloneAPI.js';
import { openTableDebugLogPopup } from "./scripts/settings/devConsole.js";
import { TableTwoStepSummary } from "./scripts/runtime/separateTableUpdate.js";
import { initTest } from "./components/_fotTest.js";
import { initAppHeaderTableDrawer, openAppHeaderTableDrawer } from "./scripts/renderer/appHeaderTableBaseDrawer.js";
import { initRefreshTypeSelector } from './scripts/runtime/absoluteRefresh.js';
import {refreshTempView, updateTableContainerPosition} from "./scripts/editor/tableTemplateEditView.js";
import { functionToBeRegistered } from "./services/debugs.js";
import { parseLooseDict, replaceUserTag } from "./utils/stringUtil.js";
import {executeTranslation} from "./services/translate.js";
import applicationFunctionManager from "./services/appFuncManager.js"
import {SheetBase} from "./core/table/base.js";
import { Cell } from "./core/table/cell.js";


// ADD import for hiding messages (best-effort; wrapped in try/catch if path differs)
import { hideChatMessageRange } from '../../../chats.js'; // If path differs in your environment, adjust accordingly.

console.log("______________________记忆插件：开始加载______________________")

const VERSION = '2.2.0'

const editErrorInfo = {
    forgotCommentTag: false,
    functionNameError: false,
}

/**
 * 修复值中不正确的转义单引号
 * @param {*} value
 * @returns
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
 * @param {number} index 表格索引
 * @returns 此索引的表格结构
 */
export function findTableStructureByIndex(index) {
    return USER.tableBaseSetting.tableStructure[index];
}

/**
 * 检查数据是否为Sheet实例，不是则转换为新的Sheet实例
 * @param {Object[]} dataTable 所有表格对象数组
 */
function checkPrototype(dataTable) {
    // 旧的Table实例检查逻辑已被移除
    // 现在使用新的Sheet类处理表格数据
    // 这个函数保留是为了兼容旧代码调用，但内部逻辑已更新
    return dataTable;
}

export function buildSheetsByTemplates(targetPiece) {
    BASE.sheetsData.context = [];
    // USER.getChatPiece().hash_sheets = {};
    const templates = BASE.templates
    templates.forEach(template => {
        if(template.enable === false) return

        // 检查 template 结构
        if (!template || !template.hashSheet || !Array.isArray(template.hashSheet) || template.hashSheet.length === 0 || !Array.isArray(template.hashSheet[0]) || !template.cellHistory || !Array.isArray(template.cellHistory)) {
            console.error(`[Memory Enhancement] 在 buildSheetsByTemplates 中遇到无效的模板结构 (缺少 hashSheet 或 cellHistory)。跳过模板:`, template);
            return; // 跳过处理此模板
        }
        try {
            const newSheet = BASE.createChatSheetByTemp(template);
            newSheet.save(targetPiece);
        } catch (error) {
            EDITOR.error(`[Memory Enhancement] 从模板创建或保存 sheet 时出错:`, error.message, error);
        }
    })
    BASE.updateSelectBySheetStatus()
    USER.saveChat()
}

/**
 * 转化旧表格为sheets
 * @param {DERIVED.Table[]} oldTableList 旧表格数据
 */
export function convertOldTablesToNewSheets(oldTableList, targetPiece) {
    //USER.getChatPiece().hash_sheets = {};
    const sheets = []
    for (const oldTable of oldTableList) {
        const valueSheet = [oldTable.columns, ...oldTable.content].map(row => ['', ...row])
        const cols = valueSheet[0].length
        const rows = valueSheet.length
        const targetSheetUid = BASE.sheetsData.context.find(sheet => sheet.name === oldTable.tableName)?.uid
        if (targetSheetUid) {
            // 如果表格已存在，则更新表格数据
            const targetSheet = BASE.getChatSheet(targetSheetUid)
            console.log("表格已存在，更新表格数据", targetSheet)
            targetSheet.rebuildHashSheetByValueSheet(valueSheet)
            targetSheet.save(targetPiece)
            addOldTablePrompt(targetSheet)
            sheets.push(targetSheet)
            continue
        }
        // 如果表格未存在，则创建新的表格
        const newSheet = BASE.createChatSheet(cols, rows);
        newSheet.name = oldTable.tableName
        newSheet.domain = SheetBase.SheetDomain.chat
        newSheet.type = SheetBase.SheetType.dynamic
        newSheet.enable = oldTable.enable
        newSheet.required = oldTable.Required
        newSheet.tochat = true
        newSheet.triggerSend = false
        newSheet.triggerSendDeep = 1

        addOldTablePrompt(newSheet)
        newSheet.data.description = `${oldTable.note}\n${oldTable.initNode}\n${oldTable.insertNode}\n${oldTable.updateNode}\n${oldTable.deleteNode}`

        valueSheet.forEach((row, rowIndex) => {
            row.forEach((value, colIndex) => {
                const cell = newSheet.findCellByPosition(rowIndex, colIndex)
                cell.data.value = value
            })
        })

        newSheet.save(targetPiece)
        sheets.push(newSheet)
    }
    // USER.saveChat()
    console.log("转换旧表格数据为新表格数据", sheets)
    return sheets
}

/**
 * 添加旧表格结构中的提示词到新的表格中
 * @param {*} sheet 表格对象
 */
function addOldTablePrompt(sheet) {
    const tableStructure = USER.tableBaseSetting.tableStructure.find(table => table.tableName === sheet.name)
    console.log("添加旧表格提示词", tableStructure, USER.tableBaseSetting.tableStructure, sheet.name)
    if (!tableStructure) return false
    const source = sheet.source
    source.required = tableStructure.Required
    source.data.initNode = tableStructure.initNode
    source.data.insertNode = tableStructure.insertNode
    source.data.updateNode = tableStructure.updateNode
    source.data.deleteNode = tableStructure.deleteNode
    source.data.note = tableStructure.note
}

/**
 * 寻找下一个含有表格数据的消息，如寻找不到，则返回null
 * @param startIndex 开始寻找的索引
 * @param isIncludeStartIndex 是否包含开始索引
 * @returns 寻找到的mes数据
 */
export function findNextChatWhitTableData(startIndex, isIncludeStartIndex = false) {
    if (startIndex === -1) return { index: - 1, chat: null }
    const chat = USER.getContext().chat
    for (let i = isIncludeStartIndex ? startIndex : startIndex + 1; i < chat.length; i++) {
        if (chat[i].is_user === false && chat[i].dataTable) {
            checkPrototype(chat[i].dataTable)
            return { index: i, chat: chat[i] }
        }
    }
    return { index: - 1, chat: null }
}

/**
 * 搜寻最后一个含有表格数据的消息，并生成提示词
 * @returns 生成的完整提示词
 */
export function initTableData(eventData) {
    const allPrompt = USER.tableBaseSetting.message_template.replace('{{tableData}}', getTablePrompt(eventData))
    const promptContent = replaceUserTag(allPrompt)  //替换所有的<user>标签
    console.log("完整提示", promptContent)
    return promptContent
}

/**
 * 获取表格相关提示词
 * @returns {string} 表格相关提示词
 */
export function getTablePrompt(eventData, isPureData = false) {
    const lastSheetsPiece = BASE.getReferencePiece()
    if(!lastSheetsPiece) return ''
    console.log("获取到的参考表格数据", lastSheetsPiece)
    return getTablePromptByPiece(lastSheetsPiece, isPureData)
}

/**
 * 通过piece获取表格相关提示词
 * @param {Object} piece 聊天片段
 * @returns {string} 表格相关提示词
 */
export function getTablePromptByPiece(piece, isPureData = false) {
    const {hash_sheets} = piece
    const sheets = BASE.hashSheetsToSheets(hash_sheets)
        .filter(sheet => sheet.enable)
        .filter(sheet => sheet.sendToContext !== false);
    console.log("构建提示词时的信息 (已过滤)", hash_sheets, sheets)
    const customParts = isPureData ? ['title', 'headers', 'rows'] : ['title', 'node', 'headers', 'rows', 'editRules'];
    const sheetDataPrompt = sheets.map((sheet, index) => sheet.getTableText(index, customParts, piece)).join('\n')
    return sheetDataPrompt
}

/**
 * 将匹配到的整体字符串转化为单个语句的数组
 * @param {string[]} matches 匹配到的整体字符串
 * @returns 单条执行语句数组
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
                name: match[1].replace("Row", "") // 转换成 update/insert/delete
            });
        }

        // 合并函数片段和位置
        for (let i = 0; i < positions.length; i++) {
            const start = positions[i].index;
            const end = i + 1 < positions.length ? positions[i + 1].index : input.length;
            const fullCall = input.slice(start, end);
            const lastParenIndex = fullCall.lastIndexOf(")");

            if (lastParenIndex !== -1) {
                const sliced = fullCall.slice(0, lastParenIndex); // 去掉最后一个 )
                const argsPart = sliced.slice(sliced.indexOf("(") + 1);
                const args = argsPart.match(/("[^"]*"|\{.*\}|[0-9]+)/g)?.map(s => s.trim());
                if(!args) continue
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

/**
 * 检查表格编辑字符串是否改变
 * @param {Chat} chat 单个聊天对象
 * @param {string[]} matches 新的匹配对象
 * @returns
 */
function isTableEditStrChanged(chat, matches) {
    if (chat.tableEditMatches != null && chat.tableEditMatches.join('') === matches.join('')) {
        return false
    }
    chat.tableEditMatches = matches
    return true
}

/**
 * 清除表格中的所有空行
 */
function clearEmpty() {
    DERIVED.any.waitingTable.forEach(table => {
        table.clearEmpty()
    })
}



/**
 * 处理文本内的表格编辑事件
 * @param {Chat} chat 单个聊天对象
 * @param {number} mesIndex 修改的消息索引
 * @param {boolean} ignoreCheck 是否跳过重复性检查
 * @returns
 */
export function handleEditStrInMessage(chat, mesIndex = -1, ignoreCheck = false) {
    parseTableEditTag(chat, mesIndex, ignoreCheck)
    updateSystemMessageTableStatus();   // 新增代码，将表格数据状态更新到系统消息中
    //executeTableEditTag(chat, mesIndex)
}

/**
 * 解析回复中的表格编辑标签
 * @param {*} piece 单个聊天对象
 * @param {number} mesIndex 修改的消息索引
 * @param {boolean} ignoreCheck 是否跳过重复性检查
 */
export function parseTableEditTag(piece, mesIndex = -1, ignoreCheck = false) {
    const { matches } = getTableEditTag(piece.mes)
    if (!ignoreCheck && !isTableEditStrChanged(piece, matches)) return false
    const tableEditActions = handleTableEditTag(matches)
    tableEditActions.forEach((action, index) => tableEditActions[index].action = classifyParams(formatParams(action.param)))
    console.log("解析到的表格编辑指令", tableEditActions)

    // 获取上一个表格数据
    const { piece: prePiece } = mesIndex === -1 ? BASE.getLastSheetsPiece(1) : BASE.getLastSheetsPiece(mesIndex - 1, 1000, false)
    const sheets = BASE.hashSheetsToSheets(prePiece.hash_sheets).filter(sheet => sheet.enable)
    console.log("执行指令时的信息", sheets)
    for (const EditAction of sortActions(tableEditActions)) {
        executeAction(EditAction, sheets)
    }
    sheets.forEach(sheet => sheet.save(piece, true))
    console.log("聊天模板：", BASE.sheetsData.context)
    console.log("获取到的表格数据", prePiece)
    console.log("测试总chat", USER.getContext().chat)
    return true
}

/**
 * 直接通过编辑指令字符串执行操作
 * @param {string[]} matches 编辑指令字符串
 */
export function executeTableEditActions(matches, referencePiece) {
    const tableEditActions = handleTableEditTag(matches)
    tableEditActions.forEach((action, index) => tableEditActions[index].action = classifyParams(formatParams(action.param)))
    console.log("解析到的表格编辑指令", tableEditActions)

    // 核心修复：不再信任传入的 referencePiece.hash_sheets，而是直接从 BASE 获取当前激活的、唯一的 Sheet 实例。
    const sheets = BASE.getChatSheets().filter(sheet => sheet.enable)
    if (!sheets || sheets.length === 0) {
        console.error("executeTableEditActions: 未找到任何启用的表格实例，操作中止。");
        return false;
    }

    console.log("执行指令时的信息 (来自 BASE.getChatSheets)", sheets)
    for (const EditAction of sortActions(tableEditActions)) {
        executeAction(EditAction, sheets)
    }
    
    // 核心修复：确保修改被保存到当前最新的聊天片段中。
    const { piece: currentPiece } = USER.getChatPiece();
    if (!currentPiece) {
        console.error("executeTableEditActions: 无法获取当前聊天片段，保存操作失败。");
        return false;
    }
    sheets.forEach(sheet => sheet.save(currentPiece, true))

    console.log("聊天模板：", BASE.sheetsData.context)
    console.log("测试总chat", USER.getContext().chat)
    return true // 返回 true 表示成功
}

/**
 * 执行单个action指令
 */
function executeAction(EditAction, sheets) {
    const action = EditAction.action
    const sheet = sheets[action.tableIndex]
    if (!sheet) {
        console.error("表格不存在，无法执行编辑操作", EditAction);
        return -1;
    }

    // 在所有操作前，深度清理一次action.data
    if (action.data) {
        action.data = fixUnescapedSingleQuotes(action.data);
    }
    switch (EditAction.type) {
        case 'update':
            // 执行更新操作
            const rowIndex = action.rowIndex ? parseInt(action.rowIndex):0
            if(rowIndex >= sheet.getRowCount()-1) return executeAction({...EditAction, type:'insert'}, sheets)
            if(!action?.data) return
            Object.entries(action.data).forEach(([key, value]) => {
                const cell = sheet.findCellByPosition(rowIndex + 1, parseInt(key) + 1)
                if (!cell) return -1
                cell.newAction(Cell.CellAction.editCell, { value }, false)
            })
            break
        case 'insert': {
            // 执行插入操作
            const cell = sheet.findCellByPosition(sheet.getRowCount() - 1, 0)
            if (!cell) return -1
            cell.newAction(Cell.CellAction.insertDownRow, {}, false)
            const lastestRow = sheet.getRowCount() - 1
            const cells = sheet.getCellsByRowIndex(lastestRow)
            if(!cells || !action.data) return
            cells.forEach((cell, index) => {
                if (index === 0) return 
                cell.data.value = action.data[index - 1]
            })
        }
            break
        case 'delete':
            // 执行删除操作
            const deleteRow = parseInt(action.rowIndex) + 1
            const cell = sheet.findCellByPosition(deleteRow, 0)
            if (!cell) return -1
            cell.newAction(Cell.CellAction.deleteSelfRow, {}, false)
            break
    }
    console.log("执行表格编辑操作", EditAction)
    return 1
}


/**
 * 为actions排序
 * @param {Object[]} actions 要排序的actions
 * @returns 排序后的actions
 */
function sortActions(actions) {
    // 定义排序优先级
    const priority = {
        update: 0,
        insert: 1,
        delete: 2
    };
    return actions.sort((a, b) => (priority[a.type] === 2 && priority[b.type] === 2) ? (b.action.rowIndex - a.action.rowIndex) : (priority[a.type] - priority[b.type]));
}

/**
 * 格式化参数
 * @description 将参数数组中的字符串转换为数字或对象
 * @param {string[]} paramArray
 * @returns
 */
function formatParams(paramArray) {
    return paramArray.map(item => {
        const trimmed = item.trim();
        if (!isNaN(trimmed) && trimmed !== "") {
            return Number(trimmed);
        }
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            const parsed = parseLooseDict(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
                Object.keys(parsed).forEach(key => {
                    if (!/^\d+$/.test(key)) {
                        delete parsed[key];
                    }
                });
            }
            return parsed;
        }

        // 其他情况都返回字符串
        return trimmed;
    });
}

/**
 * 分类参数
 * @param {string[]} param 参数
 * @returns {Object} 分类后的参数对象
 */
function classifyParams(param) {
    const action = {};
    for (const key in param) {
        if (typeof param[key] === 'number') {
            if (key === '0') action.tableIndex = param[key]
            else if (key === '1') action.rowIndex = param[key]
        } else if (typeof param[key] === 'object') {
            action.data = param[key]
        }
    }
    return action
}

/**
 * 执行回复中得编辑标签
 * @param {Chat} chat 单个聊天对象
 * @param {number} mesIndex 修改的消息索引
 */
function executeTableEditTag(chat, mesIndex = -1, ignoreCheck = false) {

    // 如果不是最新的消息，则更新接下来的表格
    if (mesIndex !== -1) {
        const { index, chat: nextChat } = findNextChatWhitTableData(mesIndex)
        if (index !== -1) handleEditStrInMessage(nextChat, index, true)
    }
}

/**
 * 干运行获取插入action的插入位置和表格插入更新内容
 */
function dryRunExecuteTableEditTag() {
    // TODO 使用新的Sheet系统处理表格编辑
}

/**
 * 获取生成的操作函数字符串
 * @returns 生成的操作函数字符串
 */
export function getTableEditActionsStr() {
    const tableEditActionsStr = DERIVED.any.tableEditActions.filter(action => action.able && action.type !== 'Comment').map(tableEditAction => tableEditAction.format()).join('\n')
    return "\n<!--\n" + (tableEditActionsStr === '' ? '' : (tableEditActionsStr + '\n')) + '-->\n'
}

/**
 * 替换聊天中的TableEdit标签内的内容
 * @param {*} chat 聊天对象
 */
export function replaceTableEditTag(chat, newContent) {
    // 处理 mes
    if (/<tableEdit>.*?<\/tableEdit>/gs.test(chat.mes)) {
        chat.mes = chat.mes.replace(/<tableEdit>(.*?)<\/tableEdit>/gs, `<tableEdit>${newContent}</tableEdit>`);
    } else {
        chat.mes += `\n<tableEdit>${newContent}</tableEdit>`;
    }
    // 处理 swipes
    if (chat.swipes != null && chat.swipe_id != null)
        if (/<tableEdit>.*?<\/tableEdit>/gs.test(chat.swipes[chat.swipe_id])) {
            chat.swipes[chat.swipe_id] = chat.swipes[chat.swipe_id].replace(/<tableEdit>(.*?)<\/tableEdit>/gs, `<tableEdit>\n${newContent}\n</tableEdit>`);
        } else {
            chat.swipes[chat.swipe_id] += `\n<tableEdit>${newContent}</tableEdit>`;
        }
    USER.getContext().saveChat();
}

/**
 * 读取设置中的注入角色
 * @returns 注入角色
 */
function getMesRole() {
    switch (USER.tableBaseSetting.injection_mode) {
        case 'deep_system':
            return 'system'
        case 'deep_user':
            return 'user'
        case 'deep_assistant':
            return 'assistant'
    }
}

/**
 * 注入表格总体提示词
 * @param {*} eventData
 * @returns
 */
// REPLACE the existing onChatCompletionPromptReady with this updated version
async function onChatCompletionPromptReady(eventData) {
    try {
        if (eventData.dryRun === true ||
            USER.tableBaseSetting.isExtensionAble === false ||
            USER.tableBaseSetting.isAiReadTable === false ||
            USER.tableBaseSetting.injection_mode === "injection_off") {
            return;
        }

        const shortWindow = USER.tableBaseSetting.short_term_memory ?? 2;
        const ctWindow = USER.tableBaseSetting.critical_thinking_memory ?? 1;

        // Keep a reference to the full original chat (UI stays untouched)
        const fullChatForUI = eventData.chat;

        // Collect critical thinking sections from the full chat BEFORE filtering
        const criticalSections = collectLastCriticalThinkingSectionsForPatch(fullChatForUI, ctWindow);
        const latestCritical = criticalSections.length
            ? criticalSections[criticalSections.length - 1]
            : '';

        // Build the reduced conversation ONLY for the model
        // Do NOT mutate source message objects; create shallow copies with stripped content
        let modelConversation = shortWindow > 0
            ? fullChatForUI.slice(-shortWindow)
            : [...fullChatForUI];

        modelConversation = modelConversation.map(msg => {
            // Normalize formats (SillyTavern vs OpenAI style)
            if (msg.content !== undefined) {
                // OpenAI-style
                return {
                    ...msg,
                    content: stripCriticalThinkingBlocksForPatch(msg.content)
                };
            } else if (msg.mes !== undefined) {
                // SillyTavern internal style
                return {
                    ...msg,
                    mes: stripCriticalThinkingBlocksForPatch(msg.mes)
                };
            }
            return msg;
        });

        // Replace eventData.chat ONLY for the outbound prompt
        eventData.chat = modelConversation;

        // Step-by-step branch (unchanged semantics; still inject table-only context)
        if (USER.tableBaseSetting.step_by_step === true) {
            const tableData = getTablePrompt(eventData, true);
            if (tableData) {
                const finalPrompt = `以下是通过表格记录的当前场景信息以及历史记录信息，你需要以此为参考进行思考：\n${tableData}`;
                if (USER.tableBaseSetting.deep === 0) {
                    eventData.chat.push({ role: getMesRole(), content: finalPrompt });
                } else {
                    eventData.chat.splice(
                        Math.max(0, eventData.chat.length - USER.tableBaseSetting.deep),
                        0,
                        { role: getMesRole(), content: finalPrompt }
                    );
                }
            }
            return;
        }

        // Standard mode injection ordering:
        // 1) Aggregated critical thinking history (if any)
        // 2) thinking_template (with <previous_thinking> replaced by latest)
        // 3) message_template (table data)
        const role = getMesRole();

        if (criticalSections.length) {
            eventData.chat.push({
                role,
                content: criticalSections.join('\n')
            });
        }

        const thinkingContent = initThinkingDataPatched(latestCritical);
        if (thinkingContent && thinkingContent.trim()) {
            eventData.chat.push({ role, content: thinkingContent });
        }

        const promptContent = initTableData(eventData);
        if (promptContent && promptContent.trim()) {
            eventData.chat.push({ role, content: promptContent });
        }

        updateSheetsView();
    } catch (error) {
        EDITOR.error(`记忆插件：表格数据注入失败\n原因：`, error.message, error);
    }
    console.log("最终发送给LLM的消息（UI未受影响）:", eventData.chat);
}

// === Helper functions used by the patched handler ===
// (Place them near existing helpers to avoid duplication)

function stripCriticalThinkingBlocksForPatch(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/<critical_thinking>[\s\S]*?<\/critical_thinking>/gi, '').trim();
}

function collectLastCriticalThinkingSectionsForPatch(chatArr, count) {
    if (count <= 0) return [];
    const collected = [];
    for (let i = chatArr.length - 1; i >= 0 && collected.length < count; i--) {
        const c = chatArr[i];
        if (!c || c.is_user) continue;
        const body = typeof c.content === 'string' ? c.content : (typeof c.mes === 'string' ? c.mes : '');
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

function initThinkingDataPatched(previousCriticalSection) {
    try {
        let tpl = USER.tableBaseSetting?.thinking_template || '';
        if (!tpl || typeof tpl !== 'string') return '';
        const replaced = tpl.replace('<previous_thinking>', previousCriticalSection || '');
        return replaceUserTag(replaced);
    } catch (error) {
        EDITOR.error('记忆插件：思考提示词注入失败\n原因：', error.message, error);
        return '';
    }
}

jQuery(async () => {
    // 注册API
    window.stMemoryEnhancement = {
        ext_getAllTables,
        ext_exportAllTablesAsJson,
        VERSION,
    };

    // 版本检查
    fetch("http://api.muyoo.com.cn/check-version", {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientVersion: VERSION, user: USER.getContext().name1 })
    }).then(res => res.json()).then(res => {
        if (res.success) {
            if (!res.isLatest) {
                $("#tableUpdateTag").show()
                $("#setting_button_new_tag").show() // 显示设置按钮的New标记
            }
            if (res.toastr) EDITOR.warning(res.toastrText)
            if (res.message) $("#table_message_tip").html(res.message)
        }
    })

    $('.extraMesButtons').append('<div title="查看表格" class="mes_button open_table_by_id">表格</div>');

    // 分离手机和电脑事件
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        console.log("手机端")
        // 手机端事件
    } else {
        console.log("电脑端")
        // 电脑端事件
        initTest();
    }

    // 开始添加各部分的根DOM
    // 添加表格编辑工具栏
    $('#translation_container').after(await SYSTEM.getTemplate('index'));
    // 添加顶部表格管理工具弹窗
    $('#extensions-settings-button').after(await SYSTEM.getTemplate('appHeaderTableDrawer'));

    // 应用程序启动时加载设置
    loadSettings();

    // 表格弹出窗
    $(document).on('click', '.open_table_by_id', function () {
        const messageId = parseInt($(this).closest('.mes').attr('mesid'))
        if (USER.getContext().chat[messageId].is_user === true) {
            toastr.warning('用户消息不支持表格编辑')
            return
        }
        BASE.refreshContextView(messageId)
        openDrawer()
    })

    // 注册宏
    USER.getContext().registerMacro("tablePrompt", () =>getMacroPrompt())
    USER.getContext().registerMacro("tableData", () =>getMacroTablePrompt())
    USER.getContext().registerMacro("GET_ALL_TABLES_JSON", () => {
        try {
            const jsonData = ext_exportAllTablesAsJson();
            if (Object.keys(jsonData).length === 0) {
                return "{}"; // 如果没有数据，返回一个空的JSON对象
            }
            // 返回JSON字符串，不带额外的格式化，以便在代码中直接使用
            return JSON.stringify(jsonData);
        } catch (error) {
            console.error("GET_ALL_TABLES_JSON 宏执行出错:", error);
            EDITOR.error("导出所有表格数据时出错。","",error);
            return "{}"; // 出错时返回空JSON对象
        }
    });

    // 设置表格编辑按钮
    console.log("设置表格编辑按钮", applicationFunctionManager.doNavbarIconClick)
    if (isDrawerNewVersion()) {
        $('#table_database_settings_drawer .drawer-toggle').on('click', applicationFunctionManager.doNavbarIconClick);
    }else{
        $('#table_drawer_content').attr('data-slide-toggle', 'hidden').css('display', 'none');
        $('#table_database_settings_drawer .drawer-toggle').on('click', openAppHeaderTableDrawer);
    }
    // // 设置表格编辑按钮
    // $(document).on('click', '.tableEditor_editButton', function () {
    //     let index = $(this).data('index'); // 获取当前点击的索引
    //     openTableSettingPopup(index);
    // })
    // 点击表格渲染样式设置按钮
    $(document).on('click', '.tableEditor_renderButton', function () {
        openTableRendererPopup();
    })
    // 点击打开查看表格日志按钮
    $(document).on('click', '#table_debug_log_button', function () {
        openTableDebugLogPopup();
    })
    // 对话数据表格弹出窗
    $(document).on('click', '.open_table_by_id', function () {
        const messageId = $(this).closest('.mes').attr('mesid');
        initRefreshTypeSelector();
    })
    // 设置表格开启开关
    $(document).on('change', '.tableEditor_switch', function () {
        let index = $(this).data('index'); // 获取当前点击的索引
        const tableStructure = findTableStructureByIndex(index);
        tableStructure.enable = $(this).prop('checked');
    })

    initAppHeaderTableDrawer().then();  // 初始化表格编辑器
    functionToBeRegistered()    // 注册用于调试的各种函数

    executeTranslation(); // 执行翻译函数

    // 监听主程序事件
    APP.eventSource.on(APP.event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    APP.eventSource.on(APP.event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    APP.eventSource.on(APP.event_types.CHAT_CHANGED, onChatChanged);
    APP.eventSource.on(APP.event_types.MESSAGE_EDITED, onMessageEdited);
    APP.eventSource.on(APP.event_types.MESSAGE_SWIPED, onMessageSwiped);
    APP.eventSource.on(APP.event_types.MESSAGE_DELETED, onChatChanged);

    
    console.log("______________________记忆插件：加载完成______________________")
});
