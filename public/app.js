"use strict";
// pi-monitor frontend - TypeScript source
function $(id) {
    return document.getElementById(id);
}
// -- State ----------------------------------------------------------------------
let lastStatusData = {};
let currentModelId = null;
let availableModelsData = [];
let lastExtensionsData = [];
let recentToolsExpanded = new Set();
let recentToolsCmds = [];
let lastStreamHistory = [];
const expandedStreamSet = new Set();
let authConfirmed = false;
const streamFilters = {
    thinking: localStorage.getItem('pi-monitor-filter-thinking') !== 'off',
    toolResult: localStorage.getItem('pi-monitor-filter-toolResult') !== 'off',
};
// -- Auth -----------------------------------------------------------------------
async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        if (data.success && data.data.authEnabled && !data.data.authenticated) {
            const loginScreen = $('login-screen');
            const mainApp = $('main-app');
            if (loginScreen)
                loginScreen.classList.add('open');
            if (mainApp)
                mainApp.classList.remove('authenticated');
            $('login-password')?.focus();
            return false;
        }
        const loginScreen = $('login-screen');
        const mainApp = $('main-app');
        if (loginScreen)
            loginScreen.classList.remove('open');
        if (mainApp)
            mainApp.classList.add('authenticated');
        return true;
    }
    catch {
        return false;
    }
}
async function doLogin(e) {
    e.preventDefault();
    const pw = $('login-password')?.value ?? '';
    const errEl = $('login-error');
    if (!pw) {
        if (errEl) {
            errEl.textContent = 'Enter password';
            errEl.classList.add('visible');
        }
        return;
    }
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (data.success) {
            const loginScreen = $('login-screen');
            const mainApp = $('main-app');
            if (loginScreen)
                loginScreen.classList.remove('open');
            if (mainApp)
                mainApp.classList.add('authenticated');
            if (errEl)
                errEl.classList.remove('visible');
            const pwInput = $('login-password');
            if (pwInput)
                pwInput.value = '';
            connect();
        }
        else {
            if (errEl) {
                errEl.textContent = data.error || 'Login failed';
                errEl.classList.add('visible');
            }
        }
    }
    catch {
        if (errEl) {
            errEl.textContent = 'Connection error';
            errEl.classList.add('visible');
        }
    }
}
// -- Helpers --------------------------------------------------------------------
function formatNumber(n) {
    if (n >= 1000000)
        return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}
function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMd(text) {
    if (!text)
        return '';
    return window.marked.parse(text);
}
function formatToolCmd(name, args) {
    if (!args)
        return '';
    if (name === 'bash' && typeof args.command === 'string')
        return args.command;
    if (name === 'read' && typeof args.path === 'string')
        return args.path;
    if (name === 'write' && typeof args.path === 'string')
        return args.path;
    if (name === 'edit' && typeof args.path === 'string')
        return args.path;
    if (name === 'find' && typeof args.path === 'string')
        return args.path;
    if (name === 'ls' && typeof args.path === 'string')
        return args.path;
    for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.length > 0)
            return v;
    }
    return '';
}
// -- Card collapse --------------------------------------------------------------
function toggleCard(el) {
    const card = el.closest('.card');
    if (!card)
        return;
    const cardId = card.dataset.cardId;
    const collapsed = card.classList.toggle('collapsed');
    const btn = card.querySelector('.card-toggle');
    if (btn) {
        btn.textContent = collapsed ? '▸' : '▾';
        btn.title = collapsed ? 'Expand' : 'Collapse';
    }
    if (cardId) {
        localStorage.setItem('pi-monitor-card-' + cardId, collapsed ? '1' : '0');
    }
}
function restoreCardStates() {
    document.querySelectorAll('.card[data-card-id]').forEach((card) => {
        const cardId = card.dataset.cardId;
        if (cardId && localStorage.getItem('pi-monitor-card-' + cardId) === '1') {
            card.classList.add('collapsed');
            const btn = card.querySelector('.card-toggle');
            if (btn) {
                btn.textContent = '▸';
                btn.title = 'Expand';
            }
        }
    });
}
// -- Status ---------------------------------------------------------------------
function setStatus(text, type) {
    const statusText = $('status-text');
    const badge = $('status-badge');
    const dot = $('status-dot');
    const header = document.querySelector('.header');
    const streamCard = document.querySelector('.stream-card');
    if (statusText)
        statusText.textContent = text;
    if (badge)
        badge.className = 'status-badge status-' + type;
    if (dot)
        dot.className = 'connection-dot dot-' + (type === 'connected' ? 'green' : type === 'streaming' ? 'yellow' : type === 'disconnected' ? 'red' : 'gray');
    if (streamCard)
        streamCard.classList.toggle('working', type === 'streaming');
    if (header)
        header.classList.toggle('header-disconnected', type === 'disconnected');
    const abortBtn = $('abort-btn');
    if (abortBtn)
        abortBtn.classList.toggle('hidden', type !== 'streaming');
    const modalDot = $('status-modal-dot');
    const modalText = $('status-modal-text');
    if (modalDot)
        modalDot.className = 'connection-dot dot-' + (type === 'connected' ? 'green' : type === 'streaming' ? 'yellow' : type === 'disconnected' ? 'red' : 'gray');
    if (modalText)
        modalText.textContent = text;
}
// -- UI Updates -----------------------------------------------------------------
function updateUI(data) {
    const msgEl = $('stat-messages');
    const reqEl = $('stat-requests');
    if (msgEl)
        msgEl.textContent = String(data.messageCount ?? 0);
    if (reqEl)
        reqEl.textContent = String(data.requestCount ?? 0);
}
function updateStats(data) {
    if (data.tokens) {
        const inputEl = $('stat-input');
        const outputEl = $('stat-output');
        if (inputEl)
            inputEl.textContent = formatNumber(data.tokens.input || 0);
        if (outputEl)
            outputEl.textContent = formatNumber(data.tokens.output || 0);
    }
    if (data.contextUsage) {
        const pct = data.contextUsage.percent ?? 0;
        const infoEl = $('context-info');
        const bar = $('context-bar');
        if (infoEl)
            infoEl.textContent = `${formatNumber(data.contextUsage.tokens || 0)} / ${formatNumber(data.contextUsage.contextWindow || 0)}`;
        if (bar)
            bar.style.width = pct + '%';
    }
    if (typeof data.cost === 'number' && data.cost > 0) {
        const costEl = $('stat-cost');
        if (costEl)
            costEl.textContent = '$' + data.cost.toFixed(4);
    }
}
// -- Models ---------------------------------------------------------------------
function updateModels(models) {
    availableModelsData = models || [];
    const container = $('model-list');
    if (!container)
        return;
    if (lastStatusData.model) {
        const m = lastStatusData.model;
        currentModelId = typeof m === 'string' ? m : (m.id || m.name || null);
    }
    if (!models || models.length === 0) {
        container.innerHTML = '<div class="model-empty">No scoped models configured</div>';
        return;
    }
    let html = '';
    for (const model of models) {
        const isActive = model.id === currentModelId;
        html += `<div class="model-item${isActive ? ' active' : ''}" data-provider="${escHtml(model.provider)}" data-model-id="${escHtml(model.id)}">`;
        html += '<span class="model-dot"></span>';
        html += `<span class="model-name">${escHtml(model.name || model.id)}</span>`;
        html += `<span class="model-provider">${escHtml(model.provider)}</span>`;
        html += '</div>';
    }
    container.innerHTML = html;
    // Attach click handlers
    container.querySelectorAll('.model-item').forEach((item) => {
        item.addEventListener('click', () => {
            const provider = item.dataset.provider;
            const modelId = item.dataset.modelId;
            if (provider && modelId)
                selectModel(provider, modelId);
        });
    });
}
async function selectModel(provider, modelId) {
    try {
        const res = await fetch('/api/set-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, modelId }),
        });
        const data = await res.json();
        if (!data.success)
            console.error('Failed to set model:', data.error);
    }
    catch (err) {
        console.error('Set model error:', err);
    }
}
// -- Extensions -----------------------------------------------------------------
function updateExtensions(data) {
    lastExtensionsData = data || [];
    const container = $('extensions-list');
    if (!container)
        return;
    if (!data || data.length === 0) {
        container.innerHTML = '<div class="ext-empty">No extensions loaded</div>';
        return;
    }
    let html = '';
    for (let i = 0; i < data.length; i++) {
        const ext = data[i];
        const statusClass = ext.status === 'connected' ? 'ext-status-connected' : ext.status === 'error' ? 'ext-status-error' : '';
        const hasDetails = ext.hasConfig && Object.keys(ext.details || {}).length > 0;
        html += '<div class="ext-item">';
        html += `<div class="ext-header${hasDetails ? ' ext-clickable' : ''}" data-ext-idx="${i}">`;
        html += `<span class="connection-dot ${ext.status === 'connected' ? 'dot-green' : ext.status === 'error' ? 'dot-red' : 'dot-gray'}"></span>`;
        html += `<span class="ext-name">${escHtml(ext.displayName || ext.name)}</span>`;
        html += `<span class="ext-status ${statusClass}">${escHtml(ext.status)}</span>`;
        if (hasDetails)
            html += '<span class="ext-chevron">❯</span>';
        html += '</div></div>';
    }
    container.innerHTML = html;
    // Attach click handlers for extension headers
    container.querySelectorAll('.ext-clickable').forEach((header) => {
        header.addEventListener('click', () => {
            const idx = parseInt(header.dataset.extIdx ?? '-1', 10);
            if (idx >= 0)
                openExtModal(idx);
        });
    });
}
function openExtModal(idx) {
    const ext = lastExtensionsData[idx];
    if (!ext)
        return;
    const details = ext.details || {};
    if (Object.keys(details).length === 0)
        return;
    const titleEl = $('ext-modal-title');
    const bodyEl = $('ext-modal-body');
    const modal = $('ext-modal');
    if (titleEl)
        titleEl.textContent = ext.displayName || ext.name;
    let html = '';
    for (const [key, val] of Object.entries(details)) {
        if (key === 'ignoredNumbers')
            continue;
        const displayVal = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        html += '<div class="modal-detail-row">';
        html += `<span class="modal-detail-key">${escHtml(key)}</span>`;
        html += `<span class="modal-detail-val">${escHtml(displayVal)}</span>`;
        html += '</div>';
    }
    if (bodyEl)
        bodyEl.innerHTML = html;
    if (modal)
        modal.classList.add('open');
}
function closeExtModal() {
    const modal = $('ext-modal');
    if (modal)
        modal.classList.remove('open');
}
// -- Status Modal ---------------------------------------------------------------
function openStatusModal() {
    const modal = $('status-modal');
    if (modal)
        modal.classList.add('open');
}
function closeStatusModal() {
    const modal = $('status-modal');
    if (modal)
        modal.classList.remove('open');
}
// -- Session Controls -----------------------------------------------------------
async function restartPi() {
    const btn = $('restart-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⟳ Restarting...';
    }
    try {
        await fetch('/api/restart', { method: 'POST' });
    }
    catch (err) {
        console.error('Restart error:', err);
        if (btn) {
            btn.disabled = false;
            btn.textContent = '⟳ Restart PI';
        }
    }
}
async function abortOperation() {
    const btn = $('abort-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏹ Aborting...';
    }
    try {
        await fetch('/api/abort', { method: 'POST' });
    }
    catch (err) {
        console.error('Abort error:', err);
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '⏹ Abort Operation';
        }
    }
}
async function newSession() {
    const btn = $('new-session-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '✨ Starting...';
    }
    try {
        await fetch('/api/new-session', { method: 'POST' });
        closeStatusModal();
    }
    catch (err) {
        console.error('New session error:', err);
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '✨ New Session';
        }
    }
}
async function doLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    }
    catch { /* ignore */ }
    closeStatusModal();
    const mainApp = $('main-app');
    if (mainApp)
        mainApp.classList.remove('authenticated');
    checkAuthStatus();
}
// -- Recent Tools ---------------------------------------------------------------
function renderRecentTools(tools) {
    const container = $('recent-tools');
    if (!container)
        return;
    if (!tools || tools.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    const prevExpanded = new Set(recentToolsExpanded);
    recentToolsExpanded.clear();
    recentToolsCmds = tools.map((t) => formatToolCmd(t.name, t.args));
    let html = `<div class="recent-tools-title">Last ${tools.length} tools</div>`;
    for (let i = 0; i < tools.length; i++) {
        const t = tools[i];
        const dotClass = t.isError ? 'recent-tool-err' : 'recent-tool-ok';
        const cmd = formatToolCmd(t.name, t.args);
        const truncated = cmd.length > 64;
        const isExpanded = prevExpanded.has(i) && truncated;
        if (isExpanded)
            recentToolsExpanded.add(i);
        const displayCmd = truncated && !isExpanded ? cmd.slice(0, 64) + '…' : cmd;
        html += '<div class="recent-tool-item">';
        html += '<div class="recent-tool-header">';
        html += `<span class="recent-tool-dot ${dotClass}"></span>`;
        html += `<span class="recent-tool-name">${escHtml(t.name)}</span>`;
        html += '</div>';
        if (cmd) {
            html += `<div class="recent-tool-cmd-wrap"><div class="tool-cmd${truncated ? ' tool-cmd-truncated' : ''}${isExpanded ? ' expanded' : ''}" data-cmd-idx="${i}">${escHtml(displayCmd)}</div></div>`;
        }
        html += '</div>';
    }
    container.innerHTML = html;
    // Attach click handlers for tool cmd expand/collapse
    container.querySelectorAll('.tool-cmd-truncated, .tool-cmd.expanded').forEach((el) => {
        el.addEventListener('click', () => toggleToolCmd(el));
    });
}
function toggleToolCmd(el) {
    const idx = parseInt(el.dataset.cmdIdx ?? '-1', 10);
    const full = recentToolsCmds[idx] || '';
    const isExpanded = el.classList.toggle('expanded');
    if (isExpanded) {
        recentToolsExpanded.add(idx);
        el.textContent = full;
    }
    else {
        recentToolsExpanded.delete(idx);
        el.textContent = full.length > 64 ? full.slice(0, 64) + '…' : full;
    }
}
// -- Stream History -------------------------------------------------------------
function streamMsgKey(msg, i, isLast) {
    if (isLast && msg.streaming)
        return 'streaming';
    return i + '|' + (msg.role || '');
}
function renderStreamHistory(messages) {
    // Snapshot previous messages before overwriting, so we can detect
    // when a streaming message gets finalized and migrate expanded state.
    const prevMessages = lastStreamHistory;
    lastStreamHistory = messages;
    const box = $('stream-box');
    if (!box)
        return;
    if (!messages || messages.length === 0) {
        box.innerHTML = '';
        return;
    }
    // Migrate expanded state when streaming message gets finalized.
    // The streaming message uses key 'streaming'; when a new message arrives,
    // it shifts position and gets a position-based key. Transfer the expanded
    // state so it persists across the transition.
    if (expandedStreamSet.has('streaming')) {
        for (let i = 0; i < prevMessages.length; i++) {
            if (prevMessages[i].streaming) {
                const oldKey = streamMsgKey(prevMessages[i], i, i === prevMessages.length - 1);
                if (oldKey === 'streaming' && i < messages.length && !messages[i].streaming) {
                    const newKey = streamMsgKey(messages[i], i, i === messages.length - 1);
                    expandedStreamSet.add(newKey);
                    expandedStreamSet.delete('streaming');
                }
                break;
            }
        }
    }
    // Build index mapping: origIndices[fi] = original index in unfiltered array.
    // Keys are always generated from original indices so they are stable
    // regardless of which messages get filtered out.
    const origIndices = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'thinking' && !streamFilters.thinking)
            continue;
        if (messages[i].role === 'toolResult' && !streamFilters.toolResult)
            continue;
        origIndices.push(i);
    }
    let html = '';
    for (let fi = 0; fi < origIndices.length; fi++) {
        const origIdx = origIndices[fi];
        const msg = messages[origIdx];
        const role = msg.role || '';
        const roleClass = role === 'user' ? 'stream-role-user' : role === 'assistant' ? 'stream-role-assistant' : 'stream-role-' + role;
        const displayText = msg.text || '';
        const isNonText = displayText.startsWith('[');
        const isToolResult = role === 'toolResult';
        const truncLen = role === 'toolResult' || role === 'thinking' ? 128 : role === 'system' ? displayText.length : 2048;
        const truncated = displayText.length > truncLen;
        const msgKey = streamMsgKey(msg, origIdx, origIdx === messages.length - 1);
        const isExpanded = expandedStreamSet.has(msgKey);
        const showText = truncated && !isExpanded ? displayText.slice(0, truncLen) : displayText;
        const isAssistant = role === 'assistant';
        const mdClass = isAssistant ? ' md-rendered' : '';
        const textClass = (isToolResult ? 'stream-tool-output' : 'stream-text' + (isNonText ? ' stream-non-text' : '') + mdClass) + (isExpanded ? ' expanded' : '');
        const renderedText = isAssistant ? renderMd(showText) : escHtml(showText);
        html += '<div class="stream-msg">';
        html += `<div class="stream-role ${roleClass}">${escHtml(role)}${msg.streaming ? ' <span class="stream-cursor"></span>' : ''}</div>`;
        html += `<div class="${textClass}" data-full="${escHtml(displayText)}" data-role="${role}" data-key="${escHtml(msgKey)}">${renderedText}</div>`;
        if (truncated) {
            html += `<div class="stream-text-truncated" data-key="${escHtml(msgKey)}">${isExpanded ? '▾ collapse' : '▸ ' + (displayText.length - truncLen) + ' more characters - click to expand'}</div>`;
        }
        html += '</div>';
    }
    box.innerHTML = html;
    // Attach click handlers for truncation toggles
    box.querySelectorAll('.stream-text-truncated').forEach((el) => {
        el.addEventListener('click', () => toggleStreamExpand(el));
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            box.scrollTop = box.scrollHeight;
        });
    });
}
function toggleStreamExpand(el) {
    const textEl = el.previousElementSibling;
    if (!textEl)
        return;
    const fullText = textEl.dataset.full || '';
    const key = textEl.dataset.key || '';
    const isAssistant = textEl.classList.contains('md-rendered');
    const role = textEl.dataset.role || '';
    const truncLen = role === 'toolResult' || role === 'thinking' ? 128 : role === 'system' ? fullText.length : 2048;
    const isExpanding = !textEl.classList.contains('expanded');
    if (isExpanding) {
        expandedStreamSet.add(key);
        textEl.classList.add('expanded');
        textEl.innerHTML = isAssistant ? renderMd(fullText) : escHtml(fullText);
        el.textContent = '▾ collapse';
    }
    else {
        expandedStreamSet.delete(key);
        textEl.classList.remove('expanded');
        const truncated = fullText.slice(0, truncLen);
        textEl.innerHTML = isAssistant ? renderMd(truncated) : escHtml(truncated);
        el.textContent = '▸ ' + (fullText.length - truncLen) + ' more characters - click to expand';
    }
}
// -- Stream Filters -------------------------------------------------------------
function toggleStreamFilter(btn) {
    const filter = btn.dataset.filter;
    if (!filter)
        return;
    streamFilters[filter] = !streamFilters[filter];
    btn.classList.toggle('active', streamFilters[filter]);
    localStorage.setItem('pi-monitor-filter-' + filter, streamFilters[filter] ? 'on' : 'off');
    renderStreamHistory(lastStreamHistory);
}
// -- Chat -----------------------------------------------------------------------
async function sendChatMessage() {
    const chatInput = $('chat-input');
    const chatSend = $('chat-send');
    const text = chatInput?.value?.trim() ?? '';
    if (!text)
        return;
    if (text === '/new' || text === '/clear') {
        if (chatInput) {
            chatInput.value = '';
            chatInput.style.height = 'auto';
        }
        newSession();
        return;
    }
    if (chatSend)
        chatSend.disabled = true;
    if (chatInput)
        chatInput.disabled = true;
    try {
        const res = await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });
        const data = await res.json();
        if (data.success) {
            if (chatInput) {
                chatInput.value = '';
                chatInput.style.height = 'auto';
            }
        }
        else {
            console.error('Failed to send:', data.error);
        }
    }
    catch (err) {
        console.error('Send error:', err);
    }
    finally {
        if (chatSend)
            chatSend.disabled = false;
        if (chatInput) {
            chatInput.disabled = false;
            chatInput.focus();
        }
    }
}
// -- SSE Connection -------------------------------------------------------------
async function connect() {
    if (!authConfirmed) {
        if (!(await checkAuthStatus()))
            return;
    }
    const evtSource = new EventSource('/events');
    evtSource.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') {
            lastStatusData = msg.data;
            updateUI(lastStatusData);
            if (lastStatusData.isStreaming) {
                setStatus('Working', 'streaming');
            }
            else {
                setStatus('Idle', 'connected');
            }
        }
        if (msg.type === 'stats') {
            updateStats(msg.data);
        }
        if (msg.type === 'stream_history') {
            renderStreamHistory(msg.data);
        }
        if (msg.type === 'models') {
            updateModels(msg.data);
        }
        if (msg.type === 'tool_start') {
            const toolData = msg.data;
            const list = $('tool-list');
            if (list) {
                const placeholder = list.querySelector('.tool-empty');
                if (placeholder)
                    placeholder.remove();
                const chip = document.createElement('div');
                chip.className = 'tool-chip';
                chip.id = 'tool-' + toolData.id;
                let inner = `<div class="spinner"></div> ${escHtml(toolData.name)}`;
                if (toolData.cmd) {
                    inner += `<div class="tool-cmd tool-cmd-active">${escHtml(toolData.cmd)}</div>`;
                }
                chip.innerHTML = inner;
                list.appendChild(chip);
            }
        }
        if (msg.type === 'tool_end') {
            const toolData = msg.data;
            const chip = $('tool-' + toolData.id);
            if (chip)
                chip.remove();
            const list = $('tool-list');
            if (list && list.children.length === 0) {
                list.innerHTML = '<span class="tool-empty">No active tools</span>';
            }
            if (toolData.recentTools) {
                renderRecentTools(toolData.recentTools);
            }
        }
        if (msg.type === 'extensions') {
            updateExtensions(msg.data);
        }
    };
    let reconnectAttempts = 0;
    evtSource.onerror = () => {
        setStatus('Disconnected', 'disconnected');
        evtSource.close();
        reconnectAttempts++;
        if (reconnectAttempts > 3) {
            checkAuthStatus().then((ok) => {
                if (!ok) {
                    reconnectAttempts = 0;
                    authConfirmed = false;
                    return;
                }
                setTimeout(connect, 2000);
            });
        }
        else {
            setTimeout(connect, 2000);
        }
    };
    evtSource.onopen = () => {
        reconnectAttempts = 0;
        authConfirmed = true;
        setStatus('Connected', 'connected');
        const btn = $('restart-btn');
        if (btn && btn.disabled) {
            btn.disabled = false;
            btn.textContent = '⟳ Restart PI';
        }
    };
}
// -- Init -----------------------------------------------------------------------
function init() {
    restoreCardStates();
    // Login form
    const loginForm = $('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', doLogin);
    }
    // Modal overlay clicks to close
    const extModal = $('ext-modal');
    if (extModal) {
        extModal.addEventListener('click', (e) => {
            if (e.target === extModal)
                closeExtModal();
        });
    }
    const statusModal = $('status-modal');
    if (statusModal) {
        statusModal.addEventListener('click', (e) => {
            if (e.target === statusModal)
                closeStatusModal();
        });
    }
    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeExtModal();
            closeStatusModal();
        }
    });
    // Card toggle click handlers
    document.querySelectorAll('.card-header').forEach((header) => {
        header.addEventListener('click', () => toggleCard(header));
    });
    // Stream filter toggle handlers
    document.querySelectorAll('.stream-toggle').forEach((btn) => {
        const filter = btn.dataset.filter;
        if (filter && streamFilters[filter] !== undefined) {
            btn.classList.toggle('active', streamFilters[filter]);
        }
        btn.addEventListener('click', () => toggleStreamFilter(btn));
    });
    // Chat input auto-resize
    const chatInput = $('chat-input');
    if (chatInput) {
        const autoResize = () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
        };
        chatInput.addEventListener('input', autoResize);
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
    // Chat send button
    const chatSend = $('chat-send');
    if (chatSend) {
        chatSend.addEventListener('click', sendChatMessage);
    }
    // Status badge click
    const statusBadge = $('status-badge');
    if (statusBadge) {
        statusBadge.addEventListener('click', openStatusModal);
    }
    // Status modal buttons
    const abortBtn = $('abort-btn');
    if (abortBtn)
        abortBtn.addEventListener('click', abortOperation);
    const newSessionBtn = $('new-session-btn');
    if (newSessionBtn)
        newSessionBtn.addEventListener('click', newSession);
    const logoutBtn = $('logout-btn');
    if (logoutBtn)
        logoutBtn.addEventListener('click', doLogout);
    const restartBtn = $('restart-btn');
    if (restartBtn)
        restartBtn.addEventListener('click', restartPi);
    // Start SSE connection
    connect();
}
// Make functions globally available for any remaining inline handlers
window.doLogin = doLogin;
window.toggleCard = toggleCard;
window.toggleStreamFilter = toggleStreamFilter;
window.sendChatMessage = sendChatMessage;
window.openStatusModal = openStatusModal;
window.closeStatusModal = closeStatusModal;
window.closeExtModal = closeExtModal;
window.restartPi = restartPi;
window.abortOperation = abortOperation;
window.newSession = newSession;
window.doLogout = doLogout;
// Boot
init();
