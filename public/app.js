// === CC-Web Frontend ===
(function () {
  'use strict';

  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const RENDER_DEBOUNCE = 100;

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: '清除当前会话' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/mode', desc: '查看/切换权限模式' },
    { cmd: '/cost', desc: '查看会话费用' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/init', desc: '生成/更新 Agent 指南文件' },
    { cmd: '/github', desc: 'GitHub 操作（读取开发者配置后执行）' },
    { cmd: '/ssh', desc: 'SSH 远程操作（读取开发者配置后执行）' },
    { cmd: '/help', desc: '显示帮助' },
  ];

  const MODE_LABELS = {
    default: '默认',
    plan: 'Plan',
    yolo: 'YOLO',
  };

  const AGENT_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
  };

  const DEFAULT_AGENT = 'claude';
  const SESSION_CACHE_LIMIT = 4;
  const SESSION_CACHE_MAX_WEIGHT = 1_500_000;
  const SIDEBAR_SWIPE_TRIGGER = 72;
  const SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT = 42;

  const MODEL_OPTIONS = [
    { value: 'opus', label: 'Opus', desc: '最强大，1M 上下文' },
    { value: 'sonnet', label: 'Sonnet', desc: '平衡性能，1M 上下文' },
    { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
  ];

  function getModePickerOptions(agent = currentAgent) {
    if (normalizeAgent(agent) === 'codex') {
      return [
        {
          value: 'yolo',
          label: 'YOLO',
          desc: '直接放开审批与沙箱限制',
        },
        { value: 'default', label: '默认', desc: 'Codex full-auto，可直接执行并修改文件' },
        { value: 'plan', label: 'Plan', desc: '只读沙箱，适合先分析方案，不能直接改文件' },
      ];
    }
    return [
      {
        value: 'yolo',
        label: 'YOLO',
        desc: isRootOrSudo ? '当前为 root/sudo 环境，会自动降级为默认模式' : '跳过所有权限检查',
      },
      { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
      { value: 'default', label: '默认', desc: '标准权限审批' },
    ];
  }

  function currentModeDescription(mode, agent = currentAgent) {
    if (normalizeAgent(agent) === 'codex') {
      if (mode === 'yolo') return 'YOLO（跳过审批与沙箱限制）';
      if (mode === 'plan') return 'Plan（只读沙箱，不能直接改文件）';
      return '默认（Codex full-auto，可直接执行并修改文件）';
    }
    if (mode === 'yolo' && isRootOrSudo) return 'YOLO（当前环境会自动降级为默认模式）';
    if (mode === 'yolo') return 'YOLO（跳过所有权限检查）';
    if (mode === 'plan') return 'Plan（执行前需确认计划）';
    return '默认（标准权限审批）';
  }

  const THEME_OPTIONS = [
    {
      value: 'washi',
      label: 'Washi Warm',
      desc: '暖纸色与朱砂点缀，保留当前熟悉的 CC-Web 气质。',
      swatches: ['#faf6f0', '#f2ebe2', '#c0553a', '#5d8a54'],
    },
    {
      value: 'coolvibe',
      label: 'CoolVibe Light',
      desc: '保留 CoolVibe 的青色科技感，但改成更干净的浅色工作台。',
      swatches: ['#f7fbfc', '#eef7f9', '#0891b2', '#ffffff'],
    },
    {
      value: 'editorial',
      label: 'Editorial Sand',
      desc: '更明亮的留白和更克制的棕色强调，像编辑台一样安静。',
      swatches: ['#f6f1e8', '#efe8dc', '#8b5e3c', '#2f4b45'],
    },
  ];

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('cc-web-token');
  let isAuthenticated = false;
  let currentSessionId = null;
  let sessions = [];
  const SESSION_LIST_CACHE_KEY = 'cc-web-session-list-cache';
  let sessionCache = new Map();
  let isGenerating = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let preserveSessionViewOnReconnect = false;
  let pendingLoginPassword = '';
  let pendingText = '';
  let renderTimer = null;
  let followLatestOutput = true;
  let activeToolCalls = new Map();
  let toolGroupCount = 0;   // 当前 .msg-tools 直接子节点数（含已有父目录）
  let hasGrouped = false;  // 本次输出是否已触发过折叠
  let cmdMenuIndex = -1;
  let currentMode = 'yolo';
  let currentModel = 'opus';
  let currentAgent = AGENT_LABELS[localStorage.getItem('cc-web-agent')] ? localStorage.getItem('cc-web-agent') : DEFAULT_AGENT;
  let currentTheme = (document.documentElement.dataset.theme || localStorage.getItem('cc-web-theme') || 'washi');
  let codexConfigCache = null;
  let loadedHistorySessionId = null;
  let activeSessionLoad = null;
  let sidebarSwipe = null;
  let pendingAttachments = [];
  let uploadingAttachments = [];
  const pendingOutboundMessages = new Map();
  // 单条消息最多附带的图片数量。后端默认同样为 20，可用环境变量 CC_MAX_MESSAGE_ATTACHMENTS 调整；
  // 后端会对超量部分做兜底截断，这里仅用于前端提示。
  const MAX_MESSAGE_ATTACHMENTS = 20;
  // 待处理的「重新发送」：先截断到目标消息，收到 session_truncated 后再把该文本重发一次。
  let pendingResend = null;
  let loginPasswordValue = ''; // store login password for force-change flow
  let isRootOrSudo = false;
  let currentCwd = null;
  let fileBrowserPath = null;
  let sidebarToolsHeightPx = 0;
  let fileBrowserContextMenu = null;
  let fileBrowserMenuDocClickHandler = null;
  let fileBrowserMenuDocContextHandler = null;
  let activeToolTab = 'files';
  let commandHistory = [];
  let commandCwdOverride = '';
  let commandExecState = createEmptyCommandExecState();
  let commandExecSyncPromise = null;
  let lastCommandExecSyncAt = 0;
  let currentSessionRunning = false;
  let skipDeleteConfirm = localStorage.getItem('cc-web-skip-delete-confirm') === '1';
  let pendingInitialSessionLoad = false;
  let initialPreferredSessionId = getLastSessionForAgent(currentAgent) || '';
  let initialPreferredSessionApplied = false;
  let initialPreferredFallbackTimer = null;
  let securityStatusCache = null;
  let fileBrowserRefreshSeq = 0;
  let deferredRuntimeMessages = [];
  let deferredRuntimeSessionId = null;
  let replayingDeferredRuntimeMessages = false;
  let historyChunkQueue = [];
  let historyChunkFrame = 0;
  let historyChunkSessionId = null;

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sessionLoadingOverlay = $('#session-loading-overlay');
  const sessionLoadingLabel = $('#session-loading-label');
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const chatMain = document.querySelector('.chat-main');
  const newChatSplit = sidebar.querySelector('.new-chat-split');
  const newChatBtn = $('#new-chat-btn');
  const newChatArrow = $('#new-chat-arrow');
  const newChatDropdown = $('#new-chat-dropdown');
  const importSessionBtn = $('#import-session-btn');
  const sessionList = $('#session-list');
  const sidebarToolsHeightResizer = $('#sidebar-tools-height-resizer');
  const sidebarTools = $('#sidebar-tools');
  const toolTabFiles = $('#tool-tab-files');
  const toolTabCmd = $('#tool-tab-cmd');
  const fileBrowserPanel = $('#file-browser-panel');
  const cmdPanel = $('#cmd-panel');
  const chatTitle = $('#chat-title');
  const chatAgentBtn = $('#chat-agent-btn');
  const chatAgentMenu = $('#chat-agent-menu');
  const chatRuntimeState = $('#chat-runtime-state');
  const chatCwd = $('#chat-cwd');
  const costDisplay = $('#cost-display');
  const attachmentTray = $('#attachment-tray');
  const imageUploadInput = $('#image-upload-input');
  const attachBtn = $('#attach-btn');
  const messagesDiv = $('#messages');
  const msgInput = $('#msg-input');
  const inputWrapper = msgInput.closest('.input-wrapper');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const cmdMenu = $('#cmd-menu');
  const modeSelect = $('#mode-select');

  // --- Viewport height fix for mobile browsers ---
  function setVH() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));

  function buildWelcomeMarkup(agent) {
    const label = AGENT_LABELS[agent] || AGENT_LABELS.claude;
    return `<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 ${label} 对话</p></div>`;
  }

  function normalizeAgent(agent) {
    return AGENT_LABELS[agent] ? agent : DEFAULT_AGENT;
  }

  function normalizeTheme(theme) {
    return THEME_OPTIONS.some((item) => item.value === theme) ? theme : 'washi';
  }

  function getThemeOption(theme) {
    return THEME_OPTIONS.find((item) => item.value === normalizeTheme(theme)) || THEME_OPTIONS[0];
  }

  function refreshThemeSummaries() {
    const label = getThemeOption(currentTheme).label;
    document.querySelectorAll('[data-theme-summary]').forEach((node) => {
      node.textContent = label;
    });
  }

  function applyTheme(theme) {
    currentTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = currentTheme;
    localStorage.setItem('cc-web-theme', currentTheme);
    refreshThemeSummaries();
  }

  function buildThemePickerHtml(options = {}) {
    const { showSectionTitle = true } = options;
    return `
      ${showSectionTitle ? '<div class="settings-section-title">界面主题</div>' : ''}
      <div class="theme-grid">
        ${THEME_OPTIONS.map((theme) => `
          <button class="theme-card${theme.value === currentTheme ? ' active' : ''}" type="button" data-theme-value="${theme.value}">
            <div class="theme-card-preview">
              ${theme.swatches.map((color) => `<span class="theme-card-swatch" style="background:${color}"></span>`).join('')}
            </div>
            <div class="theme-card-title">${escapeHtml(theme.label)}</div>
            <div class="theme-card-desc">${escapeHtml(theme.desc)}</div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function syncModePickerText() {
    const hint = currentModeDescription(currentMode);
    const modeLabel = document.querySelector('#mode-select');
    if (modeLabel) modeLabel.title = hint;
    const currentModeTag = document.querySelector('.chat-runtime-state');
    if (currentModeTag && currentModeTag.textContent.includes('运行中')) {
      currentModeTag.title = hint;
    }
  }

  function mountThemePicker(panel) {
    panel.querySelectorAll('[data-theme-value]').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(button.dataset.themeValue);
        panel.querySelectorAll('[data-theme-value]').forEach((item) => {
          item.classList.toggle('active', item.dataset.themeValue === currentTheme);
        });
      });
    });
  }

  function buildThemeEntryHtml() {
    return `
      <div class="settings-section-title">外观</div>
      <button class="settings-nav-card" type="button" data-open-theme-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">界面主题</span>
          <span class="settings-nav-card-meta">当前：<span data-theme-summary>${escapeHtml(getThemeOption(currentTheme).label)}</span></span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function buildNotifyEntryHtml(config) {
    const provider = config?.provider || 'off';
    const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
    const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
    const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
    return `
      <div class="settings-section-title">通知</div>
      <button class="settings-nav-card" type="button" data-open-notify-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">通知设置</span>
          <span class="settings-nav-card-meta" data-notify-summary>${escapeHtml(meta)}</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function openNotifySubpage() {
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Notification</div>
          <h3>通知设置</h3>
        </div>
      </div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${PROVIDER_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div id="notify-summary-area"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const summaryArea = panel.querySelector('#notify-summary-area');
    const statusDiv = panel.querySelector('#notify-status');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    let currentNotifyConfig = null;

    function renderFields(provider) {
      renderNotifyFields(fieldsDiv, currentNotifyConfig, provider);
      if (summaryArea) {
        summaryArea.innerHTML = buildSummarySettingsHtml(currentNotifyConfig);
        bindSummarySettingsEvents(panel);
      }
    }

    function collectConfig() {
      return collectNotifyConfigFromPanel(panel, currentNotifyConfig, providerSelect.value);
    }

    function showStatus(msg, type) {
      statusDiv.textContent = msg;
      statusDiv.className = 'settings-status ' + (type || '');
    }

    function refreshParentSummary(config) {
      const provider = config?.provider || 'off';
      const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
      const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
      const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
      document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
    }

    const savedOnNotifyConfig = _onNotifyConfig;
    _onNotifyConfig = (config) => {
      currentNotifyConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
      if (savedOnNotifyConfig) savedOnNotifyConfig(config);
    };

    const savedOnNotifyTestResult = _onNotifyTestResult;
    _onNotifyTestResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
      if (savedOnNotifyTestResult) savedOnNotifyTestResult(msg);
    };

    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    testBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      refreshParentSummary(config);
      showStatus('已保存', 'success');
    });

    const closeSubpage = () => {
      _onNotifyConfig = savedOnNotifyConfig;
      _onNotifyTestResult = savedOnNotifyTestResult;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubpage(); });
  }

  function openDevSettingsSubpage() {
    send({ type: 'get_dev_config' });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.id = 'dev-settings-subpage';
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header">
        <h3>开发者设置</h3>
        <button class="settings-close" id="dev-close">&times;</button>
      </div>
      <div class="settings-section-title">GitHub</div>
      <div class="settings-field">
        <label>Token</label>
        <input type="text" id="dev-github-token" placeholder="ghp_..." value="">
      </div>
      <div id="dev-github-repos"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-repo-add" style="padding:4px 12px">+ 添加仓库</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">SSH 主机</div>
      <div id="dev-ssh-hosts"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-host-add" style="padding:4px 12px">+ 添加主机</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-actions">
        <button class="btn-save" id="dev-save-btn">保存开发者配置</button>
      </div>
      <div class="settings-status" id="dev-status"></div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const closeBtn = panel.querySelector('#dev-close');
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    let editingRepos = [];
    let editingHosts = [];

    function renderRepos() {
      const container = panel.querySelector('#dev-github-repos');
      if (editingRepos.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无仓库</div>';
        return;
      }
      container.innerHTML = editingRepos.map((repo, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(repo.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-repo-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-repo-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(repo.url || '')} · ${escapeHtml(repo.branch || 'main')}${repo.notes ? ' · ' + escapeHtml(repo.notes) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-repo-edit]').forEach(btn => {
        btn.addEventListener('click', () => openRepoEditModal(parseInt(btn.dataset.repoEdit)));
      });
      container.querySelectorAll('[data-repo-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.repoDel);
          editingRepos.splice(idx, 1);
          renderRepos();
        });
      });
    }

    function openRepoEditModal(index = -1) {
      const existing = index >= 0 ? editingRepos[index] : null;
      const draft = existing || { id: '', name: '', url: '', branch: 'main', notes: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑仓库' : '添加仓库'}</h3>
          <button class="settings-close" id="repo-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="repo-name" placeholder="cc-web" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>URL</label><input type="text" id="repo-url" placeholder="https://github.com/user/repo" value="${escapeHtml(draft.url)}"></div>
        <div class="settings-field"><label>分支</label><input type="text" id="repo-branch" placeholder="main" value="${escapeHtml(draft.branch || 'main')}"></div>
        <div class="settings-field"><label>备注</label><input type="text" id="repo-notes" placeholder="说明" value="${escapeHtml(draft.notes || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="repo-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#repo-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#repo-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#repo-name').value.trim();
        const url = modal.querySelector('#repo-url').value.trim();
        if (!name || !url) { alert('请填写名称和 URL'); return; }
        const data = {
          id: draft.id || '',
          name,
          url,
          branch: modal.querySelector('#repo-branch').value.trim() || 'main',
          notes: modal.querySelector('#repo-notes').value.trim(),
        };
        if (existing) {
          editingRepos[index] = data;
        } else {
          editingRepos.push(data);
        }
        closeModal();
        renderRepos();
      });
    }

    function renderHosts() {
      const container = panel.querySelector('#dev-ssh-hosts');
      if (editingHosts.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无 SSH 主机</div>';
        return;
      }
      container.innerHTML = editingHosts.map((host, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(host.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-host-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-host-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22} · ${(host.authType || 'key') === 'password' ? '密码认证' : '密钥认证'}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-host-edit]').forEach(btn => {
        btn.addEventListener('click', () => openHostEditModal(parseInt(btn.dataset.hostEdit)));
      });
      container.querySelectorAll('[data-host-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.hostDel);
          editingHosts.splice(idx, 1);
          renderHosts();
        });
      });
    }

    function openHostEditModal(index = -1) {
      const existing = index >= 0 ? editingHosts[index] : null;
      const draft = existing || { id: '', name: '', host: '', port: 22, user: '', authType: 'key', identityFile: '', password: '', description: '' };
      const isKey = (draft.authType || 'key') === 'key';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑主机' : '添加主机'}</h3>
          <button class="settings-close" id="host-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="host-name" placeholder="主机01" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>地址</label><input type="text" id="host-host" placeholder="192.168.1.100" value="${escapeHtml(draft.host)}"></div>
        <div class="settings-field"><label>端口</label><input type="number" id="host-port" placeholder="22" value="${draft.port || 22}"></div>
        <div class="settings-field"><label>用户</label><input type="text" id="host-user" placeholder="root" value="${escapeHtml(draft.user)}"></div>
        <div class="settings-field">
          <label>认证方式</label>
          <div style="display:flex;gap:12px">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="key" ${isKey ? 'checked' : ''}> 密钥</label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="password" ${!isKey ? 'checked' : ''}> 密码</label>
          </div>
        </div>
        <div id="host-auth-key-field" class="settings-field" style="${isKey ? '' : 'display:none'}">
          <label>密钥路径</label><input type="text" id="host-identity" placeholder="~/.ssh/id_ed25519" value="${escapeHtml(draft.identityFile)}">
        </div>
        <div id="host-auth-pw-field" class="settings-field" style="${!isKey ? '' : 'display:none'}">
          <label>密码</label><input type="password" id="host-password" placeholder="SSH 登录密码" value="${escapeHtml(draft.password || '')}">
        </div>
        <div class="settings-field"><label>说明</label><input type="text" id="host-desc" placeholder="测试服务器" value="${escapeHtml(draft.description || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="host-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      // Toggle auth fields
      const keyField = modal.querySelector('#host-auth-key-field');
      const pwField = modal.querySelector('#host-auth-pw-field');
      modal.querySelectorAll('input[name="host-auth-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const isKeyMode = radio.value === 'key' && radio.checked;
          keyField.style.display = isKeyMode ? '' : 'none';
          pwField.style.display = isKeyMode ? 'none' : '';
        });
      });

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#host-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#host-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#host-name').value.trim();
        const host = modal.querySelector('#host-host').value.trim();
        if (!name || !host) { alert('请填写名称和地址'); return; }
        const authType = modal.querySelector('input[name="host-auth-type"]:checked')?.value || 'key';
        const data = {
          id: draft.id || '',
          name,
          host,
          port: parseInt(modal.querySelector('#host-port').value) || 22,
          user: modal.querySelector('#host-user').value.trim(),
          authType,
          identityFile: authType === 'key' ? modal.querySelector('#host-identity').value.trim() : '',
          password: authType === 'password' ? modal.querySelector('#host-password').value : '',
          description: modal.querySelector('#host-desc').value.trim(),
        };
        if (existing) {
          editingHosts[index] = data;
        } else {
          editingHosts.push(data);
        }
        closeModal();
        renderHosts();
      });
    }

    panel.querySelector('#dev-repo-add').addEventListener('click', () => openRepoEditModal());
    panel.querySelector('#dev-host-add').addEventListener('click', () => openHostEditModal());

    panel.querySelector('#dev-save-btn').addEventListener('click', () => {
      const token = panel.querySelector('#dev-github-token').value.trim();
      send({
        type: 'save_dev_config',
        config: {
          github: { token, repos: editingRepos },
          ssh: { hosts: editingHosts },
        },
      });
      panel.querySelector('#dev-status').textContent = '已保存';
      panel.querySelector('#dev-status').className = 'settings-status success';
    });

    _onDevConfig = (config) => {
      panel.querySelector('#dev-github-token').value = config.github?.token || '';
      editingRepos = (config.github?.repos || []).map(r => ({ ...r }));
      editingHosts = (config.ssh?.hosts || []).map(h => ({ ...h }));
      renderRepos();
      renderHosts();
    };
  }

  let _onSecurityStatus = null;
  let _onSecurityActionResult = null;

  function openSecuritySubpage() {
    send({ type: 'get_security_status' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Security</div>
          <h3>安全与访问</h3>
        </div>
      </div>
      <div class="settings-inline-note">
        连续输错密码 3 次后，该 IP 会被封禁 7 天。这里可以查看当前封禁列表并手动解封。
      </div>
      <div id="security-summary" class="settings-inline-note" style="margin-top:10px"></div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">当前状态</div>
      <div id="security-current-status"></div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">被禁 IP 列表</div>
      <div id="security-ban-list"></div>
      <div class="settings-actions">
        <button class="btn-test" id="security-refresh-btn">刷新</button>
        <button class="btn-test" id="security-clear-btn">清空全部封禁</button>
      </div>
      <div class="settings-status" id="security-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const summaryDiv = panel.querySelector('#security-summary');
    const currentStatusDiv = panel.querySelector('#security-current-status');
    const banListDiv = panel.querySelector('#security-ban-list');
    const statusDiv = panel.querySelector('#security-status');
    const refreshBtn = panel.querySelector('#security-refresh-btn');
    const clearBtn = panel.querySelector('#security-clear-btn');

    const savedOnSecurityStatus = _onSecurityStatus;
    const savedOnSecurityActionResult = _onSecurityActionResult;

    function showStatus(message, type) {
      statusDiv.textContent = message || '';
      statusDiv.className = `settings-status ${type || ''}`.trim();
    }

    function renderCurrentStatus(data) {
      const currentIp = escapeHtml(data?.currentIp || '未知');
      const currentBan = data?.currentBan;
      const lines = [
        `<div class="settings-inline-note">当前访问 IP：<code>${currentIp}</code></div>`,
        `<div class="settings-inline-note">封禁规则：${data?.failMax || 3} 次失败 / ${formatDuration(data?.failWindowMs || 0)} 窗口，封禁 ${formatDuration(data?.banDurationMs || 0)}</div>`,
      ];
      if (currentBan?.permanent) {
        lines.push('<div class="settings-inline-note" style="color:var(--text-error, #e85d5d)">当前 IP 已被永久封禁</div>');
      } else if (currentBan) {
        lines.push(`<div class="settings-inline-note" style="color:var(--text-error, #e85d5d)">当前 IP 已被封禁，剩余 ${formatDuration(currentBan.remainingMs)}，预计于 ${formatDateTime(currentBan.expiresAtIso)} 自动解封</div>`);
      } else {
        lines.push('<div class="settings-inline-note" style="color:var(--success)">当前 IP 未被封禁</div>');
      }
      currentStatusDiv.innerHTML = lines.join('');
    }

    function renderBanList(data) {
      const list = Array.isArray(data?.bannedIPs) ? data.bannedIPs : [];
      if (!list.length) {
        banListDiv.innerHTML = '<div class="settings-inline-note">当前没有被封禁的 IP</div>';
        return;
      }
      banListDiv.innerHTML = list.map((item) => `
        <div class="settings-field" style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <div>
              <div><strong><code>${escapeHtml(item.ip || '')}</code></strong></div>
              <div class="settings-inline-note">剩余：${item.permanent ? '永久' : formatDuration(item.remainingMs)}</div>
              <div class="settings-inline-note">解封时间：${item.permanent ? '永久封禁' : formatDateTime(item.expiresAtIso)}</div>
            </div>
            <button class="btn-test" data-unban-ip="${escapeHtml(item.ip || '')}" style="padding:4px 12px;white-space:nowrap">解封</button>
          </div>
        </div>
      `).join('');
      banListDiv.querySelectorAll('[data-unban-ip]').forEach((button) => {
        button.addEventListener('click', () => {
          const ip = button.getAttribute('data-unban-ip') || '';
          if (!ip) return;
          button.disabled = true;
          showStatus(`正在解封 ${ip} ...`, '');
          send({ type: 'unban_ip', ip });
        });
      });
    }

    function renderSecurityStatus(data) {
      securityStatusCache = data || null;
      const count = Array.isArray(data?.bannedIPs) ? data.bannedIPs.length : 0;
      summaryDiv.textContent = count ? `当前共有 ${count} 个 IP 在封禁列表中。` : '当前封禁列表为空。';
      renderCurrentStatus(data || {});
      renderBanList(data || {});
    }

    _onSecurityStatus = (data) => {
      renderSecurityStatus(data);
      if (savedOnSecurityStatus) savedOnSecurityStatus(data);
    };

    _onSecurityActionResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
      if (savedOnSecurityActionResult) savedOnSecurityActionResult(msg);
    };

    refreshBtn.addEventListener('click', () => {
      showStatus('正在刷新...', '');
      send({ type: 'get_security_status' });
    });

    clearBtn.addEventListener('click', () => {
      if (!confirm('确认清空全部封禁记录？')) return;
      showStatus('正在清空封禁列表...', '');
      send({ type: 'clear_banned_ips' });
    });

    const closeSubpage = () => {
      _onSecurityStatus = savedOnSecurityStatus;
      _onSecurityActionResult = savedOnSecurityActionResult;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubpage(); });

    if (securityStatusCache) renderSecurityStatus(securityStatusCache);
  }

  function openThemeSubpage() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Appearance</div>
          <h3>界面主题</h3>
        </div>
        <button class="settings-close" type="button" title="关闭">&times;</button>
      </div>
      ${buildThemePickerHtml({ showSectionTitle: false })}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    mountThemePicker(panel);
    refreshThemeSummaries();

    const closeSubpage = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    panel.querySelector('.settings-close').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubpage();
    });
  }

  function getAgentSessionStorageKey(agent) {
    return `cc-web-session-${normalizeAgent(agent)}`;
  }

  function getAgentModeStorageKey(agent) {
    return `cc-web-mode-${normalizeAgent(agent)}`;
  }

  function getLastSessionForAgent(agent) {
    return localStorage.getItem(getAgentSessionStorageKey(agent));
  }

  function setLastSessionForAgent(agent, sessionId) {
    localStorage.setItem(getAgentSessionStorageKey(agent), sessionId);
    localStorage.setItem('cc-web-session', sessionId);
  }

  function getSessionMeta(sessionId) {
    return sessions.find((s) => s.id === sessionId) || null;
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function cloneMessages(messages) {
    return Array.isArray(messages) ? deepClone(messages) : [];
  }

  function estimateSessionMessageWeight(message) {
    const content = typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content || '').length;
    const toolCalls = Array.isArray(message?.toolCalls) ? JSON.stringify(message.toolCalls).length : 0;
    return content + toolCalls + 64;
  }

  function estimateSessionSnapshotWeight(snapshot) {
    const base = JSON.stringify({
      title: snapshot.title || '',
      mode: snapshot.mode || '',
      model: snapshot.model || '',
      agent: snapshot.agent || '',
      cwd: snapshot.cwd || '',
      updated: snapshot.updated || '',
    }).length;
    return base + (snapshot.messages || []).reduce((sum, message) => sum + estimateSessionMessageWeight(message), 0);
  }

  function normalizeSessionSnapshot(payload, options = {}) {
    return {
      sessionId: payload.sessionId,
      messages: cloneMessages(payload.messages || []),
      title: payload.title || '新会话',
      mode: payload.mode || 'yolo',
      model: payload.model || '',
      agent: normalizeAgent(payload.agent),
      hasUnread: !!payload.hasUnread,
      cwd: payload.cwd || null,
      totalCost: typeof payload.totalCost === 'number' ? payload.totalCost : 0,
      totalUsage: payload.totalUsage ? deepClone(payload.totalUsage) : null,
      updated: payload.updated || null,
      isRunning: !!payload.isRunning,
      historyPending: !!payload.historyPending,
      complete: options.complete !== undefined ? !!options.complete : !payload.historyPending,
    };
  }

  function touchSessionCache(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (entry) entry.lastUsed = Date.now();
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    sessionCache.delete(sessionId);
  }

  function clearInitialPreferredFallback() {
    if (initialPreferredFallbackTimer) {
      clearTimeout(initialPreferredFallbackTimer);
      initialPreferredFallbackTimer = null;
    }
  }

  function scheduleInitialPreferredFallback() {
    clearInitialPreferredFallback();
    initialPreferredFallbackTimer = setTimeout(() => {
      initialPreferredFallbackTimer = null;
      if (initialPreferredSessionApplied && currentSessionId === initialPreferredSessionId) {
        highlightActiveSession();
        return;
      }
      syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
    }, 120);
  }

  function pruneSessionCache() {
    let totalWeight = 0;
    for (const entry of sessionCache.values()) totalWeight += entry.weight || 0;
    while (sessionCache.size > SESSION_CACHE_LIMIT || totalWeight > SESSION_CACHE_MAX_WEIGHT) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [sessionId, entry] of sessionCache) {
        if ((entry.lastUsed || 0) < oldestTs) {
          oldestTs = entry.lastUsed || 0;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      totalWeight -= sessionCache.get(oldestId)?.weight || 0;
      sessionCache.delete(oldestId);
    }
  }

  function cacheSessionSnapshot(snapshot) {
    if (!snapshot?.sessionId || !snapshot.complete) return;
    const cachedSnapshot = deepClone(snapshot);
    const weight = estimateSessionSnapshotWeight(cachedSnapshot);
    if (weight > SESSION_CACHE_MAX_WEIGHT) {
      invalidateSessionCache(cachedSnapshot.sessionId);
      return;
    }
    const meta = getSessionMeta(cachedSnapshot.sessionId);
    sessionCache.set(cachedSnapshot.sessionId, {
      snapshot: cachedSnapshot,
      version: cachedSnapshot.updated || null,
      meta: meta ? deepClone(meta) : null,
      weight,
      lastUsed: Date.now(),
    });
    pruneSessionCache();
  }

  function updateCachedSession(sessionId, updater) {
    const entry = sessionCache.get(sessionId);
    if (!entry) return;
    const nextSnapshot = deepClone(entry.snapshot);
    updater(nextSnapshot);
    entry.snapshot = nextSnapshot;
    entry.weight = estimateSessionSnapshotWeight(nextSnapshot);
    entry.lastUsed = Date.now();
    if (nextSnapshot.updated) entry.version = nextSnapshot.updated;
    pruneSessionCache();
  }

  function reconcileSessionCacheWithSessions() {
    const knownIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, entry] of sessionCache) {
      if (!knownIds.has(sessionId)) {
        sessionCache.delete(sessionId);
        continue;
      }
      const meta = getSessionMeta(sessionId);
      entry.meta = meta ? deepClone(meta) : null;
    }
  }

  function getSessionCacheDisposition(sessionId) {
    const entry = sessionCache.get(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!entry?.snapshot?.complete || !meta) return 'miss';
    if (entry.version === (meta.updated || null) && !meta.hasUnread && !meta.isRunning) {
      return 'strong';
    }
    return 'weak';
  }

  function buildCachedSessionSnapshot(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (!entry?.snapshot) return null;
    const snapshot = deepClone(entry.snapshot);
    const meta = getSessionMeta(sessionId) || entry.meta;
    if (meta) {
      snapshot.title = meta.title || snapshot.title;
      snapshot.agent = normalizeAgent(meta.agent || snapshot.agent);
      snapshot.hasUnread = !!meta.hasUnread;
      snapshot.updated = meta.updated || snapshot.updated;
      snapshot.isRunning = !!meta.isRunning;
    }
    return snapshot;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  }

  function syncAttachmentActions() {
    const uploading = uploadingAttachments.length > 0;
    if (attachBtn) attachBtn.disabled = uploading;
  }

  function replaceFileExtension(filename, ext) {
    const base = String(filename || 'image').replace(/\.[^/.]+$/, '');
    return `${base}${ext}`;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('读取图片失败'));
      };
      img.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
    const img = await loadImageFromFile(file);
    const maxDimension = 2000;
    const maxOriginalBytes = 2 * 1024 * 1024;
    const largestSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (file.size <= maxOriginalBytes && largestSide <= maxDimension) {
      return file;
    }

    const scale = Math.min(1, maxDimension / largestSide);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const targetType = 'image/webp';
    const qualities = [0.9, 0.84, 0.78, 0.72];
    let bestBlob = null;
    for (const quality of qualities) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, quality));
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= Math.max(maxOriginalBytes, file.size * 0.72)) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], replaceFileExtension(file.name || 'image', '.webp'), {
      type: bestBlob.type,
      lastModified: Date.now(),
    });
  }

  async function deleteUploadedAttachment(id) {
    if (!id) return;
    try {
      await ensureAuthenticatedWs();
      await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {}
  }

  function ensureAuthenticatedWs() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1 && authToken && isAuthenticated) {
        resolve(authToken);
        return;
      }
      const tokenForRestore = authToken || localStorage.getItem('cc-web-token') || '';
      const passwordForRestore = loginPasswordValue || pendingLoginPassword || localStorage.getItem('cc-web-pw') || '';
      if (!tokenForRestore && !passwordForRestore) {
        reject(new Error('登录状态已失效，请刷新页面后重新登录。'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('登录状态恢复超时，请刷新页面后重试。'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('cc-web-auth-restored', onRestored);
        document.removeEventListener('cc-web-auth-failed', onFailed);
      };
      const onRestored = () => {
        cleanup();
        resolve(authToken);
      };
      const onFailed = () => {
        cleanup();
        reject(new Error('登录状态已失效，请刷新页面后重新登录。'));
      };
      document.addEventListener('cc-web-auth-restored', onRestored);
      document.addEventListener('cc-web-auth-failed', onFailed);

      if (!ws || ws.readyState > 1) {
        if (passwordForRestore) pendingLoginPassword = passwordForRestore;
        connect();
      } else if (ws.readyState === 0) {
        if (passwordForRestore) pendingLoginPassword = passwordForRestore;
      } else if (ws.readyState === 1) {
        if (tokenForRestore) {
          send({ type: 'auth', token: tokenForRestore });
        } else if (passwordForRestore) {
          send({ type: 'auth', password: passwordForRestore });
        }
      }
    });
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return '-';
    if (value <= 0) return '已到期';
    const totalMinutes = Math.ceil(value / 60000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days) parts.push(`${days}天`);
    if (hours) parts.push(`${hours}小时`);
    if (minutes && parts.length < 2) parts.push(`${minutes}分钟`);
    if (!parts.length) parts.push('不足1分钟');
    return parts.join('');
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  async function apiFetch(path, options = {}) {
    await ensureAuthenticatedWs();
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${authToken}` };
    const response = await fetch(path, { ...options, headers });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || `请求失败 (${response.status})`);
    }
    return payload;
  }

  async function downloadFileWithAuth(targetPath) {
    await ensureAuthenticatedWs();
    const response = await fetch(`/api/fs/download?path=${encodeURIComponent(targetPath)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(`下载失败 (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = targetPath.split('/').pop() || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // 与服务端 INLINE_SAFE_MIME_TYPES 对应：只有这些类型服务端才肯内联下发。
  // svg 故意不在内：它是文本，走编辑器反而合适，内联渲染则有脚本风险。
  const PREVIEWABLE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

  function isPreviewableImagePath(targetPath) {
    const ext = String(targetPath || '').split('/').pop().split('.').pop().toLowerCase();
    return PREVIEWABLE_IMAGE_EXTS.has(ext);
  }

  // <img src> 带不了 Authorization 头，所以把 token 放 query，与 attachmentUrl 同理。
  function fsFileUrl(targetPath, { inline = false } = {}) {
    const params = new URLSearchParams();
    params.set('path', targetPath);
    if (authToken) params.set('token', authToken);
    if (inline) params.set('inline', '1');
    return `/api/fs/download?${params.toString()}`;
  }

  // 助手常只在正文里写「成品文件：output-composite.jpg」，浏览器拿不到这个文件，
  // 用户既看不到图也没法下载。这里把正文提到的文件名探测一遍，确实存在的才补上入口。
  // 分隔符集合刻意排除了中英文标点，好让「文件：a.png」「(a.png)」都能切出干净的文件名。
  const FILE_MENTION_RE = /[^\s"'`<>|*?:;,=!()[\]{}，。、：；！？（）【】《》]+\.(?:png|jpe?g|webp|gif|bmp)\b/gi;
  const MAX_FILE_MENTIONS_PER_MESSAGE = 8;
  const MAX_FILE_PROBE_BATCH = 20; // 与服务端 MAX_FS_PROBE_NAMES 一致
  const MAX_FILE_PROBE_CACHE = 500;
  const fileProbeCache = new Map();
  let fileProbeQueue = [];
  let fileProbeTimer = null;

  function rememberFileProbe(key, entry) {
    if (fileProbeCache.size >= MAX_FILE_PROBE_CACHE) {
      fileProbeCache.delete(fileProbeCache.keys().next().value);
    }
    fileProbeCache.set(key, entry);
  }

  // 逐个文件发一次请求会在渲染历史时打出一串请求，所以攒一小会儿合并成批。
  function queueFileProbe(base, name) {
    const key = `${base}\n${name}`;
    if (fileProbeCache.has(key)) return Promise.resolve(fileProbeCache.get(key));
    return new Promise((resolve) => {
      fileProbeQueue.push({ base, name, key, resolve });
      if (!fileProbeTimer) fileProbeTimer = setTimeout(flushFileProbes, 30);
    });
  }

  async function flushFileProbes() {
    fileProbeTimer = null;
    const queued = fileProbeQueue;
    fileProbeQueue = [];
    const byBase = new Map();
    for (const item of queued) {
      if (!byBase.has(item.base)) byBase.set(item.base, new Map());
      const names = byBase.get(item.base);
      if (!names.has(item.name)) names.set(item.name, []);
      names.get(item.name).push(item);
    }
    for (const [base, names] of byBase) {
      const unique = Array.from(names.keys());
      for (let i = 0; i < unique.length; i += MAX_FILE_PROBE_BATCH) {
        const chunk = unique.slice(i, i + MAX_FILE_PROBE_BATCH);
        const found = new Map();
        try {
          const params = new URLSearchParams();
          if (base) params.set('base', base);
          for (const name of chunk) params.append('name', name);
          const data = await apiFetch(`/api/fs/probe?${params.toString()}`);
          for (const file of data.files || []) found.set(file.name, file);
        } catch {
          // 探测失败就当文件不存在：这只是锦上添花的入口，不该弹错打断阅读
        }
        for (const name of chunk) {
          const entry = found.get(name) || null;
          for (const item of names.get(name)) {
            rememberFileProbe(item.key, entry);
            item.resolve(entry);
          }
        }
      }
    }
  }

  function splitFileMention(token) {
    const slash = token.lastIndexOf('/');
    if (slash < 0) return { base: currentCwd || '', name: token };
    const name = token.slice(slash + 1);
    if (!name) return null;
    const dir = token.slice(0, slash) || '/';
    // 相对目录要按会话 cwd 解释；服务端的 resolveFsPath 只认 process.cwd()，会解错。
    if (dir.startsWith('/')) return { base: dir, name };
    return { base: currentCwd ? `${currentCwd}/${dir}` : dir, name };
  }

  function collectFileMentions(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // pre 里多是命令输出，一段目录列表能刷出满屏缩略图；a 与附件区本来就有入口了；
        // 工具调用是折叠的实现细节，不该抢正文的名额
        const skip = node.parentElement
          && node.parentElement.closest('pre, a, .tool-call, .tool-group, .msg-attachments, .msg-generated-files');
        return skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const seen = new Set();
    const mentions = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const matches = node.nodeValue.match(FILE_MENTION_RE);
      if (!matches) continue;
      for (const token of matches) {
        const parsed = splitFileMention(token);
        if (!parsed) continue;
        const key = `${parsed.base}\n${parsed.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mentions.push(parsed);
        if (mentions.length >= MAX_FILE_MENTIONS_PER_MESSAGE) return mentions;
      }
    }
    return mentions;
  }

  function buildGeneratedFilesBlock(files) {
    const block = document.createElement('div');
    block.className = 'msg-generated-files';
    const title = document.createElement('div');
    title.className = 'msg-generated-files-title';
    title.textContent = '正文提到的文件';
    const list = document.createElement('div');
    list.className = 'msg-attachments compact';
    for (const file of files) {
      const item = document.createElement('figure');
      item.className = 'msg-attachment-item';
      if (file.previewable) {
        const thumb = document.createElement('a');
        thumb.className = 'msg-attachment-thumb';
        thumb.href = '#';
        thumb.title = `${file.name}（点击预览）`;
        const img = document.createElement('img');
        // src 用 JS 赋值而不是拼进模板，避免 token 进入 HTML 属性
        img.src = fsFileUrl(file.path, { inline: true });
        img.alt = file.name;
        img.loading = 'lazy';
        thumb.appendChild(img);
        thumb.addEventListener('click', (e) => {
          e.preventDefault();
          openImagePreview(file.path);
        });
        item.appendChild(thumb);
      }
      const download = document.createElement('a');
      download.className = 'msg-attachment-download';
      download.href = fsFileUrl(file.path);
      download.setAttribute('download', file.name);
      download.title = `下载 ${file.name}`;
      download.textContent = `⬇ ${file.name} · ${formatFileSize(file.size)}`;
      item.appendChild(download);
      list.appendChild(item);
    }
    block.appendChild(title);
    block.appendChild(list);
    return block;
  }

  async function attachFileReferences(msgEl) {
    if (!msgEl || msgEl.dataset.fileRefsDone === '1') return;
    msgEl.dataset.fileRefsDone = '1';
    const bubble = msgEl.querySelector('.msg-bubble');
    const textDiv = bubble && (bubble.querySelector('.msg-text') || bubble);
    if (!textDiv) return;
    const mentions = collectFileMentions(textDiv);
    if (mentions.length === 0) return;
    const entries = await Promise.all(mentions.map((m) => queueFileProbe(m.base, m.name)));
    const files = entries.filter(Boolean);
    // 探测是异步的，期间可能已经切走会话或重渲染
    if (files.length === 0 || !msgEl.isConnected) return;
    if (bubble.querySelector(':scope > .msg-generated-files')) return;
    bubble.appendChild(buildGeneratedFilesBlock(files));
  }

  // 不可见的历史消息不该预先探测，滚到眼前再做。
  const fileRefsObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          fileRefsObserver.unobserve(record.target);
          attachFileReferences(record.target);
        }
      }, { rootMargin: '200px' })
    : null;

  function watchFileReferences(msgEl) {
    if (!msgEl) return;
    if (fileRefsObserver) fileRefsObserver.observe(msgEl);
    else attachFileReferences(msgEl);
  }

  const COMMAND_HISTORY_KEY = 'cc-web-cmd-history';
  const SIDEBAR_TOOLS_HEIGHT_KEY = 'cc-web-sidebar-tools-height';
  const MAX_COMMAND_HISTORY = 30;

  function normalizeCommandHistory(list) {
    const deduped = [];
    for (const item of Array.isArray(list) ? list : []) {
      const cmd = String(item || '').trim();
      if (!cmd || deduped.includes(cmd)) continue;
      deduped.push(cmd);
      if (deduped.length >= MAX_COMMAND_HISTORY) break;
    }
    return deduped;
  }

  function loadCommandHistory() {
    try {
      const raw = localStorage.getItem(COMMAND_HISTORY_KEY);
      commandHistory = normalizeCommandHistory(raw ? JSON.parse(raw) : []);
    } catch {
      commandHistory = [];
    }
  }

  async function loadCommandHistoryFromServer() {
    const payload = await apiFetch('/api/exec/history');
    const remoteHistory = normalizeCommandHistory(payload?.history || []);
    if (!remoteHistory.length) {
      if (commandHistory.length) {
        await saveCommandHistoryToServer();
      }
      return;
    }
    commandHistory = remoteHistory;
    saveCommandHistory();
    renderCmdPanel();
  }

  async function saveCommandHistoryToServer() {
    await apiFetch('/api/exec/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: commandHistory }),
    });
  }

  async function syncRunningCommandFromServer(options = {}) {
    if (!authToken) return;
    const force = !!options.force;
    const now = Date.now();
    if (!force && commandExecSyncPromise) return commandExecSyncPromise;
    if (!force && now - lastCommandExecSyncAt < 1200) return commandExecSyncPromise || Promise.resolve();
    lastCommandExecSyncAt = now;
    commandExecSyncPromise = (async () => {
      try {
        const payload = await apiFetch('/api/exec/current');
        if (!payload?.running) {
          if (commandExecState.running) {
            commandExecState.running = false;
            commandExecState.stopInProgress = false;
            syncCommandPanelUi();
          }
          return;
        }
        commandExecState = {
          ...commandExecState,
          execId: payload.execId || commandExecState.execId,
          command: payload.command || commandExecState.command,
          cwd: payload.cwd || commandExecState.cwd,
          stdout: typeof payload.stdout === 'string' ? payload.stdout : commandExecState.stdout,
          stderr: typeof payload.stderr === 'string' ? payload.stderr : commandExecState.stderr,
          running: true,
          stopInProgress: !!payload.stopInProgress,
          startedAt: payload.startedAt || commandExecState.startedAt,
          error: '',
        };
        syncCommandPanelUi();
      } catch {}
      finally {
        commandExecSyncPromise = null;
      }
    })();
    return commandExecSyncPromise;
  }

  function createEmptyCommandExecState() {
    return {
      execId: '',
      command: '',
      cwd: '',
      stdout: '',
      stderr: '',
      running: false,
      stopInProgress: false,
      exitCode: null,
      timedOut: false,
      signal: '',
      error: '',
      startedAt: '',
      finishedAt: '',
    };
  }

  function buildCommandExecOutput() {
    if (!commandExecState.command) return '等待执行命令...';
    const parts = [`> ${commandExecState.command}`];
    if (commandExecState.cwd) parts.push(`[cwd] ${commandExecState.cwd}`);
    if (commandExecState.running) {
      parts.push(`[status] ${commandExecState.stopInProgress ? '正在停止...' : '执行中...'}`);
    } else if (commandExecState.error) {
      parts.push(`[error] ${commandExecState.error}`);
    } else if (typeof commandExecState.exitCode === 'number') {
      let exitLine = `[exit] ${commandExecState.exitCode}`;
      if (commandExecState.timedOut) exitLine += ' (timeout)';
      if (commandExecState.signal) exitLine += ` [signal ${commandExecState.signal}]`;
      parts.push(exitLine);
    }
    if (commandExecState.stdout) parts.push(`\n[stdout]\n${commandExecState.stdout}`);
    if (commandExecState.stderr) parts.push(`\n[stderr]\n${commandExecState.stderr}`);
    if (!commandExecState.stdout && !commandExecState.stderr && commandExecState.running) {
      parts.push('执行中...');
    }
    return parts.filter(Boolean).join('\n');
  }

  function syncCommandPanelUi() {
    if (!cmdPanel) return;
    const output = cmdPanel.querySelector('#cmd-output-box');
    const runBtn = cmdPanel.querySelector('#cmd-run-btn');
    const stopBtn = cmdPanel.querySelector('#cmd-stop-btn');
    if (output) output.textContent = buildCommandExecOutput();
    if (runBtn) runBtn.disabled = !!commandExecState.running;
    if (stopBtn) {
      stopBtn.hidden = !commandExecState.running;
      stopBtn.disabled = !commandExecState.running || !!commandExecState.stopInProgress;
    }
  }

  function appendCommandExecNote(text) {
    const output = cmdPanel?.querySelector('#cmd-output-box');
    if (!output) return;
    output.textContent = `${output.textContent}\n\n[system] ${text}`;
  }

  function handleExecStreamMessage(msg) {
    const event = String(msg?.event || '').trim();
    const execId = String(msg?.execId || '').trim();
    const sameExec = !commandExecState.execId || commandExecState.execId === execId || commandExecState.execId === 'pending';
    if (!event) return;

    switch (event) {
      case 'start':
        commandExecState = {
          ...createEmptyCommandExecState(),
          execId: execId || commandExecState.execId || 'pending',
          command: msg.command || commandExecState.command,
          cwd: msg.cwd || commandExecState.cwd,
          running: true,
          startedAt: msg.startedAt || '',
        };
        break;

      case 'stdout':
      case 'stderr':
        if (!sameExec) return;
        if (!commandExecState.execId || commandExecState.execId === 'pending') commandExecState.execId = execId;
        commandExecState.running = true;
        if (msg.cwd && !commandExecState.cwd) commandExecState.cwd = msg.cwd;
        commandExecState[event] += String(msg.text || '');
        break;

      case 'stop_requested':
        if (commandExecState.execId && execId && commandExecState.execId !== execId) return;
        commandExecState.stopInProgress = true;
        break;

      case 'end':
        if (!sameExec) return;
        if (!commandExecState.execId || commandExecState.execId === 'pending') commandExecState.execId = execId;
        commandExecState.running = false;
        commandExecState.stopInProgress = false;
        commandExecState.cwd = msg.cwd || commandExecState.cwd;
        commandExecState.exitCode = typeof msg.code === 'number' ? msg.code : commandExecState.exitCode;
        commandExecState.timedOut = !!msg.timedOut;
        commandExecState.signal = msg.signal || '';
        commandExecState.finishedAt = msg.finishedAt || '';
        break;

      case 'error':
        if (!sameExec) return;
        commandExecState.running = false;
        commandExecState.stopInProgress = false;
        commandExecState.cwd = msg.cwd || commandExecState.cwd;
        commandExecState.error = msg.message || '执行失败';
        break;

      default:
        return;
    }

    syncCommandPanelUi();
  }

  function saveCommandHistory() {
    try {
      localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(commandHistory.slice(0, MAX_COMMAND_HISTORY)));
    } catch {}
  }

  function pushCommandHistory(command) {
    const cmd = String(command || '').trim();
    if (!cmd) return;
    commandHistory = [cmd, ...commandHistory.filter((item) => item !== cmd)].slice(0, MAX_COMMAND_HISTORY);
    saveCommandHistory();
    saveCommandHistoryToServer().catch(() => {});
  }

  function getSidebarToolsHeightBounds() {
    const sidebarHeight = Math.max(1, sidebar?.clientHeight || window.innerHeight || 1);
    const min = 180;
    const max = Math.max(min + 40, Math.floor(sidebarHeight * 0.72));
    return { min, max };
  }

  function loadSidebarToolsHeight() {
    const raw = Number(localStorage.getItem(SIDEBAR_TOOLS_HEIGHT_KEY));
    if (Number.isFinite(raw) && raw > 0) {
      sidebarToolsHeightPx = raw;
      return;
    }
    const sidebarHeight = sidebar?.clientHeight || window.innerHeight || 800;
    sidebarToolsHeightPx = Math.floor(sidebarHeight * 0.42);
  }

  function applySidebarToolsHeight(nextHeight, options = {}) {
    if (!sidebarTools) return;
    const { min, max } = getSidebarToolsHeightBounds();
    const height = Math.max(min, Math.min(max, Number(nextHeight) || sidebarToolsHeightPx || min));
    sidebarToolsHeightPx = height;
    sidebarTools.style.height = `${height}px`;
    if (!options.skipPersist) {
      try { localStorage.setItem(SIDEBAR_TOOLS_HEIGHT_KEY, String(height)); } catch {}
    }
  }

  function bindSidebarToolsHeightResizer() {
    if (!sidebarTools || !sidebarToolsHeightResizer) return;
    let dragging = false;
    let pointerId = null;
    let startY = 0;
    let startHeight = 0;

    const stopDragging = (e) => {
      if (!dragging || pointerId !== e.pointerId) return;
      dragging = false;
      pointerId = null;
      document.body.style.userSelect = '';
      try { sidebarToolsHeightResizer.releasePointerCapture(e.pointerId); } catch {}
    };

    sidebarToolsHeightResizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      startY = e.clientY;
      startHeight = sidebarTools.offsetHeight || sidebarToolsHeightPx || 240;
      document.body.style.userSelect = 'none';
      try { sidebarToolsHeightResizer.setPointerCapture(e.pointerId); } catch {}
    });

    sidebarToolsHeightResizer.addEventListener('pointermove', (e) => {
      if (!dragging || pointerId !== e.pointerId) return;
      const deltaY = e.clientY - startY;
      applySidebarToolsHeight(startHeight - deltaY);
    });

    sidebarToolsHeightResizer.addEventListener('pointerup', stopDragging);
    sidebarToolsHeightResizer.addEventListener('pointercancel', stopDragging);
  }

  // 懒加载标记：第一次切到对应 tab 才发请求
  let cmdPanelLoaded = false;
  let fileBrowserLoaded = false;

  function switchToolTab(tab) {
    activeToolTab = tab === 'cmd' ? 'cmd' : 'files';
    if (toolTabFiles) toolTabFiles.classList.toggle('active', activeToolTab === 'files');
    if (toolTabCmd) toolTabCmd.classList.toggle('active', activeToolTab === 'cmd');
    if (fileBrowserPanel) fileBrowserPanel.hidden = activeToolTab !== 'files';
    if (cmdPanel) cmdPanel.hidden = activeToolTab !== 'cmd';
    if (activeToolTab === 'cmd' && !cmdPanelLoaded && isAuthenticated) {
      cmdPanelLoaded = true;
      loadCommandHistoryFromServer().catch(() => {});
    }
    if (activeToolTab === 'files' && !fileBrowserLoaded && isAuthenticated) {
      fileBrowserLoaded = true;
      refreshFileBrowser(fileBrowserPath || currentCwd || '').catch(() => {});
    }
  }

  function renderCmdPanel() {
    if (!cmdPanel) return;
    if (isAuthenticated && authToken) syncRunningCommandFromServer().catch(() => {});
    const defaultCwd = currentCwd || fileBrowserPath || '';
    const cwdValue = commandCwdOverride || defaultCwd;
    const inputValue = commandExecState.running ? commandExecState.command : '';
    cmdPanel.innerHTML = `
      <div class="cmd-head">执行目录（可修改）</div>
      <input id="cmd-cwd-input" class="cmd-input" type="text" placeholder="默认当前会话目录" value="${escapeAttr(cwdValue)}" />
      <div class="cmd-row">
        <input id="cmd-input-box" class="cmd-input" type="text" placeholder="输入命令，如 ls -la" value="${escapeAttr(inputValue)}" />
        <button id="cmd-run-btn" class="cmd-run-btn" type="button">执行</button>
        <button id="cmd-stop-btn" class="cmd-run-btn cmd-stop-btn" type="button" hidden>停止</button>
      </div>
      <div class="cmd-row">
        <select id="cmd-history-select" class="cmd-history">
          <option value="">历史命令（选择后自动填充）</option>
          ${commandHistory.map((cmd) => `<option value="${escapeAttr(cmd)}">${escapeHtml(cmd)}</option>`).join('')}
        </select>
        <button id="cmd-history-del-btn" class="cmd-run-btn" type="button">删除记录</button>
      </div>
      <pre id="cmd-output-box" class="cmd-output">${escapeHtml(buildCommandExecOutput())}</pre>
    `;

    const cwdInput = cmdPanel.querySelector('#cmd-cwd-input');
    const input = cmdPanel.querySelector('#cmd-input-box');
    const historySelect = cmdPanel.querySelector('#cmd-history-select');
    const historyDelBtn = cmdPanel.querySelector('#cmd-history-del-btn');
    const runBtn = cmdPanel.querySelector('#cmd-run-btn');

    async function stopRunningCommand() {
      if (!commandExecState.running || commandExecState.stopInProgress) return;
      commandExecState.stopInProgress = true;
      syncCommandPanelUi();
      try {
        const res = await apiFetch('/api/exec/stop', { method: 'POST' });
        if (res?.message) appendCommandExecNote(res.message);
      } catch (err) {
        commandExecState.stopInProgress = false;
        syncCommandPanelUi();
        appendCommandExecNote(`停止失败: ${err.message || 'unknown error'}`);
      }
    }

    async function runCommand(command) {
      const cmd = String(command || '').trim();
      if (!cmd) return;
      if (commandExecState.running) {
        appendCommandExecNote('命令仍在执行，请先点击“停止”');
        return;
      }
      const runCwd = (cwdInput.value || '').trim() || defaultCwd || '';
      commandCwdOverride = (cwdInput.value || '').trim();
      commandExecState = {
        ...createEmptyCommandExecState(),
        execId: 'pending',
        command: cmd,
        cwd: runCwd,
        running: true,
        startedAt: new Date().toISOString(),
      };
      syncCommandPanelUi();
      try {
        const result = await apiFetch('/api/exec/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd, cwd: runCwd }),
        });
        pushCommandHistory(cmd);
        commandExecState = {
          ...commandExecState,
          execId: result.execId || commandExecState.execId,
          command: cmd,
          cwd: result.cwd || commandExecState.cwd,
          stdout: typeof result.stdout === 'string' ? result.stdout : commandExecState.stdout,
          stderr: typeof result.stderr === 'string' ? result.stderr : commandExecState.stderr,
          running: false,
          stopInProgress: false,
          exitCode: typeof result.code === 'number' ? result.code : commandExecState.exitCode,
          timedOut: !!result.timedOut,
          signal: result.signal || '',
          error: '',
        };
        syncCommandPanelUi();
        const exists = Array.from(historySelect.options).some((option) => option.value === cmd);
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = cmd;
          opt.textContent = cmd;
          historySelect.insertBefore(opt, historySelect.children[1] || null);
        }
      } catch (err) {
        commandExecState = {
          ...commandExecState,
          running: false,
          stopInProgress: false,
          error: err.message || 'unknown error',
        };
        syncCommandPanelUi();
      }
    }

    runBtn.addEventListener('click', () => runCommand(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(input.value);
      }
    });
    historySelect.addEventListener('change', () => {
      const cmd = historySelect.value;
      if (!cmd) return;
      input.value = cmd;
      input.focus();
    });
    historyDelBtn.addEventListener('click', () => {
      const cmd = historySelect.value;
      if (!cmd) return;
      commandHistory = commandHistory.filter((item) => item !== cmd);
      saveCommandHistory();
      saveCommandHistoryToServer().catch(() => {});
      renderCmdPanel();
    });
    cwdInput.addEventListener('input', () => {
      commandCwdOverride = cwdInput.value.trim();
    });
    const stopBtn = cmdPanel.querySelector('#cmd-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', stopRunningCommand);
    syncCommandPanelUi();
  }

  function escapeAttr(value) {
    return escapeHtml(String(value || '')).replace(/"/g, '&quot;');
  }

  function renderFileBrowserShell() {
    if (!fileBrowserPanel) return;
    fileBrowserPanel.innerHTML = `
      <div class="file-browser-head">
        <div class="file-browser-title" id="file-browser-title">文件浏览</div>
        <div class="file-browser-actions">
          <button class="file-browser-btn" id="file-browser-up" title="上一级">↑</button>
          <button class="file-browser-btn" id="file-browser-refresh" title="刷新">↻</button>
        </div>
      </div>
      <div class="file-browser-list" id="file-browser-list"></div>
      <div class="file-browser-status" id="file-browser-status"></div>
    `;
  }

  function openImagePreview(targetPath) {
    const name = targetPath.split('/').pop() || 'image';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(name)}</span>
          <button class="modal-close-btn" type="button">✕</button>
        </div>
        <div class="modal-body">
          <div class="import-item-meta">${escapeHtml(targetPath)}</div>
          <div id="image-preview-frame" style="display:flex;align-items:center;justify-content:center;min-height:200px;max-height:60vh;overflow:auto;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-secondary);padding:10px;">
            <img id="image-preview-img" alt="${escapeHtml(name)}" style="max-width:100%;max-height:56vh;object-fit:contain;display:block;">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;">
            <span class="import-item-meta" id="image-preview-meta">加载中…</span>
            <button class="btn-test" id="image-preview-download" type="button">下载</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#image-preview-download').addEventListener('click', () => {
      downloadFileWithAuth(targetPath).catch((err) => alert(err.message || '下载失败'));
    });
    const img = overlay.querySelector('#image-preview-img');
    const meta = overlay.querySelector('#image-preview-meta');
    img.addEventListener('load', () => {
      meta.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    });
    img.addEventListener('error', () => {
      img.remove();
      meta.textContent = '无法预览该图片，可尝试下载后查看。';
    });
    // src 用 JS 赋值而不是拼进模板，避免 token 进入 HTML 属性
    img.src = fsFileUrl(targetPath, { inline: true });
  }

  async function openFileEditor(targetPath) {
    // 图片不进文本编辑器：utf8 往返会毁掉文件，服务端现在也会直接拒绝读取
    if (isPreviewableImagePath(targetPath)) {
      openImagePreview(targetPath);
      return;
    }
    const file = await apiFetch(`/api/fs/read?path=${encodeURIComponent(targetPath)}`);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">编辑文件</span>
          <button class="modal-close-btn" type="button">✕</button>
        </div>
        <div class="modal-body">
          <div class="import-item-meta">${escapeHtml(file.path)}</div>
          <textarea id="file-editor-text" style="width:100%;min-height:360px;resize:vertical;border:1px solid var(--border-color);border-radius:10px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;">${escapeHtml(file.content || '')}</textarea>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
            <button class="btn-test" id="file-editor-download" type="button">下载</button>
            <button class="btn-save" id="file-editor-save" type="button">保存</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#file-editor-download').addEventListener('click', () => {
      downloadFileWithAuth(targetPath).catch((err) => alert(err.message || '下载失败'));
    });
    overlay.querySelector('#file-editor-save').addEventListener('click', async () => {
      const text = overlay.querySelector('#file-editor-text').value;
      await apiFetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath, content: text }),
      });
      close();
      refreshFileBrowser();
    });
  }

  function closeFileBrowserContextMenu() {
    if (!fileBrowserContextMenu) return;
    if (fileBrowserMenuDocClickHandler) {
      document.removeEventListener('click', fileBrowserMenuDocClickHandler);
      fileBrowserMenuDocClickHandler = null;
    }
    if (fileBrowserMenuDocContextHandler) {
      document.removeEventListener('contextmenu', fileBrowserMenuDocContextHandler);
      fileBrowserMenuDocContextHandler = null;
    }
    fileBrowserContextMenu.remove();
    fileBrowserContextMenu = null;
  }

  function openFileBrowserContextMenu(x, y, items) {
    closeFileBrowserContextMenu();
    const menu = document.createElement('div');
    menu.className = 'file-browser-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.innerHTML = items.map((item) => `<button type="button" class="file-browser-context-item" data-key="${escapeAttr(item.key)}">${escapeHtml(item.label)}</button>`).join('');
    document.body.appendChild(menu);
    fileBrowserContextMenu = menu;
    setTimeout(() => {
      fileBrowserMenuDocClickHandler = (ev) => {
        if (fileBrowserContextMenu && !fileBrowserContextMenu.contains(ev.target)) closeFileBrowserContextMenu();
      };
      fileBrowserMenuDocContextHandler = (ev) => {
        if (fileBrowserContextMenu && !fileBrowserContextMenu.contains(ev.target)) closeFileBrowserContextMenu();
      };
      document.addEventListener('click', fileBrowserMenuDocClickHandler);
      document.addEventListener('contextmenu', fileBrowserMenuDocContextHandler);
    }, 0);
    return menu;
  }

  async function createFileInCurrentDir() {
    const name = prompt('输入新文件名');
    if (!name) return;
    await apiFetch('/api/fs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePath: fileBrowserPath, name: name.trim(), content: '' }),
    });
    refreshFileBrowser(fileBrowserPath);
  }

  async function createDirInCurrentDir() {
    const name = prompt('输入新文件夹名');
    if (!name) return;
    await apiFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePath: fileBrowserPath, name: name.trim() }),
    });
    refreshFileBrowser(fileBrowserPath);
  }

  async function refreshFileBrowser(targetPath = null) {
    if (!fileBrowserPanel) return;
    if (!fileBrowserPanel.querySelector('#file-browser-list')) renderFileBrowserShell();
    const seq = ++fileBrowserRefreshSeq;
    const title = fileBrowserPanel.querySelector('#file-browser-title');
    const list = fileBrowserPanel.querySelector('#file-browser-list');
    const status = fileBrowserPanel.querySelector('#file-browser-status');
    if (!isAuthenticated) {
      title.textContent = '文件浏览';
      list.innerHTML = '';
      status.textContent = authToken ? '正在恢复登录状态...' : '请先登录后查看文件';
      return;
    }
    const desiredPath = targetPath || fileBrowserPath || currentCwd || '';
    status.textContent = '加载中...';
    try {
      const result = await apiFetch(`/api/fs/list?path=${encodeURIComponent(desiredPath)}`);
      if (seq !== fileBrowserRefreshSeq) return;
      fileBrowserPath = result.cwd;
      title.textContent = `文件: ${result.cwd}`;
      list.innerHTML = result.entries.map((entry) => {
        const icon = entry.type === 'dir' ? '📁' : '📄';
        const meta = entry.type === 'dir' ? '目录' : formatBytes(entry.size);
        return `
          <div class="file-browser-item" data-entry-path="${escapeAttr(entry.path)}" data-entry-name="${escapeAttr(entry.name)}" data-entry-type="${entry.type}">
            <span>${icon}</span>
            <span class="file-browser-item-name" title="${escapeAttr(entry.path)}">${escapeHtml(entry.name)}</span>
            <span class="file-browser-item-meta">${meta}</span>
          </div>
        `;
      }).join('') || '<div class="file-browser-item"><span class="file-browser-item-meta">目录为空</span></div>';
      const shownCount = result.entries.length;
      const totalCount = Number.isFinite(result.total) ? result.total : shownCount;
      status.textContent = totalCount > shownCount
        ? `${totalCount} 项（仅显示前 ${shownCount} 项）`
        : `${totalCount} 项`;

      list.querySelectorAll('[data-entry-path]').forEach((row) => {
        row.addEventListener('dblclick', async () => {
          const entryPath = row.dataset.entryPath;
          const entryType = row.dataset.entryType;
          try {
            if (entryType === 'dir') await refreshFileBrowser(entryPath);
            else await openFileEditor(entryPath);
          } catch (err) {
            alert(err.message || '打开失败');
          }
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const entryPath = row.dataset.entryPath;
          const entryName = row.dataset.entryName || '';
          const entryType = row.dataset.entryType;
          const menu = openFileBrowserContextMenu(e.clientX, e.clientY, [
            { key: 'open', label: entryType === 'dir' ? '进入目录' : (isPreviewableImagePath(entryPath) ? '预览' : '查看/编辑') },
            ...(entryType === 'file' ? [{ key: 'download', label: '下载' }] : []),
            { key: 'rename', label: '重命名' },
            { key: 'delete', label: '删除' },
            { key: 'new_file', label: '新建文件' },
            { key: 'new_dir', label: '新建文件夹' },
            { key: 'refresh', label: '刷新' },
          ]);
          menu.querySelectorAll('[data-key]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              closeFileBrowserContextMenu();
              try {
                const key = btn.dataset.key;
                if (key === 'open') {
                  if (entryType === 'dir') await refreshFileBrowser(entryPath);
                  else await openFileEditor(entryPath);
                } else if (key === 'download' && entryType === 'file') {
                  await downloadFileWithAuth(entryPath);
                } else if (key === 'rename') {
                  const newName = prompt('输入新名称', entryName);
                  if (!newName || newName === entryName) return;
                  await apiFetch('/api/fs/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: entryPath, newName: newName.trim() }),
                  });
                  refreshFileBrowser(fileBrowserPath);
                } else if (key === 'delete') {
                  const label = entryType === 'dir' ? '目录' : '文件';
                  if (!confirm(`确认删除该${label}？`)) return;
                  await apiFetch('/api/fs/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: entryPath }),
                  });
                  refreshFileBrowser(fileBrowserPath);
                } else if (key === 'new_file') {
                  await createFileInCurrentDir();
                } else if (key === 'new_dir') {
                  await createDirInCurrentDir();
                } else if (key === 'refresh') {
                  refreshFileBrowser(fileBrowserPath);
                }
              } catch (err) {
                alert(err.message || '操作失败');
              }
            });
          });
        });
        let touchTimer = null;
        row.addEventListener('touchstart', (e) => {
          const touch = e.touches && e.touches[0];
          if (!touch) return;
          touchTimer = setTimeout(() => {
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: touch.clientX, clientY: touch.clientY }));
          }, 520);
        }, { passive: true });
        row.addEventListener('touchend', () => { if (touchTimer) clearTimeout(touchTimer); touchTimer = null; }, { passive: true });
        row.addEventListener('touchmove', () => { if (touchTimer) clearTimeout(touchTimer); touchTimer = null; }, { passive: true });
      });
      list.oncontextmenu = (e) => {
        if (e.target.closest('[data-entry-path]')) return;
        e.preventDefault();
        const menu = openFileBrowserContextMenu(e.clientX, e.clientY, [
          { key: 'new_file', label: '新建文件' },
          { key: 'new_dir', label: '新建文件夹' },
          { key: 'refresh', label: '刷新' },
        ]);
        menu.querySelectorAll('[data-key]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            closeFileBrowserContextMenu();
            try {
              if (btn.dataset.key === 'new_file') await createFileInCurrentDir();
              if (btn.dataset.key === 'new_dir') await createDirInCurrentDir();
              if (btn.dataset.key === 'refresh') refreshFileBrowser(fileBrowserPath);
            } catch (err) {
              alert(err.message || '操作失败');
            }
          });
        });
      };

      const upBtn = fileBrowserPanel.querySelector('#file-browser-up');
      const refreshBtn = fileBrowserPanel.querySelector('#file-browser-refresh');
      upBtn.disabled = !result.parent;
      upBtn.onclick = () => result.parent && refreshFileBrowser(result.parent);
      refreshBtn.onclick = () => refreshFileBrowser(fileBrowserPath);
    } catch (err) {
      if (seq !== fileBrowserRefreshSeq) return;
      list.innerHTML = '';
      status.textContent = err.message || '读取目录失败';
    }
  }

  function attachmentUrl(id, { download = false } = {}) {
    const params = new URLSearchParams();
    if (authToken) params.set('token', authToken);
    if (download) params.set('download', '1');
    const query = params.toString();
    return `/api/attachments/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
  }

  function renderAttachmentLabels(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const items = attachments.map((attachment) => {
      const name = escapeHtml(attachment.filename || 'image');
      if (attachment.storageState === 'available' && attachment.id) {
        const viewUrl = escapeHtml(attachmentUrl(attachment.id));
        const downloadUrl = escapeHtml(attachmentUrl(attachment.id, { download: true }));
        return `<figure class="msg-attachment-item">
          <a class="msg-attachment-thumb" href="${viewUrl}" target="_blank" rel="noopener" title="${name}（点击查看大图）">
            <img src="${viewUrl}" alt="${name}" loading="lazy">
          </a>
          <a class="msg-attachment-download" href="${downloadUrl}" download="${name}" title="下载 ${name}">⬇ ${name}</a>
        </figure>`;
      }
      const stateSuffix = attachment.storageState === 'expired' ? '（已过期）' : '（不可用）';
      return `<span class="msg-attachment-label">图片: ${name}${stateSuffix}</span>`;
    }).join('');
    return `<div class="msg-attachments${options.compact ? ' compact' : ''}">${items}</div>`;
  }

  function renderPendingAttachments() {
    if (!attachmentTray) return;
    if (!pendingAttachments.length && !uploadingAttachments.length) {
      attachmentTray.hidden = true;
      attachmentTray.innerHTML = '';
      syncAttachmentActions();
      return;
    }
    attachmentTray.hidden = false;
    const uploadingHtml = uploadingAttachments.map((attachment) => `
      <div class="attachment-chip uploading">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">上传中 · ${formatFileSize(attachment.size)}</span>
        </div>
      </div>
    `).join('');
    const readyHtml = pendingAttachments.map((attachment, index) => `
      <div class="attachment-chip" data-index="${index}">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 将随下一条消息发送</span>
        </div>
        <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
      </div>
    `).join('');
    const noteHtml = [
      uploadingAttachments.length > 0
        ? '<div class="attachment-tray-note">图片上传中，此时发送不会包含尚未完成的图片。</div>'
        : '',
    ].join('');
    attachmentTray.innerHTML = `${uploadingHtml}${readyHtml}${noteHtml}`;
    attachmentTray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const [removed] = pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        deleteUploadedAttachment(removed?.id);
      });
    });
    syncAttachmentActions();
  }

  async function uploadImageFile(file) {
    await ensureAuthenticatedWs();
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'image'),
    };
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers,
      body: file,
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      throw new Error('登录状态已失效，请刷新页面后重新登录再上传图片。');
    }
    if (response.status === 413) {
      throw new Error('图片大小超过当前上传限制，请压缩到 10MB 以内后重试。');
    }
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `上传失败 (${response.status})`);
    }
    return data.attachment;
  }

  async function handleSelectedImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) return;
    if (pendingAttachments.length + files.length > MAX_MESSAGE_ATTACHMENTS) {
      appendError(`单条消息最多附带 ${MAX_MESSAGE_ATTACHMENTS} 张图片。`);
      return;
    }
    const batch = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name || 'image',
      size: file.size || 0,
    }));
    uploadingAttachments.push(...batch);
    renderPendingAttachments();
    try {
      const results = await Promise.allSettled(files.map(async (file) => {
        const optimized = await compressImageFile(file);
        return uploadImageFile(optimized);
      }));
      const errors = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          pendingAttachments.push(result.value);
        } else {
          errors.push(result.reason?.message || '图片上传失败');
        }
      }
      if (errors.length > 0) {
        appendError(errors[0]);
      }
    } catch (err) {
      appendError(err.message || '图片上传失败');
    } finally {
      uploadingAttachments = uploadingAttachments.filter((item) => !batch.some((entry) => entry.id === item.id));
      renderPendingAttachments();
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  function getVisibleSessions() {
    return sessions.filter((s) => normalizeAgent(s.agent) === currentAgent);
  }

  function shouldOverlayRuntimeBadge() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  function updateCwdBadge() {
    if (!chatCwd) return;
    if (currentCwd) {
      const parts = currentCwd.replace(/\/+$/, '').split('/');
      const short = parts.slice(-2).join('/') || currentCwd;
      chatCwd.textContent = '~/' + short;
      chatCwd.title = currentCwd;
    } else {
      chatCwd.textContent = '';
      chatCwd.title = '';
    }
    chatCwd.hidden = !currentCwd || (currentSessionRunning && shouldOverlayRuntimeBadge());
  }

  function setCurrentSessionRunningState(isRunning) {
    const running = !!isRunning;
    currentSessionRunning = running;
    if (chatRuntimeState) {
      chatRuntimeState.hidden = !running;
      chatRuntimeState.textContent = running ? '运行中' : '';
    }
    updateCwdBadge();
  }

  function updateAgentScopedUI() {
    if (chatAgentBtn) {
      chatAgentBtn.textContent = AGENT_LABELS[currentAgent];
      chatAgentBtn.setAttribute('aria-expanded', chatAgentMenu && !chatAgentMenu.hidden ? 'true' : 'false');
    }
    if (chatAgentMenu) {
      chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
        const active = btn.dataset.agent === currentAgent;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    if (importSessionBtn) {
      importSessionBtn.textContent = currentAgent === 'codex' ? '导入本地 Codex 会话' : '导入本地 Claude 会话';
    }
  }

  function setCurrentAgent(agent) {
    currentAgent = normalizeAgent(agent);
    localStorage.setItem('cc-web-agent', currentAgent);
    currentMode = localStorage.getItem(getAgentModeStorageKey(currentAgent)) || 'yolo';
    modeSelect.value = currentMode;
    updateAgentScopedUI();
  }

  function closeAgentMenu() {
    if (!chatAgentMenu) return;
    chatAgentMenu.hidden = true;
    if (chatAgentBtn) chatAgentBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleAgentMenu() {
    if (!chatAgentMenu || !chatAgentBtn) return;
    const willOpen = chatAgentMenu.hidden;
    chatAgentMenu.hidden = !willOpen;
    chatAgentBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function resetChatView(agent) {
    setCurrentAgent(agent);
    currentSessionId = null;
    loadedHistorySessionId = null;
    clearSessionLoading();
    setCurrentSessionRunningState(false);
    currentCwd = null;
    renderCmdPanel();
    fileBrowserPath = null;
    currentModel = currentAgent === 'claude' ? 'opus' : '';
    isGenerating = false;
    pendingText = '';
    pendingAttachments = [];
    uploadingAttachments = [];
    activeToolCalls.clear();
    clearDeferredRuntimeMessages();
    clearHistoryChunkQueue();
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    chatTitle.textContent = '新会话';
    updateCwdBadge();
    refreshFileBrowser().catch(() => {});
    messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
    followLatestOutput = true;
    setStatsDisplay(null);
    renderPendingAttachments();
    highlightActiveSession();
  }

  function applySessionSnapshot(snapshot, options = {}) {
    if (!snapshot) return;
    const preserveStreaming = !!(options.preserveStreaming && isGenerating && snapshot.sessionId === currentSessionId && snapshot.isRunning);
    const preserveScroll = !!options.preserveScroll && snapshot.sessionId === currentSessionId;
    const previousScrollTop = messagesDiv.scrollTop;
    if (isGenerating && !preserveStreaming) {
      isGenerating = false;
      sendBtn.hidden = false;
      abortBtn.hidden = true;
      pendingText = '';
      activeToolCalls.clear();
    }
    currentSessionId = snapshot.sessionId;
    loadedHistorySessionId = snapshot.sessionId;
    setLastSessionForAgent(snapshot.agent, currentSessionId);
    chatTitle.textContent = snapshot.title || '新会话';
    setCurrentAgent(snapshot.agent);
    setCurrentSessionRunningState(snapshot.isRunning);
    setStatsDisplay(snapshot);
    currentCwd = snapshot.cwd || null;
    renderCmdPanel();
    if (currentCwd && currentCwd !== fileBrowserPath) fileBrowserPath = currentCwd;
    updateCwdBadge();
    refreshFileBrowser(fileBrowserPath || currentCwd || '').catch(() => {});
    if (snapshot.mode && MODE_LABELS[snapshot.mode]) {
      currentMode = snapshot.mode;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    }
    currentModel = snapshot.model || '';
    if (!preserveStreaming) {
      renderMessages(mergePendingOutboundMessages(snapshot.messages || [], snapshot.sessionId), {
        immediate: !!options.immediate,
        preserveScroll,
        previousScrollTop,
      });
    }
    highlightActiveSession();
    renderSessionList();
    if (!options.skipCloseSidebar) closeSidebar();
    if (snapshot.hasUnread && !options.suppressUnreadToast) {
      showToast('后台任务已完成', snapshot.sessionId);
    }
  }

  function syncViewForAgent(agent, options = {}) {
    const targetAgent = normalizeAgent(agent);
    const { preserveCurrent = true, loadLast = true } = options;
    setCurrentAgent(targetAgent);
    renderSessionList();

    const currentMeta = currentSessionId ? getSessionMeta(currentSessionId) : null;
    if (preserveCurrent && currentMeta && normalizeAgent(currentMeta.agent) === targetAgent) {
      highlightActiveSession();
      return;
    }

    if (currentSessionId && (!currentMeta || normalizeAgent(currentMeta.agent) !== targetAgent)) {
      send({ type: 'detach_view' });
    }

    resetChatView(targetAgent);

    if (!loadLast) return;
    const lastSessionId = getLastSessionForAgent(targetAgent);
    const lastMeta = lastSessionId ? getSessionMeta(lastSessionId) : null;
    if (lastMeta && normalizeAgent(lastMeta.agent) === targetAgent) {
      openSession(lastSessionId);
    }
  }

  function getSessionLoadLabel(sessionId) {
    const meta = sessionId ? getSessionMeta(sessionId) : null;
    const title = meta?.title ? `“${meta.title}”` : '所选会话';
    return `正在载入 ${title} 的完整消息记录…`;
  }

  function setSessionLoading(sessionId, options = {}) {
    const loading = !!sessionId;
    const blocking = options.blocking !== false;
    activeSessionLoad = loading ? { sessionId, blocking, preserveScroll: options.preserveScroll === true, snapshot: null } : null;
    const showOverlay = !!(loading && blocking);
    document.body.classList.toggle('session-loading-active', showOverlay);
    sessionLoadingOverlay.hidden = !showOverlay;
    sessionLoadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');
    sessionLoadingLabel.textContent = loading ? (options.label || getSessionLoadLabel(sessionId)) : '正在整理消息与上下文…';
    msgInput.disabled = showOverlay;
    modeSelect.disabled = showOverlay;
    sendBtn.disabled = showOverlay;
    abortBtn.disabled = showOverlay;
    if (showOverlay && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearSessionLoading(sessionId) {
    if (sessionId && activeSessionLoad && activeSessionLoad.sessionId !== sessionId) return;
    const closingSessionId = activeSessionLoad?.sessionId || null;
    setSessionLoading(null, { blocking: false });
    if (closingSessionId && deferredRuntimeSessionId === closingSessionId) {
      clearDeferredRuntimeMessages();
    }
    if (closingSessionId && historyChunkSessionId === closingSessionId) {
      clearHistoryChunkQueue();
    }
  }

  function isBlockingSessionLoad(sessionId) {
    return !!(activeSessionLoad &&
      activeSessionLoad.blocking &&
      (!sessionId || activeSessionLoad.sessionId === sessionId));
  }

  function finishSessionSwitch(sessionId) {
    if (isBlockingSessionLoad(sessionId)) {
      if (activeSessionLoad?.preserveScroll) updateScrollbar();
      else scrollToBottom({ force: true });
      requestAnimationFrame(() => clearSessionLoading(sessionId));
      return;
    }
    clearSessionLoading(sessionId);
  }

  function finalizeLoadedSession(sessionId) {
    if (activeSessionLoad?.sessionId === sessionId && activeSessionLoad.snapshot) {
      activeSessionLoad.snapshot.complete = true;
      cacheSessionSnapshot(activeSessionLoad.snapshot);
    }
    flushDeferredRuntimeMessages(sessionId);
    finishSessionSwitch(sessionId);
  }

  function beginSessionSwitch(sessionId, options = {}) {
    if (!sessionId) return;
    const blocking = options.blocking !== false;
    const force = options.force === true;
    if (!force && activeSessionLoad?.sessionId === sessionId) return;
    if (!force && sessionId === currentSessionId && !activeSessionLoad) return;
    renderEpoch++;
    clearDeferredRuntimeMessages();
    clearHistoryChunkQueue();
    if (!options.preserveScroll) loadedHistorySessionId = null;
    setSessionLoading(sessionId, { blocking, label: options.label, preserveScroll: options.preserveScroll === true });
    send({ type: 'load_session', sessionId });
  }

  function showCachedSession(sessionId) {
    const snapshot = buildCachedSessionSnapshot(sessionId);
    if (!snapshot) return false;
    if (currentSessionId && currentSessionId !== sessionId) {
      send({ type: 'detach_view' });
    }
    clearSessionLoading();
    touchSessionCache(sessionId);
    applySessionSnapshot(snapshot, { immediate: true, suppressUnreadToast: true });
    return true;
  }

  function openSession(sessionId, options = {}) {
    if (!sessionId) return;
    if (options.forceSync) {
      beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: true, label: options.label, preserveScroll: options.preserveScroll === true });
      return;
    }
    if (!options.force && sessionId === currentSessionId && !activeSessionLoad) return;

    const disposition = getSessionCacheDisposition(sessionId);
    if (disposition === 'strong') {
      showCachedSession(sessionId);
      return;
    }
    if (disposition === 'weak' && showCachedSession(sessionId)) {
      beginSessionSwitch(sessionId, { blocking: false, force: true, label: options.label, preserveScroll: options.preserveScroll === true });
      return;
    }
    beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: options.force === true, label: options.label, preserveScroll: options.preserveScroll === true });
  }

  function setStatsDisplay(msg) {
    if (currentAgent === 'codex' && msg && msg.totalUsage) {
      const usage = msg.totalUsage;
      if ((usage.inputTokens || 0) > 0 || (usage.outputTokens || 0) > 0) {
        const cacheText = usage.cachedInputTokens ? ` · cache ${usage.cachedInputTokens}` : '';
        costDisplay.textContent = `in ${usage.inputTokens} · out ${usage.outputTokens}${cacheText}`;
        return;
      }
    }
    if (msg && typeof msg.totalCost === 'number' && msg.totalCost > 0) {
      costDisplay.textContent = `$${msg.totalCost.toFixed(4)}`;
      return;
    }
    costDisplay.textContent = '';
  }

	  function _splitCodexThinkingModel(model) {
	    const raw = String(model || '').trim();
	    if (!raw) return { base: '', level: '' };
	    const m = raw.match(/^(.*)\(([^()]+)\)\s*$/);
	    if (!m) return { base: raw, level: '' };
	    return { base: (m[1] || '').trim(), level: (m[2] || '').trim().toLowerCase() };
	  }

	  function _parseCodexModelListText(text) {
	    const seen = new Set();
	    const models = [];
	    String(text || '')
	      .split(/\r?\n|,/)
	      .map((item) => item.trim())
	      .filter(Boolean)
	      .forEach((item) => {
	        if (seen.has(item)) return;
	        seen.add(item);
	        models.push(item);
	      });
	    return models;
	  }

	  function normalizeCodexProfile(profile) {
	    const normalized = {
	      name: String(profile?.name || '').trim(),
	      apiKey: String(profile?.apiKey || ''),
	      apiBase: String(profile?.apiBase || '').trim(),
	      useProxy: !!profile?.useProxy,
	      proxyUrl: String(profile?.proxyUrl || '').trim(),
	      model: String(profile?.model || '').trim(),
	      models: [],
	    };
	    const seen = new Set();
	    function addModel(value) {
	      const model = String(value || '').trim();
	      if (!model || seen.has(model)) return;
	      seen.add(model);
	      normalized.models.push(model);
	    }
	    if (Array.isArray(profile?.models)) profile.models.forEach(addModel);
	    addModel(normalized.model);
	    return normalized;
	  }

	  function getActiveCodexProfileConfig() {
	    const config = codexConfigCache || null;
	    if (!config || config.mode !== 'custom' || !config.activeProfile) return null;
	    const profile = (config.profiles || []).find((item) => item.name === config.activeProfile) || null;
	    return profile ? normalizeCodexProfile(profile) : null;
	  }

	  function getCodexBaseModelOptions() {
	    const seen = new Set();
	    const options = [];

	    function addOption(value, label, desc) {
	      const v = (value || '').trim();
	      if (!v || seen.has(v)) return;
	      seen.add(v);
	      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
	    }

	    function addBaseOption(value, label, desc) {
	      const { base } = _splitCodexThinkingModel(value);
	      addOption(base, label || base, desc);
	    }

	    const activeProfile = getActiveCodexProfileConfig();
	    const configuredModels = Array.isArray(activeProfile?.models) ? activeProfile.models : [];
	    configuredModels.forEach((model) => addBaseOption(model, model, 'Profile 已配置模型'));

	    return options;
	  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);
  const _previewCodeMap = new Map();
  let _previewCodeId = 0;

  const renderer = new marked.Renderer();
  renderer.code = function (code, language) {
    const lang = (language || 'plaintext').toLowerCase();
    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }
    const canPreview = PREVIEW_LANGS.has(lang);
    const previewBtn = canPreview
      ? `<button class="code-preview-btn" onclick="ccTogglePreview(this)">Preview</button>`
      : '';
    const previewPane = canPreview
      ? `<div class="code-preview-pane"><iframe class="code-preview-iframe" sandbox="allow-scripts" loading="lazy"></iframe></div>`
      : '';
    const cid = canPreview ? (++_previewCodeId) : 0;
    if (canPreview) _previewCodeMap.set(cid, code);
    return `<div class="code-block-wrapper${canPreview ? ' has-preview' : ''}"${canPreview ? ` data-cid="${cid}"` : ''}>
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <div class="code-block-actions">${previewBtn}<button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button></div>
      </div>
      ${previewPane}<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
    const code = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : wrapper.querySelector('code').textContent;
    copyTextToClipboard(code).then((ok) => {
      if (!ok) return;
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    }).catch(() => {});
  };

  window.ccTogglePreview = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const inPreview = wrapper.classList.contains('preview-mode');
    if (inPreview) {
      wrapper.classList.remove('preview-mode');
      btn.textContent = 'Preview';
    } else {
      const iframe = wrapper.querySelector('.code-preview-iframe');
      if (iframe && !iframe.dataset.loaded) {
        const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
        iframe.srcdoc = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : '';
        iframe.dataset.loaded = '1';
      }
      wrapper.classList.add('preview-mode');
      btn.textContent = 'Source';
    }
  };

  // --- WebSocket ---
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      preserveSessionViewOnReconnect = !!currentSessionId;
      // 带上上次查看的 session，让服务器在 auth 通过后顺手返回 session_info，
      // 移动端可省去一次 load_session 的 RTT。
      const preferSessionId = getLastSessionForAgent(currentAgent) || '';
      initialPreferredSessionId = preferSessionId;
      initialPreferredSessionApplied = false;
      if (pendingLoginPassword) {
        send({ type: 'auth', password: pendingLoginPassword, preferSessionId });
      } else if (authToken) {
        send({ type: 'auth', token: authToken, preferSessionId });
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      markPendingOutboundMessagesFailed('网络连接已断开，请重试');
      clearSessionLoading();
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(data));
    return true;
  }

  function submitLogin(password) {
    const pw = String(password || '');
    if (!pw) return;
    pendingLoginPassword = pw;
    if (!ws || ws.readyState > 1) {
      connect();
      return;
    }
    if (ws.readyState === 0) return;
    send({ type: 'auth', password: pw });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function isRuntimeStreamMessage(type) {
    return type === 'text_delta' ||
      type === 'tool_start' ||
      type === 'tool_end' ||
      type === 'resume_generating' ||
      type === 'done';
  }

  function clearDeferredRuntimeMessages() {
    deferredRuntimeMessages = [];
    deferredRuntimeSessionId = null;
  }

  function clearHistoryChunkQueue() {
    historyChunkQueue = [];
    historyChunkSessionId = null;
    if (historyChunkFrame) {
      cancelAnimationFrame(historyChunkFrame);
      historyChunkFrame = 0;
    }
  }

  function scheduleHistoryChunkPump() {
    if (historyChunkFrame) return;
    historyChunkFrame = requestAnimationFrame(processHistoryChunkQueue);
  }

  function enqueueHistoryChunk(chunk) {
    if (!chunk?.sessionId) return;
    if (!historyChunkSessionId) historyChunkSessionId = chunk.sessionId;
    if (historyChunkSessionId !== chunk.sessionId) {
      clearHistoryChunkQueue();
      historyChunkSessionId = chunk.sessionId;
    }
    historyChunkQueue.push(chunk);
    scheduleHistoryChunkPump();
  }

  function processHistoryChunkQueue() {
    historyChunkFrame = 0;
    if (!historyChunkQueue.length) return;

    const targetSessionId = historyChunkSessionId;
    if (!targetSessionId || targetSessionId !== currentSessionId || loadedHistorySessionId !== targetSessionId) {
      clearHistoryChunkQueue();
      return;
    }

    const startedAt = performance.now();
    const frameBudgetMs = isBlockingSessionLoad(targetSessionId) ? 12 : 8;
    let sawLastChunk = false;

    while (historyChunkQueue.length > 0 && (performance.now() - startedAt) < frameBudgetMs) {
      const chunk = historyChunkQueue.shift();
      if (chunk.sessionId !== currentSessionId || loadedHistorySessionId !== chunk.sessionId) {
        clearHistoryChunkQueue();
        return;
      }
      prependHistoryMessages(chunk.messages || [], {
        preserveScroll: !chunk.blocking,
        skipScrollbar: chunk.blocking,
      });
      if (!chunk.remaining) sawLastChunk = true;
    }

    if (historyChunkQueue.length > 0) {
      scheduleHistoryChunkPump();
      return;
    }

    historyChunkSessionId = null;
    if (sawLastChunk) {
      finalizeLoadedSession(targetSessionId);
    }
  }

  function queueDeferredRuntimeMessage(msg) {
    const targetSessionId = activeSessionLoad?.sessionId || currentSessionId || null;
    if (!deferredRuntimeSessionId) deferredRuntimeSessionId = targetSessionId;
    if (deferredRuntimeSessionId !== targetSessionId) {
      deferredRuntimeMessages = [];
      deferredRuntimeSessionId = targetSessionId;
    }
    deferredRuntimeMessages.push(msg);
  }

  function flushDeferredRuntimeMessages(sessionId) {
    if (!deferredRuntimeMessages.length) return;
    if (sessionId && deferredRuntimeSessionId && deferredRuntimeSessionId !== sessionId) return;
    const pending = deferredRuntimeMessages.slice();
    clearDeferredRuntimeMessages();
    replayingDeferredRuntimeMessages = true;
    try {
      pending.forEach((item) => handleServerMessage(item));
    } finally {
      replayingDeferredRuntimeMessages = false;
    }
  }

  function shouldDeferRuntimeMessage(msg) {
    if (replayingDeferredRuntimeMessages) return false;
    if (!activeSessionLoad) return false;
    if (!isRuntimeStreamMessage(msg.type)) return false;
    if (msg.sessionId && msg.sessionId !== activeSessionLoad.sessionId) return false;
    return true;
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    if (shouldDeferRuntimeMessage(msg)) {
      queueDeferredRuntimeMessage(msg);
      return;
    }
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          pendingLoginPassword = '';
          isAuthenticated = true;
          authToken = msg.token;
          isRootOrSudo = !!msg.isRootOrSudo;
          localStorage.setItem('cc-web-token', msg.token);
          document.dispatchEvent(new CustomEvent('cc-web-auth-restored'));
          loginOverlay.hidden = true;
          app.hidden = false;
          send({ type: 'get_codex_config' });
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else {
            pendingInitialSessionLoad = true;
          }
          syncModePickerText();
          // 命令历史和文件浏览器是懒加载的：用户切到对应 tab 时才请求，
          // 减少首屏并发请求，提升移动端 auth 后到出界面的速度。
          syncRunningCommandFromServer({ force: true }).catch(() => {});
          renderCmdPanel();
          // 当前可见 tab 触发一次首次加载
          if (activeToolTab === 'files' && !fileBrowserLoaded) {
            fileBrowserLoaded = true;
            refreshFileBrowser(fileBrowserPath || currentCwd || '').catch(() => {});
          } else if (activeToolTab === 'cmd' && !cmdPanelLoaded) {
            cmdPanelLoaded = true;
            loadCommandHistoryFromServer().catch(() => {});
          }
        } else {
          isAuthenticated = false;
          const canRetryWithPassword = !!(loginPasswordValue || pendingLoginPassword || localStorage.getItem('cc-web-pw'));
          if (msg.tokenExpired && canRetryWithPassword && !msg.banned) {
            authToken = null;
            localStorage.removeItem('cc-web-token');
            submitLogin(loginPasswordValue || pendingLoginPassword || localStorage.getItem('cc-web-pw') || '');
            return;
          }
          authToken = null;
          localStorage.removeItem('cc-web-token');
          document.dispatchEvent(new CustomEvent('cc-web-auth-failed'));
          loginOverlay.hidden = false;
          app.hidden = true;
          loginPassword.disabled = false;
          loginForm.querySelector('button[type="submit"]').disabled = false;
          if (msg.banned) {
            const remaining = msg.banInfo?.permanent
              ? '永久'
              : formatDuration(msg.banInfo?.remainingMs || 0);
            const until = msg.banInfo?.permanent
              ? '请手动解封'
              : `预计 ${formatDateTime(msg.banInfo?.expiresAtIso)} 自动解封`;
            loginError.textContent = `该 IP 已被封禁，剩余 ${remaining}。${until}`;
            loginError.hidden = false;
          } else {
            const attempts = Number.isFinite(msg.remainingAttempts) ? `，还可再试 ${msg.remainingAttempts} 次` : '';
            loginError.textContent = `密码错误${attempts}`;
            loginError.hidden = false;
          }
        }
        break;

      case 'session_list':
        sessions = msg.sessions || [];
        reconcileSessionCacheWithSessions();
        renderSessionList();
        try {
          // 缓存一份精简列表，下次刷新时可立即渲染侧边栏
          localStorage.setItem(SESSION_LIST_CACHE_KEY, JSON.stringify(sessions.map((s) => ({
            id: s.id, title: s.title, updated: s.updated, agent: s.agent,
          }))));
        } catch {}
        if (currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (pendingInitialSessionLoad) {
          pendingInitialSessionLoad = false;
          const hasUnassignedPendingMessage = Array.from(pendingOutboundMessages.values())
            .some((pending) => !pending.sessionId);
          if (hasUnassignedPendingMessage) {
            highlightActiveSession();
          } else if (initialPreferredSessionId && getSessionMeta(initialPreferredSessionId)) {
            scheduleInitialPreferredFallback();
          } else {
            syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
          }
        } else if (currentSessionId && !getSessionMeta(currentSessionId)) {
          resetChatView(currentAgent);
        }
        break;

      case 'session_info':
        const snapshot = normalizeSessionSnapshot(msg);
        reconcilePendingOutboundMessages(snapshot.messages);
        if (msg.sessionId && msg.sessionId === initialPreferredSessionId) {
          initialPreferredSessionApplied = true;
          clearInitialPreferredFallback();
        }
        if (activeSessionLoad?.sessionId === msg.sessionId) {
          activeSessionLoad.snapshot = snapshot;
        }
        applySessionSnapshot(snapshot, {
          immediate: isBlockingSessionLoad(msg.sessionId) || activeSessionLoad?.sessionId === msg.sessionId,
          suppressUnreadToast: false,
          preserveStreaming: msg.sessionId === currentSessionId && msg.isRunning,
          preserveScroll: (activeSessionLoad?.sessionId === msg.sessionId && activeSessionLoad.preserveScroll) ||
            (preserveSessionViewOnReconnect && msg.sessionId === currentSessionId),
        });
        if (msg.sessionId === currentSessionId) preserveSessionViewOnReconnect = false;
        if (!msg.historyPending) {
          if (activeSessionLoad?.sessionId === msg.sessionId) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            cacheSessionSnapshot(snapshot);
            finishSessionSwitch(msg.sessionId);
          }
        }
        break;

      case 'message_accepted':
        markOutboundMessageAccepted(msg.clientMessageId, msg.sessionId);
        break;

      case 'session_history_chunk':
        if (msg.sessionId === currentSessionId && loadedHistorySessionId === msg.sessionId) {
          const blocking = isBlockingSessionLoad(msg.sessionId);
          if (activeSessionLoad?.sessionId === msg.sessionId && activeSessionLoad.snapshot) {
            activeSessionLoad.snapshot.messages = cloneMessages(msg.messages || []).concat(activeSessionLoad.snapshot.messages);
          }
          enqueueHistoryChunk({
            sessionId: msg.sessionId,
            messages: msg.messages || [],
            blocking,
            remaining: msg.remaining,
          });
        }
        break;

      case 'session_renamed':
        sessions = sessions.map((session) => session.id === msg.sessionId ? { ...session, title: msg.title } : session);
        updateCachedSession(msg.sessionId, (snapshot) => { snapshot.title = msg.title; });
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        renderSessionList();
        break;

      case 'session_truncated': {
        const truncatedMessages = Array.isArray(msg.messages) ? msg.messages : [];
        updateCachedSession(msg.sessionId, (snapshot) => {
          snapshot.messages = cloneMessages(truncatedMessages);
          snapshot.complete = true;
          snapshot.historyPending = false;
        });
        const resend = (pendingResend && pendingResend.sessionId === msg.sessionId) ? pendingResend : null;
        pendingResend = null;
        if (msg.sessionId === currentSessionId) {
          clearHistoryChunkQueue();
          loadedHistorySessionId = currentSessionId;
          renderMessages(truncatedMessages, { immediate: true });
          if (resend) {
            dispatchMessage(resend.text, resend.attachments || []);
          } else {
            showToast('已清除该消息及其之后的内容');
          }
        }
        break;
      }

      case 'message_edited': {
        const editedMessages = Array.isArray(msg.messages) ? msg.messages : [];
        updateCachedSession(msg.sessionId, (snapshot) => {
          snapshot.messages = cloneMessages(editedMessages);
          snapshot.complete = true;
          snapshot.historyPending = false;
        });
        if (msg.sessionId === currentSessionId) {
          clearHistoryChunkQueue();
          loadedHistorySessionId = currentSessionId;
          renderMessages(editedMessages, { immediate: true, preserveScroll: true });
          showToast('已更新该消息及 AI 上下文');
        }
        break;
      }

      case 'text_delta':
        if (!isGenerating) startGenerating();
        pendingText += msg.text;
        scheduleRender();
        break;

      case 'tool_start':
        if (!isGenerating) startGenerating();
        activeToolCalls.set(msg.toolUseId, { name: msg.name, input: msg.input, kind: msg.kind || null, meta: msg.meta || null, done: false });
        appendToolCall(msg.toolUseId, msg.name, msg.input, false, msg.kind || null, msg.meta || null);
        break;

      case 'tool_end':
        if (activeToolCalls.has(msg.toolUseId)) {
          activeToolCalls.get(msg.toolUseId).done = true;
          if (msg.kind) activeToolCalls.get(msg.toolUseId).kind = msg.kind;
          if (msg.meta) activeToolCalls.get(msg.toolUseId).meta = msg.meta;
          activeToolCalls.get(msg.toolUseId).result = msg.result;
        }
        updateToolCall(msg.toolUseId, msg.result);
        break;

      case 'cost':
        costDisplay.textContent = `$${msg.costUsd.toFixed(4)}`;
        if (currentSessionId) {
          updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalCost = msg.costUsd; });
        }
        break;

      case 'usage':
        if (msg.totalUsage) {
          const cacheText = msg.totalUsage.cachedInputTokens ? ` · cache ${msg.totalUsage.cachedInputTokens}` : '';
          costDisplay.textContent = `in ${msg.totalUsage.inputTokens} · out ${msg.totalUsage.outputTokens}${cacheText}`;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalUsage = deepClone(msg.totalUsage); });
          }
        }
        break;

      case 'done':
        finishGenerating(msg.sessionId, msg.timestamp);
        break;

      case 'system_message':
        appendSystemMessage(msg.message);
        break;

      case 'codex_approval_request':
        showCodexApprovalModal(msg);
        break;

      case 'mode_changed':
        if (msg.mode && MODE_LABELS[msg.mode]) {
          currentMode = msg.mode;
          modeSelect.value = currentMode;
          localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.mode = msg.mode; });
          }
        }
        break;

      case 'model_changed':
        if (msg.model) {
          currentModel = msg.model;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.model = msg.model; });
          }
        }
        break;

      case 'resume_generating':
        // Server has an active process for this session — resume streaming
        setCurrentSessionRunningState(true);
        if (!isGenerating || !document.getElementById('streaming-msg')) {
          startGenerating();
        } else {
          sendBtn.hidden = true;
          abortBtn.hidden = false;
          toolGroupCount = 0;
          hasGrouped = false;
          activeToolCalls.clear();
          const toolsDiv = document.querySelector('#streaming-msg .msg-tools');
          if (toolsDiv) toolsDiv.innerHTML = '';
        }
        pendingText = msg.text || '';
        flushRender();
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            activeToolCalls.set(tc.id, {
              name: tc.name,
              input: tc.input,
              result: tc.result,
              kind: tc.kind || null,
              meta: tc.meta || null,
              done: tc.done,
            });
            appendToolCall(tc.id, tc.name, tc.input, tc.done, tc.kind || null, tc.meta || null);
            if (tc.done && tc.result) {
              updateToolCall(tc.id, tc.result);
            }
          }
        }
        break;

      case 'error':
        pendingResend = null;
        if (msg.clientMessageId) {
          markOutboundMessageFailed(msg.clientMessageId, msg.message || '发送失败，请重试');
        }
        appendError(msg.message);
        clearSessionLoading();
        if (!isGenerating && currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (isGenerating) finishGenerating();
        break;

      case 'notify_config':
        if (typeof _onNotifyConfig === 'function') _onNotifyConfig(msg.config);
        // Update summary in parent settings panel if visible
        if (msg.config) {
          const provider = msg.config.provider || 'off';
          const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
          const summaryOn = msg.config.summary?.enabled ? '摘要已启用' : '摘要关闭';
          const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
          document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
        }
        break;

      case 'notify_test_result':
        if (typeof _onNotifyTestResult === 'function') _onNotifyTestResult(msg);
        break;

      case 'model_config':
        if (typeof _onModelConfig === 'function') _onModelConfig(msg.config);
        break;

      case 'codex_config':
        codexConfigCache = msg.config || null;
        if (typeof _onCodexConfig === 'function') _onCodexConfig(msg.config);
        break;

      case 'claude_local_config':
        if (typeof _onClaudeLocalConfig === 'function') _onClaudeLocalConfig(msg);
        break;

      case 'codex_local_config':
        if (typeof _onCodexLocalConfig === 'function') _onCodexLocalConfig(msg);
        break;

      case 'dev_config':
        if (typeof _onDevConfig === 'function') _onDevConfig(msg.config);
        break;

      case 'security_status':
        securityStatusCache = msg || null;
        if (typeof _onSecurityStatus === 'function') _onSecurityStatus(msg);
        break;

      case 'security_action_result':
        if (typeof _onSecurityActionResult === 'function') _onSecurityActionResult(msg);
        break;

      case 'fetch_models_result':
        if (typeof _onFetchModelsResult === 'function') _onFetchModelsResult(msg);
        break;

      case 'exec_stream':
        handleExecStreamMessage(msg);
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        send({ type: 'list_sessions' });
        break;

      case 'password_changed':
        handlePasswordChanged(msg);
        break;

      case 'native_sessions':
        if (typeof _onNativeSessions === 'function') _onNativeSessions(msg.groups || [], msg);
        break;

      case 'codex_sessions':
        if (typeof _onCodexSessions === 'function') _onCodexSessions(msg.sessions || [], msg);
        break;

      case 'cwd_suggestions':
        if (typeof _onCwdSuggestions === 'function') _onCwdSuggestions(msg.paths || []);
        break;

      case 'update_info':
        if (typeof window._ccOnUpdateInfo === 'function') window._ccOnUpdateInfo(msg);
        break;
    }
  }

  // --- Generating State ---
  function startGenerating() {
    const shouldFollowOutput = followLatestOutput;
    isGenerating = true;
    setCurrentSessionRunningState(true);
    pendingText = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    // 流式消息 bubble 拆为 .msg-text 和 .msg-tools 两个子容器
    const bubble = msgEl.querySelector('.msg-bubble');
    bubble.innerHTML = '';
    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'msg-tools';
    bubble.appendChild(textDiv);
    bubble.appendChild(toolsDiv);
    addMessageCopyButton(bubble);
    messagesDiv.appendChild(msgEl);
    if (shouldFollowOutput) scrollToBottom();
  }

  function finishGenerating(sessionId, timestamp = null) {
    isGenerating = false;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    setCurrentSessionRunningState(false);
    msgInput.focus();

    if (pendingText) flushRender();

    const typing = document.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      const hasToolCalls = !!streamEl.querySelector('.tool-call');
      if (!pendingText && !hasToolCalls) {
        streamEl.remove();
      } else if (hasGrouped) {
        // 若本轮出现过父目录，把末尾散落的 .tool-call 也一并收入同一父节点
        const toolsDiv = streamEl.querySelector('.msg-tools');
        if (toolsDiv) {
          const loose = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
          if (loose.length > 0) {
            let group = toolsDiv.querySelector(':scope > .tool-group');
            if (!group) {
              group = document.createElement('details');
              group.className = 'tool-group';
              const gs = document.createElement('summary');
              gs.className = 'tool-group-summary';
              group.appendChild(gs);
              const inner = document.createElement('div');
              inner.className = 'tool-group-inner';
              group.appendChild(inner);
              toolsDiv.insertBefore(group, toolsDiv.firstChild);
            }
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
      if (streamEl.isConnected) {
        addMessageTimestamp(streamEl, timestamp || new Date().toISOString());
        streamEl.removeAttribute('id');
        attachFileReferences(streamEl);
      }
    }

    if (sessionId) currentSessionId = sessionId;
    pendingText = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  function flushRender() {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const shouldFollowOutput = followLatestOutput;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let textDiv = bubble.querySelector('.msg-text');
    if (!textDiv) { textDiv = bubble; }
    textDiv.innerHTML = renderMarkdown(pendingText);
    if (shouldFollowOutput) scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function getMessageCopyText(bubble) {
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.msg-actions, .msg-edit-box, .msg-copy-btn, .code-block-header, .code-preview-pane, .typing-indicator, .msg-generated-files').forEach((node) => node.remove());
    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  }

  function getMsgActions(bubble) {
    let actions = bubble.querySelector(':scope > .msg-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'msg-actions';
      bubble.appendChild(actions);
    }
    return actions;
  }

  function addMessageCopyButton(bubble) {
    const actions = getMsgActions(bubble);
    if (actions.querySelector(':scope > .msg-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-copy-btn';
    btn.type = 'button';
    btn.title = '复制整条消息';
    btn.setAttribute('aria-label', '复制整条消息');
    btn.textContent = '复制';
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = getMessageCopyText(bubble);
      try {
        const ok = await copyTextToClipboard(text);
        if (!ok) throw new Error('copy failed');
        btn.textContent = '已复制';
        showToast('已复制整条消息');
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      } catch {
        showToast('复制失败，请手动选择文本');
      }
    });
    actions.appendChild(btn);
  }

  function addMessageTruncateButton(bubble, message) {
    const actions = getMsgActions(bubble);
    if (actions.querySelector(':scope > .msg-truncate-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-truncate-btn';
    btn.type = 'button';
    btn.title = '删除这条及其之后的所有消息，并同步清理 AI 上下文以节省 token';
    btn.setAttribute('aria-label', '从这里清除');
    btn.textContent = '从这里清除';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!currentSessionId) return;
      if (!confirm('将删除这条消息及其之后的所有消息，并同步清理发送给 AI 的上下文（用于节省 token）。此操作不可撤销，确定继续吗？')) return;
      send({
        type: 'truncate_session',
        sessionId: currentSessionId,
        timestamp: message.timestamp || null,
        content: message.content || '',
      });
    });
    actions.appendChild(btn);
  }

  function addMessageResendButton(bubble, message) {
    const actions = getMsgActions(bubble);
    if (actions.querySelector(':scope > .msg-resend-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-resend-btn';
    btn.type = 'button';
    btn.title = '删除这条及其之后的所有消息，然后用这条消息的内容重新发送一次';
    btn.setAttribute('aria-label', '重新发送');
    btn.textContent = '重新发送';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!currentSessionId) return;
      if (isGenerating) {
        appendError('正在生成中，请先停止后再重新发送。');
        return;
      }
      const text = message.content || '';
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({ ...attachment }))
        : [];
      if (!text.trim() && attachments.length === 0) {
        appendError('该消息没有可重新发送的内容。');
        return;
      }
      if (!confirm('将删除这条消息及其之后的所有消息（并同步清理 AI 上下文），然后用这条消息的内容重新发送一次。确定继续吗？')) return;
      // 记录重发意图：截断成功后在 session_truncated 处理里触发重发
      pendingResend = { sessionId: currentSessionId, text, attachments };
      send({
        type: 'truncate_session',
        sessionId: currentSessionId,
        timestamp: message.timestamp || null,
        content: message.content || '',
      });
    });
    actions.appendChild(btn);
  }

  function addMessageEditButton(bubble, message) {
    const actions = getMsgActions(bubble);
    if (actions.querySelector(':scope > .msg-edit-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-edit-btn';
    btn.type = 'button';
    btn.title = '编辑这条消息内容，并同步到发送给 AI 的上下文';
    btn.setAttribute('aria-label', '编辑');
    btn.textContent = '编辑';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      startMessageEdit(bubble, message);
    });
    actions.appendChild(btn);
  }

  function startMessageEdit(bubble, message) {
    if (bubble.querySelector(':scope > .msg-edit-box')) return;
    const isAssistant = message.role === 'assistant';
    const textNode = bubble.querySelector(':scope > .msg-text');
    const original = message.content || (textNode ? textNode.textContent : '') || '';

    // 编辑时隐藏原内容：用户消息只有 .msg-text；AI 消息是渲染后的 Markdown + 工具调用，隐藏全部直接子元素
    const hidden = [];
    if (isAssistant) {
      for (const child of Array.from(bubble.children)) {
        if (child.classList && child.classList.contains('msg-actions')) continue;
        if (child.style.display !== 'none') { hidden.push(child); child.style.display = 'none'; }
      }
    } else if (textNode) {
      textNode.style.display = 'none';
      hidden.push(textNode);
    }

    // 隐藏原有的附件展示，改为在编辑栏内管理
    const oldAttachments = bubble.querySelector('.msg-attachments');
    if (oldAttachments) {
      oldAttachments.style.display = 'none';
      hidden.push(oldAttachments);
    }

    const box = document.createElement('div');
    box.className = 'msg-edit-box';
    const ta = document.createElement('textarea');
    ta.className = 'msg-edit-input';
    ta.value = original;
    const row = document.createElement('div');
    row.className = 'msg-edit-row';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'msg-edit-save';
    saveBtn.textContent = '保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'msg-edit-cancel';
    cancelBtn.textContent = '取消';
    if (isAssistant) {
      const hint = document.createElement('span');
      hint.className = 'msg-edit-hint';
      hint.textContent = '保存将删除本轮的工具调用记录';
      row.appendChild(hint);
    }

    // --- 附件管理 (仅用户消息支持) ---
    const editAttachments = [];
    let editRemovedAttachmentIds = [];
    let addBtn = null;
    let originalOnchange = null;

    function renderEditAttachments() {
      if (!isAssistant) {
        const tray = box.querySelector('.msg-edit-attachment-tray');
        if (!tray) return;
        if (editAttachments.length === 0 && editRemovedAttachmentIds.length === 0) {
          tray.hidden = true;
          tray.innerHTML = '';
          return;
        }
        tray.hidden = false;
        const html = editAttachments.map((attachment, index) => `
          <div class="attachment-chip" data-index="${index}">
            <div class="attachment-chip-meta">
              <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
              <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 附加到本条消息</span>
            </div>
            <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
          </div>
        `).join('');
        tray.innerHTML = html;
        tray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = Number(btn.dataset.index);
            const [removed] = editAttachments.splice(index, 1);
            editRemovedAttachmentIds.push(removed.id);
            renderEditAttachments();
          });
        });
      }
    }

    if (!isAssistant) {
      const attachments = (Array.isArray(message.attachments) ? message.attachments : []).filter((a) => a.storageState !== 'expired');
      editAttachments.push(...attachments.map((a) => ({ ...a })));

      addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'msg-edit-add-attachment';
      addBtn.textContent = '添加附件';
      addBtn.title = '上传图片并附加到本条消息';

      const tray = document.createElement('div');
      tray.className = 'msg-edit-attachment-tray attachment-tray';
      tray.hidden = true;
      box.appendChild(tray);
      renderEditAttachments();

      // 保存原始 onchange，编辑结束后恢复
      originalOnchange = imageUploadInput ? imageUploadInput.onchange : null;
      addBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (editAttachments.length + editRemovedAttachmentIds.length >= MAX_MESSAGE_ATTACHMENTS) {
          showToast(`单条消息最多附带 ${MAX_MESSAGE_ATTACHMENTS} 张图片`);
          return;
        }
        if (!imageUploadInput) return;
        imageUploadInput.onchange = async (ev) => {
          const files = Array.from(ev.target.files || []).filter((f) => f && /^image\//.test(f.type || ''));
          if (!files.length) { imageUploadInput.onchange = originalOnchange; return; }
          const room = MAX_MESSAGE_ATTACHMENTS - editAttachments.length - editRemovedAttachmentIds.length;
          const toUpload = files.slice(0, Math.max(0, room));
          const extra = files.slice(Math.max(0, room));
          if (extra.length > 0) showToast(`单条消息最多附带 ${MAX_MESSAGE_ATTACHMENTS} 张图片，已忽略超出部分`);

          // 上传并直接放入编辑栏
          const uploadPromises = toUpload.map(async (file) => {
            const optimized = await compressImageFile(file);
            return uploadImageFile(optimized);
          });
          const results = await Promise.allSettled(uploadPromises);
          const errors = [];
          for (const result of results) {
            if (result.status === 'fulfilled') {
              editAttachments.push(result.value);
            } else {
              errors.push(result.reason?.message || '图片上传失败');
            }
          }
          if (errors.length > 0) appendError(errors[0]);
          renderEditAttachments();
          if (imageUploadInput) imageUploadInput.value = '';
          imageUploadInput.onchange = originalOnchange;
        };
        imageUploadInput.click();
      });
    }

    if (addBtn) row.appendChild(addBtn);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    box.appendChild(ta);
    box.appendChild(row);

    const actions = bubble.querySelector(':scope > .msg-actions');
    if (actions) actions.style.display = 'none';
    bubble.insertBefore(box, actions || null);

    const autoGrow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 320) + 'px'; };
    autoGrow();
    ta.addEventListener('input', autoGrow);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const cleanup = () => {
      // 回退未发送的新增上传附件
      for (const a of editAttachments) {
        if (!message.attachments?.some((ma) => ma.id === a.id)) {
          deleteUploadedAttachment(a.id);
        }
      }
      // 恢复被移除的附件 (仅客户端删除记录，文件不实际删除)
      editRemovedAttachmentIds = [];
      if (imageUploadInput) imageUploadInput.onchange = originalOnchange || null;
      box.remove();
      hidden.forEach((node) => { node.style.display = ''; });
      if (actions) actions.style.display = '';
    };
    cancelBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); });
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = ta.value;
      if (!next.trim()) { showToast('内容不能为空'); return; }
      if (!currentSessionId) return;
      const isAssistant = message.role === 'assistant';
      const confirmMsg = isAssistant
        ? '将修改这条 AI 回复并同步更新上下文，本轮的工具调用记录会被删除。确定保存吗？'
        : '将修改这条消息，并同步更新发送给 AI 的上下文。确定保存吗？';
      if (!confirm(confirmMsg)) return;
      if (next === original && editAttachments.length === 0 && editRemovedAttachmentIds.length === 0) {
        cleanup();
        return;
      }
      const payload = {
        type: 'edit_message',
        sessionId: currentSessionId,
        role: message.role || 'user',
        timestamp: message.timestamp || null,
        content: original,
        newContent: next,
      };
      if (!isAssistant) {
        payload.addedAttachments = editAttachments.map((a) => ({ ...a }));
        payload.removedAttachmentIds = editRemovedAttachmentIds;
      }
      send(payload);
      cleanup();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });
  }

  function formatMessageTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function addMessageTimestamp(messageElement, timestamp) {
    if (!messageElement || messageElement.classList.contains('system')) return;
    const text = formatMessageTimestamp(timestamp);
    if (!text) return;
    const content = messageElement.querySelector(':scope > .msg-content');
    if (!content) return;
    let time = content.querySelector(':scope > .msg-time');
    if (!time) {
      time = document.createElement('time');
      time.className = 'msg-time';
      content.appendChild(time);
    }
    time.dateTime = timestamp;
    time.textContent = text;
  }

  function setOutboundMessageState(messageElement, state, errorMessage = '') {
    if (!messageElement) return;
    messageElement.classList.toggle('is-sending', state === 'sending');
    messageElement.classList.toggle('is-send-failed', state === 'failed');
    const content = messageElement.querySelector(':scope > .msg-content');
    if (!content) return;
    let status = content.querySelector(':scope > .msg-send-status');
    if (state === 'sent') {
      if (status) status.remove();
      return;
    }
    if (!status) {
      status = document.createElement('div');
      status.className = 'msg-send-status';
      content.appendChild(status);
    }
    status.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = state === 'failed' ? (errorMessage || '发送失败') : '正在发送…';
    status.appendChild(label);
    if (state === 'failed') {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'msg-send-retry';
      retryButton.textContent = '重试';
      retryButton.addEventListener('click', () => retryOutboundMessage(messageElement.dataset.clientMessageId));
      status.appendChild(retryButton);
    }
  }

  function findOutboundMessageElement(clientMessageId) {
    if (!clientMessageId) return null;
    return Array.from(messagesDiv.querySelectorAll('.msg.user[data-client-message-id]'))
      .find((element) => element.dataset.clientMessageId === clientMessageId) || null;
  }

  function markOutboundMessageAccepted(clientMessageId, sessionId) {
    const pending = pendingOutboundMessages.get(clientMessageId);
    if (!pending) return;
    pendingOutboundMessages.delete(clientMessageId);
    if (sessionId) {
      pending.sessionId = sessionId;
      currentSessionId = sessionId;
      setLastSessionForAgent(pending.agent, sessionId);
    }
    setOutboundMessageState(findOutboundMessageElement(clientMessageId), 'sent');
  }

  function reconcilePendingOutboundMessages(messages) {
    if (!Array.isArray(messages) || pendingOutboundMessages.size === 0) return;
    const acceptedIds = new Set(messages.map((message) => message?.clientMessageId).filter(Boolean));
    acceptedIds.forEach((clientMessageId) => markOutboundMessageAccepted(clientMessageId));
  }

  function mergePendingOutboundMessages(messages, sessionId) {
    const merged = cloneMessages(messages);
    const existingIds = new Set(merged.map((message) => message?.clientMessageId).filter(Boolean));
    pendingOutboundMessages.forEach((pending, clientMessageId) => {
      if (pending.sessionId !== sessionId || existingIds.has(clientMessageId)) return;
      merged.push({
        role: 'user',
        content: pending.text,
        attachments: pending.attachments,
        timestamp: pending.timestamp,
        clientMessageId,
        deliveryState: pending.state,
        deliveryError: pending.error,
      });
    });
    return merged;
  }

  function markPendingOutboundMessagesFailed(message) {
    pendingOutboundMessages.forEach((pending, clientMessageId) => {
      if (pending.state !== 'sending') return;
      markOutboundMessageFailed(clientMessageId, message);
    });
  }

  function markOutboundMessageFailed(clientMessageId, message) {
    const pending = pendingOutboundMessages.get(clientMessageId);
    if (!pending) return;
    pending.state = 'failed';
    pending.error = message || '发送失败，请重试';
    setOutboundMessageState(findOutboundMessageElement(clientMessageId), 'failed', pending.error);
    if (isGenerating) finishGenerating();
  }

  function retryOutboundMessage(clientMessageId) {
    const pending = pendingOutboundMessages.get(clientMessageId);
    if (!pending || pending.state === 'sending' || isGenerating) return;
    pending.sessionId = currentSessionId || pending.sessionId || null;
    pending.state = 'sending';
    pending.error = '';
    setOutboundMessageState(findOutboundMessageElement(clientMessageId), 'sending');
    if (!send({
      type: 'message',
      text: pending.text,
      attachments: pending.attachments,
      timestamp: pending.timestamp,
      clientMessageId,
      sessionId: pending.sessionId,
      mode: pending.mode,
      agent: pending.agent,
    })) {
      pending.state = 'failed';
      pending.error = '网络尚未连接，请稍后重试';
      setOutboundMessageState(findOutboundMessageElement(clientMessageId), 'failed', pending.error);
      connect();
      return;
    }
    startGenerating();
  }

  function createMsgElement(role, content, attachments = [], timestamp = null, options = {}) {
    const div = document.createElement('div');
    div.className = `msg ${role}${role === 'assistant' ? ' agent-' + currentAgent : ''}`;
    if (options.clientMessageId) div.dataset.clientMessageId = options.clientMessageId;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = 'U';
    } else if (currentAgent === 'codex') {
      avatar.innerHTML = `<img src="/codex.png" width="24" height="24" style="display:block;" alt="Codex">`;
    } else {
      avatar.innerHTML = `<img src="/claude.png" width="24" height="24" style="display:block;" alt="Claude">`;
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      if (content) {
        const textNode = document.createElement('div');
        textNode.className = 'msg-text';
        textNode.style.whiteSpace = 'pre-wrap';
        textNode.textContent = content;
        bubble.appendChild(textNode);
      }
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    } else {
      bubble.innerHTML = content ? renderMarkdown(content) : '';
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    }

    const messageContent = document.createElement('div');
    messageContent.className = 'msg-content';
    messageContent.appendChild(bubble);

    div.appendChild(avatar);
    div.appendChild(messageContent);
    addMessageTimestamp(div, timestamp);
    addMessageCopyButton(bubble);
    if (role === 'user' && options.deliveryState) {
      setOutboundMessageState(div, options.deliveryState, options.deliveryError || '');
    }
    return div;
  }

  let renderEpoch = 0;

  function toolKind(tool) {
    return tool?.kind || tool?.meta?.kind || '';
  }

  function toolTitle(tool) {
    if (tool?.meta?.title) return tool.meta.title;
    return tool?.name || 'Tool';
  }

  function toolSubtitle(tool) {
    if (tool?.meta?.subtitle) return tool.meta.subtitle;
    if (toolKind(tool) === 'command_execution') {
      return tool?.input?.command || '';
    }
    return '';
  }

  function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolStateLabel(tool, done) {
    if (!done) return 'Running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number') {
      return `Exit ${tool.meta.exitCode}`;
    }
    return 'Done';
  }

  function toolStateClass(tool, done) {
    if (!done) return 'running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number' && tool.meta.exitCode !== 0) {
      return 'error';
    }
    return 'done';
  }

  function applyToolSummary(summary, tool, done) {
    summary.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = `tool-call-icon ${done ? 'done' : 'running'}`;

    const main = document.createElement('span');
    main.className = 'tool-call-summary-main';
    const label = document.createElement('span');
    label.className = 'tool-call-label';
    label.textContent = toolTitle(tool);
    main.appendChild(label);

    const subtitleText = toolSubtitle(tool);
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'tool-call-subtitle';
      subtitle.textContent = subtitleText;
      main.appendChild(subtitle);
    }

    const state = document.createElement('span');
    state.className = `tool-call-state ${toolStateClass(tool, done)}`;
    state.textContent = toolStateLabel(tool, done);

    summary.appendChild(icon);
    summary.appendChild(main);
    summary.appendChild(state);
  }

  function buildStructuredToolSection(labelText, bodyText) {
    const section = document.createElement('div');
    section.className = 'tool-call-section';
    const label = document.createElement('div');
    label.className = 'tool-call-section-label';
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = 'tool-call-code';
    pre.textContent = bodyText;
    section.appendChild(label);
    section.appendChild(pre);
    return section;
  }

	  function buildMsgElement(m) {
	    const el = createMsgElement(m.role, m.content, m.attachments || [], m.timestamp || null, {
        clientMessageId: m.clientMessageId || '',
        deliveryState: m.deliveryState || '',
        deliveryError: m.deliveryError || '',
      });
	    if (m.role === 'user' && m.timestamp) {
	      const bubble = el.querySelector('.msg-bubble');
	      if (bubble) {
	        addMessageEditButton(bubble, m);
	        addMessageTruncateButton(bubble, m);
	        addMessageResendButton(bubble, m);
	      }
	    }
	    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
	      const bubble = el.querySelector('.msg-bubble');
	      const FOLD_AT = 3;
	      let grouped = false;
	      for (const tc of m.toolCalls) {
	        const details = createToolCallElement(tc.id || `saved-${Math.random().toString(36).slice(2)}`, tc, true);

	        // 散落的 .tool-call 达到 FOLD_AT 个时，移入唯一 .tool-group
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length >= FOLD_AT) {
          let group = bubble.querySelector(':scope > .tool-group');
          if (!group) {
            group = document.createElement('details');
            group.className = 'tool-group';
            const gs = document.createElement('summary');
            gs.className = 'tool-group-summary';
            group.appendChild(gs);
            const inner = document.createElement('div');
            inner.className = 'tool-group-inner';
            group.appendChild(inner);
            bubble.insertBefore(group, bubble.firstChild);
            grouped = true;
          }
          const inner = group.querySelector('.tool-group-inner');
          loose.forEach(c => inner.appendChild(c));
          _refreshGroupSummary(group);
        }
        bubble.appendChild(details);
      }
      // 结束时若出现过父目录，收尾散落项
      if (grouped) {
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length > 0) {
          const group = bubble.querySelector(':scope > .tool-group');
          if (group) {
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
    }
    if (m.role === 'assistant' && m.timestamp) {
      const bubble = el.querySelector('.msg-bubble');
      if (bubble) addMessageEditButton(bubble, m);
    }
    if (m.role === 'assistant') watchFileReferences(el);
    return el;
  }

  function renderMessages(messages, options = {}) {
    renderEpoch++;
    const epoch = renderEpoch;
    const preserveScroll = options.preserveScroll === true;
    const previousScrollTop = Number.isFinite(options.previousScrollTop) ? options.previousScrollTop : messagesDiv.scrollTop;
    // observer 会强引用被观察节点，整屏重渲染前必须解绑，否则切会话会持续堆积旧节点
    if (fileRefsObserver) fileRefsObserver.disconnect();
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
      return;
    }
    if (options.immediate) {
      const frag = document.createDocumentFragment();
      messages.forEach((message) => frag.appendChild(buildMsgElement(message)));
      messagesDiv.appendChild(frag);
      if (preserveScroll) {
        messagesDiv.scrollTop = previousScrollTop;
        updateScrollbar();
      } else {
        scrollToBottom({ force: true });
      }
      return;
    }
    // Batch render: last 10 first, then next 20, then the rest
    const batches = [];
    const len = messages.length;
    if (len <= 10) {
      batches.push([0, len]);
    } else if (len <= 30) {
      batches.push([len - 10, len]);
      batches.push([0, len - 10]);
    } else {
      batches.push([len - 10, len]);
      batches.push([len - 30, len - 10]);
      batches.push([0, len - 30]);
    }

    // Render first batch immediately
    const frag0 = document.createDocumentFragment();
    for (let i = batches[0][0]; i < batches[0][1]; i++) frag0.appendChild(buildMsgElement(messages[i]));
    messagesDiv.appendChild(frag0);
    if (preserveScroll) {
      messagesDiv.scrollTop = previousScrollTop;
      updateScrollbar();
    } else {
      scrollToBottom({ force: true });
    }

    // Render remaining batches asynchronously, prepending each
    // Use scrollHeight delta to keep current view position stable after prepend
    let delay = 0;
    for (let b = 1; b < batches.length; b++) {
      const [start, end] = batches[b];
      delay += 16;
      setTimeout(() => {
        if (renderEpoch !== epoch) return; // session switched, abort stale render
        const prevHeight = messagesDiv.scrollHeight;
        const prevScrollTop = messagesDiv.scrollTop;
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildMsgElement(messages[i]));
        messagesDiv.insertBefore(frag, messagesDiv.firstChild);
        // Compensate scrollTop so visible area stays unchanged
        messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
        updateScrollbar();
      }, delay);
    }
  }

  function prependHistoryMessages(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const preserveScroll = options.preserveScroll !== false;
    const skipScrollbar = options.skipScrollbar === true;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const frag = document.createDocumentFragment();
    messages.forEach((m) => frag.appendChild(buildMsgElement(m)));
    if (!preserveScroll) {
      messagesDiv.insertBefore(frag, messagesDiv.firstChild);
      if (!skipScrollbar) updateScrollbar();
      return;
    }
    const prevHeight = messagesDiv.scrollHeight;
    const prevScrollTop = messagesDiv.scrollTop;
    messagesDiv.insertBefore(frag, messagesDiv.firstChild);
    messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
    if (!skipScrollbar) updateScrollbar();
  }

  function normalizeAskUserInput(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return input;
  }

  function extractAskUserQuestions(input) {
    const parsed = normalizeAskUserInput(input);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  }

  function appendAskOptionToInput(question, option) {
    const header = (question?.header || '').trim() || '问题';
    const line = `【${header}】${option?.label || ''}`;
    const current = msgInput.value.trim();
    msgInput.value = current ? `${current}\n${line}` : line;
    autoResize();
    msgInput.focus();
  }

  // Codex out-of-workspace approval prompt. Codex only asks when an action escapes the
  // project directory, so any request here means the user must consciously allow it.
  let activeApprovalOverlay = null;
  const approvalQueue = [];
  function showCodexApprovalModal(msg) {
    // Codex can have several approvals in flight at once. Queue them: replacing the
    // overlay would drop the earlier request without a reply and hang that turn.
    approvalQueue.push(msg);
    if (!activeApprovalOverlay) renderNextApproval();
  }

  function renderNextApproval() {
    const msg = approvalQueue.shift();
    if (!msg) return;

    const overlay = document.createElement('div');
    overlay.className = 'approval-overlay';
    activeApprovalOverlay = overlay;

    const modal = document.createElement('div');
    modal.className = 'approval-modal';

    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = `⚠ ${msg.title || '需要确认的操作'}`;
    modal.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'approval-desc';
    desc.textContent = msg.reason || 'Codex 请求执行一个需要你确认的操作。';
    modal.appendChild(desc);

    if (msg.cwd) {
      const cwdRow = document.createElement('div');
      cwdRow.className = 'approval-meta';
      cwdRow.textContent = `项目目录：${msg.cwd}`;
      modal.appendChild(cwdRow);
    }

    if (msg.command) {
      const cmd = document.createElement('pre');
      cmd.className = 'approval-command';
      cmd.textContent = msg.command;
      modal.appendChild(cmd);
    }

    if (Array.isArray(msg.paths) && msg.paths.length > 0) {
      const pathsWrap = document.createElement('div');
      pathsWrap.className = 'approval-paths';
      pathsWrap.textContent = `涉及路径：${msg.paths.join('  ·  ')}`;
      modal.appendChild(pathsWrap);
    }

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    let answered = false;
    const respond = (decision) => {
      if (answered) return;
      answered = true;
      send({ type: 'approval_response', sessionId: msg.sessionId, approvalId: msg.approvalId, decision });
      overlay.remove();
      if (activeApprovalOverlay === overlay) activeApprovalOverlay = null;
      renderNextApproval();
    };

    const denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'approval-btn approval-deny';
    denyBtn.textContent = '拒绝';
    denyBtn.addEventListener('click', () => respond('deny'));

    const allowBtn = document.createElement('button');
    allowBtn.type = 'button';
    allowBtn.className = 'approval-btn approval-allow';
    allowBtn.textContent = '允许本次';
    allowBtn.addEventListener('click', () => respond('approve'));

    actions.appendChild(denyBtn);
    actions.appendChild(allowBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    allowBtn.focus();
  }

  function createAskUserQuestionView(questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ask-user-question';

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'ask-question-card';

      const header = document.createElement('div');
      header.className = 'ask-question-header';
      header.textContent = `${idx + 1}. ${q.header || '问题'}`;
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'ask-question-text';
      body.textContent = q.question || '';
      card.appendChild(body);

      if (Array.isArray(q.options) && q.options.length > 0) {
        const hasDesc = q.options.some(o => o.description);

        // 左右分栏容器
        const layout = document.createElement('div');
        layout.className = 'ask-options-layout' + (hasDesc ? ' has-preview' : '');

        const opts = document.createElement('div');
        opts.className = 'ask-question-options';

        // 右侧预览区（仅在有 description 时创建）
        const preview = hasDesc ? document.createElement('div') : null;
        if (preview) {
          preview.className = 'ask-option-preview';
          // 默认显示第一项
          preview.textContent = q.options[0].description || '';
        }

        // 当前选中项（移动端 tap-to-preview 状态）
        let selectedOpt = null;
        let selectedBtn = null;

        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          // 桌面：hover 切换预览
          if (preview) {
            item.addEventListener('mouseenter', () => {
              preview.textContent = opt.description || '';
            });
          }

          item.addEventListener('click', (e) => {
            const isTouch = item.dataset.touchActivated === '1';
            item.dataset.touchActivated = '';

            if (isTouch) {
              // 移动端：第一次 tap = 选中预览，不发送
              if (selectedBtn !== item) {
                if (selectedBtn) selectedBtn.classList.remove('ask-option-selected');
                selectedBtn = item;
                selectedOpt = opt;
                item.classList.add('ask-option-selected');
                if (preview) preview.textContent = opt.description || '';
                return;
              }
              // 第二次 tap 同一项 = 发送
            }

            // 桌面直接发送
            appendAskOptionToInput(q, opt);
          });

          item.addEventListener('touchstart', () => {
            item.dataset.touchActivated = '1';
          }, { passive: true });

          opts.appendChild(item);
        });

        layout.appendChild(opts);
        if (preview) {
          layout.appendChild(preview);
          // 预览区最小高度 = 左侧选项列表总高度（渲染后同步）
          requestAnimationFrame(() => {
            preview.style.minHeight = opts.offsetHeight + 'px';
          });
        }

        // 移动端确认按钮
        if (hasDesc) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'ask-confirm-btn';
          confirmBtn.textContent = '确认选择';
          confirmBtn.addEventListener('click', () => {
            if (selectedOpt) {
              appendAskOptionToInput(q, selectedOpt);
            } else if (q.options.length > 0) {
              appendAskOptionToInput(q, q.options[0]);
            }
          });
          layout.appendChild(confirmBtn);
        }

        card.appendChild(layout);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  function buildToolContentElement(name, input) {
    const tool = typeof name === 'object' && name !== null ? name : { name, input };
    const effectiveName = tool.name || name;
    const effectiveInput = tool.input !== undefined ? tool.input : input;
    const effectiveResult = tool.result;
    const kind = toolKind(tool);
    if (effectiveName === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(effectiveInput);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }

    if (kind === 'command_execution') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content command';
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      const commandText = effectiveInput?.command || tool?.meta?.subtitle || '';
      if (commandText) stack.appendChild(buildStructuredToolSection('Command', commandText));
      if (effectiveResult) {
        stack.appendChild(buildStructuredToolSection('Output', stringifyToolValue(effectiveResult)));
      } else if (!tool.done) {
        const empty = document.createElement('div');
        empty.className = 'tool-call-empty';
        empty.textContent = '等待命令输出…';
        stack.appendChild(empty);
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    if (kind === 'reasoning') {
      const content = document.createElement('div');
      content.className = 'tool-call-content reasoning';
      const text = stringifyToolValue(effectiveResult || effectiveInput);
      content.innerHTML = text ? renderMarkdown(text) : '<div class="tool-call-empty">暂无推理内容</div>';
      return content;
    }

    if (kind === 'file_change' || kind === 'mcp_tool_call') {
      const wrapper = document.createElement('div');
      wrapper.className = `tool-call-content ${kind === 'file_change' ? 'file-change' : ''}`.trim();
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      if (tool?.meta?.subtitle) {
        stack.appendChild(buildStructuredToolSection(kind === 'file_change' ? 'Target' : 'Tool', tool.meta.subtitle));
      }
      const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
      if (payloadText) {
        stack.appendChild(buildStructuredToolSection('Payload', payloadText));
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    const inputStr = stringifyToolValue(effectiveResult || effectiveInput);
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return content;
  }

  function createToolCallElement(toolUseId, tool, done) {
    const details = document.createElement('details');
    details.className = 'tool-call';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = tool.name || '';
    if (toolKind(tool)) {
      details.dataset.toolKind = toolKind(tool);
      details.classList.add(`codex-${toolKind(tool).replace(/_/g, '-')}`);
    }
    // Default expansion policy:
    // - Always open AskUserQuestion (it is an actionable UI).
    // - For non-Codex sessions, auto-open in-flight command execution so users can watch output.
    // - For Codex sessions, keep everything collapsed by default (less noise), including in-flight commands.
    const agent = normalizeAgent(currentAgent);
    const kind = toolKind(tool);
    if (tool.name === 'AskUserQuestion') {
      details.open = true;
    } else if (agent !== 'codex' && !done && kind === 'command_execution') {
      details.open = true;
    }

    const summary = document.createElement('summary');
    applyToolSummary(summary, tool, done);
    details.appendChild(summary);
    details.appendChild(buildToolContentElement({ ...tool, done }));
    return details;
  }

  function appendToolCall(toolUseId, name, input, done, kind = null, meta = null) {
    const shouldFollowOutput = followLatestOutput;
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let toolsDiv = bubble.querySelector('.msg-tools');
    if (!toolsDiv) { toolsDiv = bubble; }

    const tool = { id: toolUseId, name, input, kind, meta, done };

    const details = createToolCallElement(toolUseId, tool, done);

    // 折叠策略：只维护唯一一个 .tool-group 父节点
    // 散落的 .tool-call 直接子节点达到3个时，将它们全部移入父节点；之后继续散落，再达3个再移入
    const FOLD_AT = 3;
    const looseBefore = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
    if (looseBefore.length >= FOLD_AT) {
      // 确保存在唯一的 .tool-group
      let group = toolsDiv.querySelector(':scope > .tool-group');
      if (!group) {
        group = document.createElement('details');
        group.className = 'tool-group';
        const gs = document.createElement('summary');
        gs.className = 'tool-group-summary';
        group.appendChild(gs);
        const inner = document.createElement('div');
        inner.className = 'tool-group-inner';
        group.appendChild(inner);
        toolsDiv.insertBefore(group, toolsDiv.firstChild);
        hasGrouped = true;
      }
      const inner = group.querySelector('.tool-group-inner');
      looseBefore.forEach(c => inner.appendChild(c));
      _refreshGroupSummary(group);
    }
    toolsDiv.appendChild(details);
    if (shouldFollowOutput) scrollToBottom();
  }

  function _refreshGroupSummary(group) {
    const inner = group.querySelector('.tool-group-inner');
    const count = inner ? inner.childElementCount : 0;
    const summary = group.querySelector('.tool-group-summary');
    if (summary) summary.textContent = `展开 ${count} 个工具调用`;
  }

  function updateToolCall(toolUseId, result) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    const tool = activeToolCalls.get(toolUseId) || {
      id: toolUseId,
      name: el.dataset.toolName || '',
      kind: el.dataset.toolKind || null,
      done: true,
    };
    tool.done = true;
    if (result !== undefined) tool.result = result;
    const summary = el.querySelector('summary');
    if (summary) applyToolSummary(summary, tool, true);
    if (tool.name === 'AskUserQuestion') return;
    const nextContent = buildToolContentElement(tool);
    const content = el.querySelector('.tool-call-content');
    if (content) content.replaceWith(nextContent);
  }

  function getDeleteConfirmMessage(agent) {
    const normalized = normalizeAgent(agent);
    if (normalized === 'codex') {
      return '删除本会话将同步删去本地 Codex rollout 历史与线程记录，不可恢复。确认删除？';
    }
    return '删除本会话将同步删去本地 Claude 中的会话历史，不可恢复。确认删除？';
  }

  function showDeleteConfirm(agent, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';

    const box = document.createElement('div');
    box.className = 'settings-panel';
    box.innerHTML = `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">${escapeHtml(getDeleteConfirmMessage(agent))}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">确认删除</button>
        <button id="del-confirm-skip" style="width:100%;padding:9px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.85em;cursor:pointer;font-family:inherit">确认且不再提示</button>
        <button id="del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelector('#del-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    box.querySelector('#del-confirm-skip').addEventListener('click', () => {
      skipDeleteConfirm = true;
      localStorage.setItem('cc-web-skip-delete-confirm', '1');
      close();
      onConfirm();
    });
    box.querySelector('#del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function appendSystemMessage(message) {
    const shouldFollowOutput = followLatestOutput;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    messagesDiv.appendChild(createMsgElement('system', message));
    if (shouldFollowOutput) scrollToBottom();
  }

  function appendError(message) {
    const shouldFollowOutput = followLatestOutput;
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="msg-bubble" style="border-color:var(--danger);color:var(--danger)">⚠ ${escapeHtml(message)}</div>`;
    messagesDiv.appendChild(div);
    if (shouldFollowOutput) scrollToBottom();
  }

  function isNearBottom(threshold = 80) {
    return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight <= threshold;
  }

  function scrollToBottom(options = {}) {
    const force = options.force === true;
    requestAnimationFrame(() => {
      if (!force && !followLatestOutput) return;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      followLatestOutput = true;
      updateScrollbar();
    });
  }

  // --- Custom Scrollbar ---
  const scrollbarEl = document.getElementById('custom-scrollbar');
  const thumbEl = document.getElementById('custom-scrollbar-thumb');

  function updateScrollbar() {
    if (!scrollbarEl || !thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesDiv;
    if (scrollHeight <= clientHeight) {
      thumbEl.style.display = 'none';
      return;
    }
    thumbEl.style.display = '';
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    thumbEl.style.height = thumbH + 'px';
    thumbEl.style.top = thumbTop + 'px';
  }

  messagesDiv.addEventListener('scroll', () => {
    followLatestOutput = isNearBottom();
    updateScrollbar();
    // 移动端：滚动时短暂显示滑块，停止后淡出
    scrollbarEl.classList.add('scrolling');
    clearTimeout(scrollbarEl._hideTimer);
    scrollbarEl._hideTimer = setTimeout(() => {
      if (!isDragging) scrollbarEl.classList.remove('scrolling');
    }, 1200);
  }, { passive: true });
  new ResizeObserver(updateScrollbar).observe(messagesDiv);

  // Drag logic
  let dragStartY = 0, dragStartScrollTop = 0, isDragging = false;

  function onDragStart(e) {
    isDragging = true;
    dragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    dragStartScrollTop = messagesDiv.scrollTop;
    thumbEl.classList.add('dragging');
    scrollbarEl.classList.add('active');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dy = clientY - dragStartY;
    const { scrollHeight, clientHeight } = messagesDiv;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const ratio = (scrollHeight - clientHeight) / (trackH - thumbH);
    messagesDiv.scrollTop = dragStartScrollTop + dy * ratio;
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove('dragging');
    scrollbarEl.classList.remove('active');
  }

  thumbEl.addEventListener('mousedown', onDragStart);
  thumbEl.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  updateScrollbar();


  function renderSessionList() {
    sessionList.innerHTML = '';
    const visibleSessions = getVisibleSessions();
    if (visibleSessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = `暂无 ${AGENT_LABELS[currentAgent]} 会话，点击“新会话”开始。`;
      sessionList.appendChild(empty);
      return;
    }

    for (const s of visibleSessions) {
      const item = document.createElement('div');
      item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
      item.dataset.id = s.id;
      item.innerHTML = `
        <div class="session-item-main">
          <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
          ${s.isRunning ? '<span class="session-item-status">运行中</span>' : ''}
        </div>
        ${s.hasUnread ? '<span class="session-unread-dot"></span>' : ''}
        <span class="session-item-time">${timeAgo(s.updated)}</span>
        <div class="session-item-actions">
          <button class="session-item-btn edit" title="重命名">✎</button>
          <button class="session-item-btn delete" title="删除">×</button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('delete')) {
          e.stopPropagation();
          const doDelete = () => {
            if (getLastSessionForAgent(currentAgent) === s.id) {
              localStorage.removeItem(getAgentSessionStorageKey(currentAgent));
            }
            invalidateSessionCache(s.id);
            send({ type: 'delete_session', sessionId: s.id });
            if (s.id === currentSessionId) {
              resetChatView(currentAgent);
            }
          };
          if (skipDeleteConfirm) {
            doDelete();
          } else {
            showDeleteConfirm(s.agent, doDelete);
          }
          return;
        }
        if (target.classList.contains('edit')) {
          e.stopPropagation();
          startEditSessionTitle(item, s);
          return;
        }
        openSession(s.id);
      });

      sessionList.appendChild(item);
    }
  }

  function startEditSessionTitle(itemEl, session) {
    const titleEl = itemEl.querySelector('.session-item-title');
    const currentTitle = session.title || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentTitle;
    input.maxLength = 100;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide actions during edit
    const actions = itemEl.querySelector('.session-item-actions');
    const time = itemEl.querySelector('.session-item-time');
    if (actions) actions.style.display = 'none';
    if (time) time.style.display = 'none';

    function save() {
      const newTitle = input.value.trim() || currentTitle;
      if (newTitle !== currentTitle) {
        send({ type: 'rename_session', sessionId: session.id, title: newTitle });
      }
      // Restore
      const span = document.createElement('span');
      span.className = 'session-item-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      if (actions) actions.style.display = '';
      if (time) time.style.display = '';
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  function highlightActiveSession() {
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === currentSessionId);
    });
  }

  // --- Header title editing (contenteditable) ---
  chatTitle.addEventListener('click', () => {
    if (!currentSessionId || chatTitle.contentEditable === 'true') return;
    const originalText = chatTitle.textContent;
    chatTitle.contentEditable = 'true';
    chatTitle.style.background = '#fff';
    chatTitle.style.outline = '1px solid var(--accent)';
    chatTitle.style.borderRadius = '6px';
    chatTitle.style.padding = '2px 8px';
    chatTitle.style.minWidth = '96px';
    chatTitle.style.whiteSpace = 'normal';
    chatTitle.style.overflow = 'visible';
    chatTitle.style.textOverflow = 'clip';
    chatTitle.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(chatTitle);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(save) {
      chatTitle.contentEditable = 'false';
      chatTitle.style.background = '';
      chatTitle.style.outline = '';
      chatTitle.style.borderRadius = '';
      chatTitle.style.padding = '';
      chatTitle.style.minWidth = '';
      chatTitle.style.whiteSpace = '';
      chatTitle.style.overflow = '';
      chatTitle.style.textOverflow = '';
      const newTitle = chatTitle.textContent.trim() || originalText;
      chatTitle.textContent = newTitle;
      if (save && newTitle !== originalText && currentSessionId) {
        send({ type: 'rename_session', sessionId: currentSessionId, title: newTitle });
      }
    }

    chatTitle.addEventListener('blur', () => finish(true), { once: true });
    chatTitle.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter') { e.preventDefault(); chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
      if (e.key === 'Escape') { chatTitle.textContent = originalText; chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
    });
  });

  // --- Sidebar ---
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.hidden = true;
  }

  function canOpenSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (sidebar.classList.contains('open')) return false;
    if (sessionLoadingOverlay && !sessionLoadingOverlay.hidden) return false;
    if (!chatMain || !target || !chatMain.contains(target)) return false;
    if (!app.hidden && target && target.closest('input, textarea, select, button, .modal-panel, .settings-panel, .option-picker, .cmd-menu')) {
      return false;
    }
    return true;
  }

  function canCloseSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (!sidebar.classList.contains('open')) return false;
    if (!target) return false;
    return sidebar.contains(target) || target === sidebarOverlay;
  }

  function handleSidebarSwipeStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (canCloseSidebarBySwipe(e.target)) {
      sidebarSwipe = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        mode: 'close',
      };
      return;
    }
    if (!canOpenSidebarBySwipe(e.target)) {
      sidebarSwipe = null;
      return;
    }
    sidebarSwipe = {
      startX: touch.clientX,
      startY: touch.clientY,
      active: true,
      mode: 'open',
    };
  }

  function handleSidebarSwipeMove(e) {
    if (!sidebarSwipe?.active || !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - sidebarSwipe.startX;
    const deltaY = touch.clientY - sidebarSwipe.startY;
    if (Math.abs(deltaY) > SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT && Math.abs(deltaY) > Math.abs(deltaX)) {
      sidebarSwipe = null;
      return;
    }
    const horizontalIntent = sidebarSwipe.mode === 'open' ? deltaX > 12 : deltaX < -12;
    if (horizontalIntent && Math.abs(deltaY) < SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT) {
      e.preventDefault();
    }
  }

  function handleSidebarSwipeEnd(e) {
    if (!sidebarSwipe?.active) return;
    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : sidebarSwipe.startX;
    const endY = touch ? touch.clientY : sidebarSwipe.startY;
    const deltaX = endX - sidebarSwipe.startX;
    const deltaY = endY - sidebarSwipe.startY;
    const shouldOpen = sidebarSwipe.mode === 'open' &&
      deltaX >= SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    const shouldClose = sidebarSwipe.mode === 'close' &&
      deltaX <= -SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    sidebarSwipe = null;
    if (shouldOpen) {
      openSidebar();
    } else if (shouldClose) {
      closeSidebar();
    }
  }

  // --- Slash Command Menu ---
  function showCmdMenu(filter) {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.desc.includes(filter.slice(1))
    );
    // Exact match first (fixes /mode vs /model ambiguity)
    filtered.sort((a, b) => (b.cmd === filter ? 1 : 0) - (a.cmd === filter ? 1 : 0));
    if (filtered.length === 0) {
      hideCmdMenu();
      return;
    }
    cmdMenuIndex = 0;
    cmdMenu.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
        <span class="cmd-item-cmd">${c.cmd}</span>
        <span class="cmd-item-desc">${c.desc}</span>
      </div>`
    ).join('');
    cmdMenu.hidden = false;

    // Click handlers
    cmdMenu.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.dataset.cmd;
        if (cmd === '/model') {
          hideCmdMenu();
          msgInput.value = '';
          showModelPicker();
          return;
        }
        if (cmd === '/mode') {
          hideCmdMenu();
          msgInput.value = '';
          showModePicker();
          return;
        }
        msgInput.value = cmd + ' ';
        hideCmdMenu();
        msgInput.focus();
      });
    });
  }

  function hideCmdMenu() {
    cmdMenu.hidden = true;
    cmdMenuIndex = -1;
  }

  function navigateCmdMenu(direction) {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (items.length === 0) return;
    items[cmdMenuIndex]?.classList.remove('active');
    cmdMenuIndex = (cmdMenuIndex + direction + items.length) % items.length;
    items[cmdMenuIndex]?.classList.add('active');
  }

  function selectCmdMenuItem() {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (cmdMenuIndex >= 0 && items[cmdMenuIndex]) {
      const cmd = items[cmdMenuIndex].dataset.cmd;
      if (cmd === '/model') {
        hideCmdMenu();
        msgInput.value = '';
        showModelPicker();
        return;
      }
      if (cmd === '/mode') {
        hideCmdMenu();
        msgInput.value = '';
        showModePicker();
        return;
      }
      msgInput.value = cmd + ' ';
      hideCmdMenu();
      msgInput.focus();
    }
  }

  // --- Option Picker (generic) ---
  function showOptionPicker(title, options, currentValue, onSelect) {
    hideOptionPicker();

    const picker = document.createElement('div');
    picker.className = 'option-picker';
    picker.id = 'option-picker';

    picker.innerHTML = `
      <div class="option-picker-title">${escapeHtml(title)}</div>
      ${options.map(opt => `
        <div class="option-picker-item${opt.value === currentValue ? ' active' : ''}" data-value="${opt.value}">
          <div class="option-picker-item-info">
            <div class="option-picker-item-label">${escapeHtml(opt.label)}</div>
            <div class="option-picker-item-desc">${escapeHtml(opt.desc)}</div>
          </div>
          ${opt.value === currentValue ? '<span class="option-picker-item-check">✓</span>' : ''}
        </div>
      `).join('')}
    `;

    const chatMain = document.querySelector('.chat-main');
    chatMain.appendChild(picker);

	    picker.querySelectorAll('.option-picker-item').forEach(el => {
	      el.addEventListener('click', () => {
	        // Close current picker first so onSelect can safely open a nested picker.
	        const v = el.dataset.value;
	        hideOptionPicker();
	        onSelect(v);
	      });
	    });

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', _pickerOutsideClick);
    }, 0);
    document.addEventListener('keydown', _pickerEscape);
  }

  function hideOptionPicker() {
    const picker = document.getElementById('option-picker');
    if (picker) picker.remove();
    document.removeEventListener('click', _pickerOutsideClick);
    document.removeEventListener('keydown', _pickerEscape);
  }

  function _pickerOutsideClick(e) {
    const picker = document.getElementById('option-picker');
    if (picker && !picker.contains(e.target)) {
      hideOptionPicker();
    }
  }

  function _pickerEscape(e) {
    if (e.key === 'Escape') {
      hideOptionPicker();
    }
  }

	  function showModelPicker() {
	    if (currentAgent === 'codex') {
	      const current = _splitCodexThinkingModel(currentModel || '');
	      const baseOptions = getCodexBaseModelOptions();
	      if (baseOptions.length === 0) {
	        appendSystemMessage('当前 Codex Profile 未配置 /model 候选列表。请先在设置 -> Codex API 配置中填写模型列表，或直接输入 /model <模型名>。');
	        return;
	      }
	      showOptionPicker('选择 Codex 模型', baseOptions, current.base || '', (baseValue) => {
	        const base = String(baseValue || '').trim();
	        const thinkingOptions = [
	          { value: '', label: '无 (默认)', desc: '不附加 (medium/high/xhigh) 后缀' },
	          { value: 'medium', label: 'medium', desc: '中等 thinking' },
	          { value: 'high', label: 'high', desc: '更强 thinking' },
	          { value: 'xhigh', label: 'xhigh', desc: '最强 thinking' },
	        ];
	        showOptionPicker('选择 Thinking 强度', thinkingOptions, current.level || '', (lvl) => {
	          const level = String(lvl || '').trim().toLowerCase();
	          const full = level ? `${base}(${level})` : base;
	          send({ type: 'message', text: `/model ${full}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
	        });
	      });
	      return;
	    }
	    showOptionPicker('选择模型', MODEL_OPTIONS, currentModel, (value) => {
	      send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    });
  }

  function showModePicker() {
    showOptionPicker('选择权限模式', getModePickerOptions(), currentMode, (value) => {
      currentMode = value;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
      if (currentSessionId) {
        send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
      }
    });
  }

  // --- Send Message ---
  // 兜底：发送链路上的同步异常会让按钮「点了毫无反应」，必须暴露出来，
  // 并把卡在 sending 的消息标为失败，否则 hasSendingMessage 会永久拦住后续发送。
  function sendMessage() {
    try {
      performSendMessage();
    } catch (err) {
      console.error('sendMessage failed', err);
      markPendingOutboundMessagesFailed('发送失败，请重试');
      appendError(`发送失败：${err?.message || err}`);
    }
  }

  function performSendMessage() {
    const text = msgInput.value.trim();
    const hasSendingMessage = Array.from(pendingOutboundMessages.values()).some((pending) => pending.state === 'sending');
    if ((!text && pendingAttachments.length === 0) || isGenerating || hasSendingMessage || isBlockingSessionLoad()) return;
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
      if (pendingAttachments.length > 0) {
        appendError('命令消息暂不支持附带图片，请先移除图片或发送普通消息。');
        return;
      }
      // /model without argument → show interactive picker
      if (text === '/model' || text === '/model ') {
        showModelPicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      // /mode without argument → show interactive picker
      if (text === '/mode' || text === '/mode ') {
        showModePicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const attachments = pendingAttachments.map((attachment) => ({ ...attachment }));
    dispatchMessage(text, attachments);
    msgInput.value = '';
    pendingAttachments = [];
    renderPendingAttachments();
    autoResize();
  }

  // 把一条用户消息乐观插入界面并发往后端、进入生成态。供普通发送与「重新发送」共用。
  function dispatchMessage(text, attachments = []) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const timestamp = new Date().toISOString();
    const clientMessageId = createClientMessageId();
    const message = {
      role: 'user',
      content: text,
      attachments,
      timestamp,
      clientMessageId,
      deliveryState: 'sending',
    };
    pendingOutboundMessages.set(clientMessageId, {
      text,
      attachments,
      timestamp,
      sessionId: currentSessionId,
      mode: currentMode,
      agent: currentAgent,
      state: 'sending',
      error: '',
    });
    messagesDiv.appendChild(buildMsgElement(message));
    scrollToBottom({ force: true });
    if (!send({
      type: 'message',
      text,
      attachments,
      timestamp,
      clientMessageId,
      sessionId: currentSessionId,
      mode: currentMode,
      agent: currentAgent,
    })) {
      const pending = pendingOutboundMessages.get(clientMessageId);
      pending.state = 'failed';
      pending.error = '网络尚未连接，请稍后重试';
      setOutboundMessageState(findOutboundMessageElement(clientMessageId), 'failed', pending.error);
      connect();
      return;
    }
    startGenerating();
  }

  function autoResize() {
    msgInput.style.height = 'auto';
    const max = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--input-max-height')) || 200;
    msgInput.style.height = Math.min(msgInput.scrollHeight, max) + 'px';
  }

  function isMobileInputMode() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  // --- Event Listeners ---
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = loginPassword.value;
    if (!pw) return;
    loginError.hidden = true;
    loginPasswordValue = pw;
    // Remember password
    if (rememberPw.checked) {
      localStorage.setItem('cc-web-pw', pw);
    } else {
      localStorage.removeItem('cc-web-pw');
    }
    submitLogin(pw);
    // Request notification permission on first user interaction
    requestNotificationPermission();
  });

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener('click', closeSidebar);
  document.addEventListener('touchstart', handleSidebarSwipeStart, { passive: true });
  document.addEventListener('touchmove', handleSidebarSwipeMove, { passive: false });
  document.addEventListener('touchend', handleSidebarSwipeEnd, { passive: true });
  document.addEventListener('touchcancel', () => { sidebarSwipe = null; }, { passive: true });

  if (chatAgentBtn && chatAgentMenu) {
    chatAgentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAgentMenu();
    });
    chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAgentMenu();
        const targetAgent = normalizeAgent(btn.dataset.agent);
        if (targetAgent === currentAgent) return;
        syncViewForAgent(targetAgent, { preserveCurrent: false, loadLast: true });
      });
    });
  }

  // Split new-chat button
  newChatBtn.addEventListener('click', () => showNewSessionModal());
  newChatArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    newChatDropdown.hidden = !newChatDropdown.hidden;
  });
  importSessionBtn.addEventListener('click', () => {
    newChatDropdown.hidden = true;
    if (currentAgent === 'codex') {
      showImportCodexSessionModal();
    } else {
      showImportSessionModal();
    }
  });
  document.addEventListener('click', (e) => {
    if (!newChatDropdown.hidden &&
        !newChatDropdown.contains(e.target) &&
        e.target !== newChatArrow) {
      newChatDropdown.hidden = true;
    }
    if (chatAgentMenu && !chatAgentMenu.hidden &&
        !chatAgentMenu.contains(e.target) &&
        e.target !== chatAgentBtn) {
      closeAgentMenu();
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => send({ type: 'abort' }));
  if (attachBtn && imageUploadInput) {
    attachBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', () => {
      handleSelectedImageFiles(imageUploadInput.files);
    });
  }
  if (inputWrapper) {
    inputWrapper.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      inputWrapper.classList.add('drag-active');
    });
    inputWrapper.addEventListener('dragleave', (e) => {
      if (e.target === inputWrapper) inputWrapper.classList.remove('drag-active');
    });
    inputWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      inputWrapper.classList.remove('drag-active');
      handleSelectedImageFiles(e.dataTransfer?.files);
    });
  }

  // Mode selector
  modeSelect.value = currentMode;
  modeSelect.addEventListener('change', () => {
    currentMode = modeSelect.value;
    localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    if (currentSessionId) {
      send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
    }
    if (currentAgent === 'codex' && currentMode === 'plan') {
      appendSystemMessage('⚠ Codex 的 Plan 模式会以只读沙箱运行，适合先分析方案；如果需要直接改文件，请切回 default 或 yolo。');
    }
  });

  msgInput.addEventListener('input', () => {
    autoResize();
    const val = msgInput.value;
    // Show slash command menu
    if (val.startsWith('/') && !val.includes('\n')) {
      showCmdMenu(val);
    } else {
      hideCmdMenu();
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    // Command menu navigation
    if (!cmdMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCmdMenu(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCmdMenu(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); selectCmdMenuItem(); return; }
      if (e.key === 'Escape') { hideCmdMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isMobileInputMode()) {
        if (!cmdMenu.hidden) {
          e.preventDefault();
          selectCmdMenuItem();
        }
        return;
      }

      e.preventDefault();
      if (!cmdMenu.hidden) {
        // If menu is open and user presses Enter, select the item
        selectCmdMenuItem();
      } else {
        sendMessage();
      }
    }
  });

  msgInput.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      handleSelectedImageFiles(files);
    }
  });

  // Close cmd menu on outside click
  document.addEventListener('click', (e) => {
    if (!cmdMenu.contains(e.target) && e.target !== msgInput) {
      hideCmdMenu();
    }
  });

  // --- Toast Notification ---
  function showToast(text, sessionId) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = text;
    if (sessionId) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        openSession(sessionId);
        toast.remove();
      });
    }
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // --- Browser Notification (via Service Worker for mobile) ---
  function showBrowserNotification(title) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('CC-Web', {
          body: `「${title}」任务完成`,
          tag: 'cc-web-task',
          renotify: true,
        });
      }).catch(() => {});
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // --- Settings Panel ---
  let _onNotifyConfig = null;
  let _onNotifyTestResult = null;
  let _onModelConfig = null;
  let _onCodexConfig = null;
  let _onFetchModelsResult = null;
  let _onCodexSessions = null;
  let _onClaudeLocalConfig = null;
  let _onCodexLocalConfig = null;
  let _onDevConfig = null;

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  function buildNotifyFieldsHtml(config, provider) {
    if (provider === 'pushplus') {
      return `
        <div class="settings-field">
          <label>Token</label>
          <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(config?.pushplus?.token || '')}">
        </div>
      `;
    }
    if (provider === 'telegram') {
      return `
        <div class="settings-field">
          <label>Bot Token</label>
          <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(config?.telegram?.botToken || '')}">
        </div>
        <div class="settings-field">
          <label>Chat ID</label>
          <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(config?.telegram?.chatId || '')}">
        </div>
      `;
    }
    if (provider === 'serverchan') {
      return `
        <div class="settings-field">
          <label>SendKey</label>
          <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(config?.serverchan?.sendKey || '')}">
        </div>
      `;
    }
    if (provider === 'feishu') {
      return `
        <div class="settings-field">
          <label>Webhook 地址</label>
          <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(config?.feishu?.webhook || '')}">
        </div>
      `;
    }
    if (provider === 'qqbot') {
      return `
        <div class="settings-field">
          <label>Qmsg Key</label>
          <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(config?.qqbot?.qmsgKey || '')}">
        </div>
      `;
    }
    return '';
  }

  function buildAgentContextCard(agent, title, copy) {
    const label = AGENT_LABELS[normalizeAgent(agent)] || AGENT_LABELS.claude;
    return `
      <div class="agent-context-card">
        <div class="agent-context-kicker">${escapeHtml(label)}</div>
        ${title ? `<div class="agent-context-title">${escapeHtml(title)}</div>` : ''}
        ${copy ? `<div class="agent-context-copy">${escapeHtml(copy)}</div>` : ''}
      </div>
    `;
  }

  function renderNotifyFields(fieldsDiv, config, provider) {
    fieldsDiv.innerHTML = buildNotifyFieldsHtml(config, provider);
  }

  function collectNotifyConfigFromPanel(panel, currentConfig, provider) {
    const pp = panel.querySelector('#notify-pushplus-token');
    const tgBot = panel.querySelector('#notify-tg-bottoken');
    const tgChat = panel.querySelector('#notify-tg-chatid');
    const sc = panel.querySelector('#notify-sc-sendkey');
    const feishuWh = panel.querySelector('#notify-feishu-webhook');
    const qmsgKey = panel.querySelector('#notify-qmsg-key');
    // Summary config
    const summaryEnabled = panel.querySelector('#notify-summary-enabled');
    const summaryTrigger = panel.querySelector('#notify-summary-trigger');
    const summarySource = panel.querySelector('#notify-summary-source');
    const summaryApiBase = panel.querySelector('#notify-summary-apibase');
    const summaryApiKey = panel.querySelector('#notify-summary-apikey');
    const summaryModel = panel.querySelector('#notify-summary-model');
    const cs = currentConfig?.summary || {};
    return {
      provider,
      pushplus: { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') },
      telegram: {
        botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''),
        chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || ''),
      },
      serverchan: { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') },
      feishu: { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') },
      qqbot: { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') },
      summary: {
        enabled: summaryEnabled ? summaryEnabled.checked : !!cs.enabled,
        trigger: summaryTrigger ? summaryTrigger.value : (cs.trigger || 'background'),
        apiSource: summarySource ? summarySource.value : (cs.apiSource || 'claude'),
        apiBase: summaryApiBase ? summaryApiBase.value.trim() : (cs.apiBase || ''),
        apiKey: summaryApiKey ? summaryApiKey.value.trim() : (cs.apiKey || ''),
        model: summaryModel ? summaryModel.value.trim() : (cs.model || ''),
      },
    };
  }

  function buildSummarySettingsHtml(config) {
    const s = config?.summary || {};
    const enabled = !!s.enabled;
    const trigger = s.trigger || 'background';
    const src = s.apiSource || 'claude';
    const customVisible = src === 'custom' ? '' : 'display:none';
    return `
      <div class="settings-divider"></div>
      <div class="settings-section-title">通知摘要</div>
      <div class="settings-field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0;flex:1">启用 AI 摘要</label>
        <input type="checkbox" id="notify-summary-enabled" ${enabled ? 'checked' : ''} style="width:auto;margin:0">
      </div>
      <div id="notify-summary-options" style="${enabled ? '' : 'display:none'}">
        <div class="settings-field">
          <label>推送时机</label>
          <select class="settings-select" id="notify-summary-trigger">
            <option value="background" ${trigger === 'background' ? 'selected' : ''}>仅后台任务</option>
            <option value="always" ${trigger === 'always' ? 'selected' : ''}>所有任务</option>
          </select>
        </div>
        <div class="settings-field">
          <label>摘要 API 来源</label>
          <select class="settings-select" id="notify-summary-source">
            <option value="claude" ${src === 'claude' ? 'selected' : ''}>Claude 活跃模板</option>
            <option value="codex" ${src === 'codex' ? 'selected' : ''}>Codex 活跃 Profile</option>
            <option value="custom" ${src === 'custom' ? 'selected' : ''}>独立配置</option>
          </select>
        </div>
        <div id="notify-summary-custom" style="${customVisible}">
          <div class="settings-field">
            <label>API Base URL</label>
            <input type="text" id="notify-summary-apibase" placeholder="https://api.example.com" value="${escapeHtml(s.apiBase || '')}">
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input type="text" id="notify-summary-apikey" placeholder="sk-..." value="${escapeHtml(s.apiKey || '')}">
          </div>
          <div class="settings-field">
            <label>模型</label>
            <input type="text" id="notify-summary-model" placeholder="claude-opus-4-6" value="${escapeHtml(s.model || '')}">
          </div>
        </div>
      </div>
    `;
  }

  function bindSummarySettingsEvents(panel) {
    const enabledCb = panel.querySelector('#notify-summary-enabled');
    const optionsDiv = panel.querySelector('#notify-summary-options');
    const sourceSelect = panel.querySelector('#notify-summary-source');
    const customDiv = panel.querySelector('#notify-summary-custom');
    if (!enabledCb || !optionsDiv || !sourceSelect || !customDiv) return;
    enabledCb.addEventListener('change', () => {
      optionsDiv.style.display = enabledCb.checked ? '' : 'none';
    });
    sourceSelect.addEventListener('change', () => {
      customDiv.style.display = sourceSelect.value === 'custom' ? '' : 'none';
    });
  }

  function openPasswordModal() {
    const pwOverlay = document.createElement('div');
    pwOverlay.className = 'settings-overlay';
    pwOverlay.style.zIndex = '10001';
    const pwModal = document.createElement('div');
    pwModal.className = 'settings-panel';
    pwModal.style.maxWidth = '400px';
    pwModal.innerHTML = `
      <div class="settings-header">
        <h3>修改密码</h3>
        <button class="settings-close" id="pw-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="pw-modal-current" placeholder="当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="pw-modal-new" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="pw-modal-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="pw-modal-confirm" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-modal-submit" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-modal-status"></div>
    `;
    pwOverlay.appendChild(pwModal);
    document.body.appendChild(pwOverlay);

    const currentPwIn = pwModal.querySelector('#pw-modal-current');
    const newPwIn = pwModal.querySelector('#pw-modal-new');
    const confirmPwIn = pwModal.querySelector('#pw-modal-confirm');
    const hint = pwModal.querySelector('#pw-modal-hint');
    const submitBtn = pwModal.querySelector('#pw-modal-submit');
    const status = pwModal.querySelector('#pw-modal-status');

    function checkPw() {
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      const currentPw = currentPwIn.value;
      if (!newPw) {
        hint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hint.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        hint.textContent = result.message;
        hint.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hint.textContent = '密码强度符合要求';
      hint.className = 'password-hint success';
      submitBtn.disabled = !currentPw || !confirmPw || confirmPw !== newPw;
    }

    currentPwIn.addEventListener('input', checkPw);
    newPwIn.addEventListener('input', checkPw);
    confirmPwIn.addEventListener('input', checkPw);

    const closePwModal = () => { document.body.removeChild(pwOverlay); };
    pwModal.querySelector('#pw-modal-close').addEventListener('click', closePwModal);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePwModal(); });

    submitBtn.addEventListener('click', () => {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      if (newPw !== confirmPw) {
        status.textContent = '两次密码不一致';
        status.className = 'settings-status error';
        return;
      }
      submitBtn.disabled = true;
      status.textContent = '正在修改...';
      status.className = 'settings-status';
      _onPasswordChanged = (result) => {
        if (result.success) {
          status.textContent = result.message || '密码修改成功';
          status.className = 'settings-status success';
          setTimeout(closePwModal, 1200);
        } else {
          status.textContent = result.message || '修改失败';
          status.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    currentPwIn.focus();
  }

  function showSettingsPanel() {
    send({ type: 'get_model_config' });
    send({ type: 'get_codex_config' });
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    panel.innerHTML = `
      <h3>
        ⚙ 设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">Claude API 配置</div>
      <div id="claude-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="model-save-btn">保存 Claude 配置</button>
      </div>
      <div class="settings-status" id="model-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">Codex API 配置</div>
      <div id="codex-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="codex-save-btn">保存 Codex 配置</button>
      </div>
      <div class="settings-status" id="codex-status"></div>

      <div class="settings-divider"></div>

      ${buildThemeEntryHtml()}

      <div class="settings-divider"></div>

      ${buildNotifyEntryHtml(null)}

      <div class="settings-divider"></div>

      <div class="settings-section-title">安全</div>
      <button class="settings-nav-card" type="button" data-open-security-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">安全与访问</span>
          <span class="settings-nav-card-meta">查看封禁 IP / 手动解封</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>

      <div class="settings-divider"></div>

      <div class="settings-section-title">开发者</div>
      <button class="settings-nav-card" type="button" data-open-dev-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">开发者设置</span>
          <span class="settings-nav-card-meta">GitHub / SSH 配置</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>

      <div class="settings-divider"></div>

      <div class="settings-section-title">系统</div>
      <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
        <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
        <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
      </div>
      <div class="settings-status" id="update-status" style="margin-top:8px"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const themePageBtn = panel.querySelector('[data-open-theme-page]');
    if (themePageBtn) themePageBtn.addEventListener('click', openThemeSubpage);
    const notifyPageBtn2 = panel.querySelector('[data-open-notify-page]');
    if (notifyPageBtn2) notifyPageBtn2.addEventListener('click', openNotifySubpage);
    const securityPageBtn = panel.querySelector('[data-open-security-page]');
    if (securityPageBtn) securityPageBtn.addEventListener('click', openSecuritySubpage);
    const devPageBtn = panel.querySelector('[data-open-dev-page]');
    if (devPageBtn) devPageBtn.addEventListener('click', openDevSettingsSubpage);

    // === Claude Config UI ===
    const claudeConfigArea = panel.querySelector('#claude-config-area');
    const modelStatusDiv = panel.querySelector('#model-status');
    const modelSaveBtn = panel.querySelector('#model-save-btn');

    let modelCurrentConfig = null;
    let modelEditingTemplates = [];
    let modelActiveTemplate = '';

    function showModelStatus(msg, type) {
      modelStatusDiv.textContent = msg;
      modelStatusDiv.className = 'settings-status ' + (type || '');
    }

    function validateProxyDraft(useProxy, proxyUrl) {
      if (!useProxy) return '';
      if (!proxyUrl) return '启用代理时请填写代理地址';
      try {
        const parsed = new URL(proxyUrl);
        if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
          return `不支持的代理协议：${parsed.protocol}`;
        }
      } catch {
        return '代理地址格式无效';
      }
      return '';
    }

    function renderClaudeConfigArea() {
      const isLocal = modelActiveTemplate === '';
      const tplOptions = modelEditingTemplates.map(t =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
      ).join('');

      if (isLocal) {
        const snapshot = modelCurrentConfig?.localSnapshot || {};
        const hasSnapshot = Object.keys(snapshot).length > 0
          && (snapshot.apiKey || snapshot.apiBase);
        const localTierParts = [];
        if (snapshot.opusModel) localTierParts.push(`Opus <code>${escapeHtml(snapshot.opusModel)}</code>`);
        if (snapshot.sonnetModel) localTierParts.push(`Sonnet <code>${escapeHtml(snapshot.sonnetModel)}</code>`);
        if (snapshot.haikuModel) localTierParts.push(`Haiku <code>${escapeHtml(snapshot.haikuModel)}</code>`);
        const localTierLine = localTierParts.length ? `<br>模型映射：${localTierParts.join(' · ')}` : '';
        const localSummary = hasSnapshot
          ? `API Key：<code>${snapshot.apiKey ? '已设置' : '未设置'}</code> · API Base：<code>${snapshot.apiBase ? escapeHtml(snapshot.apiBase) : '默认'}</code> · 默认模型：<code>${snapshot.defaultModel ? escapeHtml(snapshot.defaultModel) : '未设置'}</code>${localTierLine}`
          : '尚未读取本机配置，点击「读取当前配置」查看 <code>~/.claude/settings.json</code> 中的 API 信息。';
        claudeConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活模板</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="claude-tpl-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${tplOptions}
                <option value="__new__">+ 新建模板</option>
              </select>
              <button class="btn-test" id="claude-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="claude-read-local-btn" style="padding:4px 10px">读取当前配置</button>
              ${hasSnapshot ? '<button class="btn-test" id="claude-restore-btn" style="padding:4px 10px">恢复快照</button>' : ''}
            </div>
          </div>
          <div class="settings-inline-note">${localSummary}</div>
          <div class="settings-inline-note">
            Agent 直接使用本机 <code>~/.claude/settings.json</code> 中的 API 信息，不会覆盖或修改本机配置。
          </div>
        `;
        panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            const newName = prompt('输入新模板名称:');
            if (!newName || !newName.trim()) { e.target.value = '__local__'; return; }
            const n = newName.trim();
            if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = '__local__'; return; }
            modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', useProxy: false, proxyUrl: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
            modelActiveTemplate = n;
            renderClaudeConfigArea();
            openTplEditModal();
          } else {
            modelActiveTemplate = e.target.value;
            renderClaudeConfigArea();
          }
        });
        panel.querySelector('#claude-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#claude-read-local-btn').addEventListener('click', () => send({ type: 'read_claude_local_config' }));
        const restoreBtn = panel.querySelector('#claude-restore-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', () => send({ type: 'restore_claude_local_snapshot' }));
        return;
      }

      // Custom template selected
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      let summary = '';
      if (tpl) {
        const summaryBase = tpl.apiBase ? escapeHtml(tpl.apiBase) : '默认';
        const summaryProxy = tpl.useProxy ? escapeHtml(tpl.proxyUrl || '未填写') : '关闭';
        const summaryDefault = tpl.defaultModel ? escapeHtml(tpl.defaultModel) : '未设置';
        const tierParts = [];
        if (tpl.opusModel) tierParts.push(`Opus <code>${escapeHtml(tpl.opusModel)}</code>`);
        if (tpl.sonnetModel) tierParts.push(`Sonnet <code>${escapeHtml(tpl.sonnetModel)}</code>`);
        if (tpl.haikuModel) tierParts.push(`Haiku <code>${escapeHtml(tpl.haikuModel)}</code>`);
        const tierLine = tierParts.length ? `<br>模型映射：${tierParts.join(' · ')}` : '';
        summary = `当前模板：<strong>${escapeHtml(tpl.name)}</strong> · API Key：<code>${tpl.apiKey ? '已设置' : '未设置'}</code> · API Base：<code>${summaryBase}</code> · 代理：<code>${summaryProxy}</code> · 默认模型：<code>${summaryDefault}</code>${tierLine}`;
      }
      claudeConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活模板</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="claude-tpl-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${tplOptions}
              <option value="__new__">+ 新建模板</option>
            </select>
            <button class="btn-test" id="model-tpl-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">${summary}</div>
      `;

      panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          const newName = prompt('输入新模板名称:');
          if (!newName || !newName.trim()) { e.target.value = escapeHtml(modelActiveTemplate); return; }
          const n = newName.trim();
          if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = escapeHtml(modelActiveTemplate); return; }
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', useProxy: false, proxyUrl: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
          renderClaudeConfigArea();
          openTplEditModal();
        } else if (e.target.value === '__local__') {
          modelActiveTemplate = '';
          renderClaudeConfigArea();
        } else {
          modelActiveTemplate = e.target.value;
          renderClaudeConfigArea();
        }
      });
      panel.querySelector('#model-tpl-edit').addEventListener('click', () => openTplEditModal());
      const delBtn = panel.querySelector('#model-tpl-del');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!modelActiveTemplate) return;
          if (!confirm(`确认删除模板「${modelActiveTemplate}」?`)) return;
          modelEditingTemplates = modelEditingTemplates.filter(t => t.name !== modelActiveTemplate);
          modelActiveTemplate = modelEditingTemplates[0]?.name || '';
          renderClaudeConfigArea();
        });
      }
    }

    function openTplEditModal() {
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      if (!tpl) return;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑模板: ${escapeHtml(tpl.name)}</h3>
          <button class="settings-close" id="tpl-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>模板名称</label>
          <input type="text" id="tpl-ed-name" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="tpl-ed-apikey" placeholder="sk-ant-..." value="${escapeHtml(tpl.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="tpl-ed-apibase" placeholder="https://api.anthropic.com" value="${escapeHtml(tpl.apiBase || '')}">
        </div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="tpl-ed-use-proxy"${tpl.useProxy ? ' checked' : ''}> 使用代理
          </label>
          <input type="text" id="tpl-ed-proxy-url" placeholder="http://127.0.0.1:7890" value="${escapeHtml(tpl.proxyUrl || '')}" style="margin-top:6px;${tpl.useProxy ? '' : 'display:none'}">
          <div class="settings-inline-note" id="tpl-ed-proxy-note" style="margin-top:6px;${tpl.useProxy ? '' : 'display:none'}">支持 HTTP、HTTPS 和 SOCKS 代理；仅对此模板启动的 Agent 生效。</div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="tpl-ed-custom-endpoint"> 端点
            </label>
            <input type="text" id="tpl-ed-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="tpl-ed-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="tpl-ed-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型 (ANTHROPIC_MODEL)</label>
          <input type="text" id="tpl-ed-default" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.defaultModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Opus 模型名</label>
          <input type="text" id="tpl-ed-opus" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.opusModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型名</label>
          <input type="text" id="tpl-ed-sonnet" list="tpl-dl-models" placeholder="claude-sonnet-4-6" value="${escapeHtml(tpl.sonnetModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Haiku 模型名</label>
          <input type="text" id="tpl-ed-haiku" list="tpl-dl-models" placeholder="claude-haiku-4-5-20251001" value="${escapeHtml(tpl.haikuModel || '')}" autocomplete="off">
        </div>
        <datalist id="tpl-dl-models"></datalist>
        <div class="settings-actions">
          <button class="btn-save" id="tpl-ed-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#tpl-ed-custom-endpoint');
      const endpointInput = modal.querySelector('#tpl-ed-models-endpoint');
      const useProxyInput = modal.querySelector('#tpl-ed-use-proxy');
      const proxyUrlInput = modal.querySelector('#tpl-ed-proxy-url');
      const proxyNote = modal.querySelector('#tpl-ed-proxy-note');
      useProxyInput.addEventListener('change', () => {
        proxyUrlInput.style.display = useProxyInput.checked ? '' : 'none';
        proxyNote.style.display = useProxyInput.checked ? '' : 'none';
      });
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      const fetchBtn = modal.querySelector('#tpl-ed-fetch-models');
      const fetchStatus = modal.querySelector('#tpl-ed-fetch-status');
      const datalist = modal.querySelector('#tpl-dl-models');
      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        const apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';
        _onFetchModelsResult = (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({
          type: 'fetch_models',
          apiBase,
          apiKey,
          useProxy: useProxyInput.checked,
          proxyUrl: proxyUrlInput.value.trim(),
          modelsEndpoint: modelsEndpoint || undefined,
          templateName: tpl.name,
        });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#tpl-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#tpl-ed-ok').addEventListener('click', () => {
        const newName = modal.querySelector('#tpl-ed-name').value.trim();
        if (newName && newName !== tpl.name) {
          if (modelEditingTemplates.find(t => t.name === newName && t !== tpl)) { alert('模板名称已存在'); return; }
          tpl.name = newName;
          modelActiveTemplate = newName;
        }
        const useProxy = useProxyInput.checked;
        const proxyUrl = proxyUrlInput.value.trim();
        const proxyError = validateProxyDraft(useProxy, proxyUrl);
        if (proxyError) { alert(proxyError); return; }
        tpl.apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        tpl.apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        tpl.useProxy = useProxy;
        tpl.proxyUrl = proxyUrl;
        tpl.defaultModel = modal.querySelector('#tpl-ed-default').value.trim();
        tpl.opusModel = modal.querySelector('#tpl-ed-opus').value.trim();
        tpl.sonnetModel = modal.querySelector('#tpl-ed-sonnet').value.trim();
        tpl.haikuModel = modal.querySelector('#tpl-ed-haiku').value.trim();
        closeModal();
        renderClaudeConfigArea();
      });
    }

    function showClaudeLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>本地配置说明</h3>
          <button class="settings-close" id="claude-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，Agent 直接使用本机原生配置文件中的 API 信息，不会覆盖或修改本机配置。
          <br><br>
          <strong>• Claude：</strong>切换到自定义模板时，本机 ~/.claude/settings.json 中的 API 配置会被替换为模板值。再次切回"本地配置"时，可一键恢复之前保存的快照到 settings.json。
          <br><br>
          <strong>• Codex：</strong>自定义模板不会修改本机 ~/.codex/，切回"本地配置"时自动恢复本机直通，无需恢复操作。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="claude-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#claude-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#claude-info-ok').addEventListener('click', closeModal);
    }

    modelSaveBtn.addEventListener('click', () => {
      const isLocal = modelActiveTemplate === '';
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeTemplate: isLocal ? '' : modelActiveTemplate,
        templates: modelEditingTemplates,
        localSnapshot: modelCurrentConfig?.localSnapshot || {},
      };
      send({ type: 'save_model_config', config });
      showModelStatus('已保存', 'success');
    });

    _onModelConfig = (config) => {
      modelCurrentConfig = config;
      modelEditingTemplates = (config.templates || []).map(t => Object.assign({}, t));
      if (config.mode === 'local') {
        modelActiveTemplate = '';
      } else {
        modelActiveTemplate = config.activeTemplate || (modelEditingTemplates[0]?.name || '');
      }
      renderClaudeConfigArea();
    };

    _onClaudeLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '560px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑 Claude 本地快照</h3>
          <button class="settings-close" id="edit-local-close">&times;</button>
        </div>
        ${msg.sourceFound ? '' : '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.claude/settings.json，可先编辑快照后保存。</div>'}
        <div class="settings-field">
          <label>API Key</label>
          <input id="edit-local-apikey" type="password" value="${escapeHtml(config.apiKey || '')}" placeholder="ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input id="edit-local-apibase" type="text" value="${escapeHtml(config.apiBase || '')}" placeholder="ANTHROPIC_BASE_URL">
        </div>
        <div class="settings-field">
          <label>默认模型</label>
          <input id="edit-local-default-model" type="text" value="${escapeHtml(config.defaultModel || '')}" placeholder="ANTHROPIC_MODEL">
        </div>
        <div class="settings-field">
          <label>Opus 模型</label>
          <input id="edit-local-opus-model" type="text" value="${escapeHtml(config.opusModel || '')}" placeholder="ANTHROPIC_DEFAULT_OPUS_MODEL">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型</label>
          <input id="edit-local-sonnet-model" type="text" value="${escapeHtml(config.sonnetModel || '')}" placeholder="ANTHROPIC_DEFAULT_SONNET_MODEL">
        </div>
        <div class="settings-field">
          <label>Haiku 模型</label>
          <input id="edit-local-haiku-model" type="text" value="${escapeHtml(config.haikuModel || '')}" placeholder="ANTHROPIC_DEFAULT_HAIKU_MODEL">
        </div>
        <div class="settings-actions">
          <button class="btn-test" id="edit-local-cancel">取消</button>
          <button class="btn-save" id="save-snapshot-btn">保存快照</button>
          <button class="btn-save" id="write-local-btn">覆盖本机配置</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#edit-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#edit-local-cancel').addEventListener('click', closeModal);
      const getClaudeLocalDraft = () => ({
        ...config,
        apiKey: modal.querySelector('#edit-local-apikey').value.trim(),
        apiBase: modal.querySelector('#edit-local-apibase').value.trim(),
        defaultModel: modal.querySelector('#edit-local-default-model').value.trim(),
        opusModel: modal.querySelector('#edit-local-opus-model').value.trim(),
        sonnetModel: modal.querySelector('#edit-local-sonnet-model').value.trim(),
        haikuModel: modal.querySelector('#edit-local-haiku-model').value.trim(),
      });
      modal.querySelector('#save-snapshot-btn').addEventListener('click', () => {
        send({ type: 'save_local_snapshot', snapshot: getClaudeLocalDraft() });
        closeModal();
      });
      modal.querySelector('#write-local-btn').addEventListener('click', () => {
        if (!confirm('确认覆盖 ~/.claude/settings.json？新启动的 Claude 会话会直接使用这些配置。')) return;
        send({ type: 'write_claude_local_config', snapshot: getClaudeLocalDraft() });
        closeModal();
      });
    };

    // === Codex Config UI ===
    const codexConfigArea = panel.querySelector('#codex-config-area');
    const codexStatus = panel.querySelector('#codex-status');
    const codexSaveBtn = panel.querySelector('#codex-save-btn');

    let currentCodexConfig = null;
    let codexEditingProfiles = [];
    let codexActiveProfile = '';

    function showCodexStatus(msg, type) {
      codexStatus.textContent = msg;
      codexStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodexConfigArea() {
      const isLocal = codexActiveProfile === '';
      const profileOptions = codexEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}"${profile.name === codexActiveProfile ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        codexConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="codex-profile-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="codex-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="codex-read-local-btn" style="padding:4px 10px">读取当前配置</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>。
          </div>
        `;
        panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openCodexProfileModal();
          } else if (e.target.value === '__local__') {
            codexActiveProfile = '';
            renderCodexConfigArea();
          } else {
            codexActiveProfile = e.target.value;
            renderCodexConfigArea();
          }
        });
        panel.querySelector('#codex-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#codex-read-local-btn').addEventListener('click', () => send({ type: 'read_codex_local_config' }));
        return;
      }

      // Custom profile selected
      const currentProfileRaw = codexEditingProfiles.find((profile) => profile.name === codexActiveProfile);
      const currentProfile = currentProfileRaw ? normalizeCodexProfile(currentProfileRaw) : null;
      const summaryBase = currentProfile?.apiBase ? escapeHtml(currentProfile.apiBase) : '默认';
      const summaryModel = currentProfile?.model ? escapeHtml(currentProfile.model) : '未设置';
      const summaryModelsCount = Array.isArray(currentProfile?.models) ? currentProfile.models.length : 0;
      const summaryProxy = currentProfile?.useProxy ? escapeHtml(currentProfile.proxyUrl || '未填写') : '关闭';

      codexConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codex-profile-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codex-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codex-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong> · API Base：<code>${summaryBase}</code> · 代理：<code>${summaryProxy}</code> · 默认模型：<code>${summaryModel}</code> · /model 候选：<code>${summaryModelsCount}</code> 项
        </div>
      `;

      panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodexProfileModal();
        } else if (e.target.value === '__local__') {
          codexActiveProfile = '';
          renderCodexConfigArea();
        } else {
          codexActiveProfile = e.target.value;
          renderCodexConfigArea();
        }
      });
      panel.querySelector('#codex-profile-edit').addEventListener('click', () => {
        openCodexProfileModal(codexActiveProfile);
      });
      panel.querySelector('#codex-profile-del').addEventListener('click', () => {
        if (!codexActiveProfile) return;
        if (!confirm(`确认删除 Codex Profile「${codexActiveProfile}」?`)) return;
        codexEditingProfiles = codexEditingProfiles.filter((profile) => profile.name !== codexActiveProfile);
        codexActiveProfile = codexEditingProfiles[0]?.name || '';
        renderCodexConfigArea();
      });
    }

    function openCodexProfileModal(profileName = '') {
      const current = profileName
        ? codexEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current ? normalizeCodexProfile(current) : { name: '', apiKey: '', apiBase: '', useProxy: false, proxyUrl: '', model: '', models: [] };
      const initialModelListText = Array.isArray(draft.models) ? draft.models.join('\n') : '';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${current ? `编辑 Profile: ${escapeHtml(current.name)}` : '新建 Codex Profile'}</h3>
          <button class="settings-close" id="codex-profile-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="codex-profile-name" placeholder="例如 OpenRouter Work" value="${escapeHtml(draft.name || '')}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="codex-profile-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="codex-profile-apibase" placeholder="https://api.openai.com/v1" value="${escapeHtml(draft.apiBase || '')}">
        </div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="codex-profile-use-proxy"${draft.useProxy ? ' checked' : ''}> 使用代理
          </label>
          <input type="text" id="codex-profile-proxy-url" placeholder="http://127.0.0.1:7890" value="${escapeHtml(draft.proxyUrl || '')}" style="margin-top:6px;${draft.useProxy ? '' : 'display:none'}">
          <div class="settings-inline-note" id="codex-profile-proxy-note" style="margin-top:6px;${draft.useProxy ? '' : 'display:none'}">支持 HTTP、HTTPS 和 SOCKS 代理；仅对此 Profile 启动的 Agent 生效。</div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="codex-profile-custom-endpoint"> 端点
            </label>
            <input type="text" id="codex-profile-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="codex-profile-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="codex-profile-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型</label>
          <input type="text" id="codex-profile-model" list="codex-profile-dl-models" placeholder="gpt-5.5" value="${escapeHtml(draft.model || '')}" autocomplete="off">
        </div>
        <datalist id="codex-profile-dl-models"></datalist>
        <div class="settings-field">
          <label>/model 候选列表</label>
          <textarea id="codex-profile-model-list" rows="7" placeholder="每行一个模型，例如&#10;gpt-5.5&#10;gpt-5.4&#10;gpt-5.3-codex" style="resize:vertical">${escapeHtml(initialModelListText)}</textarea>
        </div>
        <div class="settings-inline-note">
          默认模型会用于新会话；<code>/model</code> 弹出的候选项只来自这里配置的列表。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#codex-profile-custom-endpoint');
      const endpointInput = modal.querySelector('#codex-profile-models-endpoint');
      const useProxyInput = modal.querySelector('#codex-profile-use-proxy');
      const proxyUrlInput = modal.querySelector('#codex-profile-proxy-url');
      const proxyNote = modal.querySelector('#codex-profile-proxy-note');
      const fetchBtn = modal.querySelector('#codex-profile-fetch-models');
      const fetchStatus = modal.querySelector('#codex-profile-fetch-status');
      const datalist = modal.querySelector('#codex-profile-dl-models');
      const defaultModelInput = modal.querySelector('#codex-profile-model');
      const modelListTextarea = modal.querySelector('#codex-profile-model-list');
      useProxyInput.addEventListener('change', () => {
        proxyUrlInput.style.display = useProxyInput.checked ? '' : 'none';
        proxyNote.style.display = useProxyInput.checked ? '' : 'none';
      });
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';
        _onFetchModelsResult = (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
            const fetchedText = result.models.join('\n');
            const currentText = modelListTextarea.value.trim();
            if (!currentText) {
              modelListTextarea.value = fetchedText;
            } else if (currentText !== fetchedText && confirm('是否使用拉取结果覆盖当前 /model 候选列表？')) {
              modelListTextarea.value = fetchedText;
            }
            if (!defaultModelInput.value.trim() && result.models[0]) {
              defaultModelInput.value = result.models[0];
            }
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({
          type: 'fetch_models',
          apiBase,
          apiKey,
          useProxy: useProxyInput.checked,
          proxyUrl: proxyUrlInput.value.trim(),
          modelsEndpoint: modelsEndpoint || undefined,
          profileName: current?.name || modal.querySelector('#codex-profile-name').value.trim(),
        });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#codex-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codex-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codex-profile-name').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const useProxy = useProxyInput.checked;
        const proxyUrl = proxyUrlInput.value.trim();
        const model = defaultModelInput.value.trim();
        const models = _parseCodexModelListText(modelListTextarea.value);
        if (!name) { alert('请填写 Profile 名称'); return; }
        if (!apiKey) { alert('请填写 API Key'); return; }
        if (!apiBase) { alert('请填写 API Base URL'); return; }
        const proxyError = validateProxyDraft(useProxy, proxyUrl);
        if (proxyError) { alert(proxyError); return; }
        if (!model) { alert('请填写模型'); return; }
        if (!models.length) { alert('请至少填写一个 /model 候选模型'); return; }
        if (!models.includes(model)) models.unshift(model);
        const existing = codexEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) { alert('Profile 名称已存在'); return; }
        if (current) {
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
          current.useProxy = useProxy;
          current.proxyUrl = proxyUrl;
          current.model = model;
          current.models = models;
        } else {
          codexEditingProfiles.push({ name, apiKey, apiBase, useProxy, proxyUrl, model, models });
        }
        codexActiveProfile = name;
        closeModal();
        renderCodexConfigArea();
      });
    }

    _onCodexConfig = (config) => {
      currentCodexConfig = config || {};
      codexEditingProfiles = (currentCodexConfig.profiles || []).map((profile) => normalizeCodexProfile(profile));
      if (currentCodexConfig.mode === 'local') {
        codexActiveProfile = '';
      } else {
        codexActiveProfile = currentCodexConfig.activeProfile || (codexEditingProfiles[0]?.name || '');
      }
      renderCodexConfigArea();
    };

    codexSaveBtn.addEventListener('click', () => {
      const isLocal = codexActiveProfile === '';
      if (!isLocal && codexEditingProfiles.length === 0) {
        showCodexStatus('自定义模式至少需要一个 Codex Profile', 'error');
        return;
      }
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeProfile: isLocal ? '' : codexActiveProfile,
        profiles: codexEditingProfiles,
        enableSearch: false,
        localSnapshot: currentCodexConfig?.localSnapshot || {},
      };
      send({ type: 'save_codex_config', config });
      showCodexStatus('已保存', 'success');
    });

    _onCodexLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '560px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑 Codex 本地快照</h3>
          <button class="settings-close" id="edit-codex-local-close">&times;</button>
        </div>
        ${msg.warning ? `<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">${escapeHtml(msg.warning)}</div>` : ''}
        ${!msg.sourceFound ? '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.codex/ 配置文件，可先编辑快照后保存。</div>' : ''}
        <div class="settings-field">
          <label>API Key</label>
          <input id="edit-codex-local-apikey" type="password" value="${escapeHtml(config.apiKey || '')}" placeholder="OPENAI_API_KEY">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input id="edit-codex-local-apibase" type="text" value="${escapeHtml(config.apiBase || '')}" placeholder="https://api.openai.com/v1">
        </div>
        <div class="settings-field">
          <label>模型</label>
          <input id="edit-codex-local-model" type="text" value="${escapeHtml(config.model || '')}" placeholder="gpt-4.1">
        </div>
        <div class="settings-actions">
          <button class="btn-test" id="edit-codex-local-cancel">取消</button>
          <button class="btn-save" id="edit-codex-local-save">保存快照</button>
          <button class="btn-save" id="write-codex-local-btn">覆盖本机配置</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#edit-codex-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#edit-codex-local-cancel').addEventListener('click', closeModal);
      const getCodexLocalDraft = () => ({
        ...config,
        apiKey: modal.querySelector('#edit-codex-local-apikey').value.trim(),
        apiBase: modal.querySelector('#edit-codex-local-apibase').value.trim(),
        model: modal.querySelector('#edit-codex-local-model').value.trim(),
      });
      modal.querySelector('#edit-codex-local-save').addEventListener('click', () => {
        send({ type: 'save_codex_local_snapshot', snapshot: getCodexLocalDraft() });
        closeModal();
      });
      modal.querySelector('#write-codex-local-btn').addEventListener('click', () => {
        if (!confirm('确认覆盖 ~/.codex/config.toml 和 ~/.codex/auth.json？新启动的 Codex 会话会直接使用这些配置。')) return;
        send({ type: 'write_codex_local_config', snapshot: getCodexLocalDraft() });
        closeModal();
      });
    };

    // === System UI ===
    const closeBtn = panel.querySelector('.settings-close');
    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    // Check update button
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');
    let _onUpdateInfo = null;
    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = `有新版本 <strong>v${escapeHtml(info.latestVersion)}</strong>（当前 v${escapeHtml(info.localVersion)}）&nbsp;<a href="${escapeHtml(info.releaseUrl)}" target="_blank" style="color:var(--accent)">查看更新</a>`;
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    // Wire _onUpdateInfo into WS handler via closure
    const _origOnUpdateInfo = window._ccOnUpdateInfo;
    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });

    document.addEventListener('keydown', _settingsEscape);
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    document.querySelectorAll('.settings-subpage-overlay').forEach((node) => node.remove());
    _onNotifyConfig = null;
    _onNotifyTestResult = null;
    _onModelConfig = null;
    _onCodexConfig = null;
    _onFetchModelsResult = null;
    _onClaudeLocalConfig = null;
    _onCodexLocalConfig = null;
    _onDevConfig = null;
    _onSecurityStatus = null;
    _onSecurityActionResult = null;
    window._ccOnUpdateInfo = null;
    document.removeEventListener('keydown', _settingsEscape);
  }

  function _settingsEscape(e) {
    if (e.key === 'Escape') hideSettingsPanel();
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', showSettingsPanel);
  }

  // --- Force Change Password ---
  function showForceChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'force-change-overlay';
    overlay.id = 'force-change-overlay';

    const panel = document.createElement('div');
    panel.className = 'force-change-panel';

    panel.innerHTML = `
      <div class="login-logo">CC</div>
      <h2>修改初始密码</h2>
      <p>首次登录需要设置新密码</p>
      <div class="force-change-form">
        <input type="password" id="fc-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="fc-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
        <input type="password" id="fc-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
        <button id="fc-submit-btn" class="fc-submit-btn" disabled>确认修改</button>
        <div class="fc-status" id="fc-status"></div>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const newPwInput = panel.querySelector('#fc-new-pw');
    const confirmPwInput = panel.querySelector('#fc-confirm-pw');
    const hintEl = panel.querySelector('#fc-hint');
    const submitBtn = panel.querySelector('#fc-submit-btn');
    const statusEl = panel.querySelector('#fc-status');

    function checkStrength() {
      const pw = newPwInput.value;
      const confirm = confirmPwInput.value;
      if (!pw) {
        hintEl.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hintEl.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(pw);
      if (!result.valid) {
        hintEl.textContent = result.message;
        hintEl.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hintEl.textContent = '密码强度符合要求';
      hintEl.className = 'password-hint success';
      submitBtn.disabled = !confirm || confirm !== pw;
    }

    newPwInput.addEventListener('input', checkStrength);
    confirmPwInput.addEventListener('input', checkStrength);

    submitBtn.addEventListener('click', () => {
      const newPw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (newPw !== confirmPw) {
        statusEl.textContent = '两次密码不一致';
        statusEl.className = 'fc-status error';
        return;
      }
      submitBtn.disabled = true;
      statusEl.textContent = '正在修改...';
      statusEl.className = 'fc-status';
      send({ type: 'change_password', currentPassword: loginPasswordValue || localStorage.getItem('cc-web-pw') || '', newPassword: newPw });
    });

    newPwInput.focus();
  }

  function hideForceChangePassword() {
    const overlay = document.getElementById('force-change-overlay');
    if (overlay) overlay.remove();
  }

  function clientValidatePassword(pw) {
    if (!pw || pw.length < 8) {
      return { valid: false, message: '密码长度至少 8 位' };
    }
    let types = 0;
    if (/[a-z]/.test(pw)) types++;
    if (/[A-Z]/.test(pw)) types++;
    if (/[0-9]/.test(pw)) types++;
    if (/[^a-zA-Z0-9]/.test(pw)) types++;
    if (types < 2) {
      return { valid: false, message: '需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
    }
    return { valid: true, message: '' };
  }

  // --- Password Changed Handler ---
  let _onPasswordChanged = null;

  function handlePasswordChanged(msg) {
    if (msg.success) {
      // Update token
      authToken = msg.token;
      localStorage.setItem('cc-web-token', msg.token);
      // Update remembered password
      if (localStorage.getItem('cc-web-pw')) {
        // Clear old remembered password since it's changed
        localStorage.removeItem('cc-web-pw');
      }

      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        showToast('密码修改成功');
      }

      // If settings panel change password
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: true, message: msg.message });
        _onPasswordChanged = null;
      }
    } else {
      // Force-change error
      const fcStatus = document.querySelector('#fc-status');
      if (fcStatus) {
        fcStatus.textContent = msg.message || '修改失败';
        fcStatus.className = 'fc-status error';
        const btn = document.querySelector('#fc-submit-btn');
        if (btn) btn.disabled = false;
      }

      // Settings panel error
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: false, message: msg.message });
        _onPasswordChanged = null;
      }
    }
  }

  // --- Recent CWD memory (localStorage) ---
  const RECENT_CWD_KEY = 'cc-web-recent-cwds';
  const RECENT_CWD_MAX = 5;

  function getRecentCwds() {
    try {
      const raw = localStorage.getItem(RECENT_CWD_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveRecentCwd(cwd) {
    if (!cwd) return;
    let list = getRecentCwds().filter(p => p !== cwd);
    list.unshift(cwd);
    if (list.length > RECENT_CWD_MAX) list = list.slice(0, RECENT_CWD_MAX);
    try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list)); } catch {}
  }

  // --- Pinned CWD helpers ---
  function getPinnedCwds(agent) {
    try {
      const raw = localStorage.getItem('cc-web-pinned-cwds-' + agent);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function savePinnedCwd(agent, cwd) {
    if (!cwd) return;
    let list = getPinnedCwds(agent);
    if (list.includes(cwd)) return;
    list.unshift(cwd);
    if (list.length > 5) list = list.slice(0, 5);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  function removePinnedCwd(agent, cwd) {
    let list = getPinnedCwds(agent).filter(p => p !== cwd);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  // --- New Session Modal ---
  let _onCwdSuggestions = null;

  function openDirectoryPicker(options = {}) {
    const title = options.title || '选择目录';
    const confirmLabel = options.confirmLabel || '使用此目录';
    const description = String(options.description || '').trim();
    const initialPath = String(options.initialPath || '').trim();

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-panel modal-panel-wide ns-dir-picker-panel">
          <div class="modal-header">
            <span class="modal-title">${escapeHtml(title)}</span>
            <button class="modal-close-btn" id="ns-dir-picker-close">✕</button>
          </div>
          <div class="modal-body">
            ${description ? `<div class="settings-inline-note ns-dir-picker-note">${escapeHtml(description)}</div>` : ''}
            <div class="ns-dir-picker-toolbar">
              <input type="text" id="ns-dir-picker-path" class="modal-text-input" placeholder="输入目录路径" value="${escapeAttr(initialPath)}">
              <button class="btn-test" id="ns-dir-picker-go" type="button">打开</button>
              <button class="btn-test" id="ns-dir-picker-up" type="button">上一级</button>
              <button class="btn-test" id="ns-dir-picker-refresh" type="button">刷新</button>
            </div>
            <div class="ns-dir-picker-current" id="ns-dir-picker-current"></div>
            <div class="file-browser-list ns-dir-picker-list" id="ns-dir-picker-list"></div>
            <div class="file-browser-status" id="ns-dir-picker-status"></div>
          </div>
          <div class="modal-footer">
            <button class="modal-btn-secondary" id="ns-dir-picker-cancel">取消</button>
            <button class="modal-btn-primary" id="ns-dir-picker-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const pathInput = overlay.querySelector('#ns-dir-picker-path');
      const currentEl = overlay.querySelector('#ns-dir-picker-current');
      const listEl = overlay.querySelector('#ns-dir-picker-list');
      const statusEl = overlay.querySelector('#ns-dir-picker-status');
      const okBtn = overlay.querySelector('#ns-dir-picker-ok');

      let currentPath = initialPath;
      let currentParent = null;
      let loading = false;
      let closed = false;

      function close(result = null) {
        if (closed) return;
        closed = true;
        overlay.remove();
        resolve(result);
      }

      async function loadDir(targetPath = currentPath) {
        if (loading) return;
        loading = true;
        statusEl.textContent = '加载中...';
        listEl.innerHTML = '';
        okBtn.disabled = true;
        try {
          const result = await apiFetch(`/api/fs/list?path=${encodeURIComponent(targetPath || '')}`);
          const dirEntries = (result.entries || []).filter((entry) => entry.type === 'dir');
          currentPath = result.cwd || '';
          currentParent = result.parent || null;
          pathInput.value = currentPath;
          currentEl.textContent = `当前目录：${currentPath}`;
          listEl.innerHTML = [
            currentParent ? `
              <button type="button" class="file-browser-item ns-dir-picker-item" data-nav-path="${escapeAttr(currentParent)}">
                <span>↩</span>
                <span class="file-browser-item-name">..</span>
                <span class="file-browser-item-meta">上一级</span>
              </button>
            ` : '',
            ...dirEntries.map((entry) => `
              <button type="button" class="file-browser-item ns-dir-picker-item" data-nav-path="${escapeAttr(entry.path)}">
                <span>📁</span>
                <span class="file-browser-item-name" title="${escapeAttr(entry.path)}">${escapeHtml(entry.name)}</span>
                <span class="file-browser-item-meta">目录</span>
              </button>
            `),
          ].join('') || '<div class="file-browser-item"><span class="file-browser-item-meta">当前目录下没有子目录</span></div>';
          statusEl.textContent = [
            `${dirEntries.length} 个子目录`,
            result.truncated ? '目录项过多，已截断' : '',
            currentParent ? '可进入上一级' : '',
          ].filter(Boolean).join(' · ');
          okBtn.disabled = !currentPath;
          listEl.querySelectorAll('[data-nav-path]').forEach((btn) => {
            btn.addEventListener('click', () => loadDir(btn.dataset.navPath || ''));
          });
        } catch (err) {
          statusEl.textContent = err.message || '读取目录失败';
          currentEl.textContent = '';
          listEl.innerHTML = '<div class="file-browser-item"><span class="file-browser-item-meta">无法读取该目录</span></div>';
        } finally {
          loading = false;
        }
      }

      overlay.querySelector('#ns-dir-picker-close').addEventListener('click', () => close(null));
      overlay.querySelector('#ns-dir-picker-cancel').addEventListener('click', () => close(null));
      overlay.querySelector('#ns-dir-picker-go').addEventListener('click', () => loadDir(pathInput.value));
      overlay.querySelector('#ns-dir-picker-refresh').addEventListener('click', () => loadDir(currentPath || pathInput.value));
      overlay.querySelector('#ns-dir-picker-up').addEventListener('click', () => {
        if (currentParent) loadDir(currentParent);
      });
      overlay.querySelector('#ns-dir-picker-ok').addEventListener('click', () => close(currentPath || pathInput.value.trim() || null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          loadDir(pathInput.value);
        }
      });

      loadDir(initialPath);
    });
  }

  function showNewSessionModal() {
    const targetAgent = currentAgent;
    const targetLabel = AGENT_LABELS[targetAgent] || AGENT_LABELS.claude;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'new-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel">
        <div class="modal-header">
          <span class="modal-title">新建 ${escapeHtml(targetLabel)} 会话</span>
          <button class="modal-close-btn" id="ns-close-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="agent-context-card" style="margin-bottom:12px">
            <div class="agent-context-kicker" id="ns-task-label">${escapeHtml(targetLabel)} · 本地任务</div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn-test ns-task-tab active" id="ns-tab-local" style="flex:1;padding:6px 12px">本地任务</button>
            <button class="btn-test ns-task-tab" id="ns-tab-remote" style="flex:1;padding:6px 12px">远程任务</button>
          </div>
          <div id="ns-local-view"></div>
          <div id="ns-remote-view" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-create-btn">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let currentTab = 'local';
    let selectedHostId = '';
    const tabLocal = overlay.querySelector('#ns-tab-local');
    const tabRemote = overlay.querySelector('#ns-tab-remote');
    const localView = overlay.querySelector('#ns-local-view');
    const remoteView = overlay.querySelector('#ns-remote-view');
    const taskLabel = overlay.querySelector('#ns-task-label');

    function switchTab(tab) {
      currentTab = tab;
      tabLocal.classList.toggle('active', tab === 'local');
      tabRemote.classList.toggle('active', tab === 'remote');
      tabLocal.style.opacity = tab === 'local' ? '1' : '0.6';
      tabRemote.style.opacity = tab === 'remote' ? '1' : '0.6';
      localView.style.display = tab === 'local' ? '' : 'none';
      remoteView.style.display = tab === 'remote' ? '' : 'none';
      taskLabel.textContent = targetLabel + (tab === 'local' ? ' · 本地任务' : ' · 远程任务');
    }
    tabLocal.addEventListener('click', () => switchTab('local'));
    tabRemote.addEventListener('click', () => switchTab('remote'));
    switchTab('local');

    // --- Local task view ---
    let selectedLocalIndex = 0;
    let customLocalCwd = '';
    const localDirDrafts = new Map();

    function getLocalDirState() {
      const currentPinned = getPinnedCwds(targetAgent);
      const currentRecent = getRecentCwds().filter((p) => !currentPinned.includes(p));
      const filledDirs = [...currentPinned, ...currentRecent].slice(0, 4);
      return { currentPinned, filledDirs };
    }

    function getDraftLocalDir(dir) {
      return localDirDrafts.has(dir) ? localDirDrafts.get(dir) : dir;
    }

    function setSelectedLocalRow(index) {
      selectedLocalIndex = index;
      localView.querySelectorAll('[data-local-row]').forEach((row) => {
        const rowIndex = Number(row.dataset.localRow);
        const selected = rowIndex === selectedLocalIndex;
        row.classList.toggle('is-selected', selected);
        const radio = row.querySelector('.ns-cwd-radio');
        if (radio) radio.checked = selected;
      });
    }

    function getSelectedLocalCwd() {
      const { filledDirs } = getLocalDirState();
      if (selectedLocalIndex === filledDirs.length) {
        return customLocalCwd.trim();
      }
      const sourceDir = filledDirs[selectedLocalIndex] || '';
      return String(getDraftLocalDir(sourceDir) || '').trim();
    }

    function renderLocalView() {
      const { currentPinned, filledDirs } = getLocalDirState();
      const maxIndex = filledDirs.length;
      if (selectedLocalIndex > maxIndex) selectedLocalIndex = maxIndex;

      localView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${filledDirs.map((dir, i) => {
            const isPinned = currentPinned.includes(dir);
            const isSelected = selectedLocalIndex === i;
            return `
              <div class="ns-cwd-row${isSelected ? ' is-selected' : ''}" data-local-row="${i}">
                <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${i}" ${isSelected ? 'checked' : ''}>
                <input type="text" class="modal-text-input ns-cwd-item" value="${escapeAttr(getDraftLocalDir(dir))}" data-idx="${i}" data-cwd-key="${escapeAttr(dir)}" style="flex:1;${isPinned ? '' : 'opacity:0.6'}">
                <button class="btn-test ns-pin-btn" data-idx="${i}" data-cwd-key="${escapeAttr(dir)}" style="padding:2px 6px;font-size:0.9em;${isPinned ? 'color:var(--accent)' : ''}" title="${isPinned ? '取消固定' : '固定'}">${isPinned ? '★' : '☆'}</button>
                <button class="btn-test ns-del-dir-btn" data-idx="${i}" data-cwd-key="${escapeAttr(dir)}" style="padding:2px 6px;font-size:0.9em" title="移除">✕</button>
              </div>
            `;
          }).join('')}
          <div class="ns-cwd-row${selectedLocalIndex === filledDirs.length ? ' is-selected' : ''}" data-local-row="${filledDirs.length}">
            <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${filledDirs.length}" ${selectedLocalIndex === filledDirs.length ? 'checked' : ''}>
            <input type="text" id="ns-cwd-custom" class="modal-text-input" placeholder="输入自定义目录" style="flex:1" value="${escapeAttr(customLocalCwd)}">
            <button class="btn-test" id="ns-choose-dir-btn" type="button" style="padding:6px 10px;white-space:nowrap">选择</button>
          </div>
        </div>
      `;

      localView.querySelectorAll('[data-local-row]').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.ns-pin-btn') || e.target.closest('.ns-del-dir-btn') || e.target.closest('#ns-choose-dir-btn')) return;
          setSelectedLocalRow(Number(row.dataset.localRow));
        });
      });

      localView.querySelectorAll('.ns-cwd-item').forEach((input) => {
        input.addEventListener('input', () => {
          const cwdKey = input.dataset.cwdKey || '';
          if (!cwdKey) return;
          localDirDrafts.set(cwdKey, input.value);
        });
        input.addEventListener('focus', () => {
          const row = input.closest('[data-local-row]');
          if (!row) return;
          setSelectedLocalRow(Number(row.dataset.localRow));
        });
      });

      const customInput = localView.querySelector('#ns-cwd-custom');
      if (customInput) {
        customInput.addEventListener('input', () => {
          customLocalCwd = customInput.value;
        });
        customInput.addEventListener('focus', () => {
          const row = customInput.closest('[data-local-row]');
          if (!row) return;
          setSelectedLocalRow(Number(row.dataset.localRow));
        });
      }

      localView.querySelectorAll('.ns-pin-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sourceCwd = btn.dataset.cwdKey || '';
          const cwd = String(getDraftLocalDir(sourceCwd) || sourceCwd).trim();
          if (!cwd) return;
          const currentPinned2 = getPinnedCwds(targetAgent);
          if (currentPinned2.includes(sourceCwd) && cwd === sourceCwd) {
            removePinnedCwd(targetAgent, sourceCwd);
          } else {
            savePinnedCwd(targetAgent, cwd);
          }
          selectedLocalIndex = Number(btn.dataset.idx || 0);
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-del-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sourceCwd = btn.dataset.cwdKey || '';
          const editedCwd = String(getDraftLocalDir(sourceCwd) || '').trim();
          if (!sourceCwd && !editedCwd) return;
          removePinnedCwd(targetAgent, sourceCwd);
          if (editedCwd && editedCwd !== sourceCwd) removePinnedCwd(targetAgent, editedCwd);
          let recents = getRecentCwds().filter((p) => p !== sourceCwd && p !== editedCwd);
          try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(recents)); } catch {}
          localDirDrafts.delete(sourceCwd);
          if (selectedLocalIndex > 0) selectedLocalIndex -= 1;
          renderLocalView();
        });
      });

      const chooseDirBtn = localView.querySelector('#ns-choose-dir-btn');
      if (chooseDirBtn) {
        chooseDirBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          setSelectedLocalRow(filledDirs.length);
          const pickedPath = await openDirectoryPicker({
            title: '选择本地工作目录',
            confirmLabel: '使用此目录',
            initialPath: customLocalCwd.trim() || getSelectedLocalCwd() || currentCwd || '',
            description: '浏览当前 CC-Web 所在服务器上的文件系统，选择一个目录作为新会话工作目录。',
          });
          if (!pickedPath) return;
          customLocalCwd = pickedPath;
          const freshCustomInput = localView.querySelector('#ns-cwd-custom');
          if (freshCustomInput) {
            freshCustomInput.value = pickedPath;
            freshCustomInput.focus();
            if (typeof freshCustomInput.setSelectionRange === 'function') {
              freshCustomInput.setSelectionRange(pickedPath.length, pickedPath.length);
            }
          }
        });
      }
    }

    renderLocalView();

    // --- Remote task view ---
    // Fetch dev config for SSH hosts
    let sshHosts = [];
    const prevOnDevConfig = _onDevConfig;
    send({ type: 'get_dev_config' });
    _onDevConfig = (config) => {
      sshHosts = config.ssh?.hosts || [];
      renderRemoteView();
    };

    function renderRemoteView() {
      if (sshHosts.length === 0) {
        remoteView.innerHTML = '<div class="settings-inline-note" style="text-align:center">请先在 设置 > 开发者设置 中添加 SSH 主机</div>';
        return;
      }
      remoteView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sshHosts.map((host) => `
            <div style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px;cursor:pointer;${selectedHostId === host.id ? 'border-color:var(--accent);background:var(--accent-dim,rgba(100,150,255,0.08))' : ''}" data-host-select="${host.id}">
              <input type="radio" name="ns-ssh-host" value="${escapeHtml(host.id)}" ${selectedHostId === host.id ? 'checked' : ''} style="margin:0">
              <div style="flex:1">
                <div style="font-weight:600">${escapeHtml(host.name || '未命名')}</div>
                <div style="font-size:0.85em;color:var(--text-secondary)">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
              </div>
            </div>
          `).join('')}
          ${selectedHostId ? `
            <div style="margin-top:8px">
              <label class="modal-field-label" style="margin-bottom:4px">远端工作目录（可选）</label>
              <input type="text" id="ns-remote-cwd" class="modal-text-input" placeholder="留空使用 SSH 默认目录">
            </div>
          ` : ''}
        </div>
      `;

      remoteView.querySelectorAll('[data-host-select]').forEach(el => {
        el.addEventListener('click', () => {
          selectedHostId = el.dataset.hostSelect;
          renderRemoteView();
        });
      });
    }
    renderRemoteView();

    function close() {
      overlay.remove();
      _onCwdSuggestions = null;
      _onDevConfig = prevOnDevConfig;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ns-create-btn').addEventListener('click', () => {
      if (currentTab === 'local') {
        const cwd = getSelectedLocalCwd() || null;
        if (!cwd) {
          alert('请选择或输入工作目录');
          return;
        }
        close();
        saveRecentCwd(cwd);
        send({ type: 'new_session', cwd, agent: targetAgent, mode: currentMode, taskMode: 'local' });
      } else {
        // Remote task
        if (!selectedHostId) {
          alert('请选择一个 SSH 主机');
          return;
        }
        const remoteCwd = remoteView.querySelector('#ns-remote-cwd')?.value?.trim() || '';
        close();
        send({ type: 'new_session', agent: targetAgent, mode: currentMode, taskMode: 'remote', sshHostId: selectedHostId, remoteCwd });
      }
    });
  }

  // --- Import Native Session Modal ---
  let _onNativeSessions = null;

  function showImportSessionModal() {
    if (currentAgent !== 'claude') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 CLI 会话</span>
          <button class="modal-close-btn" id="is-close-btn">✕</button>
        </div>
        <div class="modal-body" id="is-body">
          ${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}
          <div class="modal-loading">正在加载…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onNativeSessions = null;
    }

    overlay.querySelector('#is-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onNativeSessions = (groups, payload) => {
      const body = overlay.querySelector('#is-body');
      if (!body) return;
      if (!groups || groups.length === 0) {
        body.innerHTML = `${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}<div class="modal-empty">未找到本地 CLI 会话</div>`;
        return;
      }
      body.innerHTML = buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。');
      for (const group of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'import-group';
        // Convert slug dir to readable path
        let readablePath = group.dir.replace(/-/g, '/');
        if (!readablePath.startsWith('/')) readablePath = '/' + readablePath;
        readablePath = readablePath.replace(/\/+/g, '/');
        const groupTitle = document.createElement('div');
        groupTitle.className = 'import-group-title';
        groupTitle.textContent = readablePath;
        groupEl.appendChild(groupTitle);
        for (const sess of group.sessions) {
          const item = document.createElement('div');
          item.className = 'import-item';
          const info = document.createElement('div');
          info.className = 'import-item-info';
          const titleEl = document.createElement('div');
          titleEl.className = 'import-item-title';
          titleEl.textContent = sess.title;
          const meta = document.createElement('div');
          meta.className = 'import-item-meta';
          const cwdText = sess.cwd ? sess.cwd : '';
          const timeText = sess.updatedAt ? timeAgo(sess.updatedAt) : '';
          meta.textContent = [cwdText, timeText].filter(Boolean).join(' · ');
          info.appendChild(titleEl);
          info.appendChild(meta);
          const btn = document.createElement('button');
          btn.className = 'import-item-btn';
          btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
          btn.addEventListener('click', () => {
            if (sess.alreadyImported) {
              if (!confirm('已导入过此会话，重新导入将覆盖已有内容。确认继续？')) return;
            } else {
              if (!confirm('由于 cc-web 与本地 CLI 的逻辑不同，导入会话需要解析后方可展示，导入后将覆盖已有内容。确认继续？')) return;
            }
            close();
            send({ type: 'import_native_session', sessionId: sess.sessionId, projectDir: group.dir });
          });
          item.appendChild(info);
          item.appendChild(btn);
          groupEl.appendChild(item);
        }
        body.appendChild(groupEl);
      }
      appendImportTruncationNote(body, payload);
    };

    send({ type: 'list_native_sessions' });
  }

  function showImportCodexSessionModal() {
    if (currentAgent !== 'codex') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-codex-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 Codex 会话</span>
          <button class="modal-close-btn" id="ics-close-btn">✕</button>
        </div>
        <div class="modal-body" id="ics-body">
          ${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}
          <div class="modal-loading">正在加载 Codex 本地历史…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onCodexSessions = null;
    }

    overlay.querySelector('#ics-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onCodexSessions = (items, payload) => {
      const body = overlay.querySelector('#ics-body');
      if (!body) return;
      if (!items || items.length === 0) {
        body.innerHTML = `${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}<div class="modal-empty">未找到本地 Codex 会话</div>`;
        return;
      }

      body.innerHTML = buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。');
      items.forEach((sess) => {
        const item = document.createElement('div');
        item.className = 'import-item';

        const info = document.createElement('div');
        info.className = 'import-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'import-item-title';
        titleEl.textContent = sess.title || sess.threadId;

        const meta = document.createElement('div');
        meta.className = 'import-item-meta';
        meta.textContent = [
          sess.cwd || '',
          sess.source ? `source:${sess.source}` : '',
          sess.updatedAt ? timeAgo(sess.updatedAt) : '',
        ].filter(Boolean).join(' · ');

        const tags = document.createElement('div');
        tags.className = 'import-item-tags';
        if (sess.cliVersion) {
          const ver = document.createElement('span');
          ver.className = 'import-item-tag';
          ver.textContent = `CLI ${sess.cliVersion}`;
          tags.appendChild(ver);
        }
        if (sess.source) {
          const source = document.createElement('span');
          source.className = 'import-item-tag';
          source.textContent = sess.source;
          tags.appendChild(source);
        }

        info.appendChild(titleEl);
        info.appendChild(meta);
        if (tags.children.length > 0) info.appendChild(tags);

        const btn = document.createElement('button');
        btn.className = 'import-item-btn';
        btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
        btn.addEventListener('click', () => {
          const confirmed = sess.alreadyImported
            ? confirm('已导入过此 Codex 会话，重新导入将覆盖已有内容。确认继续？')
            : confirm('将解析本地 Codex rollout 历史并导入当前 Web 视图。确认继续？');
          if (!confirmed) return;
          close();
          send({ type: 'import_codex_session', threadId: sess.threadId, rolloutPath: sess.rolloutPath });
        });

        item.appendChild(info);
        item.appendChild(btn);
        body.appendChild(item);
      });
      appendImportTruncationNote(body, payload);
    };

    send({ type: 'list_codex_sessions' });
  }

  // --- Helpers ---
  function appendImportTruncationNote(body, payload) {
    if (!payload?.truncated) return;
    const note = document.createElement('div');
    note.className = 'import-group-title';
    note.textContent = `仅显示最近的历史记录，共发现 ${payload.totalFiles} 个文件`;
    body.appendChild(note);
  }

  // crypto.randomUUID 仅在安全上下文可用，通过局域网 IP 明文访问时会缺失。
  function createClientMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }

  // --- Init ---
  applyTheme(currentTheme);
  setCurrentAgent(currentAgent);
  loadCommandHistory();
  loadSidebarToolsHeight();
  renderSessionList();
  renderFileBrowserShell();
  renderCmdPanel();
  bindSidebarToolsHeightResizer();
  if (toolTabFiles) toolTabFiles.addEventListener('click', () => switchToolTab('files'));
  if (toolTabCmd) toolTabCmd.addEventListener('click', () => switchToolTab('cmd'));
  switchToolTab('files');
  applySidebarToolsHeight(sidebarToolsHeightPx, { skipPersist: true });
  connect();
  window.addEventListener('resize', () => {
    updateCwdBadge();
    applySidebarToolsHeight(sidebarToolsHeightPx, { skipPersist: true });
  });

  // Register Service Worker for mobile push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Restore remembered password
  const savedPw = localStorage.getItem('cc-web-pw');
  if (savedPw) {
    loginPassword.value = savedPw;
    rememberPw.checked = true;
  }

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      // WS is dead, force reconnect
      connect();
    } else if (ws.readyState === 1 && currentSessionId) {
      syncRunningCommandFromServer({ force: true }).catch(() => {});
    } else if (ws.readyState === 1) {
      syncRunningCommandFromServer({ force: true }).catch(() => {});
    }
  });

  // 启动时机优化：
  // - 有 token 时不仅隐藏登录页，连主应用都立刻显示，并用上次缓存的 session 列表
  //   先渲染侧边栏，体感上"立即出界面"。等 auth_result 到达后服务器会下发新的
  //   session_list 覆盖旧缓存。
  // - 5 秒兜底，如果 WS 始终连不上，再回退到登录页。
  const hasStoredToken = !!localStorage.getItem('cc-web-token');
  if (hasStoredToken) {
    loginOverlay.hidden = true;
    app.hidden = false;
    try {
      const cached = JSON.parse(localStorage.getItem(SESSION_LIST_CACHE_KEY) || '[]');
      if (Array.isArray(cached) && cached.length) {
        sessions = cached.map((s) => ({ ...s, isRunning: false, hasUnread: false }));
        renderSessionList();
      }
    } catch {}
    setTimeout(() => {
      if (!isAuthenticated) {
        loginOverlay.hidden = false;
        app.hidden = true;
      }
    }, 5000);
  } else {
    loginOverlay.hidden = false;
    app.hidden = true;
  }
})();
