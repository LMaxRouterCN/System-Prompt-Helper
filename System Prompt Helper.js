// ==UserScript==
// @name         System Prompt Helper
// @namespace    http://tampermonkey.net/
// @version      2.1
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
        panelSize: { width: 320, height: 180 },
        prependFreq: 1,       // 【新增】拼接频率：0=关闭，1=每次发送都拼接，N=每N次发送拼接一次（取代旧 autoPrepend 布尔开关）
        prependCountdown: 1   // 【新增】拼接倒计时：还剩几次发送触发下次拼接，发送时递减，归零即拼接并重置为 prependFreq
    };

    const DEFAULTS = {
        whitelist: ['https://chatglm.cn/', 'https://chat.openai.com/', 'https://claude.ai/'],
        debugMode: false,
        ...SITE_DEFAULTS
    };

    const STORE_KEY = 'system_prompt_helper_config_v2';

    function _loadStore() {
        let store;
        try {
            store = GM_getValue(STORE_KEY, null);
        } catch (_) {
            store = null;
        }
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
        // 【新增】拼接频率迁移：旧 autoPrepend(布尔) → prependFreq(数值)，true→1(每次)，false→0(关闭)
        // 幂等设计：重复执行无副作用，可随每次加载安全运行
        const migrateFreq = (cfg) => {
            if (cfg.prependFreq === undefined) {
                cfg.prependFreq = (cfg.autoPrepend === false) ? 0 : 1;
            }
            if (cfg.prependCountdown === undefined || cfg.prependCountdown < 1) {
                cfg.prependCountdown = cfg.prependFreq > 0 ? cfg.prependFreq : 1; // 倒计时缺失/非法时回落满周期
            }
            delete cfg.autoPrepend; // 旧键已被 prependFreq 完全取代，清除避免残留
        };
        // 兼容旧版本 v1 数据结构
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
            if (store.autoPrepend !== undefined) newStore.defaults.prependFreq = store.autoPrepend ? 1 : 0; // 【新增】v1 旧键偏好保留
            migrateFreq(newStore.defaults); // 【新增】v1 路径同样执行频率字段规范化
            return newStore;
        }
        migrateFreq(store.defaults); // 【新增】v2 结构：默认配置迁移
        if (store.perSite) Object.values(store.perSite).forEach(migrateFreq); // 【新增】v2 结构：各站点独立配置迁移
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

    let _editTarget = 'defaults'; // 当前配置面板编辑的目标：'defaults' 或 site_url

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
        // 触发悬浮窗UI刷新
        if (_floatPanel) _syncFloatPanelUI();
    }

    const isWhitelisted = () => cfgLoad().whitelist.some(p => location.href.startsWith(p));

    /* ================================================================
     * 1.5 启用状态管理 (4态控制)
     * ================================================================ */
    const ENABLE_MODE_KEY = 'sph_enable_mode';
    const PAGE_SESSION_KEY = '__SPH_PageEnabled__';
    let _sessionEnabled = false;
    let _abortController = null; // 用于一键切断所有事件监听

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
            case 'always':
                GM_setValue(ENABLE_MODE_KEY, 'always');
                break;
            case 'session':
                _sessionEnabled = true;
                break;
            case 'page':
                sessionStorage.setItem(PAGE_SESSION_KEY, '1');
                break;
        }
    }

    const ENABLE_LABELS = {
        disabled: '不启用',
        always: '默认启用',
        session: '此次会话启用',
        page: '当前页面启用'
    };

    let _enableMenuIds = [];

    function _registerEnableMenus() {
        _enableMenuIds.forEach(id => {
            try {
                GM_unregisterMenuCommand(id);
            } catch (e) {}
        });
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
        // 切断所有DOM事件监听，防止内存泄漏和幽灵拦截
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
        #sph-float-body { flex: 1; padding: 8px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
        #sph-prompt-area { flex: 1; width: 100%; background: #1a1a1a; border: 1px solid #2a2a2a; color: #d4d4d4; padding: 8px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; resize: none; outline: none; border-radius: 0; }
        #sph-prompt-area:focus { border-color: #facc15; }
        #sph-float-foot { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; border-top: 1px solid #2a2a2a; background: #0a0a0a; }
        #sph-status { font-size: 10px; color: #737373; }
        #sph-resize-handle { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: se-resize; background: linear-gradient(135deg, transparent 50%, #737373 50%); opacity: 0.5; }
        #sph-resize-handle:hover { opacity: 1; }
        /* 【新增】拼接频率选择器（交互与视觉对齐 PokerAgent 记忆注入频率控件：头部行 + 可展开选项体） */
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
        // 极简版暂不实现UI浮窗日志，仅控制台输出
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
            <div id="sph-float-body">
                <textarea id="sph-prompt-area" placeholder="在此输入系统提示词..." spellcheck="false"></textarea>
            </div>
            <div id="sph-freq">
                <div id="sph-freq-head" title="拼接频率：每N次发送自动拼接一次系统提示词，0为关闭">
                    <span id="sph-freq-label">🔁 拼接频率</span>
                    <span id="sph-freq-count" title="距离下次拼接还剩的发送次数"></span>
                    <span id="sph-freq-val"></span>
                </div>
                <div id="sph-freq-body">
                    <div id="sph-freq-opts">
                        <span class="sph-freq-opt" data-freq="0">关闭</span>
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
            <div id="sph-resize-handle"></div>
        `;
        document.body.appendChild(_floatPanel);
        _promptArea = _floatPanel.querySelector('#sph-prompt-area');
        _syncFloatPanelUI();
        // 【改】原"启用拼接"复选框及其 onchange 绑定删除，功能并入频率选择器（关闭=0 / 每次=1 / 每N次=N）
        // 频率选择器绑定：头部点击展开/收起，选项即点即存（交互对齐 PokerAgent 记忆注入频率控件）
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
            if (v > 0) _applyPrependFreq(v); // 0/负数/非数字输入静默忽略，与 PokerAgent 自定义轮数行为一致
        };
        _floatPanel.querySelector('#sph-float-close').onclick = () => hideFloatPanel();
        // 拖拽逻辑
        const head = _floatPanel.querySelector('#sph-float-head');
        head.addEventListener('mousedown', (e) => {
            if (e.target.id === 'sph-float-close') return;
            _isDragging = true;
            _startPos = { x: e.clientX, y: e.clientY };
            _startPanelPos = { x: parseInt(_floatPanel.style.left) || 0, y: parseInt(_floatPanel.style.top) || 0 };
            e.preventDefault();
        });
        // 缩放逻辑
        const resizeHandle = _floatPanel.querySelector('#sph-resize-handle');
        resizeHandle.addEventListener('mousedown', (e) => {
            _isResizing = true;
            _startPos = { x: e.clientX, y: e.clientY };
            _startPanelSize = { width: parseInt(_floatPanel.style.width) || 0, height: parseInt(_floatPanel.style.height) || 0 };
            e.preventDefault();
            e.stopPropagation();
        });
        // 全局鼠标事件 (使用具名函数以便后续清理)
        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mouseup', _onMouseUp);
        // 文本变化保存
        _promptArea.addEventListener('input', () => {
            cfgSaveRuntime({ systemPrompt: _promptArea.value });
        });
        log('INFO', '悬浮窗已创建');
    }

    function _onMouseMove(e) {
        if (_isDragging) {
            _floatPanel.style.left = (_startPanelPos.x + e.clientX - _startPos.x) + 'px';
            _floatPanel.style.top = (_startPanelPos.y + e.clientY - _startPos.y) + 'px';
        } else if (_isResizing) {
            _floatPanel.style.width = Math.max(200, _startPanelSize.width + e.clientX - _startPos.x) + 'px';
            _floatPanel.style.height = Math.max(100, _startPanelSize.height + e.clientY - _startPos.y) + 'px';
        }
    }

    function _onMouseUp() {
        if (_isDragging || _isResizing) {
            cfgSaveRuntime({
                panelPos: {
                    x: parseInt(_floatPanel.style.left) || 0,
                    y: parseInt(_floatPanel.style.top) || 0
                },
                panelSize: {
                    width: parseInt(_floatPanel.style.width) || 320,
                    height: parseInt(_floatPanel.style.height) || 180
                }
            });
        }
        _isDragging = false;
        _isResizing = false;
    }

    /* 【新增】拼接频率辅助函数 */
    // 频率数值 → 显示文案：0=关闭，1=每次，N=每N次
    function _freqLabel(n) {
        const f = parseInt(n);
        if (!f || f <= 0) return '关闭';
        return f === 1 ? '每次' : `每${f}次`;
    }
    // 应用新拼接频率：写入配置并重置倒计时为新周期（避免旧倒计时跨越新频率产生错位）
    function _applyPrependFreq(n) {
        cfgSaveRuntime({ prependFreq: n, prependCountdown: n > 0 ? n : 1 }); // 内部触发 _syncFloatPanelUI → _updateFreqUI 完成刷新
        const body = _floatPanel?.querySelector('#sph-freq-body');
        if (body) body.style.display = 'none'; // 选择后收起选项面板，与 PokerAgent 记忆频率控件行为一致
        log('INFO', `拼接频率切换为: ${_freqLabel(n)}`);
    }
    // 刷新频率选择器显示：当前频率文案、剩余次数倒计时、选项高亮态
    function _updateFreqUI() {
        if (!_floatPanel) return;
        const c = cfgLoad();
        const freq = parseInt(c.prependFreq) || 0;
        const valEl = _floatPanel.querySelector('#sph-freq-val');
        const countEl = _floatPanel.querySelector('#sph-freq-count');
        if (!valEl || !countEl) return;
        valEl.textContent = _freqLabel(freq);
        if (freq >= 2) {
            // 倒计时仅频率≥2时有意义（关闭/每次模式下不存在周期概念）
            let countdown = parseInt(c.prependCountdown);
            if (isNaN(countdown) || countdown < 1) countdown = freq; // 非法状态防御性回落满周期
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
        _updateFreqUI(); // 【改】原复选框同步(enabledCb.checked)删除，改为频率选择器同步
        _updateStatus();
    }

    function _updateStatus(statusText) {
        const status = _floatPanel?.querySelector('#sph-status');
        if (!status) return;
        if (statusText) {
            status.textContent = statusText;
        } else {
            const freq = parseInt(cfgLoad().prependFreq) || 0;
            status.textContent = freq > 0 ? '就绪' : '就绪（拼接已关闭）'; // 【改】判定依据 autoPrepend → prependFreq
        }
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
        _configPanel.querySelector('#sph-config-close').onclick = hideConfigPanel;
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
        // 绑定事件
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
        wlInput.onkeydown = e => {
            if (e.key === 'Enter') doAdd();
        };
        _configPanel.querySelector('#sph-debug-cb').onchange = (e) => {
            const s = _loadStore();
            s.debugMode = e.target.checked;
            _saveStore(s);
            log('INFO', `调试模式已${s.debugMode ? '启用' : '禁用'}`);
        };
        _renderWhitelist();
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
        if (!_lastFocusedInput) return; // 【改】autoPrepend 前置守卫移除，统一收敛到 _onSendDetected 内判定
        const sendBtn = _findSendButton();
        if (sendBtn && sendBtn.contains(e.target)) {
            log('INFO', '检测到发送按钮点击');
            _onSendDetected();
        }
    }

    function _onKeydown(e) {
        if (e.repeat) return; // 【新增】长按Enter的连续keydown只计一次发送（旧版靠includes内容去重兜底，计数模式下必须显式拦截）
        if (!_lastFocusedInput) return; // 【改】同上
        if ((e.ctrlKey && e.key === 'Enter') || (e.key === 'Enter' && !e.shiftKey && _isInInputContext(e.target))) {
            log('INFO', '检测到发送快捷键');
            _onSendDetected();
        }
    }

    /* 【新增】发送检测统一入口：频率判定 + 倒计时推进；实际拼接仍委托 _prependSystemPrompt */
    function _onSendDetected() {
        if (!_lastFocusedInput) return;
        const c = cfgLoad();
        const freq = parseInt(c.prependFreq) || 0;
        if (freq <= 0) return;                                 // 频率关闭：不进入周期
        if (!c.systemPrompt || !c.systemPrompt.trim()) return; // 空提示词：无内容可拼，周期不启动（避免空转计数）
        let countdown = parseInt(c.prependCountdown);
        if (isNaN(countdown) || countdown < 1) countdown = freq; // 倒计时缺失/非法：回落满周期
        countdown--;                                           // 本次发送消耗一次额度
        const willPrepend = countdown <= 0;                    // 本次发送是否触发拼接
        if (willPrepend) countdown = freq;                     // 重置倒计时，开启下一周期
        cfgSaveRuntime({ prependCountdown: countdown });       // 先落账并刷新倒计时显示（内部触发 _syncFloatPanelUI）
        if (willPrepend) _prependSystemPrompt();               // 后执行拼接：保证"已拼接"状态提示不被随后的UI刷新覆盖
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
        if (_abortController) _abortController.abort(); // 防止重复启动
        _abortController = new AbortController();
        const signal = _abortController.signal;
        // 使用 AbortSignal 优雅管理事件生命周期
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
        // 根据初始状态决定是否启动
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
