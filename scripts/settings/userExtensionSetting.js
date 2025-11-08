import { BASE, DERIVED, EDITOR, SYSTEM, USER } from '../../core/manager.js';
import { updateSystemMessageTableStatus, updateAlternateTable } from "../renderer/tablePushToChat.js";
import { rebuildSheets, modifyRebuildTemplate, newRebuildTemplate, deleteRebuildTemplate, exportRebuildTemplate, importRebuildTemplate, triggerStepByStepNow } from "../runtime/absoluteRefresh.js";
import { generateDeviceId } from "../../utils/utility.js";
import { updateModelList, handleApiTestRequest, processApiKey } from "./standaloneAPI.js";
import { filterTableDataPopup } from "../../data/pluginSetting.js";
import { initRefreshTypeSelector } from "../runtime/absoluteRefresh.js";
import { rollbackVersion } from "../../services/debugs.js";
import { customSheetsStylePopup } from "../editor/customSheetsStyle.js";
import { openAppHeaderTableDrawer } from "../renderer/appHeaderTableBaseDrawer.js";
import { buildSheetsByTemplates } from "../../index.js"

/**
 * 格式化深度设置
 */
function formatDeep() {
    USER.tableBaseSetting.deep = Math.abs(USER.tableBaseSetting.deep)
}

/**
 * 更新设置中的开关状态
 */
function updateSwitch(selector, switchValue) {
    if (switchValue) {
        $(selector).prop('checked', true);
    } else {
        $(selector).prop('checked', false);
    }
}

/**
 * 更新设置中的表格结构DOM
 */
function updateTableView() {
    const show_drawer_in_extension_list = USER.tableBaseSetting.show_drawer_in_extension_list;
    const extensionsMenu = document.querySelector('#extensionsMenu');
    const show_settings_in_extension_menu = USER.tableBaseSetting.show_settings_in_extension_menu;
    const alternate_switch = USER.tableBaseSetting.alternate_switch;
    const extensions_settings = document.querySelector('#extensions_settings');

    if (show_drawer_in_extension_list === true) {
        // 如果不存在则创建
        if (document.querySelector('#drawer_in_extension_list_button')) return
        $(extensionsMenu).append(`
<div id="drawer_in_extension_list_button" class="list-group-item flex-container flexGap5 interactable">
    <div class="fa-solid fa-table extensionsMenuExtensionButton"></div>
    <span>增强记忆表格</span>
</div>
`);
        // 设置点击事件
        $('#drawer_in_extension_list_button').on('click', () => {
            // $('#table_drawer_icon').click()
            openAppHeaderTableDrawer('database');
        });
    } else {
        document.querySelector('#drawer_in_extension_list_button')?.remove();
    }

    //     if (show_drawer_in_extension_list === true) {
    //         // 如果不存在则创建
    //         if (document.querySelector('#drawer_in_extension_list_button')) return
    //         $(extensions_settings).append(`
    // <div id="drawer_in_extension_list_button" class="list-group-item flex-container flexGap5 interactable">
    // </div>
    // `);
    //     } else {
    //
    //     }
}

function getSheetsCellStyle() {
    const style = document.createElement('style');  // 为 sheetContainer 的内容添加一个 style
    // 获取 sheetContainer 元素
    const cellWidth = USER.tableBaseSetting.table_cell_width_mode
    let sheet_cell_style_container = document.querySelector('#sheet_cell_style_container');
    if (sheet_cell_style_container) {
        // 清空现有的样式
        sheet_cell_style_container.innerHTML = '';
    } else {
        // 创建一个新的 sheet_cell_style_container 元素
        sheet_cell_style_container = document.createElement('div');
        sheet_cell_style_container.id = 'sheet_cell_style_container';
        document.body.appendChild(sheet_cell_style_container);
    }
    switch (cellWidth) {
        case 'single_line':
            style.innerHTML = ``;
            break;
        case 'wide1_cell':
            style.innerHTML = ` tr .sheet-cell { max-width: 800px !important; white-space: normal !important; } `;
            break;
        case 'wide1_2_cell':
            style.innerHTML = ` tr .sheet-cell { max-width: 400px !important; white-space: normal !important; } `;
            break;
        case 'wide1_4_cell':
            style.innerHTML = ` tr .sheet-cell { max-width: 200px !important; white-space: normal !important; } `;
            break;
    }
    sheet_cell_style_container.appendChild(style);
}

/**
 * 将表格结构转为设置DOM
 * @param {object} tableStructure 表格结构
 * @returns 设置DOM
 */
function tableStructureToSettingDOM(tableStructure) {
    const tableIndex = tableStructure.tableIndex;
    const $item = $('<div>', { class: 'dataTable_tableEditor_item' });
    const $index = $('<div>').text(`#${tableIndex}`); // 编号
    const $input = $('<div>', {
        class: 'tableName_pole margin0',
    });
    $input.text(tableStructure.tableName);
    const $checkboxLabel = $('<label>', { class: 'checkbox' });
    const $checkbox = $('<input>', { type: 'checkbox', 'data-index': tableIndex, checked: tableStructure.enable, class: 'tableEditor_switch' });
    $checkboxLabel.append($checkbox, '启用');
    const $editButton = $('<div>', {
        class: 'menu_button menu_button_icon fa-solid fa-pencil tableEditor_editButton',
        title: '编辑',
        'data-index': tableIndex, // 绑定索引
    }).text('编辑');
    $item.append($index, $input, $checkboxLabel, $editButton);
    return $item;
}

/**
 * 导入插件设置
 */
async function importTableSet() {
    // 创建一个 input 元素，用于选择文件
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json'; // 限制文件类型为 JSON

    // 监听 input 元素的 change 事件，当用户选择文件后触发
    input.addEventListener('change', async (event) => {
        const file = event.target.files[0]; // 获取用户选择的文件

        if (!file) {
            return; // 用户未选择文件，直接返回
        }

        const reader = new FileReader(); // 创建 FileReader 对象来读取文件内容

        reader.onload = async (e) => {
            try {
                const importedData = JSON.parse(e.target.result); // 解析 JSON 文件内容

                // 获取导入 JSON 的第一级 key
                const firstLevelKeys = Object.keys(importedData);

                // 构建展示第一级 key 的 HTML 结构
                let keyListHTML = '<ul>';
                firstLevelKeys.forEach(key => {
                    keyListHTML += `<li>${key}</li>`;
                });
                keyListHTML += '</ul>';

                const tableInitPopup = $(`<div>
                    <p>即将导入的设置项 (第一级):</p>
                    ${keyListHTML}
                    <p>是否继续导入并重置这些设置？</p>
                </div>`);

                const confirmation = await EDITOR.callGenericPopup(tableInitPopup, EDITOR.POPUP_TYPE.CONFIRM, '导入设置确认', { okButton: "继续导入", cancelButton: "取消" });
                if (!confirmation) return; // 用户取消导入

                // 用户确认导入后，进行数据应用
                // 注意：这里假设你需要将 importedData 的所有内容都合并到 USER.tableBaseSetting 中
                // 你可能需要根据实际需求调整数据合并逻辑，例如只合并第一级 key 对应的数据，或者进行更细粒度的合并
                for (let key in importedData) {
                    USER.tableBaseSetting[key] = importedData[key];
                }

                renderSetting(); // 重新渲染设置界面，应用新的设置
                // 重新转换模板
                initTableStructureToTemplate()
                BASE.refreshTempView(true) // 刷新模板视图
                EDITOR.success('导入成功并已重置所选设置'); // 提示用户导入成功

                // [新增] 若当前会话中的表数据“全部为空”，则清空 chat 域并用全局模板覆盖到 chat 域
                try {
                    const { piece } = USER.getChatPiece() || {};
                    // 判定：若无载体则跳过（无法保存到聊天记录）
                    if (piece) {
                        // 先征询用户确认再执行替换
                        const confirmReplace = await EDITOR.callGenericPopup(
                            '是否替换掉当前聊天的模板（重要提示：替换会清空此聊天的旧表格数据且无法找回）',
                            EDITOR.POPUP_TYPE.CONFIRM,
                            '替换模板确认',
                            { okButton: '清空并采用预设表格', cancelButton: '不替换' }
                        );
                        if (!confirmReplace) {
                            EDITOR.success && EDITOR.success('已取消模板替换');
                        } else {
                            BASE.sheetsData.context = {}; // 清空 chat 域并用全局模板重建
                            // 删除聊天列表中所有 piece 的 hash_sheets
                            try {
                                const chatArr = USER.getContext()?.chat || [];
                                for (const msg of chatArr) {
                                    if (msg && Object.prototype.hasOwnProperty.call(msg, 'hash_sheets')) {
                                        delete msg.hash_sheets;
                                    }
                                }
                            } catch (_) { }
                            // 在当前载体上用全局模板重建
                            buildSheetsByTemplates(piece);
                            // 刷新界面与系统消息
                            BASE.refreshContextView();
                            BASE.refreshTempView(true)
                            updateSystemMessageTableStatus(true);
                            EDITOR.success('已用全局模板覆盖到 chat 域');
                        }
                    } else {
                        // 无载体时给出明确提示
                        EDITOR.warning('因为当前聊天没有聊天载体所以跳过预设表格模板替换');
                    }
                } catch (e) {
                    // 静默失败，不影响导入主流程
                    console.warn('[Preset Import] 覆盖 chat 域模板时发生非致命错误：', e);
                }

            } catch (error) {
                EDITOR.error('JSON 文件解析失败，请检查文件格式是否正确。', error.message, error); // 提示 JSON 解析失败
                console.error("文件读取或解析错误:", error); // 打印详细错误信息到控制台
            }
        };

        reader.onerror = (error) => {
            EDITOR.error(`文件读取失败`, error.message, error); // 提示文件读取失败
        };

        reader.readAsText(file); // 以文本格式读取文件内容
    });

    input.click(); // 模拟点击 input 元素，弹出文件选择框
}


/**
 * 导出插件设置
 */
async function exportTableSet() {
    templateToTableStructure()
    const { filterData, confirmation } = await filterTableDataPopup(USER.tableBaseSetting, "请选择需要导出的数据", "")
    if (!confirmation) return;

    try {
        const blob = new Blob([JSON.stringify(filterData)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a')
        a.href = url;
        a.download = `tableCustomConfig-${SYSTEM.generateRandomString(8)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        EDITOR.success('导出成功');
    } catch (error) {
        EDITOR.error(`导出失败`, error.message, error);
    }
}

/**
 * 重置设置
 */
async function resetSettings() {
    const { filterData, confirmation } = await filterTableDataPopup(USER.tableBaseDefaultSettings, "请选择需要重置的数据", "建议重置前先备份数据")
    if (!confirmation) return;

    try {
        for (let key in filterData) {
            USER.tableBaseSetting[key] = filterData[key]
        }
        renderSetting()
        if ('tableStructure' in filterData) {
            initTableStructureToTemplate()
            BASE.refreshTempView(true)
        }
        EDITOR.success('已重置所选设置');
    } catch (error) {
        EDITOR.error(`重置设置失败`, error.message, error);
    }
}

function ensureShortTermMemoryField() {
    // Already exists?
    if ($('#dataTable_short_term_memory').length) {
        $('#dataTable_short_term_memory').val(USER.tableBaseSetting.short_term_memory ?? 2);
        return;
    }

    const $deepInput = $('#dataTable_deep');
    if (!$deepInput.length) {
        console.warn('[Short-term memory] #dataTable_deep not found yet.');
        return;
    }

    // Find a reasonable "row" container to clone positioning logic from.
    // Adjust selectors to match your existing setting row containers if needed.
    const $rowContainer =
        $deepInput.closest('.setting-item, .flex-container, .row, .formRow, div');

    if (!$rowContainer.length) {
        console.warn('[Short-term memory] Could not locate a container for #dataTable_deep, aborting injection.');
        return;
    }

    // Make sure parent flex can wrap so the new row breaks to next line instead of squeezing inline
    const $parent = $rowContainer.parent();
    if ($parent.length && $parent.css('display') === 'flex' && $parent.css('flex-wrap') === 'nowrap') {
        $parent.css('flex-wrap', 'wrap');
    }

    // Build a new full-width row BELOW the existing depth row
    const $newRow = $(`
        <div class="short-term-memory-row" style="
            display:flex;
            align-items:center;
            gap:8px;
            margin-top:6px;
            width:100%;
            flex-basis:100%;
        ">
            <label for="dataTable_short_term_memory" style="white-space:nowrap;">Short-term memory</label>
            <input id="dataTable_short_term_memory"
                   type="number"
                   min="1"
                   class="${$deepInput.attr('class') || 'text_pole'}"
                   style="max-width:140px;"
                   value="${USER.tableBaseSetting.short_term_memory ?? 2}" />
        </div>
    `);

    // Insert AFTER the whole depth row container so it appears on the next line
    $rowContainer.after($newRow);
    console.log('[Short-term memory] Field injected below depth field.');
}

function ensureCriticalThinkingMemoryField() {
    if ($('#dataTable_critical_thinking_memory').length) {
        $('#dataTable_critical_thinking_memory').val(USER.tableBaseSetting.critical_thinking_memory ?? 1);
        return;
    }
    const $stmRow = $('.short-term-memory-row');
    if (!$stmRow.length) return;

    const $newRow = $(`
        <div class="critical-thinking-memory-row" style="
            display:flex;
            align-items:center;
            gap:8px;
            margin-top:6px;
            width:100%;
            flex-basis:100%;
        ">
            <label for="dataTable_critical_thinking_memory" style="white-space:nowrap;">Critical-thinking memory</label>
            <input id="dataTable_critical_thinking_memory"
                   type="number"
                   min="0"
                   class="text_pole"
                   style="max-width:140px;"
                   value="${USER.tableBaseSetting.critical_thinking_memory ?? 1}" />
        </div>
    `);
    $stmRow.after($newRow);
}
// Update ensureRagFieldsRow guard to avoid reinjection unless all IDs exist
function ensureRagFieldsRow() {
    // No-op if all present (static template covers this case)
    if ($('#enable_rag').length && $('#rag_similarity').length && $('#rag_top_k').length && $('#rag_depth').length) return;

    // Fallback injection if needed (kept defensive)
    const $anchor = $('#dataTable_short_term_memory').closest('div').parent();
    if (!$anchor.length) return;

    const topK = USER.tableBaseSetting.rag_top_k ?? 3;
    const depth = USER.tableBaseSetting.rag_depth ?? 1;
    const sim = (USER.tableBaseSetting.rag_similarity ?? 0.25).toFixed(2);

    const $row = $(`
        <div class="rag-row" style="display:flex; align-items:center; gap:8px; margin-top:6px; width:100%; flex-basis:100%;">
            <label class="checkbox_label range-block justifyLeft" style="display:flex; align-items:center; gap:6px; margin:0;">
                <input type="checkbox" id="enable_rag"><span>Enable Rag</span>
            </label>
            <label for="rag_similarity" style="white-space:nowrap; margin-left:10px;">rag_similarity</label>
            <input id="rag_similarity" type="range" min="0" max="1" step="0.01" style="width:180px;" value="${sim}">
            <code id="rag_similarity_value" style="min-width:40px; text-align:center;">${sim}</code>
            <label for="rag_top_k" style="white-space:nowrap; margin-left:10px;">top_k</label>
            <input id="rag_top_k" type="number" min="1" max="50" value="${topK}" class="text_pole" style="width:70px;">
            <label for="rag_depth" style="white-space:nowrap; margin-left:10px;">rag_depth</label>
            <input id="rag_depth" type="number" min="1" max="10" value="${depth}" class="text_pole" style="width:70px;">
        </div>
    `);
    $anchor.after($row);
}
function InitBinging() {
    console.log('初始化绑定')
    // 开始绑定事件
    // 导入预设
    $('#table-set-import').on('click', () => importTableSet());
    // 导出
    $("#table-set-export").on('click', () => exportTableSet());
    // 重置设置
    $("#table-reset").on('click', () => resetSettings());
    // 回退表格2.0到1.0
    $("#table-init-from-2-to-1").on('click', async () => {
        if (await rollbackVersion() === true) {
            window.location.reload()
        }
    });
    // 插件总体开关 - FIXED: Added $ for jQuery selector
    $('#table_switch').change(function () {
        USER.tableBaseSetting.isExtensionAble = this.checked;
        EDITOR.success(this.checked ? '插件已开启' : '插件已关闭，可以打开和手动编辑表格但AI不会读表和生成');
        updateSystemMessageTableStatus();   // 将表格数据状态更新到系统消息中
    });
    // 调试模式开关
    $('#table_switch_debug_mode').change(function () {
        USER.tableBaseSetting.tableDebugModeAble = this.checked;
        EDITOR.success(this.checked ? '调试模式已开启' : '调试模式已关闭');
    });
    // 插件读表开关
    $('#table_read_switch').change(function () {
        USER.tableBaseSetting.isAiReadTable = this.checked;
        EDITOR.success(this.checked ? 'AI现在会读取表格' : 'AI现在将不会读表');
    });
    // 插件写表开关
    $('#table_edit_switch').change(function () {
        USER.tableBaseSetting.isAiWriteTable = this.checked;
        EDITOR.success(this.checked ? 'AI的更改现在会被写入表格' : 'AI的更改现在不会被写入表格');
    });

    // 表格插入模式
    $('#dataTable_injection_mode').change(function (event) {
        USER.tableBaseSetting.injection_mode = event.target.value;
    });
    $("#fill_table_time").change(function () {
        const value = $(this).val();
        const step_by_step = value === 'after'
        $('#reply_options').toggle(!step_by_step);
        $('#step_by_step_options').toggle(step_by_step);
        USER.tableBaseSetting.step_by_step = step_by_step;
    })
    // 确认执行
    $('#confirm_before_execution').change(function () {
        USER.tableBaseSetting.confirm_before_execution = $(this).prop('checked');
    })
    // //整理表格相关高级设置
    // $('#advanced_settings').change(function() {
    //     $('#advanced_options').toggle(this.checked);
    //     USER.tableBaseSetting.advanced_settings = this.checked;
    // });
    // 忽略删除
    $('#ignore_del').change(function () {
        USER.tableBaseSetting.bool_ignore_del = $(this).prop('checked');
    });
    // 忽略用户回复
    $('#ignore_user_sent').change(function () {
        USER.tableBaseSetting.ignore_user_sent = $(this).prop('checked');
    });
    // // 强制刷新
    // $('#bool_force_refresh').change(function() {
    //     USER.tableBaseSetting.bool_force_refresh = $(this).prop('checked');
    // });
    // 静默刷新
    $('#bool_silent_refresh').change(function () {
        USER.tableBaseSetting.bool_silent_refresh = $(this).prop('checked');
    });
    //token限制代替楼层限制
    $('#use_token_limit').change(function () {
        $('#token_limit_container').toggle(this.checked);
        $('#clear_up_stairs_container').toggle(!this.checked);
        USER.tableBaseSetting.use_token_limit = this.checked;
    });
    // 初始化API设置显示状态
    $('#use_main_api').change(function () {
        USER.tableBaseSetting.use_main_api = this.checked;
    });
    // 初始化API设置显示状态
    $('#step_by_step_use_main_api').change(function () {
        USER.tableBaseSetting.step_by_step_use_main_api = this.checked;
    });
    // 根据下拉列表选择的模型更新自定义模型名称
    $('#model_selector').change(function (event) {
        $('#custom_model_name').val(event.target.value);
        USER.IMPORTANT_USER_PRIVACY_DATA.custom_model_name = event.target.value;
        USER.saveSettings && USER.saveSettings(); // 保存设置
    });
    // 表格推送至对话开关
    $('#table_to_chat').change(function () {
        USER.tableBaseSetting.isTableToChat = this.checked;
        EDITOR.success(this.checked ? '表格会被推送至对话中' : '关闭表格推送至对话');
        $('#table_to_chat_options').toggle(this.checked);
        updateSystemMessageTableStatus();   // 将表格数据状态更新到系统消息中
    });
    // 在扩展菜单栏中显示表格设置开关
    $('#show_settings_in_extension_menu').change(function () {
        USER.tableBaseSetting.show_settings_in_extension_menu = this.checked;
        updateTableView();
    });
    // 在扩展菜单栏中显示穿插模型设置开关
    $('#alternate_switch').change(function () {
        USER.tableBaseSetting.alternate_switch = this.checked;
        EDITOR.success(this.checked ? '开启表格渲染穿插模式' : '关闭表格渲染穿插模式');
        updateTableView();
        updateAlternateTable();
    });
    // 在扩展列表显示表格设置
    $('#show_drawer_in_extension_list').change(function () {
        USER.tableBaseSetting.show_drawer_in_extension_list = this.checked;
        updateTableView();
    });
    // 推送至前端的表格数据可被编辑
    $('#table_to_chat_can_edit').change(function () {
        USER.tableBaseSetting.table_to_chat_can_edit = this.checked;
        updateSystemMessageTableStatus();   // 将表格数据状态更新到系统消息中
    });
    // 根据下拉列表选择表格推送位置
    $('#table_to_chat_mode').change(function (event) {
        USER.tableBaseSetting.table_to_chat_mode = event.target.value;
        $('#table_to_chat_is_micro_d').toggle(event.target.value === 'macro');
        updateSystemMessageTableStatus();   // 将表格数据状态更新到系统消息中
    });

    // 根据下拉列表选择表格推送位置
    $('#table_cell_width_mode').change(function (event) {
        USER.tableBaseSetting.table_cell_width_mode = event.target.value;
        getSheetsCellStyle()
    });


    // API URL
    $('#custom_api_url').on('input', function () {
        USER.IMPORTANT_USER_PRIVACY_DATA.custom_api_url = $(this).val();
        USER.saveSettings && USER.saveSettings(); // 保存设置
    });
    // API KEY
    let apiKeyDebounceTimer;
    $('#custom_api_key').on('input', function () {
        clearTimeout(apiKeyDebounceTimer);
        apiKeyDebounceTimer = setTimeout(async () => {
            try {
                const rawKey = $(this).val();
                const result = processApiKey(rawKey, generateDeviceId());
                USER.IMPORTANT_USER_PRIVACY_DATA.custom_api_key = result.encryptedResult.encrypted || result.encryptedResult;
                USER.saveSettings && USER.saveSettings(); // 保存设置
                EDITOR.success(result.message);
            } catch (error) {
                console.error('API Key 处理失败:', error);
                EDITOR.error('未能获取到API KEY，请重新输入~', error.message, error);
            }
        }, 500); // 500ms防抖延迟
    })
    // 模型名称
    $('#custom_model_name').on('input', function () {
        USER.IMPORTANT_USER_PRIVACY_DATA.custom_model_name = $(this).val();
        USER.saveSettings && USER.saveSettings(); // 保存设置
    });
    // 表格消息模板
    $('#dataTable_message_template').on("input", function () {
        const value = $(this).val();
        USER.tableBaseSetting.message_template = value;
    })
    $(document).on('change', '#enable_narration_stage', function () {
        USER.tableBaseSetting.enable_narration_stage = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $(document).on('change', '#enable_thinking_stage', function () {
        USER.tableBaseSetting.enable_thinking_stage = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $(document).on('change', '#enable_main_stage', function () {
        USER.tableBaseSetting.enable_main_stage = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $(document).on('change', '#enable_long_term_summary_stage', function () {
        USER.tableBaseSetting.enable_long_term_summary_stage = this.checked;
        USER.saveSettings && USER.saveSettings();
    });

    function syncStageToggleUI() {
        const S = USER.tableBaseSetting || {};
        $('#enable_narration_stage').prop('checked', S.enable_narration_stage !== false);
        $('#enable_thinking_stage').prop('checked', S.enable_thinking_stage !== false);
        $('#enable_main_stage').prop('checked', S.enable_main_stage !== false);
        $('#enable_long_term_summary_stage').prop('checked', S.enable_long_term_summary_stage !== false);
    }
    syncStageToggleUI();

    $('#dataTable_thinking_template').on('input', function () {
        USER.tableBaseSetting.thinking_template = $(this).val();
    });
    $('#dataTable_narration_template').on('input', function () {
        USER.tableBaseSetting.narration_template = $(this).val();
    });
    $('#dataTable_main_response_template').on('input', function () {
        USER.tableBaseSetting.main_response_template = $(this).val();
    });
    $('#dataTable_long_term_summary_template').on('input', function () {
        USER.tableBaseSetting.long_term_summary_template = $(this).val();
    });
    // 表格深度
    $('#dataTable_deep').on("input", function () {
        const value = $(this).val();
        USER.tableBaseSetting.deep = Math.abs(value);
    })
    // Remove any older direct binding logic for #dataTable_short_term_memory if present
    $(document).off('input.shortTermMemory');

    // Delegated binding to survive dynamic re-renders
    $(document).on('input.shortTermMemory', '#dataTable_short_term_memory', function () {
        let v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        this.value = v;
        USER.tableBaseSetting.short_term_memory = v;
        USER.saveSettings && USER.saveSettings();
    });
    $(document).off('input.criticalThinkingMemory').on('input.criticalThinkingMemory', '#dataTable_critical_thinking_memory', function () {
        let v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        this.value = v;
        USER.tableBaseSetting.critical_thinking_memory = v;
        USER.saveSettings && USER.saveSettings();
    });
    // Bind RAG controls (after rendering)
    bindRagEvents();
    // 分步填表提示词
    $('#step_by_step_user_prompt').on('input', function () {
        USER.tableBaseSetting.step_by_step_user_prompt = $(this).val();
    });
    // 分步填表读取的上下文层数
    $('#separateReadContextLayers').on('input', function () {
        USER.tableBaseSetting.separateReadContextLayers = Number($(this).val());
    });
    // 分步填表是否读取世界书
    $('#separateReadLorebook').change(function () {
        USER.tableBaseSetting.separateReadLorebook = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    // 重置分步填表提示词为默认值
    $('#reset_step_by_step_user_prompt').on('click', function () {
        const defaultValue = USER.tableBaseDefaultSettings.step_by_step_user_prompt;
        $('#step_by_step_user_prompt').val(defaultValue);
        // 同样更新内存中的设置
        USER.tableBaseSetting.step_by_step_user_prompt = defaultValue;
        EDITOR.success('分步填表提示词已重置为默认值。');
    });
    // 清理聊天记录楼层
    $('#clear_up_stairs').on('input', function () {
        const value = $(this).val();
        $('#clear_up_stairs_value').text(value);
        USER.tableBaseSetting.clear_up_stairs = Number(value);
    });
    // token限制
    $('#rebuild_token_limit').on('input', function () {
        const value = $(this).val();
        $('#rebuild_token_limit_value').text(value);
        USER.tableBaseSetting.rebuild_token_limit_value = Number(value);
    });
    // 模型温度设定
    $('#custom_temperature').on('input', function () {
        const value = $(this).val();
        $('#custom_temperature_value').text(value);
        USER.tableBaseSetting.custom_temperature = Number(value);
    });

    // 代理地址
    $('#table_proxy_address').on('input', function () {
        USER.IMPORTANT_USER_PRIVACY_DATA.table_proxy_address = $(this).val();
        USER.saveSettings && USER.saveSettings(); // 保存设置
    });
    // 代理密钥
    $('#table_proxy_key').on('input', function () {
        USER.IMPORTANT_USER_PRIVACY_DATA.table_proxy_key = $(this).val();
        USER.saveSettings && USER.saveSettings(); // 保存设置
    });

    // 获取模型列表
    $('#fetch_models_button').on('click', updateModelList);

    // 测试API
    $(document).on('click', '#table_test_api_button', async () => {
        const apiUrl = $('#custom_api_url').val();
        const modelName = $('#custom_model_name').val();
        const encryptedApiKeys = USER.IMPORTANT_USER_PRIVACY_DATA.custom_api_key;
        const results = await handleApiTestRequest(apiUrl, encryptedApiKeys, modelName);
    });

    // 开始整理表格
    $("#table_clear_up").on('click', () => {
        rebuildSheets()
    });

    // 完整重建表格（合并到上面的下拉框内）
    // $('#rebuild_table').on('click', () => rebuildTableActions(USER.tableBaseSetting.bool_force_refresh, USER.tableBaseSetting.bool_silent_refresh));

    // 表格推送至对话
    $("#dataTable_to_chat_button").on("click", async function () {
        customSheetsStylePopup()
    })

    // 重整理模板编辑
    $("#rebuild--set-rename").on("click", modifyRebuildTemplate)
    $("#rebuild--set-new").on("click", newRebuildTemplate)
    $("#rebuild--set-delete").on("click", deleteRebuildTemplate)
    $("#rebuild--set-export").on("click", exportRebuildTemplate)
    $("#rebuild--set-import").on("click", importRebuildTemplate)
    $('#rebuild--select').on('change', function () {
        USER.tableBaseSetting.lastSelectedTemplate = $(this).val();
        USER.saveSettings && USER.saveSettings();
    });

    // 手动触发分步填表
    $(document).on('click', '#trigger_step_by_step_button', () => {
        triggerStepByStepNow();
    });

}


// Call bindRagEvents after UI render (ensure it’s in InitBinging)
function bindRagEvents() {
    $('#enable_rag').off('change.rag').on('change.rag', function () {
        USER.tableBaseSetting.enable_rag = this.checked;
        USER.saveSettings && USER.saveSettings();
        if (this.checked) {
            try { window.ST_RAG?.vectorizeAllIfNeeded(); } catch { }
            EDITOR.success('RAG enabled');
        } else {
            EDITOR.success('RAG disabled');
        }
    });

    $('#rag_similarity').off('input.rag change.rag').on('input.rag change.rag', function () {
        const v = Math.max(0, Math.min(1, parseFloat(this.value)));
        USER.tableBaseSetting.rag_similarity = isNaN(v) ? 0.25 : v;
        $('#rag_similarity_value').text(USER.tableBaseSetting.rag_similarity.toFixed(2));
        USER.saveSettings && USER.saveSettings();
    });

    $('#rag_top_k').off('input.rag change.rag').on('input.rag change.rag', function () {
        let v = parseInt(this.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        if (v > 50) v = 50;
        this.value = v;
        USER.tableBaseSetting.rag_top_k = v;
        USER.saveSettings && USER.saveSettings();
    });

    $('#rag_depth').off('input.rag change.rag').on('input.rag change.rag', function () {
        let v = parseInt(this.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        if (v > 10) v = 10;
        this.value = v;
        USER.tableBaseSetting.rag_depth = v;
        USER.saveSettings && USER.saveSettings();
    });
}
/**
 * 渲染设置
 */
export function renderSetting() {
    // 初始化数值
    $(`#dataTable_injection_mode option[value="${USER.tableBaseSetting.injection_mode}"]`).prop('selected', true);
    $(`#table_to_chat_mode option[value="${USER.tableBaseSetting.table_to_chat_mode}"]`).prop('selected', true);
    $(`#table_cell_width_mode option[value="${USER.tableBaseSetting.table_cell_width_mode}"]`).prop('selected', true);
    $('#dataTable_message_template').val(USER.tableBaseSetting.message_template);
    $('#dataTable_thinking_template').val(USER.tableBaseSetting.thinking_template || '');
    $('#dataTable_narration_template').val(USER.tableBaseSetting.narration_template || '');
    $('#dataTable_main_response_template').val(USER.tableBaseSetting.main_response_template || '');
    $('#dataTable_long_term_summary_template').val(USER.tableBaseSetting.long_term_summary_template || '');

    $('#dataTable_deep').val(USER.tableBaseSetting.deep);
    ensureShortTermMemoryField();
    ensureCriticalThinkingMemoryField();
    ensureRagFieldsRow();

    // Initialize RAG values
    updateSwitch('#enable_rag', USER.tableBaseSetting.enable_rag === true);
    $('#rag_similarity').val(USER.tableBaseSetting.rag_similarity ?? 0.25);
    $('#rag_similarity_value').text((USER.tableBaseSetting.rag_similarity ?? 0.25).toFixed(2));
    updateSwitch('#enable_rag', USER.tableBaseSetting.enable_rag === true);
    $('#rag_similarity').val(USER.tableBaseSetting.rag_similarity ?? 0.25);
    $('#rag_similarity_value').text((USER.tableBaseSetting.rag_similarity ?? 0.25).toFixed(2));

    // Initialize new fields
    $('#rag_top_k').val(USER.tableBaseSetting.rag_top_k ?? 3);
    $('#rag_depth').val(USER.tableBaseSetting.rag_depth ?? 1);

    //// New: top_k and depth defaults
    //const topK = USER.tableBaseSetting.rag_top_k ?? 3;
    //const depth = USER.tableBaseSetting.rag_depth ?? 1;
    //$('#rag_top_k').val(topK);
    //$('#rag_depth').val(depth);

    $('#dataTable_short_term_memory').val(USER.tableBaseSetting.short_term_memory ?? 2);
    $('#dataTable_critical_thinking_memory').val(USER.tableBaseSetting.critical_thinking_memory ?? 1);

    // 2. In InitBinging() add (near other input bindings):
    $('#dataTable_short_term_memory').on('input', function () {
        let v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        this.value = v;
        USER.tableBaseSetting.short_term_memory = v;
        USER.saveSettings && USER.saveSettings();
    });
    $('#dataTable_critical_thinking_memory').on('input', function () {
        let v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        this.value = v;
        USER.tableBaseSetting.critical_thinking_memory = v;
        USER.saveSettings && USER.saveSettings();
    });

    $('#clear_up_stairs').val(USER.tableBaseSetting.clear_up_stairs);
    $('#clear_up_stairs_value').text(USER.tableBaseSetting.clear_up_stairs);
    $('#rebuild_token_limit').val(USER.tableBaseSetting.rebuild_token_limit_value);
    $('#rebuild_token_limit_value').text(USER.tableBaseSetting.rebuild_token_limit_value);
    $('#custom_temperature').val(USER.tableBaseSetting.custom_temperature);
    $('#custom_temperature_value').text(USER.tableBaseSetting.custom_temperature);
    // 加载分步填表提示词
    $('#step_by_step_user_prompt').val(USER.tableBaseSetting.step_by_step_user_prompt || '');
    // 分步填表读取的上下文层数
    $('#separateReadContextLayers').val(USER.tableBaseSetting.separateReadContextLayers);
    // 分步填表是否读取世界书
    updateSwitch('#separateReadLorebook', USER.tableBaseSetting.separateReadLorebook);
    $("#fill_table_time").val(USER.tableBaseSetting.step_by_step ? 'after' : 'chat');
    refreshRebuildTemplate()

    // 私有数据
    $('#custom_api_url').val(USER.IMPORTANT_USER_PRIVACY_DATA.custom_api_url || '');
    $('#custom_api_key').val(USER.IMPORTANT_USER_PRIVACY_DATA.custom_api_key || '');
    $('#custom_model_name').val(USER.IMPORTANT_USER_PRIVACY_DATA.custom_model_name || '');
    $('#table_proxy_address').val(USER.IMPORTANT_USER_PRIVACY_DATA.table_proxy_address || '');
    $('#table_proxy_key').val(USER.IMPORTANT_USER_PRIVACY_DATA.table_proxy_key || '');

    // 初始化开关状态
    updateSwitch('#table_switch', USER.tableBaseSetting.isExtensionAble);
    updateSwitch('#table_switch_debug_mode', USER.tableBaseSetting.tableDebugModeAble);
    updateSwitch('#table_read_switch', USER.tableBaseSetting.isAiReadTable);
    updateSwitch('#table_edit_switch', USER.tableBaseSetting.isAiWriteTable);
    updateSwitch('#table_to_chat', USER.tableBaseSetting.isTableToChat);
    // updateSwitch('#advanced_settings', USER.tableBaseSetting.advanced_settings);
    updateSwitch('#confirm_before_execution', USER.tableBaseSetting.confirm_before_execution);
    updateSwitch('#use_main_api', USER.tableBaseSetting.use_main_api);
    updateSwitch('#step_by_step_use_main_api', USER.tableBaseSetting.step_by_step_use_main_api);
    updateSwitch('#ignore_del', USER.tableBaseSetting.bool_ignore_del);
    // updateSwitch('#bool_force_refresh', USER.tableBaseSetting.bool_force_refresh);
    updateSwitch('#bool_silent_refresh', USER.tableBaseSetting.bool_silent_refresh);
    // updateSwitch('#use_token_limit', USER.tableBaseSetting.use_token_limit);
    updateSwitch('#ignore_user_sent', USER.tableBaseSetting.ignore_user_sent);
    updateSwitch('#show_settings_in_extension_menu', USER.tableBaseSetting.show_settings_in_extension_menu);
    updateSwitch('#alternate_switch', USER.tableBaseSetting.alternate_switch);
    updateSwitch('#show_drawer_in_extension_list', USER.tableBaseSetting.show_drawer_in_extension_list);
    updateSwitch('#table_to_chat_can_edit', USER.tableBaseSetting.table_to_chat_can_edit);
    $('#reply_options').toggle(!USER.tableBaseSetting.step_by_step);
    $('#step_by_step_options').toggle(USER.tableBaseSetting.step_by_step);
    $('#table_to_chat_options').toggle(USER.tableBaseSetting.isTableToChat);
    $('#table_to_chat_is_micro_d').toggle(USER.tableBaseSetting.table_to_chat_mode === 'macro');

    // 不再在设置中显示表格结构
    // updateTableStructureDOM()
    console.log("设置已渲染")
}

/**
 * 加载设置
 */
export function loadSettings() {
    USER.IMPORTANT_USER_PRIVACY_DATA = USER.IMPORTANT_USER_PRIVACY_DATA || {};

    // 检查是否需要迁移（将 updateIndex 增加到 5）
    if (USER.tableBaseSetting.updateIndex < 5) {
        console.log("触发迁移到新记忆表格格式");

        // 清除任何现有的问题数据
        if (USER.getContext().chatMetadata?.sheets) {
            USER.getContext().chatMetadata.sheets = [];
        }

        try {
            initTableStructureToTemplate();
            ensureRuntimeMemoryTableHasCognitiveImpact();
            USER.tableBaseSetting.updateIndex = 5;
            console.log("迁移成功");
        } catch (error) {
            console.error("迁移失败:", error);
            EDITOR.error("表格迁移失败。详情请查看控制台.", error.message, error);
        }
    }

    // Set missing defaults safely
    if (typeof USER.tableBaseSetting.short_term_memory !== 'number') {
        USER.tableBaseSetting.short_term_memory = 2;
    }
    if (typeof USER.tableBaseSetting.critical_thinking_memory !== 'number') {
        USER.tableBaseSetting.critical_thinking_memory = 1;
    }
    // NEW default for reasoning retention flag
    if (typeof USER.tableBaseSetting.keep_reasoning_in_stmBase !== 'boolean') {
        USER.tableBaseSetting.keep_reasoning_in_stmBase = false;
    }
    if (typeof USER.tableBaseSetting.rag_top_k !== 'number') {
        USER.tableBaseSetting.rag_top_k = 3;   // NEW
    }
    if (typeof USER.tableBaseSetting.rag_depth !== 'number') {
        USER.tableBaseSetting.rag_depth = 1;   // NEW
    }

    // Lorebook defaults (no UI controls; prevent "not found" warnings)
    if (typeof USER.tableBaseSetting.lorebook_query_source !== 'string') {
        // 'last_user' | 'stm'
        USER.tableBaseSetting.lorebook_query_source = 'last_user';
    }
    if (typeof USER.tableBaseSetting.lorebook_min_score !== 'number') {
        USER.tableBaseSetting.lorebook_min_score = 0.25;
    }
    if (typeof USER.tableBaseSetting.lorebook_top_k !== 'number') {
        USER.tableBaseSetting.lorebook_top_k = 5;
    }
    if (typeof USER.tableBaseSetting.lorebook_max_chars !== 'number') {
        USER.tableBaseSetting.lorebook_max_chars = 4000;
    }
    // Optional but recommended: default for the stage toggle
    if (typeof USER.tableBaseSetting.enable_lorebook_stages !== 'boolean') {
        USER.tableBaseSetting.enable_lorebook_stages = false;
    }

    if (USER.tableBaseSetting.deep < 0) formatDeep();

    renderSetting();
    InitBinging();
    initRefreshTypeSelector();
    updateTableView();
    getSheetsCellStyle();
}

export function initTableStructureToTemplate() {
    try {
        const sheetDefaultTemplates = USER.tableBaseSetting.tableStructure || [];

        // 清除现有模板以避免冲突
        USER.getSettings().table_selected_sheets = []
        USER.getSettings().table_database_templates = [];

        // 如果不存在旧结构，则创建新的默认记忆表模板
        if (sheetDefaultTemplates.length === 0) {
            console.log("未找到现有表结构，创建默认的记忆表模板");
            createDefaultMemoryTableTemplate();
            USER.saveSettings();
            return;
        }

        // 检查是否已经有新的记忆表结构
        const existingMemoryTable = sheetDefaultTemplates.find(template =>
            template.tableName === "Memory Table" ||
            template.columns?.includes("Place") && template.columns?.includes("Characters") &&
            template.columns?.includes("Keys") && template.columns?.includes("Content")
        );

        if (existingMemoryTable) {
            console.log("记忆表模板已存在，使用现有结构");
            processExistingTemplate(existingMemoryTable);
            USER.saveSettings();
            return;
        }

        // 从旧的中文结构迁移到新的英文结构
        console.log("迁移旧的表结构到新的记忆表格式");

        // 不再迁移多个表，创建一个单一的记忆表
        createDefaultMemoryTableTemplate();

        // 可选择地通过合并旧数据来保留旧数据（您可以自定义此逻辑）
        // migrateOldTableData(sheetDefaultTemplates);

        USER.saveSettings();

    } catch (error) {
        console.error("迁移失败，创建默认记忆表模板时发生错误:", error);
        try {
            createDefaultMemoryTableTemplate();
            USER.saveSettings();
        } catch (fallbackError) {
            console.error("创建默认模板失败:", fallbackError);
            EDITOR.error("初始化表格模板失败。请检查您的设置.", fallbackError.message, fallbackError);
        }
    }
}

function createDefaultMemoryTableTemplate() {
    const newTemplate = new BASE.SheetTemplate();
    newTemplate.domain = 'global';
    // 6 columns total (blank index + 5 headers)
    newTemplate.createNewTemplate(6, 1, false);
    newTemplate.name = 'Memory Table';

    const headerCells = newTemplate.getCellsByRowIndex(0);
    if (headerCells.length >= 6) {
        headerCells[1].data.value = 'Place';
        headerCells[2].data.value = 'Characters';
        headerCells[3].data.value = 'Keys';
        headerCells[4].data.value = 'Content';
        headerCells[5].data.value = 'Cognitive Impact';
    }

    newTemplate.enable = true;
    newTemplate.tochat = true;
    newTemplate.required = true;
    newTemplate.triggerSend = true;
    newTemplate.triggerSendDeep = 3;

    newTemplate.source.data.note = 'Single memory table storing all contextual information with place, characters, keywords, content descriptions, and cognitive impact (low/medium/high)';
    newTemplate.source.data.initNode = 'This round must search for events from the context and insert them using insertRow function';
    newTemplate.source.data.insertNode = 'When new significant events, character interactions, or location changes occur';
    newTemplate.source.data.updateNode = 'When existing entries need content updates or clarification';
    newTemplate.source.data.deleteNode = 'When entries become irrelevant or outdated';

    USER.getSettings().table_selected_sheets.push(newTemplate.uid);
    newTemplate.save();

    console.log("创建默认记忆表模板 (含 Cognitive Impact):", newTemplate);
}

// 2) UPDATED processExistingTemplate to migrate & append the column if missing.
// 2) UPDATED processExistingTemplate to migrate & append the column if missing.
function processExistingTemplate(template) {
    // Clone columns and append the new column if absent
    const columns = Array.isArray(template.columns) ? [...template.columns] : [];
    const hadColumn = columns.includes('Cognitive Impact');
    if (!hadColumn) {
        columns.push('Cognitive Impact');
        console.log('[Memory Table Migration] Added missing "Cognitive Impact" column.');
    }

    const newTemplate = new BASE.SheetTemplate();
    newTemplate.domain = 'global';
    // +1 for the leading blank index column
    newTemplate.createNewTemplate(columns.length + 1, 1, false);
    newTemplate.name = template.tableName || 'Memory Table';

    columns.forEach((column, index) => {
        newTemplate.findCellByPosition(0, index + 1).data.value = column;
    });

    newTemplate.enable = template.enable ?? true;
    newTemplate.tochat = template.tochat ?? true;
    newTemplate.required = template.Required ?? true;
    newTemplate.triggerSend = template.triggerSend ?? true;
    newTemplate.triggerSendDeep = template.triggerSendDeep ?? 3;

    if (template.config) {
        newTemplate.config = JSON.parse(JSON.stringify(template.config));
    }

    // Ensure note mentions the new column
    const baseNote = template.note || '';
    if (!/cognitive impact/i.test(baseNote)) {
        newTemplate.source.data.note = (baseNote + '\nIncludes cognitive impact (low/medium/high)').trim();
    } else {
        newTemplate.source.data.note = baseNote;
    }
    newTemplate.source.data.initNode = template.initNode || '';
    newTemplate.source.data.deleteNode = template.deleteNode || '';
    newTemplate.source.data.updateNode = template.updateNode || '';
    newTemplate.source.data.insertNode = template.insertNode || '';

    USER.getSettings().table_selected_sheets.push(newTemplate.uid);
    newTemplate.save();

    console.log("迁移/处理记忆表模板 (已确保 Cognitive Impact 列):", newTemplate);
}
// 3) OPTIONAL: If you want to enforce migration on existing loaded runtime templates too,
// you can call this helper after initTableStructureToTemplate or during loadSettings.
function ensureRuntimeMemoryTableHasCognitiveImpact() {
    try {
        let changed = false;
        BASE.templates.forEach(t => {
            if (t.name === 'Memory Table' && t.hashSheet?.[0]) {
                const headerRow = t.hashSheet[0]
                    .slice(1)
                    .map(cellUid => t.cells.get(cellUid)?.data?.value);
                if (headerRow && !headerRow.includes('Cognitive Impact')) {
                    // Expand template by adding a new header cell
                    const template = new BASE.SheetTemplate(t.uid);
                    const oldCols = headerRow.length;
                    template.createNewTemplate(oldCols + 2, 1, false); // rebuild with +1 new header (+1 blank)
                    // Re-set old headers
                    headerRow.forEach((val, i) => {
                        template.findCellByPosition(0, i + 1).data.value = val;
                    });
                    template.findCellByPosition(0, oldCols + 1).data.value = 'Cognitive Impact';
                    template.save();
                    changed = true;
                    console.log('[Runtime Migration] Added "Cognitive Impact" to existing Memory Table template.');
                }
            }
        });
        if (changed) {
            USER.saveSettings && USER.saveSettings();
        }
    } catch (e) {
        console.warn('[Runtime Migration] Cognitive Impact column ensure failed:', e);
    }
}
function templateToTableStructure() {
    const tableTemplates = BASE.templates.map((templateData, index) => {
        const template = new BASE.SheetTemplate(templateData.uid)
        return {
            tableIndex: index,
            tableName: template.name,
            columns: template.hashSheet[0].slice(1).map(cellUid => template.cells.get(cellUid).data.value),
            note: template.data.note,
            initNode: template.data.initNode,
            deleteNode: template.data.deleteNode,
            updateNode: template.data.updateNode,
            insertNode: template.data.insertNode,
            config: JSON.parse(JSON.stringify(template.config)),
            Required: template.required,
            tochat: template.tochat,
            enable: template.enable,
            triggerSend: template.triggerSend,
            triggerSendDeep: template.triggerSendDeep,
        }
    })
    USER.tableBaseSetting.tableStructure = tableTemplates
    USER.saveSettings()
}

/**
 * 刷新重整理模板
 */
export function refreshRebuildTemplate() {
    const templateSelect = $('#rebuild--select');
    if (!templateSelect.length) {
        console.warn('rebuild--select element not found');
        return;
    }

    templateSelect.empty(); // 清空现有选项

    // 添加默认选项
    const defaultOption = $('<option>', {
        value: "rebuild_base",
        text: "默认模板",
    });
    templateSelect.append(defaultOption);

    // 从 profile_prompts.js 添加模板
    import('../../data/profile_prompts.js').then(({ profile_prompts }) => {
        Object.entries(profile_prompts).forEach(([key, value]) => {
            if (key !== 'rebuild_base') { // 跳过默认值，因为我们已经添加了它
                const option = $('<option>', {
                    value: key,
                    text: (() => {
                        switch (value.type) {
                            case 'refresh':
                                return '**旧版** ' + (value.name || key);
                            case 'third_party':
                                return '**第三方** ' + (value.name || key);
                            default:
                                return value.name || key;
                        }
                    })()
                });
                templateSelect.append(option);
            }
        });

        // 添加自定义模板
        const customTemplates = USER.tableBaseSetting.rebuild_message_template_list || {};
        Object.keys(customTemplates).forEach(key => {
            const template = customTemplates[key];
            const option = $('<option>', {
                value: key,
                text: '**自定义** ' + (template.name || key)
            });
            templateSelect.append(option);
        });

        // 设置默认选定项
        const lastSelected = USER.tableBaseSetting.lastSelectedTemplate;
        if (lastSelected) {
            console.log("设置默认选择项:", lastSelected);
            templateSelect.val(lastSelected);
        }
    }).catch(error => {
        console.error('加载 profile_prompts 失败:', error);

        // 回退：仅添加自定义模板
        const customTemplates = USER.tableBaseSetting.rebuild_message_template_list || {};
        Object.keys(customTemplates).forEach(key => {
            const template = customTemplates[key];
            const option = $('<option>', {
                value: key,
                text: template.name || key
            });
            templateSelect.append(option);
        });

        // Set default selected item
        const lastSelected = USER.tableBaseSetting.lastSelectedTemplate;
        if (lastSelected) {
            templateSelect.val(lastSelected);
        }
    });
}