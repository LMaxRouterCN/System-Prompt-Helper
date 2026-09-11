// ==UserScript==
// @name         System Prompt Helper
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  在LLM对话中辅助填写系统提示词，支持多站点独立配置、按频率拼接、黑金UI风格
// @author       LMaxRouterCN
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     * 1. 存储与配置 (多站点隔离架构)
     * ================================================================ */
    const SITE_DEFAULTS = {
        systemPrompt: '',
        panelPos: { x: 100, y: 100 },
        panelSize: { width: 520, height: 220 },
        prependFreq: 1,
        prependCountdown: 1
    };

    const DEFAULTS = {
        whitelist: ['https://chatglm.cn/', 'https://chat.openai.com/', 'https://claude.ai/'],
        debugMode: false,
        ...SITE_DEFAULTS
    };

    const STORE_KEY = 'system_prompt_helper_config_v2';

    function _loadStore() {
        let store;
        try { store = GM_getValue(STORE_KEY, null); } catch (_) { store = null; }
        if (!store) {
            return {
                whitelist: DEFAULTS.whitelist,
                debugMode: false,
                defaults: { ...SITE_DEFAULTS },
                perSite: {}
            };
        }
        return _migrateStore(store);
    }

    function _saveStore(store) {
        GM_setValue(STORE_KEY, store);
    }

    function _migrateStore(store) {
        const migrateFreq = (cfg) => {
            if (cfg.prependFreq === undefined) {
                cfg.prependFreq = (cfg.autoPrepend === false) ? 0 : 1;
            }
            if (cfg.prependCountdown === undefined || cfg.prependCountdown < 1) {
                cfg.prependCountdown = cfg.prependFreq > 0 ? cfg.prependFreq : 1;
            }
            delete cfg.autoPrepend;
        };
        const migratePanel = (cfg) => {
            if (!cfg.panelSize || cfg.panelSize.width < 420 || cfg.panelSize.height < 170) {
                cfg.panelSize = { width: 520, height: 220 };
            }
        };
        if (!store.defaults) {
            const newStore = {
                whitelist: store.whitelist || DEFAULTS.whitelist,
                debugMode: !!store.debugMode,
                defaults: { ...SITE_DEFAULTS },
                perSite: {}
            };
            for (const key of Object.keys(SITE_DEFAULTS)) {
                if (store[key] !== undefined) newStore.defaults[key] = store[key];
            }
            if (store.autoPrepend !== undefined) newStore.defaults.prependFreq = store.autoPrepend ? 1 : 0;
            migrateFreq(newStore.defaults);
            migratePanel(newStore.defaults);
            return newStore;
        }
        migrateFreq(store.defaults);
        migratePanel(store.defaults);
        if (store.perSite) Object.values(store.perSite).forEach(migrateFreq);
        return store;
    }

    function _matchSite() {
        const store = _loadStore();
        return store.whitelist.find(p => location.href.startsWith(p)) || null;
    }

    function _getConfigSource() {
        const store = _loadStore();
        const site = _matchSite();
        if (site && store.perSite && store.perSite[site]) return site;
        return 'defaults';
    }

    function cfgLoad() {
        const store = _loadStore();
        const site = _matchSite();
        const siteCfg = (site && store.perSite && store.perSite[site]) ? store.perSite[site] : {};
        return {
            ...DEFAULTS,
            whitelist: store.whitelist,
            debugMode: store.debugMode,
            ...store.defaults,
            ...siteCfg
        };
    }

    let _editTarget = 'defaults';

    function cfgSaveRuntime(partial) {
        const store = _loadStore();
        const source = _getConfigSource();
        if (source === 'defaults') {
            if (!store.defaults) store.defaults = { ...SITE_DEFAULTS };
            Object.assign(store.defaults, partial);
        } else {
            if (!store.perSite) store.perSite = {};
            if (!store.perSite[source]) store.perSite[source] = { ...SITE_DEFAULTS };
            Object.assign(store.perSite[source], partial);
        }
        _saveStore(store);
        if (_floatPanel) _syncFloatPanelUI();
    }

    const isWhitelisted = () => cfgLoad().whitelist.some(p => location.href.startsWith(p));

    /* ================================================================
     * 1.5 启用状态管理 (4态控制)
     * ================================================================ */
    const ENABLE_MODE_KEY = 'sph_enable_mode';
    const PAGE_SESSION_KEY = '__SPH_PageEnabled__';
    let _sessionEnabled = false;
    let _abortController = null;

    function _getEnableState() {
        if (_sessionEnabled) return 'session';
        if (sessionStorage.getItem(PAGE_SESSION_KEY) === '1') return 'page';
        const globalMode = GM_getValue(ENABLE_MODE_KEY, 'disabled');
        if (globalMode === 'always') return 'always';
        return 'disabled';
    }

    function _setEnableState(state) {
        _sessionEnabled = false;
        GM_setValue(ENABLE_MODE_KEY, 'disabled');
        sessionStorage.removeItem(PAGE_SESSION_KEY);
        switch (state) {
            case 'always': GM_setValue(ENABLE_MODE_KEY, 'always'); break;
            case 'session': _sessionEnabled = true; break;
            case 'page': sessionStorage.setItem(PAGE_SESSION_KEY, '1'); break;
        }
    }

    const ENABLE_LABELS = { disabled: '不启用', always: '默认启用', session: '此次会话启用', page: '当前页面启用' };
    let _enableMenuIds = [];

    function _registerEnableMenus() {
        _enableMenuIds.forEach(id => { try { GM_unregisterMenuCommand(id); } catch (e) {} });
        _enableMenuIds = [];
        const current = _getEnableState();
        const modes = ['disabled', 'always', 'session', 'page'];
        modes.forEach(mode => {
            const prefix = current === mode ? '✓ ' : '';
            const id = GM_registerMenuCommand(`${prefix}${ENABLE_LABELS[mode]}`, () => _switchEnableState(mode));
            _enableMenuIds.push(id);
        });
    }

    function _switchEnableState(mode) {
        const current = _getEnableState();
        if (current === mode) return;
        _setEnableState(mode);
        log('INFO', `启用状态: ${ENABLE_LABELS[current]} → ${ENABLE_LABELS[mode]}`);
        if (mode === 'disabled') {
            _stopAgent();
        } else {
            _startAgent();
        }
        _registerEnableMenus();
    }

    function _stopAgent() {
        if (_abortController) {
            _abortController.abort();
            _abortController = null;
        }
        hideFloatPanel();
        if (_configPanel) _configPanel.style.display = 'none';
        log('INFO', '⏹ Agent 已停止');
    }

    /* ================================================================
     * 2. 样式注入 (黑金配色，无圆角)
     * ================================================================ */
    GM_addStyle(`
        /* 悬浮窗样式 */
        #sph-float { position: fixed; top: 100px; left: 100px; width: 320px; height: 180px; background: #0a0a0a; color: #d4d4d4; border: 1px solid #2a2a2a; border-radius: 0; box-shadow: 0 24px 80px rgba(0,0,0,.55); z-index: 2147483647; display: flex; flex-direction: column; font: 14px/1.5 system-ui, sans-serif; }
        #sph-float * { box-sizing: border-box; margin: 0; padding: 0; }
        #sph-float-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #1a1a1a; cursor: move; border-bottom: 1px solid #2a2a2a; }
        #sph-float-head b { font-size: 13px; color: #facc15; user-select: none; }
        #sph-float-close { background: none; border: none; color: #a0a0a0; font-size: 16px; cursor: pointer; padding: 0 4px; }
        #sph-float-close:hover { color: #ef4444; }
        #sph-float-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
        #sph-prompt-area { flex: 1; width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; color: #d4d4d4; padding: 8px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; resize: none; outline: none; border-radius: 0; }
        #sph-prompt-area:focus { border-color: #facc15; }
        #sph-float-foot { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; border-top: 1px solid #2a2a2a; background: #0a0a0a; }
        #sph-status { font-size: 10px; color: #737373; }
        #sph-resize-handle { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: se-resize; background: linear-gradient(135deg, transparent 50%, #737373 50%); opacity: 0.5; }
        #sph-resize-handle:hover { opacity: 1; }
        /* ===== 预设文本历史区（悬浮窗右侧扩展栏）===== */
        #sph-float-main { flex: 1; display: flex; min-height: 0; }
        #sph-float-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 8px; overflow: hidden; }
        #sph-hist { width: 160px; flex-shrink: 0; border-left: 1px solid #2a2a2a; background: #0d0d0d; display: flex; flex-direction: column; min-height: 0; }
        #sph-hist-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; font-size: 10px; color: #a0a0a0; border-bottom: 1px solid #2a2a2a; flex-shrink: 0; user-select: none; }
        #sph-hist-count { color: #737373; }
        #sph-hist-list { flex: 1; min-height: 0; overflow-y: auto; padding: 5px; display: flex; flex-direction: column; gap: 4px; }
        #sph-hist-list::-webkit-scrollbar { width: 4px; }
        #sph-hist-list::-webkit-scrollbar-thumb { background: #2a2a2a; }
        #sph-hist-empty { color: #737373; font-size: 10px; text-align: center; padding: 14px 6px; line-height: 1.7; }
        .sph-hist-item { height: 44px; flex-shrink: 0; background: #1a1a1a; border: 1px solid #2a2a2a; border-left: 2px solid #2a2a2a; padding: 4px 6px; cursor: pointer; position: relative; overflow: hidden; }
        .sph-hist-item:hover { border-color: #facc15; }
        .sph-hist-item.pinned { border-left-color: #facc15; }
        .sph-hist-name { font-size: 11px; color: #d4d4d4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 40px; }
        .sph-hist-meta { font-size: 9px; color: #737373; margin-top: 3px; }
        .sph-hist-btns { position: absolute; right: 3px; top: 3px; display: none; gap: 2px; background: #0a0a0a; border: 1px solid #2a2a2a; padding: 1px 2px; }
        .sph-hist-item:hover .sph-hist-btns { display: flex; }
        .sph-hist-btn { background: none; border: none; color: #a0a0a0; font-size: 9px; cursor: pointer; padding: 0 2px; line-height: 1.4; }
        .sph-hist-btn:hover { color: #facc15; }
        .sph-hist-btn.active { color: #facc15; }
        .sph-hist-btn.danger:hover { color: #ef4444; }
        .sph-hist-sep { height: 0; border-top: 1px dashed #2a2a2a; margin: 1px 0; flex-shrink: 0; }
        .sph-hist-edit-inp { width: 100%; background: #0a0a0a; border: 1px solid #facc15; color: #d4d4d4; font-size: 11px; padding: 1px 3px; outline: none; }
        /* ===== 配置面板·预设文本库编辑区（新增）===== */
        #sph-cfg-hist-list { max-height: 200px; overflow-y: auto; background: #1a1a1a; padding: 5px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
        #sph-cfg-hist-list::-webkit-scrollbar { width: 4px; }
        #sph-cfg-hist-list::-webkit-scrollbar-thumb { background: #2a2a2a; }
        .sph-cfg-hist-empty { color: #737373; font-size: 12px; text-align: center; padding: 14px 6px; line-height: 1.7; }
        #sph-cfg-hist-editor { display: flex; flex-direction: column; gap: 6px; }
        #sph-cfg-hist-hint { font-size: 11px; color: #737373; }
        #sph-cfg-hist-content { width: 100%; height: 130px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #d4d4d4; padding: 7px 10px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; resize: vertical; outline: none; box-sizing: border-box; }
        #sph-cfg-hist-content:focus { border-color: #facc15; }
        .sph-hist-item.sel { border-color: #facc15; background: #232323; }
        /* 拼接频率选择器 */
        #sph-freq { border-top: 1px solid #2a2a2a; }
        #sph-freq-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 5px 8px; cursor: pointer; user-select: none; }
        #sph-freq-head:hover { background: #1a1a1a; }
        #sph-freq-label { font-size: 10px; color: #737373; }
        #sph-freq-count { font-size: 10px; color: #22c55e; }
        #sph-freq-val { font-size: 10px; color: #facc15; }
        #sph-freq-body { display: none; padding: 5px 8px 6px; border-top: 1px solid #2a2a2a; }
        #sph-freq-opts { display: flex; flex-wrap: wrap; gap: 2px 10px; }
        .sph-freq-opt { font-size: 10px; color: #737373; cursor: pointer; padding: 3px 0; transition: color .15s; }
        .sph-freq-opt:hover { color: #d4d4d4; }
        .sph-freq-opt.active { color: #facc15; }
        #sph-freq-custom { display: flex; gap: 4px; margin-top: 5px; align-items: center; }
        #sph-freq-custom input { flex: 1; min-width: 60px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #d4d4d4; font-size: 10px; padding: 3px 5px; outline: none; border-radius: 0; }
        #sph-freq-custom input:focus { border-color: #facc15; }
        #sph-freq-custom button { background: none; border: 1px solid #2a2a2a; color: #facc15; font-size: 10px; cursor: pointer; padding: 3px 8px; border-radius: 0; }
        #sph-freq-custom button:hover { border-color: #facc15; }
        /* 配置面板样式 */
        #sph-config { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(540px, 92vw); max-height: 82vh; overflow-y: auto; background: #0a0a0a; color: #d4d4d4; border: 1px solid #2a2a2a; border-radius: 0; box-shadow: 0 24px 80px rgba(0,0,0,.55); z-index: 2147483647; font: 14px/1.5 system-ui, sans-serif; display: none; }
        #sph-config * { box-sizing: border-box; margin: 0; padding: 0; }
        #sph-config-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid #2a2a2a; }
        #sph-config-head b { font-size: 15px; color: #facc15; }
        #sph-config-close { background: none; border: none; color: #a0a0a0; font-size: 20px; cursor: pointer; }
        #sph-config-close:hover { color: #ef4444; }
        #sph-config-body { padding: 20px; }
        .sph-sec { margin-bottom: 18px; }
        .sph-sec-title { font-size: 11px; font-weight: 700; color: #a0a0a0; text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
        .sph-sec-title::before { content: ''; width: 3px; height: 13px; background: #facc15; border-radius: 0; }
        .sph-field { margin-bottom: 10px; }
        .sph-field label { display: block; font-size: 12px; color: #d4d4d4; margin-bottom: 4px; }
        .sph-inp { width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; color: #ffffff; padding: 7px 10px; font-size: 12px; outline: none; border-radius: 0; font-family: 'SF Mono', Consolas, monospace; }
        .sph-inp:focus { border-color: #facc15; }
        .sph-btn { padding: 7px 13px; border: none; border-radius: 0; font-size: 12px; font-weight: 600; cursor: pointer; transition: .15s; white-space: nowrap; }
        .sph-btn-p { background: #facc15; color: #0a0a0a; }
        .sph-btn-p:hover { background: #fde047; }
        .sph-btn-g { background: #1a1a1a; color: #d4d4d4; border: 1px solid #2a2a2a; }
        .sph-btn-g:hover { border-color: #facc15; color: #facc15; }
        .sph-wl-list { max-height: 110px; overflow-y: auto; background: #1a1a1a; border-radius: 0; padding: 3px; margin-bottom: 6px; }
        .sph-wl-item { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 0; font-size: 12px; }
        .sph-wl-item code { flex: 1; min-width: 0; color: #22c55e; word-break: break-all; font-family: 'SF Mono', Consolas, monospace; font-size: 11px; }
        .sph-wl-rm { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 14px; padding: 0 4px; opacity: .5; }
        .sph-wl-rm:hover { opacity: 1; }
        .sph-toggle { display: flex; align-items: center; gap: 10px; }
        .sph-toggle input[type="checkbox"] { width: 16px; height: 16px; accent-color: #facc15; }
        .sph-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 14px; border-top: 1px solid #2a2a2a; margin-top: 6px; }
        .sph-site-info { background: #1a1a1a; padding: 10px 14px; margin-bottom: 10px; border: 1px solid #2a2a2a; }
        .sph-site-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
        .sph-site-label { color: #a0a0a0; min-width: 56px; flex-shrink: 0; }
        .sph-site-value { color: #d4d4d4; word-break: break-all; }
        .sph-site-badge { font-size: 10px; padding: 1px 6px; flex-shrink: 0; border-radius: 0; }
        .sph-badge-ok { background: rgba(34,197,94,.12); color: #22c55e; }
        .sph-badge-fail { background: rgba(239,68,68,.12); color: #ef4444; }
        .sph-site-actions { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
    `);

    /* ================================================================
     * 3. 调试日志系统
     * ================================================================ */
    function log(type, msg) {
        const c = cfgLoad();
        console.log(`[SPH-${type}] ${msg}`);
    }

    /* ================================================================
     * 4. 悬浮窗管理 (拖拽 + 缩放)
     * ================================================================ */
    let _floatPanel = null;
    let _promptArea = null;
    let _isDragging = false;
    let _isResizing = false;
    let _startPos = { x: 0, y: 0 };
    let _startPanelPos = { x: 0, y: 0 };
    let _startPanelSize = { width: 0, height: 0 };
    let _pendingManualEdit = false;
    let _pasteEchoValue = null;
    const HISTORY_MAX = 100;
    const _genHistId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    function _createFloatPanel() {
        if (_floatPanel) return;
        const c = cfgLoad();
        _floatPanel = document.createElement('div');
        _floatPanel.id = 'sph-float';
        _floatPanel.style.left = c.panelPos.x + 'px';
        _floatPanel.style.top = c.panelPos.y + 'px';
        _floatPanel.style.width = c.panelSize.width + 'px';
        _floatPanel.style.height = c.panelSize.height + 'px';
        _floatPanel.innerHTML = `
            <div id="sph-float-head">
                <b>🤖 系统提示词</b>
                <button id="sph-float-close">✕</button>
            </div>
            <div id="sph-float-main">
                <div id="sph-float-left">
                    <div id="sph-float-body">
                        <textarea id="sph-prompt-area" placeholder="在此输入系统提示词..." spellcheck="false"></textarea>
                    </div>
                    <div id="sph-freq">
                        <div id="sph-freq-head" title="拼接频率：仅1次=本页首次发送拼接后关闭(刷新重置)，每N次=每N次发送拼接一次，0为关闭">
                            <span id="sph-freq-label">🔁 拼接频率</span>
                            <span id="sph-freq-count" title="距离下次拼接还剩的发送次数"></span>
                            <span id="sph-freq-val"></span>
                        </div>
                        <div id="sph-freq-body">
                            <div id="sph-freq-opts">
                                <span class="sph-freq-opt" data-freq="0">关闭</span>
                                <span class="sph-freq-opt" data-freq="-1">仅1次</span>  <!-- 【新增】-1=仅本页首次发送拼接，刷新重置 -->
                                <span class="sph-freq-opt" data-freq="1">每次</span>
                                <span class="sph-freq-opt" data-freq="2">每2次</span>
                                <span class="sph-freq-opt" data-freq="3">每3次</span>
                                <span class="sph-freq-opt" data-freq="5">每5次</span>
                                <span class="sph-freq-opt" data-freq="10">每10次</span>
                            </div>
                            <div id="sph-freq-custom">
                                <input type="number" min="1" id="sph-freq-custom-inp" placeholder="自定义次数">
                                <button id="sph-freq-custom-ok">✓</button>
                            </div>
                        </div>
                    </div>
                    <div id="sph-float-foot">
                        <span id="sph-status">就绪</span>
                    </div>
                </div>
                <div id="sph-hist">
                    <div id="sph-hist-head"><span>📜 预设文本</span><span id="sph-hist-count"></span></div>
                    <div id="sph-hist-list"></div>
                </div>
            </div>
            <div id="sph-resize-handle"></div>
        `;
        document.body.appendChild(_floatPanel);
        _promptArea = _floatPanel.querySelector('#sph-prompt-area');
        _syncFloatPanelUI();
        const freqHead = _floatPanel.querySelector('#sph-freq-head');
        const freqBody = _floatPanel.querySelector('#sph-freq-body');
        freqHead.onclick = () => {
            freqBody.style.display = (freqBody.style.display === 'block') ? 'none' : 'block';
        };
        _floatPanel.querySelectorAll('.sph-freq-opt').forEach(opt => {
            opt.onclick = () => _applyPrependFreq(parseInt(opt.dataset.freq));
        });
        _floatPanel.querySelector('#sph-freq-custom-ok').onclick = () => {
            const v = parseInt(_floatPanel.querySelector('#sph-freq-custom-inp').value);
            if (v > 0) _applyPrependFreq(v);
        };
        _floatPanel.querySelector('#sph-hist-list').addEventListener('click', _onHistClick);
        _promptArea.addEventListener('paste', (e) => {
            const raw = e.clipboardData ? e.clipboardData.getData('text') : '';
            if (!raw || !raw.trim()) return;
            const t = raw.replace(/\r\n?/g, '\n');
            _addHistory(t);
            const ss = _promptArea.selectionStart, se = _promptArea.selectionEnd;
            _pasteEchoValue = _promptArea.value.slice(0, ss) + t + _promptArea.value.slice(se);
        });
        _promptArea.addEventListener('input', () => {
            cfgSaveRuntime({ systemPrompt: _promptArea.value });
            if (_pasteEchoValue !== null) {
                const isEcho = _promptArea.value === _pasteEchoValue;
                _pasteEchoValue = null;
                if (isEcho) { _pendingManualEdit = false; return; }
            }
            _pendingManualEdit = true;
        });
        _promptArea.addEventListener('blur', () => {
            if (!_pendingManualEdit) return;
            _pendingManualEdit = false;
            if (_promptArea.value.trim()) _addHistory(_promptArea.value);
        });
        _floatPanel.querySelector('#sph-float-close').onclick = () => hideFloatPanel();
        const head = _floatPanel.querySelector('#sph-float-head');
        head.addEventListener('mousedown', (e) => {
            if (e.target.id === 'sph-float-close') return;
            _isDragging = true;
            _startPos = { x: e.clientX, y: e.clientY };
            _startPanelPos = { x: parseInt(_floatPanel.style.left) || 0, y: parseInt(_floatPanel.style.top) || 0 };
            e.preventDefault();
        });
        const resizeHandle = _floatPanel.querySelector('#sph-resize-handle');
        resizeHandle.addEventListener('mousedown', (e) => {
            _isResizing = true;
            _startPos = { x: e.clientX, y: e.clientY };
            _startPanelSize = { width: parseInt(_floatPanel.style.width) || 0, height: parseInt(_floatPanel.style.height) || 0 };
            e.preventDefault();
            e.stopPropagation();
        });
        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mouseup', _onMouseUp);
        _renderHistoryList();
        log('INFO', '悬浮窗已创建');
    }

    function _onMouseMove(e) {
        if (_isDragging) {
            _floatPanel.style.left = (_startPanelPos.x + e.clientX - _startPos.x) + 'px';
            _floatPanel.style.top = (_startPanelPos.y + e.clientY - _startPos.y) + 'px';
        } else if (_isResizing) {
            _floatPanel.style.width = Math.max(400, _startPanelSize.width + e.clientX - _startPos.x) + 'px';
            _floatPanel.style.height = Math.max(150, _startPanelSize.height + e.clientY - _startPos.y) + 'px';
        }
    }

    function _onMouseUp() {
        if (_isDragging || _isResizing) {
            cfgSaveRuntime({
                panelPos: { x: parseInt(_floatPanel.style.left) || 0, y: parseInt(_floatPanel.style.top) || 0 },
                panelSize: { width: parseInt(_floatPanel.style.width) || 320, height: parseInt(_floatPanel.style.height) || 180 }
            });
        }
        _isDragging = false;
        _isResizing = false;
    }

    function _freqLabel(n) {
        const f = parseInt(n);
        if (f === -1) return '仅1次'; // 【新增】仅1次模式的哨兵值
        if (!f || f <= 0) return '关闭';
        return f === 1 ? '每次' : `每${f}次`;
    }

    function _applyPrependFreq(n) {
        if (n === -1) _onceModeUsed = false; // 【新增】显式选择仅1次=重新武装：否则"切走再切回"会停留在已用完态，反直觉
        cfgSaveRuntime({ prependFreq: n, prependCountdown: n > 0 ? n : 1 }); // -1时countdown写1占位，该模式不消费此值
        const body = _floatPanel?.querySelector('#sph-freq-body');
        if (body) body.style.display = 'none';
        log('INFO', `拼接频率切换为: ${_freqLabel(n)}`);
    }

    function _updateFreqUI() {
        if (!_floatPanel) return;
        const c = cfgLoad();
        const freq = parseInt(c.prependFreq) || 0;
        const valEl = _floatPanel.querySelector('#sph-freq-val');
        const countEl = _floatPanel.querySelector('#sph-freq-count');
        if (!valEl || !countEl) return;
        valEl.textContent = _freqLabel(freq);
        if (freq === -1) {
            // 【新增】仅1次模式：倒计时槽位改显状态（武装中/已用完），发送后立即可见翻转
            countEl.textContent = _onceModeUsed ? '已用完' : '待触发';
        } else if (freq >= 2) {
            let countdown = parseInt(c.prependCountdown);
            if (isNaN(countdown) || countdown < 1) countdown = freq;
            countEl.textContent = `剩${countdown}次`;
        } else {
            countEl.textContent = '';
        }
        _floatPanel.querySelectorAll('.sph-freq-opt').forEach(o => {
            o.classList.toggle('active', parseInt(o.dataset.freq) === freq);
        });
    }

    function _syncFloatPanelUI() {
        if (!_promptArea) return;
        const c = cfgLoad();
        _promptArea.value = c.systemPrompt || '';
        _updateFreqUI();
        _updateStatus();
    }

    function _updateStatus(statusText) {
        const status = _floatPanel?.querySelector('#sph-status');
        if (!status) return;
        if (statusText) {
            status.textContent = statusText;
        } else {
            const freq = parseInt(cfgLoad().prependFreq) || 0;
            if (freq === -1) {
                // 【新增】仅1次模式的状态行：随用时翻转，2秒后由_prependSystemPrompt的延时还原自然接住
                status.textContent = _onceModeUsed ? '就绪（仅1次已用完）' : '就绪（仅1次待触发）';
            } else {
                status.textContent = freq > 0 ? '就绪' : '就绪（拼接已关闭）';
            }
        }
    }

    /* ================================================================
     * 4.5 预设文本历史
     * 存储结构：store.histories（顶层，全局共享，不随站点配置隔离）
     * 数组顺序 = 显示顺序：[置顶区(手动序), 非置顶区(时间倒序)]
     * 所有排序在数据变更时维护，渲染层零排序逻辑
     * ================================================================ */
    function esc(s) {
        return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    function _loadHistories() {
        const store = _loadStore();
        if (!Array.isArray(store.histories)) store.histories = [];
        return store.histories;
    }

    function _saveHistories(arr) {
        const store = _loadStore();
        store.histories = arr;
        _saveStore(store);
    }

    function _firstUnpinnedIndex(arr) {
        const i = arr.findIndex(h => !h.pinned);
        return i === -1 ? arr.length : i;
    }

    function _fmtTime(ts) {
        const d = new Date(ts), now = new Date();
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    }

    /* 【新增】容量淘汰（从 _addHistory 抽出公用）：从最旧端(数组尾)找非置顶删除，置顶条目豁免 */
    function _evictHistories(arr) {
        while (arr.length > HISTORY_MAX) {
            let di = -1;
            for (let i = arr.length - 1; i >= 0; i--) { if (!arr[i].pinned) { di = i; break; } }
            if (di === -1) return;
            arr.splice(di, 1);
        }
    }

    /* 【新增】双侧渲染同步：悬浮窗列表 + 配置面板列表。各自内部有存在性守卫，任一未开则跳过。
       所有历史数据变更的统一出口——存储同源，调用此函数即实现两侧UI一致 */
    function _refreshHistories() {
        _renderHistoryList();
        _renderConfigHistory();
    }

    function _addHistory(text) {
        const content = String(text);
        if (!content.trim()) return;
        const arr = _loadHistories();
        const now = Date.now();
        const key = content.trim();
        const idx = arr.findIndex(h => h.content.trim() === key);
        if (idx !== -1) {
            const h = arr[idx];
            h.updatedAt = now;
            if (!h.pinned) { arr.splice(idx, 1); arr.splice(_firstUnpinnedIndex(arr), 0, h); }
        } else {
            arr.splice(_firstUnpinnedIndex(arr), 0, { id: _genHistId(), title: '', content, pinned: false, createdAt: now, updatedAt: now });
        }
        _evictHistories(arr);
        _saveHistories(arr);
        _refreshHistories();
    }

    function _renderHistoryList() {
        const list = _floatPanel?.querySelector('#sph-hist-list');
        if (!list) return;
        const arr = _loadHistories();
        const cntEl = _floatPanel.querySelector('#sph-hist-count');
        if (cntEl) cntEl.textContent = arr.length ? `(${arr.length})` : '';
        if (!arr.length) {
            list.innerHTML = '<div id="sph-hist-empty">暂无预设<br>粘贴或输入文本后自动记录</div>';
            return;
        }
        let html = '';
        arr.forEach((h, i) => {
            if (i > 0 && arr[i - 1].pinned && !h.pinned) html += '<div class="sph-hist-sep"></div>';
            const name = h.title || h.content;
            const btns = `<span class="sph-hist-btns">` +
                (h.pinned ? `<button class="sph-hist-btn" data-act="up" title="上移">▲</button><button class="sph-hist-btn" data-act="down" title="下移">▼</button>` : '') +
                `<button class="sph-hist-btn ${h.pinned ? 'active' : ''}" data-act="pin" title="${h.pinned ? '取消置顶' : '置顶'}">📌</button>` +
                `<button class="sph-hist-btn" data-act="rename" title="重命名">✏</button>` +
                `<button class="sph-hist-btn danger" data-act="del" title="删除">✕</button></span>`;
            html += `<div class="sph-hist-item ${h.pinned ? 'pinned' : ''}" data-id="${h.id}">` +
                `<div class="sph-hist-name">${esc(name)}</div>` +
                `<div class="sph-hist-meta">${h.content.length}字 · ${_fmtTime(h.updatedAt)}</div>` +
                btns + `</div>`;
        });
        list.innerHTML = html;
    }

    function _onHistClick(e) {
        if (e.target.classList.contains('sph-hist-edit-inp')) return;
        const item = e.target.closest('.sph-hist-item');
        if (!item) return;
        const id = item.dataset.id;
        const btn = e.target.closest('.sph-hist-btn');
        if (btn) {
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'del') _histDelete(id);
            else if (act === 'pin') _histTogglePin(id);
            else if (act === 'up') _histMove(id, -1);
            else if (act === 'down') _histMove(id, 1);
            else if (act === 'rename') _histStartRename(item, id);
            return;
        }
        _histLoad(id);
    }

    function _histLoad(id) {
        const h = _loadHistories().find(x => x.id === id);
        if (!h || !_promptArea) return;
        _promptArea.value = h.content;
        cfgSaveRuntime({ systemPrompt: h.content });
        _pendingManualEdit = false;
        _updateStatus('已载入预设');
        setTimeout(() => _updateStatus(), 2000);
        log('INFO', `已载入预设文本 (${h.content.length} 字符)`);
    }

    function _histDelete(id) {
        const arr = _loadHistories();
        const i = arr.findIndex(x => x.id === id);
        if (i === -1) return;
        arr.splice(i, 1);
        _saveHistories(arr);
        _refreshHistories();
        log('INFO', '已删除预设条目');
    }

    function _histTogglePin(id) {
        const arr = _loadHistories();
        const i = arr.findIndex(x => x.id === id);
        if (i === -1) return;
        const h = arr[i];
        h.pinned = !h.pinned;
        arr.splice(i, 1);
        if (h.pinned) arr.unshift(h);
        else arr.splice(_firstUnpinnedIndex(arr), 0, h);
        _saveHistories(arr);
        _refreshHistories();
    }

    function _histMove(id, dir) {
        const arr = _loadHistories();
        const i = arr.findIndex(x => x.id === id);
        if (i === -1) return;
        const j = i + dir;
        if (j < 0 || j >= arr.length) return;
        if (!arr[i].pinned || !arr[j].pinned) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        _saveHistories(arr);
        _refreshHistories();
    }

    function _histStartRename(item, id) {
        if (item.querySelector('.sph-hist-edit-inp')) return;
        const h = _loadHistories().find(x => x.id === id);
        if (!h) return;
        const nameEl = item.querySelector('.sph-hist-name');
        const inp = document.createElement('input');
        inp.className = 'sph-hist-edit-inp';
        inp.value = h.title || '';
        inp.placeholder = h.content.slice(0, 20);
        nameEl.replaceWith(inp);
        inp.focus();
        inp.select();
        let done = false;
        const confirm = (save) => {
            if (done) return;
            done = true;
            if (save) {
                const arr = _loadHistories();
                const t = arr.find(x => x.id === id);
                if (t) { t.title = inp.value.trim(); _saveHistories(arr); }
            }
            _refreshHistories();
        };
        inp.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') confirm(true);
            else if (ev.key === 'Escape') confirm(false);
        });
        inp.addEventListener('blur', () => setTimeout(() => confirm(true), 0));
        inp.addEventListener('click', (ev) => ev.stopPropagation());
    }

    function showFloatPanel() {
        if (!_floatPanel) _createFloatPanel();
        _floatPanel.style.display = 'flex';
        _syncFloatPanelUI();
    }

    function hideFloatPanel() {
        if (_floatPanel) _floatPanel.style.display = 'none';
    }

    /* ================================================================
     * 5. 配置面板 (多站点管理)
     * ================================================================ */
    let _configPanel = null;

    function _createConfigPanel() {
        if (_configPanel) return;
        _configPanel = document.createElement('div');
        _configPanel.id = 'sph-config';
        document.body.appendChild(_configPanel);
        // 【Bug修复】删除原末行 _configPanel.querySelector('#sph-config-close').onclick = hideConfigPanel;
        // 创建时面板尚无innerHTML，querySelector必返null，赋值抛TypeError导致配置面板菜单首次点击失效
        // （第二次点击因_configPanel已存在跳过创建才恢复）。关闭按钮绑定由_renderConfigPanel完成，此处冗余且有害
    }

    function _renderConfigPanel() {
        const store = _loadStore();
        const site = _matchSite();
        const inWhitelist = !!site;
        const hasSiteCfg = site && store.perSite && store.perSite[site];
        _editTarget = hasSiteCfg ? site : 'defaults';
        const titleText = _editTarget === 'defaults' ? '⚙️ 系统提示词助手 — 默认设置' : `⚙️ 系统提示词助手 — ${_editTarget} 独立设置`;
        const siteDisplay = site || location.hostname;
        const sourceDisplay = _editTarget === 'defaults' ? '默认配置' : `${_editTarget} 独立配置`;
        const badgeClass = inWhitelist ? 'sph-badge-ok' : 'sph-badge-fail';
        const badgeText = inWhitelist ? '在白名单内' : '不在白名单内';
        let actionsHtml = `<button class="sph-btn ${_editTarget === 'defaults' ? 'sph-btn-p' : 'sph-btn-g'}" id="sph-edit-defaults">编辑默认配置</button>`;
        if (inWhitelist) {
            if (hasSiteCfg) {
                actionsHtml += `<button class="sph-btn ${_editTarget === site ? 'sph-btn-p' : 'sph-btn-g'}" id="sph-edit-site">编辑当前网站配置</button>`;
                actionsHtml += `<button class="sph-btn sph-btn-g" id="sph-del-site" style="color:#ef4444">删除独立配置</button>`;
            } else {
                actionsHtml += `<button class="sph-btn sph-btn-g" id="sph-create-site">为此网站创建独立配置</button>`;
            }
        }
        _configPanel.innerHTML = `
            <div id="sph-config-head"><b>${titleText}</b><button id="sph-config-close">✕</button></div>
            <div id="sph-config-body">
                <div class="sph-site-info">
                    <div class="sph-site-row"><span class="sph-site-label">当前网站:</span><span class="sph-site-value">${siteDisplay}</span><span class="sph-site-badge ${badgeClass}">${badgeText}</span></div>
                    <div class="sph-site-row"><span class="sph-site-label">当前使用:</span><span class="sph-site-value" style="color:#facc15">${sourceDisplay}</span></div>
                </div>
                <div class="sph-site-actions">${actionsHtml}</div>
                <div class="sph-sec">
                    <div class="sph-sec-title">网站白名单</div>
                    <div class="sph-wl-list" id="sph-wl-list"></div>
                    <div style="display:flex; gap:6px;">
                        <input class="sph-inp" id="sph-wl-new" placeholder="https://example.com/" style="flex:1">
                        <button class="sph-btn sph-btn-g" id="sph-wl-add">添加</button>
                    </div>
                </div>
                <div class="sph-sec">
                    <div class="sph-sec-title">预设文本库 <span id="sph-cfg-hist-count" style="font-weight:400"></span></div>
                    <div id="sph-cfg-hist-list"></div>
                    <div id="sph-cfg-hist-editor">
                        <div id="sph-cfg-hist-hint">未选中条目 — 写好内容后点"存为新预设"，或点击上方列表选中条目</div>
                        <input class="sph-inp" id="sph-cfg-hist-title" placeholder="标题（可选，留空则列表显示内容前缀）">
                        <textarea id="sph-cfg-hist-content" placeholder="在此编辑预设文本内容..." spellcheck="false"></textarea>
                        <div style="display:flex; gap:6px;">
                            <button class="sph-btn sph-btn-g" id="sph-cfg-hist-new">➕ 存为新预设</button>
                            <button class="sph-btn sph-btn-p" id="sph-cfg-hist-save">💾 保存修改</button>
                        </div>
                    </div>
                </div>
                <div class="sph-sec">
                    <div class="sph-sec-title">控制台</div>
                    <div class="sph-toggle">
                        <input type="checkbox" id="sph-debug-cb" ${store.debugMode ? 'checked' : ''}>
                        <label for="sph-debug-cb" style="cursor:pointer; font-size:12px;">启用调试日志</label>
                    </div>
                </div>
                <div class="sph-foot">
                    <button class="sph-btn sph-btn-g" id="sph-cancel">关闭</button>
                </div>
            </div>
        `;
        _configPanel.querySelector('#sph-config-close').onclick = hideConfigPanel;
        _configPanel.querySelector('#sph-cancel').onclick = hideConfigPanel;
        _configPanel.querySelector('#sph-edit-defaults').onclick = () => {
            _editTarget = 'defaults';
            _renderConfigPanel();
        };
        if (inWhitelist && hasSiteCfg) {
            _configPanel.querySelector('#sph-edit-site').onclick = () => {
                _editTarget = site;
                _renderConfigPanel();
            };
            _configPanel.querySelector('#sph-del-site').onclick = () => {
                const s = _loadStore();
                if (s.perSite && s.perSite[site]) delete s.perSite[site];
                _saveStore(s);
                _editTarget = 'defaults';
                _renderConfigPanel();
                _syncFloatPanelUI();
            };
        }
        if (inWhitelist && !hasSiteCfg) {
            _configPanel.querySelector('#sph-create-site').onclick = () => {
                const s = _loadStore();
                if (!s.perSite) s.perSite = {};
                s.perSite[site] = { ...s.defaults };
                _saveStore(s);
                _editTarget = site;
                _renderConfigPanel();
                _syncFloatPanelUI();
            };
        }
        const wlInput = _configPanel.querySelector('#sph-wl-new');
        const doAdd = () => {
            const v = wlInput.value.trim();
            if (!v) return;
            const s = _loadStore();
            if (!s.whitelist.includes(v)) s.whitelist.push(v);
            _saveStore(s);
            wlInput.value = '';
            _renderWhitelist();
        };
        _configPanel.querySelector('#sph-wl-add').onclick = doAdd;
        wlInput.onkeydown = e => { if (e.key === 'Enter') doAdd(); };
        _configPanel.querySelector('#sph-debug-cb').onchange = (e) => {
            const s = _loadStore();
            s.debugMode = e.target.checked;
            _saveStore(s);
            log('INFO', `调试模式已${s.debugMode ? '启用' : '禁用'}`);
        };
        _renderWhitelist();
        _configPanel.querySelector('#sph-cfg-hist-list').addEventListener('click', _onCfgHistClick);
        _configPanel.querySelector('#sph-cfg-hist-save').onclick = _cfgHistSave;
        _configPanel.querySelector('#sph-cfg-hist-new').onclick = _cfgHistSaveNew;
        if (_cfgHistSelId && !_loadHistories().some(x => x.id === _cfgHistSelId)) _cfgHistSelId = null;
        _cfgHistEditorFill(_cfgHistSelId ? _loadHistories().find(x => x.id === _cfgHistSelId) : null);
        _renderConfigHistory();
    }

    function _renderWhitelist() {
        const list = _configPanel?.querySelector('#sph-wl-list');
        if (!list) return;
        const store = _loadStore();
        list.innerHTML = store.whitelist.length ? store.whitelist.map((u, i) => `<div class="sph-wl-item"><code>${u}</code><button class="sph-wl-rm" data-i="${i}">✕</button></div>`).join('') : '<div style="padding:8px 10px; color:#737373; font-size:12px; text-align:center;">暂无白名单</div>';
        list.querySelectorAll('.sph-wl-rm').forEach(btn => {
            btn.onclick = () => {
                const s = _loadStore();
                s.whitelist.splice(+btn.dataset.i, 1);
                _saveStore(s);
                _renderWhitelist();
            };
        });
    }

    /* ================================================================
     * 5.5 配置面板·预设文本库编辑区（新增）
     * 与悬浮窗历史区共享 store.histories 与全部数据操作函数；
     * 双向同步 = 变更后统一走 _refreshHistories()（存储同源，天然一致）
     * 编辑器内容以DOM为准：列表级重渲染绝不回填编辑器，防止未保存修改被覆盖
     * ================================================================ */
    let _cfgHistSelId = null;

    function _renderConfigHistory() {
        if (!_configPanel) return;
        const list = _configPanel.querySelector('#sph-cfg-hist-list');
        if (!list) return;
        const arr = _loadHistories();
        const cntEl = _configPanel.querySelector('#sph-cfg-hist-count');
        if (cntEl) cntEl.textContent = arr.length ? `(${arr.length})` : '';
        if (!arr.length) {
            list.innerHTML = '<div class="sph-cfg-hist-empty">暂无预设<br>在下方编辑器写好内容后点"存为新预设"</div>';
        } else {
            let html = '';
            arr.forEach((h, i) => {
                if (i > 0 && arr[i - 1].pinned && !h.pinned) html += '<div class="sph-hist-sep"></div>';
                const name = h.title || h.content;
                const btns = `<span class="sph-hist-btns">` +
                    (h.pinned ? `<button class="sph-hist-btn" data-act="up" title="上移">▲</button><button class="sph-hist-btn" data-act="down" title="下移">▼</button>` : '') +
                    `<button class="sph-hist-btn ${h.pinned ? 'active' : ''}" data-act="pin" title="${h.pinned ? '取消置顶' : '置顶'}">📌</button>` +
                    `<button class="sph-hist-btn danger" data-act="del" title="删除">✕</button></span>`;
                html += `<div class="sph-hist-item ${h.pinned ? 'pinned' : ''} ${h.id === _cfgHistSelId ? 'sel' : ''}" data-id="${h.id}">` +
                    `<div class="sph-hist-name">${esc(name)}</div>` +
                    `<div class="sph-hist-meta">${h.content.length}字 · ${_fmtTime(h.updatedAt)}</div>` +
                    btns + `</div>`;
            });
            list.innerHTML = html;
        }
        if (_cfgHistSelId && !arr.some(x => x.id === _cfgHistSelId)) {
            _cfgHistSelId = null;
            _cfgHistEditorFill(null);
        }
    }

    function _cfgHistEditorFill(h) {
        if (!_configPanel) return;
        const titleInp = _configPanel.querySelector('#sph-cfg-hist-title');
        const contentTa = _configPanel.querySelector('#sph-cfg-hist-content');
        const hint = _configPanel.querySelector('#sph-cfg-hist-hint');
        if (!titleInp || !contentTa || !hint) return;
        titleInp.value = h ? (h.title || '') : '';
        contentTa.value = h ? h.content : '';
        hint.textContent = h
            ? `正在编辑: ${h.title || (h.content.trim().slice(0, 24) || '(空)')}`
            : '未选中条目 — 写好内容后点"存为新预设"，或点击上方列表选中条目';
    }

    function _onCfgHistClick(e) {
        const item = e.target.closest('.sph-hist-item');
        if (!item) return;
        const id = item.dataset.id;
        const btn = e.target.closest('.sph-hist-btn');
        if (btn) {
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'del') _histDelete(id);
            else if (act === 'pin') _histTogglePin(id);
            else if (act === 'up') _histMove(id, -1);
            else if (act === 'down') _histMove(id, 1);
            return;
        }
        _cfgHistSelId = id;
        _cfgHistEditorFill(_loadHistories().find(x => x.id === id) || null);
        _renderConfigHistory();
    }

    function _cfgHistSave() {
        if (!_configPanel) return;
        if (!_cfgHistSelId) { log('WARN', '未选中预设条目：请先点击列表条目，或改用"存为新预设"'); return; }
        const arr = _loadHistories();
        const h = arr.find(x => x.id === _cfgHistSelId);
        if (!h) { _cfgHistSelId = null; _refreshHistories(); return; }
        const titleInp = _configPanel.querySelector('#sph-cfg-hist-title');
        const contentTa = _configPanel.querySelector('#sph-cfg-hist-content');
        if (!titleInp || !contentTa) return;
        const content = contentTa.value;
        if (!content.trim()) { log('WARN', '预设内容为空：如需移除该条目请用列表的删除按钮'); return; }
        const contentChanged = content !== h.content;
        h.title = titleInp.value.trim();
        h.content = content;
        if (contentChanged) {
            h.updatedAt = Date.now();
            if (!h.pinned) { const i = arr.indexOf(h); arr.splice(i, 1); arr.splice(_firstUnpinnedIndex(arr), 0, h); }
        }
        _saveHistories(arr);
        _refreshHistories();
        log('OK', `预设已保存 (${content.length} 字符${contentChanged ? '，内容变更已提升至时间区顶部' : ''})`);
    }

    function _cfgHistSaveNew() {
        if (!_configPanel) return;
        const titleInp = _configPanel.querySelector('#sph-cfg-hist-title');
        const contentTa = _configPanel.querySelector('#sph-cfg-hist-content');
        if (!titleInp || !contentTa) return;
        const content = contentTa.value;
        if (!content.trim()) { log('WARN', '内容为空，无法保存为新预设'); return; }
        const arr = _loadHistories();
        const now = Date.now();
        const entry = { id: _genHistId(), title: titleInp.value.trim(), content, pinned: false, createdAt: now, updatedAt: now };
        arr.splice(_firstUnpinnedIndex(arr), 0, entry);
        _evictHistories(arr);
        _saveHistories(arr);
        _cfgHistSelId = entry.id;
        _cfgHistEditorFill(entry);
        _refreshHistories();
        log('OK', `已保存为新预设 (${content.length} 字符)`);
    }

    function showConfigPanel() {
        if (!_configPanel) _createConfigPanel();
        _renderConfigPanel();
        _configPanel.style.display = 'block';
    }

    function hideConfigPanel() {
        if (_configPanel) _configPanel.style.display = 'none';
    }

    /* ================================================================
     * 6. 输入拦截核心逻辑
     * ================================================================ */
    let _lastFocusedInput = null;
    let _onceModeUsed = false; // 【新增】仅1次模式(-1)的已用标志：模块级变量，生命周期=页面生命周期。
                               // 刻意不用sessionStorage(同tab刷新后存活,违背"刷新即重置")也不用GM存储(跨页持久,更违背)。
                               // SPA路由切换不触发脚本重跑，once不重置——符合"新标签页/刷新"字面语义

    function _findInputElement() {
        const selectors = ['textarea', 'input[type="text"]', 'div[contenteditable="true"]'];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el.id === 'sph-prompt-area') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width > 100 && rect.height > 20 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden') {
                    return el;
                }
            }
        }
        return null;
    }

    function _findSendButton() {
        const candidates = document.querySelectorAll('button, div[role="button"], svg');
        for (const btn of candidates) {
            const text = (btn.textContent || '').toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (text.includes('send') || text.includes('发送') || ariaLabel.includes('send') || ariaLabel.includes('发送')) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return btn;
            }
        }
        return null;
    }

    function _onFocus(e) {
        const target = e.target;
        if (target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text') || target.isContentEditable)) {
            if (target.id !== 'sph-prompt-area') {
                _lastFocusedInput = target;
            }
        }
    }

    function _onClick(e) {
        if (!_lastFocusedInput) return;
        const sendBtn = _findSendButton();
        if (sendBtn && sendBtn.contains(e.target)) {
            log('INFO', '检测到发送按钮点击');
            _onSendDetected();
        }
    }

    function _onKeydown(e) {
        if (e.repeat) return;
        if (e.target && e.target.classList && e.target.classList.contains('sph-hist-edit-inp')) return;
        if (!_lastFocusedInput) return;
        if ((e.ctrlKey && e.key === 'Enter') || (e.key === 'Enter' && !e.shiftKey && _isInInputContext(e.target))) {
            log('INFO', '检测到发送快捷键');
            _onSendDetected();
        }
    }

    function _onSendDetected() {
        if (!_lastFocusedInput) return;
        const c = cfgLoad();
        const freq = parseInt(c.prependFreq) || 0;
        if (freq === -1) {
            // 【新增】仅1次模式：本页面生命周期内只拼接第一次发送
            if (_onceModeUsed) return;                                // 已用过：本次会话内等效关闭
            if (!c.systemPrompt || !c.systemPrompt.trim()) return;    // 无内容可拼：不消耗唯一机会
            _onceModeUsed = true;                                     // 先落账再拼接
            _updateFreqUI();                                          // 立即刷新状态显示（该模式无配置变更，不走cfgSaveRuntime）
            _prependSystemPrompt();
            return;
        }
        if (freq <= 0) return; // 0=关闭（-1已在上方分支消化）
        if (!c.systemPrompt || !c.systemPrompt.trim()) return;
        let countdown = parseInt(c.prependCountdown);
        if (isNaN(countdown) || countdown < 1) countdown = freq;
        countdown--;
        const willPrepend = countdown <= 0;
        if (willPrepend) countdown = freq;
        cfgSaveRuntime({ prependCountdown: countdown });
        if (willPrepend) _prependSystemPrompt();
    }

    function _isInInputContext(el) {
        if (!el) return false;
        return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text') || el.isContentEditable;
    }

    function _prependSystemPrompt() {
        if (!_lastFocusedInput) return;
        const c = cfgLoad();
        const systemPrompt = c.systemPrompt || '';
        if (!systemPrompt.trim()) return;
        let currentContent = '';
        if (_lastFocusedInput.tagName === 'TEXTAREA' || _lastFocusedInput.tagName === 'INPUT') {
            currentContent = _lastFocusedInput.value;
        } else if (_lastFocusedInput.isContentEditable) {
            currentContent = _lastFocusedInput.textContent || '';
        }
        if (currentContent.includes(systemPrompt)) return;
        const newContent = systemPrompt + '\n\n' + currentContent;
        _setInputValue(_lastFocusedInput, newContent);
        log('OK', `系统提示词已拼接，总长度: ${newContent.length}`);
        _updateStatus('已拼接系统提示词');
        setTimeout(() => _updateStatus(), 2000);
    }

    function _setInputValue(el, value) {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
        }
    }

    /* ================================================================
     * 7. 启动入口
     * ================================================================ */
    function _startAgent() {
        if (_abortController) _abortController.abort();
        _abortController = new AbortController();
        const signal = _abortController.signal;
        document.addEventListener('focus', _onFocus, { capture: true, signal });
        document.addEventListener('click', _onClick, { capture: true, signal });
        document.addEventListener('keydown', _onKeydown, { capture: true, signal });
        if (isWhitelisted()) {
            setTimeout(() => {
                showFloatPanel();
                log('OK', '脚本已启动，悬浮窗已显示');
            }, 500);
        } else {
            log('INFO', '当前网站不在白名单内，悬浮窗隐藏');
        }
    }

    function init() {
        GM_registerMenuCommand('⚙️ 配置面板', showConfigPanel);
        GM_registerMenuCommand('🤖 显示/隐藏悬浮窗', () => {
            if (_floatPanel && _floatPanel.style.display !== 'none') hideFloatPanel();
            else showFloatPanel();
        });
        _registerEnableMenus();
        if (_getEnableState() !== 'disabled') {
            _startAgent();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
