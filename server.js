const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { ProxyAgent } = require('proxy-agent');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { createCodexAppServer } = require('./lib/codex-appserver');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = parseInt(process.env.PORT) || 8012;
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CODEX_PATH = process.env.CODEX_PATH || 'codex';
const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(__dirname, 'config');
const SESSIONS_DIR = process.env.CC_WEB_SESSIONS_DIR || path.join(__dirname, 'sessions');
const PUBLIC_DIR = process.env.CC_WEB_PUBLIC_DIR || path.join(__dirname, 'public');
const LOGS_DIR = process.env.CC_WEB_LOGS_DIR || path.join(__dirname, 'logs');
const ATTACHMENTS_DIR = path.join(SESSIONS_DIR, '_attachments');
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

function normalizeProxyConfig(value) {
  return {
    useProxy: !!value?.useProxy,
    proxyUrl: String(value?.proxyUrl || '').trim(),
  };
}

function validateProxyConfig(value) {
  const proxy = normalizeProxyConfig(value);
  if (!proxy.useProxy) return { ...proxy, error: '' };
  if (!proxy.proxyUrl) return { ...proxy, error: '启用代理时必须填写代理地址。' };
  try {
    const parsed = new URL(proxy.proxyUrl);
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
      return { ...proxy, error: `不支持的代理协议：${parsed.protocol}` };
    }
  } catch {
    return { ...proxy, error: '代理地址格式无效。' };
  }
  return { ...proxy, error: '' };
}

function createProxyAgent(proxyConfig) {
  const proxy = validateProxyConfig(proxyConfig);
  if (!proxy.useProxy || proxy.error) return null;
  return new ProxyAgent({ getProxyForUrl: () => proxy.proxyUrl });
}
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_FS_LIST_ENTRIES = 2000;
const MAX_FS_PROBE_NAMES = 20;
const MAX_IMPORT_LIST_FILES = 200;
const MAX_IMPORT_META_CACHE = 500;
const MAX_MESSAGE_ATTACHMENTS = Math.max(1, parseInt(process.env.CC_MAX_MESSAGE_ATTACHMENTS, 10) || 20);
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NOTIFY_CONFIG_PATH = path.join(CONFIG_DIR, 'notify.json');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const AUTH_TOKENS_PATH = path.join(CONFIG_DIR, 'auth_tokens.json');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const BANNED_IPS_PATH = path.join(CONFIG_DIR, 'banned_ips.json');
const COMMAND_HISTORY_PATH = path.join(CONFIG_DIR, 'command-history.json');
const activeExecByToken = new Map();
const activeWsByToken = new Map();
const IS_ROOT_OR_SUDO = (() => {
  try {
    if (typeof process.env.SUDO_USER === 'string' && process.env.SUDO_USER) return true;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) return true;
  } catch {}
  return false;
})();

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

function plog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Simple rotation: if file > 2MB, rename to .old and start fresh
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_SIZE) {
        const oldFile = LOG_FILE.replace('.log', '.old.log');
        try { fs.unlinkSync(oldFile); } catch {}
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// === Notification System ===
const DEFAULT_SUMMARY_CONFIG = {
  enabled: false,
  trigger: 'background', // 'background' | 'always'
  apiSource: 'claude',   // 'claude' | 'codex' | 'custom'
  apiBase: '',
  apiKey: '',
  model: '',
};

function loadNotifyConfig() {
  try {
    if (fs.existsSync(NOTIFY_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(NOTIFY_CONFIG_PATH, 'utf8'));
      // Ensure summary field exists for older configs
      if (!raw.summary) raw.summary = { ...DEFAULT_SUMMARY_CONFIG };
      return raw;
    }
  } catch {}
  // First run: migrate from .env PUSHPLUS_TOKEN
  const token = process.env.PUSHPLUS_TOKEN || '';
  const config = {
    provider: token ? 'pushplus' : 'off',
    pushplus: { token },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
    summary: { ...DEFAULT_SUMMARY_CONFIG },
  };
  saveNotifyConfig(config);
  return config;
}

function saveNotifyConfig(config) {
  fs.writeFileSync(NOTIFY_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function maskToken(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getNotifyConfigMasked() {
  const config = loadNotifyConfig();
  const s = config.summary || {};
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
    summary: {
      enabled: !!s.enabled,
      trigger: s.trigger || 'background',
      apiSource: s.apiSource || 'claude',
      apiBase: s.apiBase || '',
      apiKey: maskToken(s.apiKey),
      model: s.model || '',
    },
  };
}

// === Notification Summary ===

// Per-channel content length limits (chars)
const NOTIFY_CONTENT_LIMITS = {
  telegram: 3800,
  qqbot: 3800,
  serverchan: 30000,
  pushplus: 18000,
  feishu: 18000,
};

function truncateForChannel(text, provider) {
  const limit = NOTIFY_CONTENT_LIMITS[provider] || 18000;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + '\n\n[内容已截断]';
}

function getSummaryApiCredentials(summaryConfig) {
  // Returns { apiBase, apiKey, model, useProxy, proxyUrl } or null
  const src = summaryConfig.apiSource || 'claude';
  if (src === 'claude') {
    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find(t => t.name === modelCfg.activeTemplate);
      if (tpl && tpl.apiKey && tpl.apiBase) {
        return {
          apiBase: tpl.apiBase,
          apiKey: tpl.apiKey,
          model: tpl.defaultModel || tpl.opusModel || '',
          ...normalizeProxyConfig(tpl),
        };
      }
    }
    return null; // local mode — no API credentials available
  }
  if (src === 'codex') {
    const codexCfg = loadCodexConfig();
    if (codexCfg.mode === 'custom' && codexCfg.activeProfile) {
      const profile = (codexCfg.profiles || []).find(p => p.name === codexCfg.activeProfile);
      if (profile && profile.apiKey && profile.apiBase) {
        const resolvedModel = splitCodexModelSpec(summaryConfig.model || profile.model || DEFAULT_CODEX_MODEL).base || DEFAULT_CODEX_MODEL;
        return {
          apiBase: profile.apiBase,
          apiKey: profile.apiKey,
          model: resolvedModel,
          ...normalizeProxyConfig(profile),
        };
      }
    }
    return null;
  }
  if (src === 'custom') {
    if (summaryConfig.apiBase && summaryConfig.apiKey) {
      return { apiBase: summaryConfig.apiBase, apiKey: summaryConfig.apiKey, model: summaryConfig.model || '' };
    }
    return null;
  }
  return null;
}

function callSummaryApi(creds, prompt) {
  return new Promise((resolve) => {
    try {
      const base = creds.apiBase.replace(/\/+$/, '');
      const url = new URL(base + '/v1/chat/completions');
      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const model = creds.model || 'claude-opus-4-6';
      const body = JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const proxyAgent = createProxyAgent(creds);
      const req = mod.request(url, {
        method: 'POST',
        agent: proxyAgent || undefined,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.message?.content || json.content?.[0]?.text || '';
            resolve({ ok: !!text, text: text.trim() });
          } catch {
            resolve({ ok: false, text: '' });
          }
        });
      });
      req.on('error', () => resolve({ ok: false, text: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '' }); });
      req.on('close', () => proxyAgent?.destroy());
      req.write(body);
      req.end();
    } catch {
      resolve({ ok: false, text: '' });
    }
  });
}

function buildSummaryPrompt(sessionTitle, lastUserMsg, fullText, isError, errorDesc) {
  const userSnip = (lastUserMsg || '').slice(0, 300);
  const outputSnip = (fullText || '').slice(0, 15000);
  const base = `会话：${sessionTitle}\n用户请求：${userSnip}\n\n以下是助手的输出内容：\n${outputSnip}`;
  if (isError) {
    return base + `\n\n错误信息：${(errorDesc || '').slice(0, 300)}\n\n` +
      `请用纯文本简要说明本次任务做了什么、遇到了什么问题。` +
      `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
  }
  return base + `\n\n请用纯文本简要说明本次任务做了什么、结论是否成功。` +
    `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
}

async function buildNotifyContent(entry, session, completionError, contextLimitExceeded) {
  const title = session?.title || 'Untitled';
  const agent = entry.agent || 'claude';
  const agentLabel = agent === 'codex' ? 'Codex' : 'Claude';
  const hasTools = (entry.toolCalls || []).length > 0;

  // Determine notify title
  let notifyTitle;
  if (contextLimitExceeded) {
    notifyTitle = `⚠ ${title} 上下文已压缩`;
  } else if (completionError) {
    notifyTitle = `✗ ${title} 任务异常`;
  } else if (hasTools) {
    notifyTitle = `✓ ${title} 任务完成`;
  } else {
    notifyTitle = `✓ ${title} 回复就绪`;
  }

  // Context limit: fixed message, no AI
  if (contextLimitExceeded) {
    return { title: notifyTitle, content: `${agentLabel} 会话上下文已达上限，已自动触发压缩。\n会话: ${title}` };
  }

  // Check if summary is enabled and applicable
  const notifyCfg = loadNotifyConfig();
  const summaryCfg = notifyCfg.summary || {};
  const summaryEnabled = !!summaryCfg.enabled;

  if (!summaryEnabled) {
    // Fallback: simple content
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  const creds = getSummaryApiCredentials(summaryCfg);
  if (!creds) {
    // No credentials — fallback
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  // Get last user message from session
  const messages = session?.messages || [];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserMsg = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const prompt = buildSummaryPrompt(title, lastUserMsg, entry.fullText || '', !!completionError, completionError || '');
  const result = await callSummaryApi(creds, prompt);

  let bodyText;
  if (result.ok && result.text) {
    bodyText = result.text;
  } else {
    // Fallback on API failure
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    if (!result.ok) lines.push('（摘要生成失败，以上为原始信息）');
    bodyText = lines.join('\n');
  }

  return { title: notifyTitle, content: bodyText };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });
  const https = require('https');
  const truncated = truncateForChannel(content, config.provider);

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content: truncated, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${truncated}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: truncated });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${truncated}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${truncated}`)}`;
        isFormData = true;
        break;
      }
      default:
        return resolve({ ok: false, error: `未知通知方式: ${config.provider}` });
    }

    const parsed = new URL(url);
    const contentType = isFormData ? 'application/x-www-form-urlencoded' : 'application/json';
    const reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(parsed, reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        plog('INFO', 'notify_response', { provider: config.provider, status: res.statusCode, body: body.slice(0, 200) });
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => {
      plog('WARN', 'notify_error', { provider: config.provider, error: e.message });
      resolve({ ok: false, error: e.message });
    });
    req.write(data);
    req.end();
  });
}

// Load config on startup (ensures migration)
loadNotifyConfig();

// === Auth Config ===
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function loadAuthConfig() {
  // Priority 1: config/auth.json exists with password
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      if (config.password) return config;
    }
  } catch {}

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = { password: envPw, mustChange: false };
    saveAuthConfig(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = { password: pw, mustChange: true };
  saveAuthConfig(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) {
    return { valid: false, message: '密码长度至少 8 位' };
  }
  let types = 0;
  if (/[a-z]/.test(pw)) types++;
  if (/[A-Z]/.test(pw)) types++;
  if (/[0-9]/.test(pw)) types++;
  if (/[^a-zA-Z0-9]/.test(pw)) types++;
  if (types < 2) {
    return { valid: false, message: '密码需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
  }
  return { valid: true, message: '' };
}

let authConfig = null;
let PASSWORD = '';

function ensureAuthLoaded() {
  if (!authConfig) {
    authConfig = loadAuthConfig();
    PASSWORD = authConfig.password;
  }
  return authConfig;
}

function reloadAuthConfig() {
  authConfig = loadAuthConfig();
  PASSWORD = authConfig.password;
  return authConfig;
}

const activeTokens = new Map(); // token -> lastActive timestamp

const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

function saveAuthTokens() {
  const obj = Object.fromEntries(activeTokens);
  try {
    fs.writeFileSync(AUTH_TOKENS_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

// debounce 异步写：登录成功后 rememberAuthToken 每次都写盘代价不必要，
// 合并 200ms 内的多次写入，并改用异步 API 避免阻塞事件循环。
let authTokensWriteTimer = null;
function scheduleSaveAuthTokens() {
  if (authTokensWriteTimer) return;
  authTokensWriteTimer = setTimeout(() => {
    authTokensWriteTimer = null;
    const obj = Object.fromEntries(activeTokens);
    fs.writeFile(AUTH_TOKENS_PATH, JSON.stringify(obj, null, 2), () => {});
  }, 200);
}

function loadAuthTokens() {
  try {
    if (!fs.existsSync(AUTH_TOKENS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf8'));
    const now = Date.now();
    for (const [token, ts] of Object.entries(data || {})) {
      const lastActive = Number(ts);
      if (token && Number.isFinite(lastActive) && now - lastActive <= TOKEN_TTL) {
        activeTokens.set(token, lastActive);
      }
    }
    saveAuthTokens();
  } catch {}
}

function rememberAuthToken(token) {
  if (!token) return;
  activeTokens.set(token, Date.now());
  scheduleSaveAuthTokens();
}

function clearAuthTokens() {
  activeTokens.clear();
  saveAuthTokens();
}

function isTokenValid(token) {
  if (!token || !activeTokens.has(token)) return false;
  const now = Date.now();
  if (now - activeTokens.get(token) > TOKEN_TTL) {
    activeTokens.delete(token);
    scheduleSaveAuthTokens();
    return false;
  }
  rememberAuthToken(token);
  return true;
}

loadAuthTokens();

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, ts] of activeTokens) {
    if (now - ts > TOKEN_TTL) {
      activeTokens.delete(token);
      changed = true;
    }
  }
  if (changed) saveAuthTokens();
}, 6 * 60 * 60 * 1000).unref();

// === Anti-brute-force ===
const AUTH_FAIL_WINDOW = 5 * 60 * 1000; // 5 minutes
const AUTH_FAIL_MAX = 3;
const BAN_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const authFailures = new Map(); // ip -> [timestamp, ...]
let bannedIPs = new Map(); // ip -> expireTimestamp

// Tailscale / loopback whitelist — never ban these IPs.
// Extra whitelist can be provided via env var (comma/space separated):
//   CC_WEB_IP_WHITELIST="<ip1>,<ip2>"
const EXTRA_WHITELIST_IPS = new Set(
  String(process.env.CC_WEB_IP_WHITELIST || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^::ffff:/, ''))
);

function isWhitelistedIP(ip) {
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/, '');
  return cleaned === '127.0.0.1'
    || cleaned === '::1'
    || cleaned.startsWith('100.')
    || EXTRA_WHITELIST_IPS.has(cleaned);
}

function loadBannedIPs() {
  try {
    if (fs.existsSync(BANNED_IPS_PATH)) {
      const data = JSON.parse(fs.readFileSync(BANNED_IPS_PATH, 'utf8'));
      if (Array.isArray(data)) {
        const exp = Date.now() + BAN_DURATION;
        bannedIPs = new Map(data.map(ip => [ip, exp]));
      } else {
        bannedIPs = new Map(Object.entries(data).map(([ip, t]) => [ip, Number(t)]));
      }
    } else {
      bannedIPs = new Map();
    }
  } catch { bannedIPs = new Map(); }
}
function saveBannedIPs() {
  const obj = Object.fromEntries(bannedIPs);
  fs.writeFileSync(BANNED_IPS_PATH, JSON.stringify(obj, null, 2));
}
loadBannedIPs();

function normalizeClientIP(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

function isBanned(ip) {
  const normalized = normalizeClientIP(ip);
  if (!normalized || !bannedIPs.has(normalized)) return false;
  const exp = bannedIPs.get(normalized);
  if (exp !== -1 && Date.now() > exp) {
    bannedIPs.delete(normalized);
    saveBannedIPs();
    return false;
  }
  return true;
}

function recordAuthFailure(ip) {
  const normalized = normalizeClientIP(ip);
  if (!normalized || isWhitelistedIP(normalized)) return false;
  const now = Date.now();
  let list = authFailures.get(normalized) || [];
  list.push(now);
  list = list.filter(t => now - t < AUTH_FAIL_WINDOW);
  authFailures.set(normalized, list);
  if (list.length >= AUTH_FAIL_MAX) {
    bannedIPs.set(normalized, Date.now() + BAN_DURATION);
    saveBannedIPs();
    authFailures.delete(normalized);
    plog('WARN', 'ip_banned', { ip: normalized, reason: `${AUTH_FAIL_MAX} failed auth in ${AUTH_FAIL_WINDOW / 1000}s` });
    return true;
  }
  return false;
}

function getBanInfo(ip) {
  const normalized = normalizeClientIP(ip);
  if (!normalized || !isBanned(normalized)) return null;
  const expiresAt = Number(bannedIPs.get(normalized));
  const now = Date.now();
  const remainingMs = expiresAt === -1 ? -1 : Math.max(0, expiresAt - now);
  return {
    ip: normalized,
    expiresAt,
    expiresAtIso: expiresAt === -1 ? null : new Date(expiresAt).toISOString(),
    remainingMs,
    permanent: expiresAt === -1,
  };
}

function listBannedIPs() {
  const now = Date.now();
  const entries = [];
  for (const [ip, expiresAtRaw] of bannedIPs.entries()) {
    const info = getBanInfo(ip);
    if (!info) continue;
    entries.push({
      ip: normalizeClientIP(ip),
      expiresAt: Number(expiresAtRaw),
      expiresAtIso: info.expiresAtIso,
      remainingMs: info.remainingMs,
      permanent: info.permanent,
      whitelisted: isWhitelistedIP(ip),
      bannedAtIso: expiresAtRaw === -1 ? null : new Date(Number(expiresAtRaw) - BAN_DURATION).toISOString(),
      active: info.permanent || Number(expiresAtRaw) > now,
    });
  }
  entries.sort((a, b) => {
    if (a.permanent !== b.permanent) return a.permanent ? -1 : 1;
    return (b.expiresAt || 0) - (a.expiresAt || 0);
  });
  return entries;
}

function unbanIP(ip) {
  const normalized = normalizeClientIP(ip);
  if (!normalized) return false;
  const existed = bannedIPs.delete(normalized);
  authFailures.delete(normalized);
  if (existed) {
    saveBannedIPs();
    plog('INFO', 'ip_unbanned', { ip: normalized });
  }
  return existed;
}

function clearAllBannedIPs() {
  if (!bannedIPs.size) return 0;
  const count = bannedIPs.size;
  bannedIPs.clear();
  authFailures.clear();
  saveBannedIPs();
  plog('INFO', 'all_ips_unbanned', { count });
  return count;
}

// Pending slash command metadata: sessionId -> { kind: string }
const pendingSlashCommands = new Map();

// Pending compact retry metadata: sessionId -> { text: string, mode: string, reason: string }
const pendingCompactRetries = new Map();

// Active processes: sessionId -> { pid, ws, fullText, toolCalls, lastCost, tailer }
const activeProcesses = new Map();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();

// Default fallback MODEL_MAP (overridden by model config at runtime)
// opus/sonnet use [1m] suffix to enable 1M context window by default
let MODEL_MAP = {
  opus: 'claude-opus-4-6[1m]',
  sonnet: 'claude-sonnet-4-6[1m]',
  haiku: 'claude-haiku-4-5-20251001',
};

const VALID_AGENTS = new Set(['claude', 'codex']);

// Final fallback only. New Codex sessions prefer:
// 1) active custom profile model
// 2) ~/.codex/config.toml top-level model
// 3) this constant
const DEFAULT_CODEX_MODEL = 'gpt-5.5';

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, useProxy, proxyUrl, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
  localSnapshot: {},  // saved snapshot of local ~/.claude/settings.json API config
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
  localSnapshot: {},  // saved snapshot of local ~/.codex config (archive-only, no restore)
};

function splitCodexModelSpec(model) {
  const raw = String(model || '').trim();
  if (!raw) return { raw: '', base: '', reasoning: '' };
  const match = raw.match(/^(.*)\((medium|high|xhigh)\)\s*$/i);
  if (!match) return { raw, base: raw, reasoning: '' };
  return {
    raw,
    base: String(match[1] || '').trim(),
    reasoning: String(match[2] || '').trim().toLowerCase(),
  };
}

function normalizeCodexModelList(models, defaultModel = '') {
  const seen = new Set();
  const list = [];

  function addModel(value) {
    const model = String(value || '').trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    list.push(model);
  }

  if (Array.isArray(models)) {
    models.forEach(addModel);
  }
  addModel(defaultModel);
  return list;
}

function readCodexLocalConfigSnapshot() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const config = { apiKey: '', apiBase: '', model: '' };
  let sourceFound = false;
  let hasApiKey = false;

  const codexConfigToml = path.join(homeDir, '.codex', 'config.toml');
  try {
    if (fs.existsSync(codexConfigToml)) {
      sourceFound = true;
      const toml = fs.readFileSync(codexConfigToml, 'utf8');
      const baseMatch = toml.match(/base_url\s*=\s*"([^"]+)"/);
      const modelMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (baseMatch) config.apiBase = baseMatch[1];
      if (modelMatch) config.model = modelMatch[1];
    }
  } catch {}

  const codexAuthJson = path.join(homeDir, '.codex', 'auth.json');
  try {
    if (fs.existsSync(codexAuthJson)) {
      sourceFound = true;
      const auth = JSON.parse(fs.readFileSync(codexAuthJson, 'utf8'));
      if (auth.OPENAI_API_KEY) {
        config.apiKey = auth.OPENAI_API_KEY;
        hasApiKey = true;
      }
    }
  } catch {}

  return { config, sourceFound, hasApiKey };
}

function resolveDefaultCodexModel() {
  const codexConfig = loadCodexConfig();
  if (codexConfig.mode === 'custom' && codexConfig.activeProfile) {
    const activeProfile = (codexConfig.profiles || []).find((profile) => profile.name === codexConfig.activeProfile);
    const profileModel = String(activeProfile?.model || '').trim();
    return profileModel || DEFAULT_CODEX_MODEL;
  }
  const localModel = String(readCodexLocalConfigSnapshot().config.model || '').trim();
  return localModel || DEFAULT_CODEX_MODEL;
}

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
      if (!config.localSnapshot) config.localSnapshot = {};
      return config;
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG));
}

function saveModelConfig(config) {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadCodexConfig() {
  try {
    if (fs.existsSync(CODEX_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CODEX_CONFIG_PATH, 'utf8'));
      return {
        mode: raw.mode === 'custom' ? 'custom' : 'local',
        activeProfile: raw.activeProfile || '',
        profiles: Array.isArray(raw.profiles) ? raw.profiles.map((profile) => ({
          name: String(profile?.name || '').trim(),
          apiKey: String(profile?.apiKey || ''),
          apiBase: String(profile?.apiBase || '').trim(),
          ...normalizeProxyConfig(profile),
          model: String(profile?.model || '').trim(),
          models: normalizeCodexModelList(profile?.models, profile?.model),
        })).filter((profile) => profile.name) : [],
        enableSearch: false,
        supportsSearch: false,
        storedEnableSearch: !!raw.enableSearch,
        localSnapshot: raw.localSnapshot || {},
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CODEX_CONFIG));
}

function saveCodexConfig(config) {
  fs.writeFileSync(CODEX_CONFIG_PATH, JSON.stringify({
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: Array.isArray(config.profiles) ? config.profiles.map((profile) => ({
      name: String(profile?.name || '').trim(),
      apiKey: String(profile?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
      ...normalizeProxyConfig(profile),
      model: String(profile?.model || '').trim(),
      models: normalizeCodexModelList(profile?.models, profile?.model),
    })).filter((profile) => profile.name) : [],
    enableSearch: false,
    localSnapshot: config.localSnapshot || {},
  }, null, 2));
}

function getCodexConfigMasked() {
  const config = loadCodexConfig();
  return {
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
      ...normalizeProxyConfig(profile),
      model: profile.model || '',
      models: normalizeCodexModelList(profile.models, profile.model),
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
    localSnapshot: config.localSnapshot || {},
  };
}

function maskSecret(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getModelConfigMasked() {
  const config = loadModelConfig();
  return {
    mode: config.mode,
    activeTemplate: config.activeTemplate,
    templates: (config.templates || []).map(t => ({
      name: t.name,
      apiKey: maskSecret(t.apiKey),
      apiBase: t.apiBase || '',
      ...normalizeProxyConfig(t),
      defaultModel: t.defaultModel || '',
      opusModel: t.opusModel || '',
      sonnetModel: t.sonnetModel || '',
      haikuModel: t.haikuModel || '',
    })),
    localSnapshot: config.localSnapshot || {},
  };
}

// === Dev Config (GitHub / SSH) ===
const DEV_CONFIG_PATH = path.join(CONFIG_DIR, 'dev.json');
const DEFAULT_DEV_CONFIG = { github: { token: '', repos: [] }, ssh: { hosts: [] } };

function loadDevConfig() {
  try {
    if (fs.existsSync(DEV_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DEV_CONFIG_PATH, 'utf8'));
      return {
        github: {
          token: raw.github?.token || '',
          repos: Array.isArray(raw.github?.repos) ? raw.github.repos : [],
        },
        ssh: {
          hosts: Array.isArray(raw.ssh?.hosts) ? raw.ssh.hosts : [],
        },
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_DEV_CONFIG));
}

function saveDevConfig(config) {
  fs.writeFileSync(DEV_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getDevConfigMasked() {
  const config = loadDevConfig();
  return {
    github: {
      token: maskSecret(config.github.token),
      repos: config.github.repos || [],
    },
    ssh: {
      hosts: (config.ssh.hosts || []).map(h => ({
        id: h.id || '',
        name: h.name || '',
        host: h.host || '',
        port: h.port || 22,
        user: h.user || '',
        authType: h.authType || 'key',
        identityFile: h.identityFile || '',
        password: maskSecret(h.password || ''),
        description: h.description || '',
      })),
    },
  };
}

function handleSaveDevConfig(ws, msg) {
  if (!msg.config || typeof msg.config !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的开发者配置' });
  }
  const current = loadDevConfig();
  let token = String(msg.config.github?.token || '');
  // Mask merge: keep existing if masked
  if (token.includes('****')) token = current.github.token;
  const repos = Array.isArray(msg.config.github?.repos) ? msg.config.github.repos.map(r => ({
    id: r.id || ('r_' + crypto.randomBytes(4).toString('hex')),
    name: String(r.name || '').trim(),
    url: String(r.url || '').trim(),
    branch: String(r.branch || 'main').trim(),
    notes: String(r.notes || '').trim(),
  })).filter(r => r.name && r.url) : [];
  const oldHosts = Array.isArray(current.ssh?.hosts) ? current.ssh.hosts : [];
  const hosts = Array.isArray(msg.config.ssh?.hosts) ? msg.config.ssh.hosts.map(h => {
    const old = oldHosts.find(oh => oh.id === h.id || oh.name === h.name);
    const authType = h.authType === 'password' ? 'password' : 'key';
    let password = String(h.password || '');
    if (password.includes('****')) password = old?.password || '';
    return {
      id: h.id || ('h_' + crypto.randomBytes(4).toString('hex')),
      name: String(h.name || '').trim(),
      host: String(h.host || '').trim(),
      port: parseInt(h.port) || 22,
      user: String(h.user || '').trim(),
      authType,
      identityFile: authType === 'key' ? String(h.identityFile || '').trim() : '',
      password: authType === 'password' ? password : '',
      description: String(h.description || '').trim(),
    };
  }).filter(h => h.name && h.host) : [];
  const merged = { github: { token, repos }, ssh: { hosts } };
  saveDevConfig(merged);
  plog('INFO', 'dev_config_saved', { repoCount: repos.length, hostCount: hosts.length });
  wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '开发者配置已保存' });
}

const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function normalizeCodexRuntimeApiBase(apiBase) {
  const raw = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/+$/, '');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function codexSessionHomeDir(sessionId) {
  return path.join(CONFIG_DIR, 'codex-session-home', sanitizeId(sessionId || 'default'));
}

function walkJsonlFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(fullPath, files);
    else if (entry.isFile() && fullPath.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

function copyCodexThreadRollouts(threadId, targetHomeDir) {
  if (!threadId || !targetHomeDir) return;
  const targetSessionsDir = path.join(targetHomeDir, 'sessions');
  fs.mkdirSync(targetSessionsDir, { recursive: true });
  const sourceDirs = [CODEX_SESSIONS_DIR, path.join(CODEX_RUNTIME_HOME, 'sessions')];
  for (const sourceDir of sourceDirs) {
    try {
      for (const filePath of walkJsonlFiles(sourceDir)) {
        if (!filePath.includes(threadId)) continue;
        const rel = path.relative(sourceDir, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const target = path.join(targetSessionsDir, rel);
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(filePath, target);
      }
    } catch {}
  }
}

function prepareCodexLocalRuntimeHome(homeDir) {
  fs.mkdirSync(homeDir, { recursive: true });
  const sourceHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex');
  for (const filename of ['config.toml', 'auth.json']) {
    try {
      const source = path.join(sourceHome, filename);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(homeDir, filename));
    } catch {}
  }
}

function ensureCodexSessionHome(session) {
  if (!session?.id) return CODEX_RUNTIME_HOME;
  if (!session.codexHomeDir) session.codexHomeDir = codexSessionHomeDir(session.id);
  if (session.codexThreadId) copyCodexThreadRollouts(session.codexThreadId, session.codexHomeDir);
  fs.mkdirSync(session.codexHomeDir, { recursive: true });
  return session.codexHomeDir;
}

function prepareCodexCustomRuntime(config, session = null) {
  const homeDir = ensureCodexSessionHome(session);
  if (!config || config.mode !== 'custom') {
    prepareCodexLocalRuntimeHome(homeDir);
    if (session) {
      session.codexHomeDir = homeDir;
      session.codexRuntimeKey = 'local';
    }
    return { mode: 'local', homeDir, runtimeKey: 'local' };
  }
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 自定义配置缺少已激活的 profile。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex profile「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }

  fs.mkdirSync(homeDir, { recursive: true });
  const modelSpec = splitCodexModelSpec(activeProfile.model || DEFAULT_CODEX_MODEL);
  const runtimeApiBase = normalizeCodexRuntimeApiBase(activeProfile.apiBase);
  const configToml = [
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    ...(modelSpec.base ? [`model = ${tomlString(modelSpec.base)}`] : []),
    ...(modelSpec.reasoning ? [`model_reasoning_effort = ${tomlString(modelSpec.reasoning)}`] : []),
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(activeProfile.name || 'OpenAI Compat')}`,
    `base_url = ${tomlString(runtimeApiBase)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(homeDir, 'config.toml'), configToml);
  if (session) {
    session.codexHomeDir = homeDir;
    session.codexRuntimeKey = `custom:${activeProfile.name}`;
  }

  return {
    mode: 'custom',
    homeDir,
    apiKey: activeProfile.apiKey,
    apiBase: runtimeApiBase,
    ...normalizeProxyConfig(activeProfile),
    model: activeProfile.model || '',
    runtimeKey: `custom:${activeProfile.name}`,
    profileName: activeProfile.name,
  };
}

// Read ~/.claude.json for model name overrides
function loadClaudeJsonModelMap() {
  try {
    const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const env = raw?.env || {};
    const map = {};
    // Append [1m] to opus/sonnet for 1M context window; haiku uses model name as-is
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) map.opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) map.sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) map.haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    // Fallback: ANTHROPIC_MODEL maps to opus slot
    if (!map.opus && env.ANTHROPIC_MODEL) map.opus = env.ANTHROPIC_MODEL + '[1m]';
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

// Apply model config to runtime MODEL_MAP only (env vars are injected per-spawn, not here)
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json');
const SETTINGS_API_KEYS = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_REASONING_MODEL', ...PROXY_ENV_KEYS];
// root 用户下 Claude CLI 禁用 --dangerously-skip-permissions，YOLO 会被降级为 default。
// 在 settings.json 里预先批准这些工具，让 default 模式也能直接编辑 / 执行命令，避免
// 非交互子进程被权限询问卡死。
const ROOT_FALLBACK_ALLOW_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Bash', 'WebFetch', 'NotebookEdit'];

function mergeRootFallbackAllow(settings) {
  const permissions = (settings.permissions && typeof settings.permissions === 'object') ? settings.permissions : {};
  const existing = Array.isArray(permissions.allow) ? permissions.allow : [];
  const merged = new Set(existing);
  for (const tool of ROOT_FALLBACK_ALLOW_TOOLS) merged.add(tool);
  permissions.allow = Array.from(merged);
  settings.permissions = permissions;
  return settings;
}

function ensureRootPermissionAllowlist() {
  if (!IS_ROOT_OR_SUDO) return;
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch {}
  const before = JSON.stringify(settings.permissions?.allow || []);
  mergeRootFallbackAllow(settings);
  const after = JSON.stringify(settings.permissions.allow);
  if (before === after) return;
  const tmpPath = CLAUDE_SETTINGS_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

ensureRootPermissionAllowlist();

function applyCustomTemplateToSettings(tpl) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch {}
  const cleanedEnv = {};
  for (const [k, v] of Object.entries(settings.env || {})) {
    if (!SETTINGS_API_KEYS.includes(k)) cleanedEnv[k] = v;
  }
  if (tpl.apiKey)       { cleanedEnv.ANTHROPIC_AUTH_TOKEN = tpl.apiKey; }
  if (tpl.apiBase)      cleanedEnv.ANTHROPIC_BASE_URL = tpl.apiBase;
  if (tpl.defaultModel) cleanedEnv.ANTHROPIC_MODEL = tpl.defaultModel;
  if (tpl.opusModel)    cleanedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tpl.opusModel;
  if (tpl.sonnetModel)  cleanedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tpl.sonnetModel;
  if (tpl.haikuModel)   cleanedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tpl.haikuModel;
  const proxy = normalizeProxyConfig(tpl);
  if (proxy.useProxy && proxy.proxyUrl) {
    cleanedEnv.HTTP_PROXY = proxy.proxyUrl;
    cleanedEnv.HTTPS_PROXY = proxy.proxyUrl;
    cleanedEnv.ALL_PROXY = proxy.proxyUrl;
  }
  settings.env = cleanedEnv;
  if (IS_ROOT_OR_SUDO) mergeRootFallbackAllow(settings);
  // 原子写入：先写临时文件再 rename，避免 Claude 子进程读到写了一半的文件
  const tmpPath = CLAUDE_SETTINGS_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function upsertTomlStringValue(toml, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${key} = ${tomlString(value)}`;
  const re = new RegExp(`^\\s*${escapedKey}\\s*=.*$`, 'm');
  if (re.test(toml)) return toml.replace(re, line);
  const trimmed = toml.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n' : ''}${line}\n`;
}

function writeCodexLocalConfig(snapshot) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) throw new Error('无法确定 HOME 目录');
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const configTomlPath = path.join(codexDir, 'config.toml');
  let toml = '';
  try { toml = fs.readFileSync(configTomlPath, 'utf8'); } catch {}
  const apiBase = String(snapshot.apiBase || '').trim();
  const model = String(snapshot.model || '').trim();
  if (apiBase) toml = upsertTomlStringValue(toml, 'base_url', apiBase);
  if (model) toml = upsertTomlStringValue(toml, 'model', model);
  atomicWriteFile(configTomlPath, toml || '');

  const apiKey = String(snapshot.apiKey || '').trim();
  if (apiKey) {
    const authJsonPath = path.join(codexDir, 'auth.json');
    let auth = {};
    try { auth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8')); } catch {}
    auth.OPENAI_API_KEY = apiKey;
    atomicWriteFile(authJsonPath, JSON.stringify(auth, null, 2));
  }
}

function applyModelConfig() {
  const config = loadModelConfig();
  if (config.mode === 'custom' && config.activeTemplate) {
    const tpl = (config.templates || []).find(t => t.name === config.activeTemplate);
    if (tpl) {
      if (tpl.opusModel) MODEL_MAP.opus = tpl.opusModel.endsWith('[1m]') ? tpl.opusModel : tpl.opusModel + '[1m]';
      if (tpl.sonnetModel) MODEL_MAP.sonnet = tpl.sonnetModel.endsWith('[1m]') ? tpl.sonnetModel : tpl.sonnetModel + '[1m]';
      if (tpl.haikuModel) MODEL_MAP.haiku = tpl.haikuModel;
      return;
    }
  }
  // mode === 'local': read model names from ~/.claude.json
  const localMap = loadClaudeJsonModelMap();
  if (localMap) {
    if (localMap.opus) MODEL_MAP.opus = localMap.opus;
    if (localMap.sonnet) MODEL_MAP.sonnet = localMap.sonnet;
    if (localMap.haiku) MODEL_MAP.haiku = localMap.haiku;
  }
}

// Apply on startup
applyModelConfig();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 只有这些类型允许 inline 呈现。SVG 不在其中：它能携带脚本，
// 内联打开等于在应用自身的 origin 上执行任意代码。
const INLINE_SAFE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

// === Utility Functions ===

const WS_BACKLOG_LIMIT = 4 * 1024 * 1024; // 4MB per socket

function wsSend(ws, data, dropIfBacklogged = false) {
  if (!ws || ws.readyState !== 1) return;
  if (dropIfBacklogged && ws.bufferedAmount > WS_BACKLOG_LIMIT) return;
  ws.send(JSON.stringify(data));
}

function registerWsToken(token, ws) {
  if (!token || !ws) return;
  let sockets = activeWsByToken.get(token);
  if (!sockets) {
    sockets = new Set();
    activeWsByToken.set(token, sockets);
  }
  sockets.add(ws);
}

function unregisterWsToken(token, ws) {
  if (!token || !ws) return;
  const sockets = activeWsByToken.get(token);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) activeWsByToken.delete(token);
}

function wsSendByToken(token, data, dropIfBacklogged = false) {
  if (!token) return;
  const sockets = activeWsByToken.get(token);
  if (!sockets || sockets.size === 0) return;
  for (const ws of Array.from(sockets)) {
    if (!ws || ws.readyState !== 1) {
      sockets.delete(ws);
      continue;
    }
    wsSend(ws, data, dropIfBacklogged);
  }
  if (sockets.size === 0) activeWsByToken.delete(token);
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-]/g, '');
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

function runDir(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(sessionId)}-run`);
}

function attachmentDataPath(id, ext = '') {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}${ext}`);
}

function attachmentMetaPath(id) {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}.json`);
}

function safeFilename(name) {
  return String(name || 'image')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '';
  }
}

function loadAttachmentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(attachmentMetaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveAttachmentMeta(meta) {
  fs.writeFileSync(attachmentMetaPath(meta.id), JSON.stringify(meta, null, 2));
}

function removeAttachmentById(id) {
  const meta = loadAttachmentMeta(id);
  const paths = new Set([attachmentMetaPath(id)]);
  if (meta?.path) paths.add(meta.path);
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function currentAttachmentState(meta) {
  if (!meta) return 'missing';
  const expiresAtMs = new Date(meta.expiresAt || 0).getTime();
  if (expiresAtMs && Date.now() > expiresAtMs) return 'expired';
  if (!meta.path || !fs.existsSync(meta.path)) return 'missing';
  return 'available';
}

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const normalized = [];
  for (const attachment of attachments) {
    const id = sanitizeId(attachment?.id || '');
    if (!id) continue;
    const meta = loadAttachmentMeta(id);
    const state = currentAttachmentState(meta);
    if (state === 'expired') removeAttachmentById(id);
    normalized.push({
      id,
      kind: 'image',
      filename: meta?.filename || attachment?.filename || 'image',
      mime: meta?.mime || attachment?.mime || 'image/png',
      size: meta?.size || attachment?.size || 0,
      createdAt: meta?.createdAt || attachment?.createdAt || null,
      expiresAt: meta?.expiresAt || attachment?.expiresAt || null,
      storageState: state === 'available' ? 'available' : 'expired',
    });
  }
  return normalized;
}

function resolveMessageAttachments(attachments) {
  const resolved = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    if (attachment.storageState !== 'available') continue;
    const meta = loadAttachmentMeta(attachment.id);
    if (!meta?.path || !fs.existsSync(meta.path)) continue;
    resolved.push({
      ...attachment,
      path: meta.path,
    });
  }
  return resolved;
}

function cleanupExpiredAttachments() {
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const meta = loadAttachmentMeta(id);
      if (!meta || currentAttachmentState(meta) === 'expired') {
        removeAttachmentById(id);
      }
    }
  } catch {}
}

function collectSessionAttachmentIds(session) {
  const ids = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      const id = sanitizeId(attachment?.id || '');
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', () => reject(new Error('读取请求体失败')));
  });
}

function normalizeCommandHistory(list, limit = 30) {
  const deduped = [];
  for (const item of Array.isArray(list) ? list : []) {
    const cmd = String(item || '').trim();
    if (!cmd || deduped.includes(cmd)) continue;
    deduped.push(cmd);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function loadCommandHistoryFromDisk() {
  try {
    if (!fs.existsSync(COMMAND_HISTORY_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(COMMAND_HISTORY_PATH, 'utf8'));
    return normalizeCommandHistory(raw?.history || []);
  } catch {
    return [];
  }
}

function saveCommandHistoryToDisk(list) {
  const history = normalizeCommandHistory(list);
  const payload = { history, updatedAt: new Date().toISOString() };
  fs.writeFileSync(COMMAND_HISTORY_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return history;
}

function resolveFsPath(rawPath) {
  const input = String(rawPath || '').trim();
  const base = process.cwd();
  const candidate = input ? (path.isAbsolute(input) ? input : path.join(base, input)) : base;
  return path.resolve(candidate);
}

// Shell output is a replay buffer for reconnecting clients, so keep the tail
// (what a terminal view cares about) rather than growing without bound.
const MAX_EXEC_OUTPUT_CHARS = 512 * 1024;
const EXEC_OUTPUT_TRUNCATED_NOTICE = '[输出过长，已省略较早内容]\n';

function appendCappedOutput(existing, text, limit = MAX_EXEC_OUTPUT_CHARS) {
  const combined = String(existing || '') + String(text || '');
  if (combined.length <= limit) return combined;
  return EXEC_OUTPUT_TRUNCATED_NOTICE + combined.slice(combined.length - limit);
}

function runShellCommand(command, cwd, timeoutMs = 600000, options = {}) {
  return new Promise((resolve, reject) => {
    const targetCwd = resolveFsPath(cwd || '');
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const env = { ...process.env };
    if (/\bdocker(?:-compose|\s+compose)\b/i.test(String(command || '')) && !env.COMPOSE_STATUS_STDOUT) {
      env.COMPOSE_STATUS_STDOUT = '1';
    }
    const child = spawn(shell, args, { cwd: targetCwd, env });
    if (typeof options.onSpawn === 'function') {
      try { options.onSpawn(child, targetCwd); } catch {}
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1000, Number(timeoutMs) || 600000));

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = appendCappedOutput(stdout, text);
      if (typeof options.onStdout === 'function') {
        try { options.onStdout(text); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendCappedOutput(stderr, text);
      if (typeof options.onStderr === 'function') {
        try { options.onStderr(text); } catch {}
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (typeof options.onDone === 'function') {
        try { options.onDone(); } catch {}
      }
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (typeof options.onDone === 'function') {
        try { options.onDone(); } catch {}
      }
      resolve({ stdout, stderr, code: code ?? -1, signal: signal || null, timedOut, cwd: targetCwd });
    });
  });
}

const INITIAL_HISTORY_COUNT = 12;
const HISTORY_CHUNK_SIZE = 24;

function normalizeAgent(agent) {
  return VALID_AGENTS.has(agent) ? agent : 'claude';
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeSessionId')) session.claudeSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexThreadId')) session.codexThreadId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexHomeDir')) session.codexHomeDir = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'codexRuntimeKey')) session.codexRuntimeKey = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'taskMode')) session.taskMode = 'local';
  if (!Object.prototype.hasOwnProperty.call(session, 'sshHostId')) session.sshHostId = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'remoteCwd')) session.remoteCwd = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) session.messages = [];
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      if (message.attachments) {
        return { ...message, attachments: normalizeMessageAttachments(message.attachments) };
      }
      return message;
    });
  }
  return session;
}

function getSessionAgent(session) {
  return normalizeAgent(session?.agent);
}

function isClaudeSession(session) {
  return getSessionAgent(session) === 'claude';
}

function getRuntimeSessionId(session) {
  if (!session) return null;
  return getSessionAgent(session) === 'codex'
    ? (session.codexThreadId || null)
    : (session.claudeSessionId || null);
}

function setRuntimeSessionId(session, runtimeId) {
  if (!session) return;
  if (getSessionAgent(session) === 'codex') {
    session.codexThreadId = runtimeId || null;
  } else {
    session.claudeSessionId = runtimeId || null;
  }
}

function clearRuntimeSessionId(session) {
  setRuntimeSessionId(session, null);
}

function loadSession(id) {
  try {
    return normalizeSession(JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')));
  } catch {
    return null;
  }
}

function findSessionByClientMessageId(clientMessageId) {
  if (!clientMessageId) return null;
  ensureSessionMetaCache();
  const sessionId = clientMessageIndex.get(clientMessageId);
  if (!sessionId) return null;
  return loadSession(sessionId);
}

// session 元信息内存缓存：避免 sendSessionList 每次都同步遍历所有 session 文件
const sessionMetaCache = new Map(); // id -> { id, title, updated, hasUnread, agent }
const clientMessageIndex = new Map(); // clientMessageId -> sessionId
const sessionClientMessageIds = new Map(); // sessionId -> Set<clientMessageId>
let sessionMetaCacheReady = false;

// Stale entries must not survive truncate/edit/delete: a clientMessageId that
// still maps to a session it was removed from would append a retried message to
// that session instead of starting a new one.
function indexSessionClientMessageIds(session) {
  if (!session?.id) return;
  const previous = sessionClientMessageIds.get(session.id);
  if (previous) {
    for (const id of previous) {
      if (clientMessageIndex.get(id) === session.id) clientMessageIndex.delete(id);
    }
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const ids = new Set();
  for (const message of messages) {
    const id = message?.clientMessageId;
    if (!id) continue;
    ids.add(id);
    clientMessageIndex.set(id, session.id);
  }
  if (ids.size > 0) sessionClientMessageIds.set(session.id, ids);
  else sessionClientMessageIds.delete(session.id);
}

function dropSessionClientMessageIds(sessionId) {
  const ids = sessionClientMessageIds.get(sessionId);
  if (!ids) return;
  for (const id of ids) {
    if (clientMessageIndex.get(id) === sessionId) clientMessageIndex.delete(id);
  }
  sessionClientMessageIds.delete(sessionId);
}

function getSessionActivityTimestamp(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const timestamp = messages[index]?.timestamp;
    if (timestamp && Number.isFinite(Date.parse(timestamp))) return timestamp;
  }
  return session?.updated || null;
}

function buildSessionMetaCacheEntry(session) {
  if (!session?.id) return null;
  return {
    id: session.id,
    title: session.title || 'Untitled',
    updated: getSessionActivityTimestamp(session),
    hasUnread: !!session.hasUnread,
    agent: getSessionAgent(session),
    claudeSessionId: session.claudeSessionId || null,
    codexThreadId: session.codexThreadId || null,
  };
}

function ensureSessionMetaCache() {
  if (sessionMetaCacheReady) return;
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        const entry = buildSessionMetaCacheEntry(s);
        if (entry) sessionMetaCache.set(entry.id, entry);
        indexSessionClientMessageIds(s);
      } catch {}
    }
  } catch {}
  sessionMetaCacheReady = true;
}

function updateSessionMetaCache(session) {
  ensureSessionMetaCache();
  const entry = buildSessionMetaCacheEntry(session);
  if (entry) sessionMetaCache.set(entry.id, entry);
  indexSessionClientMessageIds(session);
}

function removeSessionMetaCache(sessionId) {
  ensureSessionMetaCache();
  sessionMetaCache.delete(sessionId);
  dropSessionClientMessageIds(sessionId);
}

function saveSession(session) {
  normalizeSession(session);
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
  updateSessionMetaCache(session);
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const entry = Object.entries(MODEL_MAP).find(([, v]) => v === fullModel);
  return entry ? entry[0] : null;
}

function sessionModelLabel(session) {
  if (!session?.model) return null;
  return isClaudeSession(session) ? (modelShortName(session.model) || session.model) : session.model;
}

function splitHistoryMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= INITIAL_HISTORY_COUNT) {
    return { recentMessages: list, olderChunks: [] };
  }
  const recentMessages = list.slice(-INITIAL_HISTORY_COUNT);
  const older = list.slice(0, -INITIAL_HISTORY_COUNT);
  const olderChunks = [];
  for (let end = older.length; end > 0; end -= HISTORY_CHUNK_SIZE) {
    const start = Math.max(0, end - HISTORY_CHUNK_SIZE);
    olderChunks.push(older.slice(start, end));
  }
  return { recentMessages, olderChunks };
}

const IS_WIN = process.platform === 'win32';

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, force = false) {
  try {
    if (IS_WIN) {
      const args = ['/T', '/PID', String(pid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {}
}

function cleanRunDir(sessionId) {
  const dir = runDir(sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch {}
}

function sendSessionList(ws) {
  try {
    ensureSessionMetaCache();
    const sessions = [];
    for (const meta of sessionMetaCache.values()) {
      sessions.push({
        id: meta.id,
        title: meta.title,
        updated: meta.updated,
        hasUnread: meta.hasUnread,
        agent: meta.agent,
        isRunning: activeProcesses.has(meta.id),
      });
    }
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}

// === File Tailer ===
// Tails a file and calls onLine for each new complete line.
class FileTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.interval = null;
    this.stopped = false;
  }

  start() {
    this.readNew();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.stopped) this.readNew();
      });
      this.watcher.on('error', () => {});
    } catch {}
    // Backup poll every 500ms (fs.watch not always reliable on all systems)
    this.interval = setInterval(() => {
      if (!this.stopped) this.readNew();
    }, 500);
  }

  readNew() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return;
      const buf = Buffer.alloc(stat.size - this.offset);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;
      this.buffer += buf.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    } catch {}
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

// === Process Lifecycle ===

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function condenseRuntimeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const usageIndex = lines.findIndex((line) => /^Usage:/i.test(line));
  if (usageIndex >= 0) return lines.slice(0, usageIndex).join(' ');
  return lines.slice(0, 3).join(' ');
}

function formatRuntimeError(agent, raw, context = {}) {
  const condensed = condenseRuntimeError(raw);
  const exitInfo = typeof context.exitCode === 'number' ? `（退出码 ${context.exitCode}）` : '';
  if (!condensed) {
    return agent === 'codex'
      ? `Codex 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`
      : `Claude 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`;
  }

  if (agent === 'codex') {
    if (/stream disconnected before completion|stream closed before response\.completed|response\.completed/i.test(condensed)) {
      return 'Codex 上游响应流提前中断：当前自定义 API 的 Responses 流式协议没有完整发送 response.completed。请检查该 API 端点是否完整兼容 OpenAI Responses SSE，或切回确认兼容的 API 模板。';
    }
    // Must not match "unexpected status 404 Not Found" from the upstream API, which is a
    // model/endpoint problem rather than a missing binary.
    if (/ENOENT|command not found|No such file/i.test(condensed)) {
      return '找不到 Codex CLI。请检查 Codex 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `codex`。';
    }
    if (/unexpected status 404|is not supported by|unknown model|model_not_found/i.test(condensed)) {
      return `Codex 上游未接受当前模型或接口地址：${condensed}（请在 Codex 设置里核对模型名与 API Base URL）`;
    }
    if (/unexpected argument|unexpected option|Usage:\s*codex/i.test(raw || '')) {
      return `Codex CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Codex CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    // Relays report plan/balance problems under a 401, so quota must be classified before
    // auth — otherwise "add paid balance" is reported as a local CLI login failure.
    if (/rate limit|quota|billing|credits|insufficient|balance|upgrade your plan|payment required|too many requests/i.test(condensed)) {
      return `Codex 请求被额度或计费限制拦截：${condensed}`;
    }
    if (/authentication|unauthorized|invalid api key|api key|credential|not logged in/i.test(condensed)) {
      return `Codex 鉴权失败：${condensed}（请检查 Codex CLI 登录状态，若使用自定义 API 请核对模板中的密钥与地址）`;
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Codex 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/sandbox|approval|read-only|bypass-approvals/i.test(condensed)) {
      return `Codex 当前的审批或沙箱设置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `Codex 任务失败${exitInfo}：${condensed}`;
  }

  if (/ENOENT|not found|No such file/i.test(condensed)) {
    return '找不到 Claude CLI。请检查当前环境是否能直接运行 `claude`。';
  }
  if (/authentication|unauthorized|forbidden|api key|credential/i.test(condensed)) {
    return 'Claude 鉴权失败。请确认本机 Claude CLI 已完成登录，且凭据仍然有效。';
  }
  return `Claude 任务失败${exitInfo}：${condensed}`;
}

function compactStartMessage(agent) {
  return agent === 'codex'
    ? '正在执行 Codex /compact 压缩上下文，请稍候…'
    : '正在执行 Claude 原生 /compact 压缩上下文，请稍候…';
}

function compactDoneMessage(agent) {
  return agent === 'codex'
    ? '上下文压缩完成。已执行 Codex /compact，下次继续在同一会话发送即可。'
    : '上下文压缩完成。已按 Claude Code 原生策略执行 /compact，下次继续在同一会话发送即可。';
}

function initStartMessage(agent) {
  return agent === 'codex'
    ? '正在分析项目并生成 AGENTS.md ...'
    : '正在分析项目并生成 CLAUDE.md ...';
}

function buildCodexInitPrompt(cwd) {
  const targetPath = path.join(cwd || process.cwd(), 'AGENTS.md');
  return [
    'You are running cc-web\'s /init for a Codex session.',
    'Analyze the current workspace and create or update AGENTS.md at the repository root.',
    `The file path to write is: ${targetPath}`,
    'Requirements:',
    '- Actually write the file; do not stop after summarizing in chat.',
    '- If AGENTS.md already exists, update it in place instead of creating a duplicate.',
    '- Keep the document concise and practical for future coding agents working in this repo.',
    '- Include the project purpose, key entry points, dev/test commands, important workflows, and repo-specific safety constraints.',
    '- Prefer facts from the actual codebase over README claims when they differ.',
    '- After editing the file, reply with a brief summary of what you wrote.',
  ].join('\n');
}

function compactAutoStartMessage(agent) {
  return agent === 'codex'
    ? '检测到上下文达到上限，正在按 Codex /compact 自动压缩，然后继续当前任务…'
    : '检测到上下文达到上限，正在按 Claude Code 原版策略自动执行 /compact，然后继续当前任务…';
}

function compactAutoResumeMessage(agent) {
  return agent === 'codex'
    ? '检测到上一条请求因上下文过大失败，现已按 Codex 压缩计划继续执行。'
    : '检测到上一条请求因上下文过大失败，现已自动按压缩计划继续执行。';
}

function isContextLimitError(agent, raw) {
  const text = String(raw || '');
  if (!text) return false;
  if (agent === 'claude') {
    return /Request too large \(max 20MB\)/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  const completeTime = new Date().toISOString();
  const wsConnected = !!entry.ws;
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;

  const pendingRetry = pendingCompactRetries.get(sessionId) || null;
  let contextLimitExceeded = false;

  // Read stderr for error clues
  let stderrSnippet = '';
  try {
    const errPath = path.join(runDir(sessionId), 'error.log');
    if (fs.existsSync(errPath)) {
      const content = fs.readFileSync(errPath, 'utf8').trim();
      if (content) stderrSnippet = content.slice(-500);
    }
  } catch {}

  const rawCompletionError = entry.lastError || (
    ((typeof exitCode === 'number' && exitCode !== 0) || (!!signal && signal !== 'SIGTERM'))
      ? (stderrSnippet || null)
      : null
  );
  contextLimitExceeded = isContextLimitError(entry.agent || 'claude', `${entry.fullText || ''}\n${stderrSnippet || ''}\n${rawCompletionError || ''}`);
  const completionError = rawCompletionError ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, { exitCode, signal }) : null;
  if (!entry.lastError && rawCompletionError) entry.lastError = rawCompletionError;

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    usage: entry.lastUsage || null,
    error: rawCompletionError,
    stderr: stderrSnippet || null,
    requestTooLarge: contextLimitExceeded,
  });

  // Final read
  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

  const pendingSlash = pendingSlashCommands.get(sessionId) || null;
  if (pendingSlash) pendingSlashCommands.delete(sessionId);

  // Save result to session
  const session = loadSession(sessionId);
  let completedMessageTimestamp = null;
  if (session && entry.fullText) {
    completedMessageTimestamp = new Date().toISOString();
    const msg = {
      role: 'assistant',
      content: entry.fullText,
      toolCalls: entry.toolCalls || [],
      timestamp: completedMessageTimestamp,
    };
    if (entry.fullTextTruncated) msg.truncated = true;
    if (entry.toolCallsTruncated) msg.toolCallsTruncated = true;
    session.messages.push(msg);
    session.updated = completedMessageTimestamp;
    if (!entry.ws) session.hasUnread = true;
    saveSession(session);
  }

  if (pendingSlash?.kind === 'compact' && session) {
    if (entry.lastCost) {
      session.totalCost = Math.max(0, (session.totalCost || 0) - entry.lastCost);
    }
    session.updated = new Date().toISOString();
    saveSession(session);
  }

  let shouldReturnForFollowup = false;
  let shouldAutoCompact = false;

  activeProcesses.delete(sessionId);
  cleanRunDir(sessionId);
  pendingSlashCommands.delete(sessionId);

  // Notify client
  if (entry.ws) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      const autoRetryRequested = !!(retry?.text && retry?.reason === 'auto');
      if (autoRetryRequested) {
        if (contextLimitExceeded) {
          pendingCompactRetries.delete(sessionId);
          wsSend(entry.ws, { type: 'system_message', message: '已尝试执行 /compact，但仍未成功解除上下文超限。请手动缩小输入范围后重试。' });
        } else {
          wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
          wsSend(entry.ws, { type: 'system_message', message: compactAutoResumeMessage(entry.agent || 'claude') });
          shouldReturnForFollowup = true;
        }
      } else {
        wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
      }
    }

    if (contextLimitExceeded && !pendingSlash && session && getRuntimeSessionId(session)) {
      pendingCompactRetries.set(sessionId, { text: pendingRetry?.text || '', mode: pendingRetry?.mode || session.permissionMode || 'yolo', reason: 'auto' });
      wsSend(entry.ws, { type: 'system_message', message: compactAutoStartMessage(entry.agent || 'claude') });
      shouldAutoCompact = true;
    }

    if (completionError && !entry.errorSent && !shouldAutoCompact) {
      entry.errorSent = true;
      wsSend(entry.ws, { type: 'error', message: completionError });
    }

    wsSend(entry.ws, {
      type: 'done',
      sessionId,
      timestamp: completedMessageTimestamp,
      costUsd: entry.lastCost || null,
    });
    sendSessionList(entry.ws);
    // Push notification when trigger='always' (user online but still wants notification)
    (() => {
      const notifyCfg = loadNotifyConfig();
      if (!notifyCfg.provider || notifyCfg.provider === 'off') return;
      if ((notifyCfg.summary?.trigger || 'background') !== 'always') return;
      const sess = loadSession(sessionId);
      buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
        sendNotification(ntitle, content);
      });
    })();
  } else {
    // Process completed while browser was disconnected — notify all connected clients
    const sess = loadSession(sessionId);
    const title = sess?.title || 'Untitled';
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        wsSend(client, {
          type: 'background_done',
          sessionId,
          title,
          costUsd: entry.lastCost || null,
          responseLen: (entry.fullText || '').length,
        });
      }
    }
    // Push notification (background task)
    buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
      sendNotification(ntitle, content);
    });
  }

  if (!shouldReturnForFollowup && !shouldAutoCompact && !contextLimitExceeded && pendingRetry && pendingRetry.text === (entry.fullText || '').trim()) {
    pendingCompactRetries.delete(sessionId);
  }

  if (shouldReturnForFollowup && entry.ws && entry.ws.readyState === 1 && session) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      if (retry?.text) {
        pendingCompactRetries.delete(sessionId);
        handleMessage(entry.ws, { text: retry.text, sessionId, mode: retry.mode || session.permissionMode || 'yolo' });
      }
      return;
    }
  }

  if (shouldAutoCompact && entry.ws && entry.ws.readyState === 1 && session) {
    pendingSlashCommands.set(sessionId, { kind: 'compact' });
    handleMessage(entry.ws, { text: '/compact', sessionId, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
    return;
  }
}

// Global PID monitor: detect process completion (especially after server restart)
setInterval(() => {
  for (const [sessionId, entry] of activeProcesses) {
    if (entry.pid && !isProcessRunning(entry.pid)) {
      plog('INFO', 'pid_monitor_detected_exit', {
        sessionId: sessionId.slice(0, 8),
        pid: entry.pid,
        wsConnected: !!entry.ws,
      });
      handleProcessComplete(sessionId, null, 'unknown (detected by monitor)');
    }
  }
}, 2000);

cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);

// Recover processes that were running before server restart
function recoverProcesses() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('-run') && fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    if (entries.length === 0) return;
    plog('INFO', 'recovery_start', { runDirs: entries.length });
    for (const dirName of entries) {
      const sessionId = dirName.replace('-run', '');
      const dir = path.join(SESSIONS_DIR, dirName);
      const pidPath = path.join(dir, 'pid');
      const outputPath = path.join(dir, 'output.jsonl');
      const session = loadSession(sessionId);
      const agent = getSessionAgent(session);

      if (!fs.existsSync(pidPath)) {
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        continue;
      }

      const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

      if (isProcessRunning(pid)) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        plog('INFO', 'recovery_alive', { sessionId: sessionId.slice(0, 8), pid, agent });
        const entry = { pid, ws: null, agent, fullText: '', toolCalls: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
        activeProcesses.set(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(entry, event, sessionId);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', { sessionId: sessionId.slice(0, 8), pid, agent });
        if (fs.existsSync(outputPath)) {
          const tempEntry = { pid: 0, ws: null, agent, fullText: '', toolCalls: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          if (session && tempEntry.fullText) {
            session.messages.push({
              role: 'assistant',
              content: tempEntry.fullText,
              toolCalls: tempEntry.toolCalls || [],
              timestamp: new Date().toISOString(),
            });
            session.updated = new Date().toISOString();
            saveSession(session);
          }
        }
        try { fs.rmSync(dir, { recursive: true }); } catch {}
      }
    }
  } catch (err) {
    console.error('[recovery] Error:', err.message);
  }
}

// === HTTP Static File Server ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    const filename = safeFilename(rawName);
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return jsonResponse(res, 400, { ok: false, message: '仅支持 PNG/JPG/WEBP/GIF 图片' });
    }

    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ATTACHMENT_SIZE) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) {
        return jsonResponse(res, 413, { ok: false, message: '图片大小不能超过 10MB' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容为空' });
      }
      const id = crypto.randomUUID();
      const ext = extFromMime(mime) || path.extname(filename) || '';
      const dataPath = attachmentDataPath(id, ext);
      const now = new Date();
      const meta = {
        id,
        kind: 'image',
        filename,
        mime,
        size: buffer.length,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
        path: dataPath,
      };
      try {
        fs.writeFileSync(dataPath, buffer);
        saveAttachmentMeta(meta);
        return jsonResponse(res, 200, {
          ok: true,
          attachment: {
            id,
            kind: 'image',
            filename,
            mime,
            size: buffer.length,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            storageState: 'available',
          },
        });
      } catch (err) {
        try { if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath); } catch {}
        try { if (fs.existsSync(attachmentMetaPath(id))) fs.unlinkSync(attachmentMetaPath(id)); } catch {}
        return jsonResponse(res, 500, { ok: false, message: `保存附件失败: ${err.message}` });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '上传过程中断' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req) || String(url.searchParams.get('token') || '');
    if (!isTokenValid(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    const meta = id ? loadAttachmentMeta(id) : null;
    if (!meta || currentAttachmentState(meta) !== 'available') {
      return jsonResponse(res, 404, { ok: false, message: '附件不存在或已过期' });
    }
    let buffer;
    try {
      buffer = fs.readFileSync(meta.path);
    } catch {
      return jsonResponse(res, 404, { ok: false, message: '附件读取失败' });
    }
    const disposition = url.searchParams.get('download') ? 'attachment' : 'inline';
    res.writeHead(200, {
      'Content-Type': meta.mime || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.filename || 'image')}`,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(buffer);
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    if (!id) {
      return jsonResponse(res, 400, { ok: false, message: '缺少附件 ID' });
    }
    removeAttachmentById(id);
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/list') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    try {
      const dirPath = resolveFsPath(url.searchParams.get('path') || '');
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) return jsonResponse(res, 400, { ok: false, message: '目标不是目录' });
      const dirents = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
        const aDir = a.isDirectory();
        const bDir = b.isDirectory();
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const total = dirents.length;
      // stat() costs one syscall per entry, so only pay for the slice we return.
      const entries = dirents.slice(0, MAX_FS_LIST_ENTRIES).map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        let size = 0;
        let mtime = null;
        try {
          const s = fs.statSync(fullPath);
          size = s.isFile() ? s.size : 0;
          mtime = s.mtime.toISOString();
        } catch {}
        return {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
        };
      });
      const parentPath = path.dirname(dirPath);
      return jsonResponse(res, 200, {
        ok: true,
        cwd: dirPath,
        parent: parentPath !== dirPath ? parentPath : null,
        entries,
        total,
        truncated: total > entries.length,
      });
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: `读取目录失败: ${err.message}` });
    }
  }

  // 聊天正文里出现的文件名（"成品文件：output.jpg"）需要判断是否真有这个文件，
  // 才能决定要不要渲染成预览/下载链接。只按名字在指定目录下查，不接受路径分隔符，
  // 免得变成任意目录的探测接口。
  if (req.method === 'GET' && url.pathname === '/api/fs/probe') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    try {
      const baseDir = resolveFsPath(url.searchParams.get('base') || '');
      const names = url.searchParams.getAll('name').slice(0, MAX_FS_PROBE_NAMES);
      const files = [];
      for (const raw of names) {
        const name = String(raw || '').trim();
        if (!name || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) continue;
        const fullPath = path.join(baseDir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;
          const mime = MIME_TYPES[path.extname(fullPath).toLowerCase()] || '';
          files.push({ name, path: fullPath, size: stat.size, previewable: INLINE_SAFE_MIME_TYPES.has(mime) });
        } catch {}
      }
      return jsonResponse(res, 200, { ok: true, base: baseDir, files });
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: `探测文件失败: ${err.message}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/read') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    try {
      const filePath = resolveFsPath(url.searchParams.get('path') || '');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return jsonResponse(res, 400, { ok: false, message: '目标不是文件' });
      if (stat.size > 1024 * 1024) return jsonResponse(res, 413, { ok: false, message: '文件超过 1MB，暂不支持在线编辑' });
      const buffer = fs.readFileSync(filePath);
      // utf8 解码二进制会产生替换字符，一旦编辑器再按 utf8 存回就把原文件毁了，
      // 所以宁可拒绝打开。NUL 字节是判定二进制最省事且够可靠的信号。
      if (buffer.includes(0)) {
        return jsonResponse(res, 415, { ok: false, message: '这是二进制文件，无法在线编辑（编辑保存会损坏文件），请改用下载。' });
      }
      const content = buffer.toString('utf8');
      return jsonResponse(res, 200, { ok: true, path: filePath, content, size: stat.size });
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: `读取文件失败: ${err.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/write') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const filePath = resolveFsPath(body.path || '');
        const content = typeof body.content === 'string' ? body.content : '';
        fs.writeFileSync(filePath, content, 'utf8');
        return jsonResponse(res, 200, { ok: true, path: filePath, size: Buffer.byteLength(content, 'utf8') });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `保存文件失败: ${err.message}` });
      }
    }).catch((err) => {
      return jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/download') {
    // 图片预览要经由 <img src>，那里带不了 Authorization 头，所以同时接受 query token
    // （与 /api/attachments 的取法一致）。
    const token = extractBearerToken(req) || String(url.searchParams.get('token') || '');
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    try {
      const filePath = resolveFsPath(url.searchParams.get('path') || '');
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return jsonResponse(res, 400, { ok: false, message: '目标不是文件' });
      const filename = path.basename(filePath);
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || '';
      // inline 会让内容在本应用的 origin 下被渲染，所以只对确定不含脚本的位图开放；
      // 其余一切（含 SVG、HTML）仍按附件下发。
      const inline = url.searchParams.get('inline') === '1' && INLINE_SAFE_MIME_TYPES.has(mime);
      res.writeHead(200, {
        'Content-Type': inline ? mime : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: `下载文件失败: ${err.message}` });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/mkdir') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const baseDir = resolveFsPath(body.basePath || '');
        const name = String(body.name || '').trim();
        if (!name || name.includes('/') || name.includes('\\')) return jsonResponse(res, 400, { ok: false, message: '目录名非法' });
        const target = path.join(baseDir, name);
        fs.mkdirSync(target, { recursive: false });
        return jsonResponse(res, 200, { ok: true, path: target });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `新建目录失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/create') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const baseDir = resolveFsPath(body.basePath || '');
        const name = String(body.name || '').trim();
        const content = typeof body.content === 'string' ? body.content : '';
        if (!name || name.includes('/') || name.includes('\\')) return jsonResponse(res, 400, { ok: false, message: '文件名非法' });
        const target = path.join(baseDir, name);
        fs.writeFileSync(target, content, { flag: 'wx', encoding: 'utf8' });
        return jsonResponse(res, 200, { ok: true, path: target });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `新建文件失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/rename') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const sourcePath = resolveFsPath(body.path || '');
        const newName = String(body.newName || '').trim();
        if (!newName || newName.includes('/') || newName.includes('\\')) return jsonResponse(res, 400, { ok: false, message: '新名称非法' });
        const targetPath = path.join(path.dirname(sourcePath), newName);
        fs.renameSync(sourcePath, targetPath);
        return jsonResponse(res, 200, { ok: true, path: targetPath });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `重命名失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/delete') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const targetPath = resolveFsPath(body.path || '');
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) fs.rmSync(targetPath, { recursive: true, force: false });
        else fs.unlinkSync(targetPath);
        return jsonResponse(res, 200, { ok: true });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `删除失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/exec/history') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    return jsonResponse(res, 200, { ok: true, history: loadCommandHistoryFromDisk() });
  }

  if (req.method === 'POST' && url.pathname === '/api/exec/history') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then((body) => {
      try {
        const history = saveCommandHistoryToDisk(body?.history || []);
        return jsonResponse(res, 200, { ok: true, history });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, message: `保存历史命令失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/exec/current') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    const running = activeExecByToken.get(token);
    if (!running?.child) {
      return jsonResponse(res, 200, { ok: true, running: false });
    }
    return jsonResponse(res, 200, {
      ok: true,
      running: true,
      execId: running.execId || '',
      command: running.command || '',
      cwd: running.cwd || '',
      stdout: running.stdout || '',
      stderr: running.stderr || '',
      startedAt: running.startedAt || '',
      stopInProgress: !!running.stopping,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/exec/stop') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    const running = activeExecByToken.get(token);
    if (!running?.child) return jsonResponse(res, 200, { ok: true, stopped: false, message: '当前没有正在执行的命令' });
    try {
      running.stopping = true;
      wsSendByToken(token, {
        type: 'exec_stream',
        event: 'stop_requested',
        execId: running.execId || '',
        command: running.command || '',
      });
      running.child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!running.child.killed) running.child.kill('SIGKILL');
        } catch {}
      }, 1200);
      return jsonResponse(res, 200, { ok: true, stopped: true, message: '已发送停止信号' });
    } catch (err) {
      return jsonResponse(res, 400, { ok: false, message: `停止命令失败: ${err.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/exec/run') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    readJsonBody(req).then(async (body) => {
      const execState = {
        child: null,
        command: '',
        cwd: '',
        stdout: '',
        stderr: '',
        startedAt: new Date().toISOString(),
        stopping: false,
        execId: crypto.randomUUID(),
      };
      try {
        const command = String(body.command || '').trim();
        const cwd = String(body.cwd || '').trim();
        const timeoutMs = Math.min(1800000, Math.max(1000, Number(body.timeoutMs) || 600000));
        if (!command) return jsonResponse(res, 400, { ok: false, message: '命令不能为空' });
        const current = activeExecByToken.get(token);
        if (current?.child) {
          return jsonResponse(res, 409, { ok: false, message: '已有命令正在执行，请先停止后再执行新命令' });
        }
        execState.command = command;
        const result = await runShellCommand(command, cwd, timeoutMs, {
          onSpawn: (child, targetCwd) => {
            execState.child = child;
            execState.cwd = targetCwd;
            activeExecByToken.set(token, execState);
            wsSendByToken(token, {
              type: 'exec_stream',
              event: 'start',
              execId: execState.execId,
              command,
              cwd: targetCwd,
              startedAt: execState.startedAt,
            });
          },
          onStdout: (text) => {
            execState.stdout = appendCappedOutput(execState.stdout, text);
            wsSendByToken(token, {
              type: 'exec_stream',
              event: 'stdout',
              execId: execState.execId,
              text,
            }, true);
          },
          onStderr: (text) => {
            execState.stderr = appendCappedOutput(execState.stderr, text);
            wsSendByToken(token, {
              type: 'exec_stream',
              event: 'stderr',
              execId: execState.execId,
              text,
            }, true);
          },
          onDone: () => {
            const active = activeExecByToken.get(token);
            if (active === execState) activeExecByToken.delete(token);
          },
        });
        wsSendByToken(token, {
          type: 'exec_stream',
          event: 'end',
          execId: execState.execId,
          command,
          cwd: result.cwd,
          code: result.code,
          signal: result.signal,
          timedOut: !!result.timedOut,
          stopping: !!execState.stopping,
          finishedAt: new Date().toISOString(),
        });
        return jsonResponse(res, 200, { ok: true, execId: execState.execId, ...result });
      } catch (err) {
        activeExecByToken.delete(token);
        wsSendByToken(token, {
          type: 'exec_stream',
          event: 'error',
          execId: execState.execId,
          command: execState.command || '',
          cwd: execState.cwd || '',
          message: err.message || '执行失败',
        });
        return jsonResponse(res, 400, { ok: false, message: `执行失败: ${err.message}` });
      }
    }).catch((err) => jsonResponse(res, 400, { ok: false, message: err.message || '请求无效' }));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  filePath = path.resolve(filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    const relativeStaticPath = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
    const cacheControl = relativeStaticPath.startsWith('vendor/')
      ? 'public, max-age=31536000, immutable'
      : (ext === '.html' || relativeStaticPath === 'app.js' || relativeStaticPath === 'style.css')
        ? 'no-cache'
        : 'public, max-age=86400';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(data);
  });
});

// === WebSocket Server ===
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const clientIP = normalizeClientIP(forwarded ? forwarded.split(',')[0].trim()
    : req.socket?.remoteAddress || null);

  // Check if IP is banned
  if (clientIP && isBanned(clientIP)) {
    plog('WARN', 'banned_ip_rejected', { ip: clientIP });
    wsSend(ws, { type: 'auth_result', success: false, banned: true, banInfo: getBanInfo(clientIP) });
    ws.close();
    return;
  }

  let authenticated = false;
  let authToken = null;
  const wsId = crypto.randomBytes(4).toString('hex'); // short id for log correlation
  const wsConnectTime = new Date().toISOString();
  plog('INFO', 'ws_connect', { wsId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return wsSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      reloadAuthConfig();
      loadBannedIPs();
      // Check ban before processing auth
      if (clientIP && isBanned(clientIP)) {
        wsSend(ws, { type: 'auth_result', success: false, banned: true, banInfo: getBanInfo(clientIP) });
        ws.close();
        return;
      }
      const tokenValid = isTokenValid(msg.token);
      if (msg.password === PASSWORD || tokenValid) {
        if (authToken && authToken !== msg.token) unregisterWsToken(authToken, ws);
        authToken = tokenValid ? msg.token : crypto.randomBytes(32).toString('hex');
        rememberAuthToken(authToken);
        authenticated = true;
        registerWsToken(authToken, ws);
        wsSend(ws, {
          type: 'auth_result',
          success: true,
          token: authToken,
          mustChangePassword: !!authConfig.mustChange,
          isRootOrSudo: IS_ROOT_OR_SUDO,
        });
        // 客户端在 auth 时如果带了上次查看的 session，直接顺手把 session_info 推过去，
        // 省一次 load_session 的 RTT（移动端最受益）。
        let sentPreferredSession = false;
        if (typeof msg.preferSessionId === 'string' && msg.preferSessionId) {
          try {
            handleLoadSession(ws, msg.preferSessionId);
            sentPreferredSession = true;
          } catch {}
        }
        if (sentPreferredSession) {
          setImmediate(() => sendSessionList(ws));
        } else {
          sendSessionList(ws);
        }
      } else {
        const triedPassword = typeof msg.password === 'string' && msg.password.length > 0;
        const justBanned = triedPassword ? recordAuthFailure(clientIP) : false;
        wsSend(ws, {
          type: 'auth_result',
          success: false,
          banned: isBanned(clientIP),
          banInfo: getBanInfo(clientIP),
          remainingAttempts: triedPassword
            ? (justBanned ? 0 : Math.max(0, AUTH_FAIL_MAX - ((authFailures.get(clientIP) || []).length)))
            : AUTH_FAIL_MAX,
          tokenExpired: !tokenValid && !triedPassword,
        });
        if (justBanned) ws.close();
      }
      return;
    }

    if (!authenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
          handleSlashCommand(ws, msg.text.trim(), msg.sessionId, msg.agent);
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'approval_response':
        codexAppServer.resolveApproval(msg.sessionId, msg.approvalId, msg.decision);
        break;
      case 'new_session':
        handleNewSession(ws, msg);
        break;
      case 'load_session':
        handleLoadSession(ws, msg.sessionId);
        break;
      case 'delete_session':
        handleDeleteSession(ws, msg.sessionId);
        break;
      case 'truncate_session':
        handleTruncateSession(ws, msg).catch((err) => {
          plog('ERROR', 'session_truncate_fail', {
            sessionId: String(msg.sessionId || '').slice(0, 8),
            error: err.message,
          });
          wsSend(ws, { type: 'error', message: `清除失败：${err.message}` });
        });
        break;
      case 'edit_message':
        handleEditMessage(ws, msg);
        break;
      case 'rename_session':
        handleRenameSession(ws, msg.sessionId, msg.title);
        break;
      case 'set_mode':
        handleSetMode(ws, msg.sessionId, msg.mode);
        break;
      case 'list_sessions':
        sendSessionList(ws);
        break;
      case 'detach_view':
        handleDetachView(ws);
        break;
      case 'get_notify_config':
        wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
        break;
      case 'save_notify_config':
        handleSaveNotifyConfig(ws, msg.config);
        break;
      case 'test_notify':
        handleTestNotify(ws);
        break;
      case 'change_password':
        {
          const newToken = handleChangePassword(ws, msg, authToken);
          if (newToken) {
            unregisterWsToken(authToken, ws);
            authToken = newToken;
            registerWsToken(authToken, ws);
          }
        }
        break;
      case 'get_security_status':
        handleGetSecurityStatus(ws, clientIP);
        break;
      case 'unban_ip':
        handleUnbanIP(ws, msg.ip, clientIP);
        break;
      case 'clear_banned_ips':
        handleClearBannedIPs(ws, clientIP);
        break;
      case 'get_model_config':
        wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
        break;
      case 'save_model_config':
        handleSaveModelConfig(ws, msg.config);
        break;
      case 'get_codex_config':
        wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
        break;
      case 'save_codex_config':
        handleSaveCodexConfig(ws, msg.config);
        break;
      case 'fetch_models':
        handleFetchModels(ws, msg);
        break;
      case 'check_update':
        handleCheckUpdate(ws);
        break;
      case 'read_claude_local_config':
        handleReadClaudeLocalConfig(ws);
        break;
      case 'read_codex_local_config':
        handleReadCodexLocalConfig(ws);
        break;
      case 'save_local_snapshot':
        handleSaveLocalSnapshot(ws, msg);
        break;
      case 'save_codex_local_snapshot':
        handleSaveCodexLocalSnapshot(ws, msg);
        break;
      case 'write_claude_local_config':
        handleWriteClaudeLocalConfig(ws, msg);
        break;
      case 'write_codex_local_config':
        handleWriteCodexLocalConfig(ws, msg);
        break;
      case 'restore_claude_local_snapshot':
        handleRestoreClaudeLocalSnapshot(ws);
        break;
      case 'get_dev_config':
        wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
        break;
      case 'save_dev_config':
        handleSaveDevConfig(ws, msg);
        break;
      case 'list_native_sessions':
        handleListNativeSessions(ws);
        break;
      case 'import_native_session':
        handleImportNativeSession(ws, msg);
        break;
      case 'list_codex_sessions':
        handleListCodexSessions(ws);
        break;
      case 'import_codex_session':
        handleImportCodexSession(ws, msg);
        break;
      case 'list_cwd_suggestions':
        handleListCwdSuggestions(ws);
        break;
      default:
        wsSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => handleDisconnect(ws, wsId, authToken));
  ws.on('error', (err) => {
    plog('WARN', 'ws_error', { wsId, error: err.message });
    handleDisconnect(ws, wsId, authToken);
  });
});

// === Notify Config Handlers ===
function handleSaveNotifyConfig(ws, newConfig) {
  if (!newConfig || !newConfig.provider) {
    return wsSend(ws, { type: 'error', message: '无效的通知配置' });
  }
  const current = loadNotifyConfig();
  // Merge: only update fields that are not masked (contain ****)
  const merged = { provider: newConfig.provider };
  // pushplus
  merged.pushplus = { token: (newConfig.pushplus?.token && !newConfig.pushplus.token.includes('****')) ? newConfig.pushplus.token : current.pushplus?.token || '' };
  // telegram
  merged.telegram = {
    botToken: (newConfig.telegram?.botToken && !newConfig.telegram.botToken.includes('****')) ? newConfig.telegram.botToken : current.telegram?.botToken || '',
    chatId: newConfig.telegram?.chatId !== undefined ? newConfig.telegram.chatId : current.telegram?.chatId || '',
  };
  // serverchan
  merged.serverchan = { sendKey: (newConfig.serverchan?.sendKey && !newConfig.serverchan.sendKey.includes('****')) ? newConfig.serverchan.sendKey : current.serverchan?.sendKey || '' };
  // feishu
  merged.feishu = { webhook: (newConfig.feishu?.webhook && !newConfig.feishu.webhook.includes('****')) ? newConfig.feishu.webhook : current.feishu?.webhook || '' };
  // qqbot
  merged.qqbot = { qmsgKey: (newConfig.qqbot?.qmsgKey && !newConfig.qqbot.qmsgKey.includes('****')) ? newConfig.qqbot.qmsgKey : current.qqbot?.qmsgKey || '' };
  // summary
  const ns = newConfig.summary || {};
  const cs = current.summary || {};
  merged.summary = {
    enabled: !!ns.enabled,
    trigger: ['background', 'always'].includes(ns.trigger) ? ns.trigger : (cs.trigger || 'background'),
    apiSource: ['claude', 'codex', 'custom'].includes(ns.apiSource) ? ns.apiSource : (cs.apiSource || 'claude'),
    apiBase: ns.apiBase !== undefined ? ns.apiBase : (cs.apiBase || ''),
    apiKey: (ns.apiKey && !ns.apiKey.includes('****')) ? ns.apiKey : (cs.apiKey || ''),
    model: ns.model !== undefined ? ns.model : (cs.model || ''),
  };

  saveNotifyConfig(merged);
  plog('INFO', 'notify_config_saved', { provider: merged.provider });
  wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '通知配置已保存' });
}

function handleTestNotify(ws) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') {
    return wsSend(ws, { type: 'notify_test_result', success: false, message: '通知已关闭，无法测试' });
  }
  sendNotification('CC-Web 测试通知', '这是一条测试消息，如果你收到了说明通知配置正确！').then((result) => {
    wsSend(ws, { type: 'notify_test_result', success: result.ok, message: result.ok ? '测试消息已发送，请检查是否收到' : `发送失败: ${result.error || result.body || '未知错误'}` });
  });
}

function handleChangePassword(ws, msg, currentToken) {
  const { currentPassword, newPassword } = msg;

  reloadAuthConfig();

  // Validate current password
  if (currentPassword !== PASSWORD) {
    return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // Save new password
  authConfig = { password: newPassword, mustChange: false };
  saveAuthConfig(authConfig);
  PASSWORD = newPassword;
  plog('INFO', 'password_changed', {});

  // Clear all tokens (force all sessions to re-login)
  clearAuthTokens();
  activeWsByToken.clear();

  // Generate new token for current connection
  const newToken = crypto.randomBytes(32).toString('hex');
  rememberAuthToken(newToken);

  wsSend(ws, { type: 'password_changed', success: true, token: newToken, message: '密码修改成功' });
  return newToken;
}

function handleGetSecurityStatus(ws, clientIP) {
  wsSend(ws, {
    type: 'security_status',
    currentIp: normalizeClientIP(clientIP),
    banDurationMs: BAN_DURATION,
    failWindowMs: AUTH_FAIL_WINDOW,
    failMax: AUTH_FAIL_MAX,
    whitelist: Array.from(EXTRA_WHITELIST_IPS).sort(),
    bannedIPs: listBannedIPs(),
    currentBan: getBanInfo(clientIP),
  });
}

function handleUnbanIP(ws, ip, clientIP) {
  const normalized = normalizeClientIP(ip);
  if (!normalized) {
    return wsSend(ws, { type: 'security_action_result', success: false, message: 'IP 不能为空' });
  }
  const removed = unbanIP(normalized);
  wsSend(ws, {
    type: 'security_action_result',
    success: removed,
    message: removed ? `已解封 ${normalized}` : `${normalized} 不在封禁列表中`,
  });
  handleGetSecurityStatus(ws, clientIP);
}

function handleClearBannedIPs(ws, clientIP) {
  const count = clearAllBannedIPs();
  wsSend(ws, {
    type: 'security_action_result',
    success: true,
    message: count ? `已清空 ${count} 条封禁记录` : '当前没有封禁记录',
  });
  handleGetSecurityStatus(ws, clientIP);
}

// === Model Config Handler ===
function handleSaveModelConfig(ws, newConfig) {
  if (!newConfig || !['local', 'custom'].includes(newConfig.mode)) {
    return wsSend(ws, { type: 'error', message: '无效的模型配置' });
  }
  const current = loadModelConfig();
  const merged = {
    mode: newConfig.mode,
    activeTemplate: newConfig.activeTemplate || '',
    templates: [],
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };

  // Merge templates: keep existing secrets if masked
  const newTemplates = Array.isArray(newConfig.templates) ? newConfig.templates : [];
  const oldTemplates = Array.isArray(current.templates) ? current.templates : [];
  for (const nt of newTemplates) {
    if (!nt.name || !nt.name.trim()) continue;
    const old = oldTemplates.find(t => t.name === nt.name);
    const proxy = validateProxyConfig(nt);
    if (proxy.error) {
      return wsSend(ws, { type: 'error', message: `Claude 模板「${nt.name.trim()}」：${proxy.error}` });
    }
    merged.templates.push({
      name: nt.name.trim(),
      apiKey: (nt.apiKey && !nt.apiKey.includes('****')) ? nt.apiKey : (old?.apiKey || ''),
      apiBase: nt.apiBase || '',
      useProxy: proxy.useProxy,
      proxyUrl: proxy.proxyUrl,
      defaultModel: nt.defaultModel || '',
      opusModel: nt.opusModel || '',
      sonnetModel: nt.sonnetModel || '',
      haikuModel: nt.haikuModel || '',
    });
  }

  saveModelConfig(merged);

  // Re-apply at runtime (mutate in-place to preserve agent-runtime closure reference)
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  // custom mode: write to ~/.claude/settings.json immediately on save
  if (merged.mode === 'custom' && merged.activeTemplate) {
    const tpl = merged.templates.find(t => t.name === merged.activeTemplate);
    if (tpl) applyCustomTemplateToSettings(tpl);
  }

  // Remap ALL Claude sessions' model to current runtime MODEL_MAP values.
  // Build reverse map from BOTH pre-save and post-save template model names:
  // - current.templates: identifies sessions created under old model names (including edited/renamed)
  // - merged.templates: keeps post-save model names in the lookup as well
  // Include both raw and [1m]-suffixed keys: applyModelConfig() appends [1m] to
  // opus/sonnet when storing into session.model, so we need both forms to match.
  const modelToTier = new Map();
  const lookupTemplates = [
    ...(Array.isArray(current.templates) ? current.templates : []),
    ...(Array.isArray(merged.templates) ? merged.templates : []),
  ];
  for (const tpl of lookupTemplates) {
    if (tpl.opusModel) {
      modelToTier.set(tpl.opusModel, 'opus');
      if (!tpl.opusModel.endsWith('[1m]')) modelToTier.set(tpl.opusModel + '[1m]', 'opus');
    }
    if (tpl.sonnetModel) {
      modelToTier.set(tpl.sonnetModel, 'sonnet');
      if (!tpl.sonnetModel.endsWith('[1m]')) modelToTier.set(tpl.sonnetModel + '[1m]', 'sonnet');
    }
    if (tpl.haikuModel) modelToTier.set(tpl.haikuModel, 'haiku');
  }
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      try {
        const session = loadSession(sessionId);
        if (!session?.model || session.agent === 'codex') continue;
        const tier = modelToTier.get(session.model);
        if (tier && MODEL_MAP[tier] !== session.model) {
          session.model = MODEL_MAP[tier];
          saveSession(session);
        }
      } catch {}
    }
  } catch {}

  plog('INFO', 'model_config_saved', { mode: merged.mode, activeTemplate: merged.activeTemplate });
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '模型配置已保存' });
}

function handleSaveCodexConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Codex 配置' });
  }
  const current = loadCodexConfig();
  const newProfiles = Array.isArray(newConfig.profiles) ? newConfig.profiles : [];
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const profile of newProfiles) {
    const name = String(profile?.name || '').trim();
    if (!name) continue;
    const old = oldProfiles.find((item) => item.name === name);
    const rawApiKey = String(profile?.apiKey || '');
    const rawModel = String(profile?.model || '').trim();
    const mergedModel = rawModel || String(old?.model || '').trim();
    const incomingModels = Array.isArray(profile?.models) ? profile.models : null;
    const mergedModelsSource = incomingModels && incomingModels.length > 0 ? incomingModels : old?.models;
    const proxy = validateProxyConfig(profile);
    if (proxy.error) {
      return wsSend(ws, { type: 'error', message: `Codex Profile「${name}」：${proxy.error}` });
    }
    mergedProfiles.push({
      name,
      apiKey: rawApiKey && !rawApiKey.includes('****') ? rawApiKey : (old?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
      useProxy: proxy.useProxy,
      proxyUrl: proxy.proxyUrl,
      model: mergedModel,
      models: normalizeCodexModelList(
        mergedModelsSource,
        mergedModel,
      ),
    });
  }
  const requestedSearch = !!newConfig.enableSearch;
  const merged = {
    mode: newConfig.mode === 'custom' ? 'custom' : 'local',
    activeProfile: String(newConfig.activeProfile || '').trim(),
    profiles: mergedProfiles,
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: requestedSearch,
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  saveCodexConfig(merged);
  const nextDefaultModel = resolveDefaultCodexModel();
  if (nextDefaultModel) {
    try {
      for (const file of fs.readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.slice(0, -5);
        try {
          const session = loadSession(sessionId);
          if (!session || getSessionAgent(session) !== 'codex') continue;
          if (session.model === nextDefaultModel) continue;
          session.model = nextDefaultModel;
          saveSession(session);
        } catch {}
      }
    } catch {}
  }
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
    defaultModel: nextDefaultModel || null,
    enableSearchRequested: requestedSearch,
    enableSearchEffective: false,
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: requestedSearch
      ? 'Codex 配置已保存。当前 cc-web 的 Codex exec 路径暂未接入 Web Search，已自动忽略该开关。'
      : 'Codex 配置已保存',
  });
}

// === Local Config Snapshot Handlers ===
function handleReadClaudeLocalConfig(ws) {
  let settings = {};
  let sourceFound = false;
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      sourceFound = true;
    }
  } catch {}
  const env = settings.env || {};
  const config = {
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    apiBase: env.ANTHROPIC_BASE_URL || '',
    useProxy: !!(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy),
    proxyUrl: env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy || '',
    defaultModel: env.ANTHROPIC_MODEL || '',
    opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
  };
  wsSend(ws, { type: 'claude_local_config', config, sourceFound });
}

function handleReadCodexLocalConfig(ws) {
  const { config, sourceFound, hasApiKey } = readCodexLocalConfigSnapshot();
  const result = { type: 'codex_local_config', config, sourceFound, hasApiKey };
  if (!hasApiKey) result.warning = '本机使用登录态认证，未检测到 API Key';
  wsSend(ws, result);
}

function handleSaveLocalSnapshot(ws, msg) {
  const config = loadModelConfig();
  config.localSnapshot = msg.snapshot || {};
  saveModelConfig(config);
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '本地配置快照已保存' });
}

function handleSaveCodexLocalSnapshot(ws, msg) {
  const current = loadCodexConfig();
  saveCodexConfig({
    ...current,
    localSnapshot: msg.snapshot || {},
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, { type: 'system_message', message: 'Codex 本地配置快照已保存' });
}

function handleWriteClaudeLocalConfig(ws, msg) {
  const snapshot = msg.snapshot || {};
  try {
    const config = loadModelConfig();
    config.localSnapshot = snapshot;
    config.mode = 'local';
    config.activeTemplate = '';
    saveModelConfig(config);
    applyCustomTemplateToSettings(snapshot);
    applyModelConfig();
    wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
    wsSend(ws, { type: 'claude_local_config_written', ok: true });
    wsSend(ws, { type: 'system_message', message: '已覆盖 ~/.claude/settings.json，新启动的 Claude 会话将使用新配置' });
  } catch (error) {
    wsSend(ws, { type: 'claude_local_config_written', ok: false, error: error.message });
    wsSend(ws, { type: 'error', message: `覆盖 Claude 本地配置失败：${error.message}` });
  }
}

function handleWriteCodexLocalConfig(ws, msg) {
  const snapshot = msg.snapshot || {};
  try {
    const current = loadCodexConfig();
    saveCodexConfig({
      ...current,
      mode: 'local',
      activeProfile: '',
      localSnapshot: snapshot,
    });
    writeCodexLocalConfig(snapshot);
    wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
    wsSend(ws, { type: 'codex_local_config_written', ok: true });
    wsSend(ws, { type: 'system_message', message: '已覆盖 ~/.codex/config.toml 与 auth.json，新启动的 Codex 会话将使用新配置' });
  } catch (error) {
    wsSend(ws, { type: 'codex_local_config_written', ok: false, error: error.message });
    wsSend(ws, { type: 'error', message: `覆盖 Codex 本地配置失败：${error.message}` });
  }
}

function handleRestoreClaudeLocalSnapshot(ws) {
  const config = loadModelConfig();
  const snapshot = config.localSnapshot;
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return wsSend(ws, { type: 'error', message: '没有已保存的本地配置快照' });
  }
  applyCustomTemplateToSettings(snapshot);
  // Switch to local mode after restore
  config.mode = 'local';
  config.activeTemplate = '';
  saveModelConfig(config);
  // Reset MODEL_MAP to local defaults
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '已恢复本地配置快照到 ~/.claude/settings.json' });
}

// === Fetch Upstream Models ===
function handleFetchModels(ws, msg) {
  const { apiBase, apiKey, modelsEndpoint } = msg;
  if (!apiBase || !apiKey) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '需要填写 API Base 和 API Key' });
  }
  // Build URL: apiBase + modelsEndpoint (default /v1/models)
  let base = apiBase.replace(/\/+$/, '');
  const endpoint = modelsEndpoint || '/v1/models';
  const fullUrl = base + endpoint;

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '无效的 URL: ' + fullUrl });
  }

  const proxy = validateProxyConfig(msg);
  if (proxy.error) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: proxy.error });
  }

  // Resolve real apiKey (if masked, look up saved config by template name or apiBase)
  let realKey = apiKey;
  if (apiKey.includes('****')) {
    const modelConfig = loadModelConfig();
    const codexConfig = loadCodexConfig();
    const savedTemplates = modelConfig.templates || [];
    const savedProfiles = codexConfig.profiles || [];
    const tpl = (msg.templateName && savedTemplates.find((t) => t.name === msg.templateName))
      || savedTemplates.find((t) => t.apiBase && t.apiBase.replace(/\/+$/, '') === base)
      || null;
    const profile = (msg.profileName && savedProfiles.find((p) => p.name === msg.profileName))
      || savedProfiles.find((p) => p.apiBase && p.apiBase.replace(/\/+$/, '') === base)
      || null;
    if (tpl?.apiKey && !tpl.apiKey.includes('****')) realKey = tpl.apiKey;
    else if (profile?.apiKey && !profile.apiKey.includes('****')) realKey = profile.apiKey;
    else return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
  }

  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const proxyAgent = createProxyAgent(proxy);
  const reqOptions = {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${realKey}` },
    timeout: 15000,
    agent: proxyAgent || undefined,
  };

  const req = mod.request(parsed, reqOptions, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      }
      try {
        const json = JSON.parse(body);
        const models = (json.data || json.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean).sort();
        wsSend(ws, { type: 'fetch_models_result', success: true, models });
      } catch (e) {
        wsSend(ws, { type: 'fetch_models_result', success: false, message: '解析响应失败: ' + e.message });
      }
    });
  });

  req.on('error', (e) => {
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求超时 (15s)' });
  });
  req.on('close', () => proxyAgent?.destroy());
  req.end();
}

// === Slash Command Handler ===
function handleSlashCommand(ws, text, sessionId, fallbackAgent) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);

  switch (cmd) {
    case '/clear': {
      if (session) {
        if (activeProcesses.has(sessionId)) {
          const entry = activeProcesses.get(sessionId);
          killProcess(entry.pid);
          if (entry.tailer) entry.tailer.stop();
          activeProcesses.delete(sessionId);
          cleanRunDir(sessionId);
        }
        session.messages = [];
        clearRuntimeSessionId(session);
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, {
          type: 'session_info',
          sessionId: session.id,
          messages: [],
          title: session.title,
          mode: session.permissionMode || 'yolo',
          model: sessionModelLabel(session),
          agent: getSessionAgent(session),
          cwd: session.cwd || null,
          totalCost: session.totalCost || 0,
          totalUsage: session.totalUsage || null,
          taskMode: session.taskMode || 'local',
          sshHostId: session.sshHostId || '',
          remoteCwd: session.remoteCwd || '',
        });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/model': {
      const modelInput = parts[1];
      if (agent === 'codex') {
        if (!modelInput) {
          const current = session?.model || resolveDefaultCodexModel() || '配置默认模型';
          wsSend(ws, { type: 'system_message', message: `当前 Codex 模型: ${current}\n用法: /model <模型名>` });
        } else {
          if (session) {
            session.model = modelInput;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelInput });
          wsSend(ws, { type: 'system_message', message: `Codex 模型已切换为: ${modelInput}` });
        }
      } else if (!modelInput) {
        const current = session?.model ? modelShortName(session.model) || session.model : 'opus (默认)';
        wsSend(ws, { type: 'system_message', message: `当前模型: ${current}\n可选: opus, sonnet, haiku` });
      } else {
        const modelKey = modelInput.toLowerCase();
        if (!MODEL_MAP[modelKey]) {
          wsSend(ws, { type: 'system_message', message: `无效模型: ${modelInput}\n可选: opus, sonnet, haiku` });
        } else {
          const model = MODEL_MAP[modelKey];
          if (session) {
            session.model = model;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelKey });
          wsSend(ws, { type: 'system_message', message: `模型已切换为: ${modelKey}` });
        }
      }
      break;
    }

    case '/cost': {
      if (agent === 'codex') {
        const usage = session?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        wsSend(ws, {
          type: 'system_message',
          message: `当前会话累计 Token: 输入 ${usage.inputTokens}，缓存 ${usage.cachedInputTokens}，输出 ${usage.outputTokens}`,
        });
      } else {
        const cost = session?.totalCost || 0;
        wsSend(ws, { type: 'system_message', message: `当前会话累计费用: $${cost.toFixed(4)}` });
      }
      break;
    }

    case '/compact': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '当前没有可压缩的会话。请先进入一个已进行过对话的会话后再执行 /compact。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止，再执行 /compact。' });
        break;
      }
      const runtimeId = getRuntimeSessionId(session);
      if (!runtimeId) {
        wsSend(ws, {
          type: 'system_message',
          message: agent === 'codex'
            ? '当前会话尚未建立 Codex 上下文，暂时无需压缩。'
            : '当前会话尚未建立 Claude 上下文，暂时无需压缩。',
        });
        break;
      }

      wsSend(ws, { type: 'system_message', message: compactStartMessage(agent) });
      pendingSlashCommands.set(session.id, { kind: 'compact' });
      handleMessage(ws, { text: '/compact', sessionId: session.id, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
      break;
    }

    case '/init': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /init。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      wsSend(ws, { type: 'system_message', message: initStartMessage(agent) });
      pendingSlashCommands.set(session.id, { kind: 'init' });
      handleMessage(ws, {
        text: agent === 'codex' ? buildCodexInitPrompt(session.cwd) : '/init',
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/github': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /github。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const ghArgs = parts.slice(1).join(' ').trim() || '列出所有可用仓库';
      const ghPrompt = [
        '[系统指令]',
        '用户请求执行 GitHub 相关操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 GitHub token 和仓库信息`,
        '2. 根据用户的自然语言指令匹配对应的仓库（按 name 或 notes 字段）',
        '3. 使用读取到的 token 进行 git 认证（可设置环境变量 GIT_TOKEN 或直接在 URL 中使用）',
        '4. 严格禁止在回复中打印、回显或引用 token 的完整内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${ghArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'github' });
      handleMessage(ws, {
        text: ghPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/ssh': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /ssh。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const sshArgs = parts.slice(1).join(' ').trim() || '列出所有可用主机';
      const sshPrompt = [
        '[系统指令]',
        '用户请求执行 SSH 远程操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 SSH 主机信息`,
        '2. 根据用户的自然语言指令匹配对应的主机（按 name 或 description 字段）',
        '3. 根据主机的 authType 字段选择认证方式：',
        '   - authType 为 "key" 时：使用 ssh -i {identityFile} -p {port} {user}@{host} 连接',
        '   - authType 为 "password" 时：使用 sshpass -p {password} ssh -p {port} {user}@{host} 连接（如系统无 sshpass 可先安装）',
        '4. 严格禁止在回复中打印任何密钥或密码内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${sshArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'ssh' });
      handleMessage(ws, {
        text: sshPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

		    case '/mode': {
		      const modeInput = parts[1];
		      const VALID_MODES = ['default', 'plan', 'yolo'];
		      const MODE_DESC = agent === 'codex'
		        ? {
		            default: '默认（Codex full-auto，可直接执行并修改文件）',
		            plan: 'Plan（只读沙箱，适合先分析方案）',
		            yolo: 'YOLO（跳过审批与沙箱限制）',
		          }
		        : {
		            default: '默认（需权限审批，受限操作）',
		            plan: 'Plan（需确认计划后执行）',
		            yolo: 'YOLO（跳过所有权限检查）',
		          };
		      if (!modeInput) {
		        const cur = session?.permissionMode || 'yolo';
		        wsSend(ws, { type: 'system_message', message: `当前模式: ${MODE_DESC[cur] || cur}\n可选: default, plan, yolo` });
		      } else if (VALID_MODES.includes(modeInput.toLowerCase())) {
		        const mode = modeInput.toLowerCase();
		        if (session) {
		          session.permissionMode = mode;
		          // Mode switching should not reset runtime context (Claude/Codex both resume).
		          session.updated = new Date().toISOString();
		          saveSession(session);
		        }
		        wsSend(ws, { type: 'system_message', message: `权限模式已切换为: ${MODE_DESC[mode]}` });
		        wsSend(ws, { type: 'mode_changed', mode });
		      } else {
	        wsSend(ws, { type: 'system_message', message: `无效模式: ${modeInput}\n可选: default, plan, yolo` });
      }
      break;
    }

	    case '/help': {
	      const base = '可用指令:\n' +
	        '/clear — 清除当前会话（含上下文）\n' +
	        `/mode [模式] — 查看/切换权限模式（default, plan, yolo${agent === 'codex' ? '；其中 plan 为只读' : ''}）\n` +
	        '/cost — 查看当前会话累计统计\n' +
	        '/github [指令] — GitHub 操作（读取开发者配置后执行）\n' +
	        '/ssh [指令] — SSH 远程操作（读取开发者配置后执行）\n' +
        '/help — 显示本帮助';
      wsSend(ws, {
        type: 'system_message',
        message: agent === 'codex'
          ? base + '\n/model [名称] — 查看/切换 Codex 模型（自由输入）\n/compact — 执行 Codex /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
          : base + '\n/model [名称] — 查看/切换模型（opus, sonnet, haiku）\n/compact — 执行 Claude 原生上下文压缩（保留压缩计划并可自动续跑）\n/init — 分析项目并生成/更新 CLAUDE.md',
      });
      break;
    }

    default:
      wsSend(ws, { type: 'system_message', message: `未知指令: ${cmd}\n输入 /help 查看可用指令` });
  }
}

// === Session Handlers ===
function handleNewSession(ws, msg) {
  const cwd = (msg && msg.cwd) ? String(msg.cwd) : null;
  const agent = normalizeAgent(msg?.agent);
  const requestedMode = ['default', 'plan', 'yolo'].includes(msg?.mode) ? msg.mode : 'yolo';
  const taskMode = msg?.taskMode === 'remote' ? 'remote' : 'local';
  const sshHostId = String(msg?.sshHostId || '').trim();
  const remoteCwd = String(msg?.remoteCwd || '').trim();

  let resolvedCwd = cwd || (agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null);
  let hostInfo = null;

  // Remote task: create host-specific directory and inject host info
  if (taskMode === 'remote' && sshHostId) {
    const devConfig = loadDevConfig();
    hostInfo = (devConfig.ssh.hosts || []).find(h => h.id === sshHostId) || null;
    if (hostInfo) {
      const hostDir = path.join(CONFIG_DIR, 'host', sshHostId);
      fs.mkdirSync(hostDir, { recursive: true });
      resolvedCwd = hostDir;
    }
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    model: agent === 'codex' ? resolveDefaultCodexModel() : MODEL_MAP.opus,
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
    taskMode,
    sshHostId: taskMode === 'remote' ? sshHostId : '',
    remoteCwd: taskMode === 'remote' ? remoteCwd : '',
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: [],
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent,
    cwd: session.cwd,
    totalCost: 0,
    totalUsage: session.totalUsage,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode,
    sshHostId: session.sshHostId,
    remoteCwd: session.remoteCwd,
  });
  sendSessionList(ws);

  // Inject initial prompt for remote sessions
  if (taskMode === 'remote' && hostInfo) {
    const authType = hostInfo.authType || 'key';
    const authInfo = authType === 'password'
      ? `密码认证（密码已配置，使用 sshpass 连接）`
      : `密钥认证：${hostInfo.identityFile || '(未配置)'}`;
    const sshCmd = authType === 'password'
      ? `sshpass -p <password> ssh -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`
      : `ssh -i ${hostInfo.identityFile} -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`;
    const initPrompt = [
      '[系统上下文]',
      '当前为远程任务会话。目标主机信息：',
      `- 主机名：${hostInfo.name}`,
      `- 地址：${hostInfo.user}@${hostInfo.host}:${hostInfo.port}`,
      `- 认证方式：${authInfo}`,
      `- 远端工作目录：${remoteCwd || 'SSH 默认目录'}`,
      `本地工作目录为 ${resolvedCwd}。`,
      `连接命令：${sshCmd}`,
      '严格禁止在回复中打印任何密钥或密码内容。',
    ].join('\n');
    handleMessage(ws, {
      text: initPrompt,
      sessionId: id,
      mode: requestedMode,
    }, { hideInHistory: true });
  }
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }
  if (getSessionAgent(session) === 'claude' && !session.cwd && session.claudeSessionId) {
    const localMeta = resolveClaudeSessionLocalMeta(session.claudeSessionId);
    if (localMeta?.cwd) {
      session.cwd = localMeta.cwd;
      if (!session.importedFrom && localMeta.projectDir) session.importedFrom = localMeta.projectDir;
      saveSession(session);
    }
  }
  const { recentMessages, olderChunks } = splitHistoryMessages(session.messages);
  const effectiveCwd = session.cwd || activeProcesses.get(sessionId)?.cwd || null;

  // Detach ws from any previous session's process
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }

  wsSessionMap.set(ws, sessionId);

  // Read and clear unread flag
  const hadUnread = !!session.hasUnread;
  if (session.hasUnread) {
    session.hasUnread = false;
    saveSession(session);
  }

  wsSend(ws, {
    type: 'session_info',
    sessionId: session.id,
    messages: recentMessages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    hasUnread: hadUnread,
    cwd: effectiveCwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    historyTotal: session.messages.length,
    historyBuffered: recentMessages.length,
    historyPending: olderChunks.length > 0,
    updated: session.updated,
    isRunning: activeProcesses.has(sessionId),
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });

  if (olderChunks.length > 0) {
    olderChunks.forEach((chunk, index) => {
      wsSend(ws, {
        type: 'session_history_chunk',
        sessionId: session.id,
        messages: chunk,
        remaining: Math.max(0, olderChunks.length - index - 1),
      });
    });
  }

  // Resume streaming if process is still active
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    entry.ws = ws;
    entry.wsDisconnectTime = null; // clear disconnect marker
    plog('INFO', 'ws_resume_attach', {
      sessionId: sessionId.slice(0, 8),
      pid: entry.pid,
      responseLen: (entry.fullText || '').length,
    });
    wsSend(ws, {
      type: 'resume_generating',
      sessionId,
      text: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
    });
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function deleteClaudeLocalSession(claudeSessionId) {
  if (!claudeSessionId) return;
  const projectsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch {}
}

function findClaudeSessionFile(claudeSessionId) {
  if (!claudeSessionId) return null;
  const projectsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(target)) return target;
    }
  } catch {}
  return null;
}

// 提取一条 .jsonl 用户条目的可见文本；纯 tool_result 条目返回 null（不是人类轮次）
function extractClaudeUserTurnText(entry) {
  if (!entry || entry.type !== 'user') return null;
  const raw = entry.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    if (raw.every((b) => b && b.type === 'tool_result')) return null;
    return raw.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  }
  return null;
}

// 回退截断：保留 .jsonl 中目标人类轮次「之前」的所有行，从该轮次起整体删除。
// 切在人类轮次边界，可保证 parentUuid 链与 tool_use/tool_result 配对完整。
// occurrence：目标内容在更早消息中重复出现的次数，用于消歧。
function truncateClaudeContext(claudeSessionId, targetContent, occurrence) {
  const filePath = findClaudeSessionFile(claudeSessionId);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');

  const wantEmpty = !String(targetContent || '').trim();
  let seen = 0;
  let cutLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const text = extractClaudeUserTurnText(entry);
    if (text === null) continue; // 非人类轮次
    const matches = wantEmpty ? !text.trim() : text === targetContent;
    if (!matches) continue;
    if (seen === occurrence) { cutLineIndex = i; break; }
    seen++;
  }

  if (cutLineIndex < 0) return { found: false };

  const kept = lines.slice(0, cutLineIndex);
  // 去掉尾部空行，保证文件以换行结尾以便 CLI 续接
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const remainingTurns = kept.some((l) => {
    const t = l.trim();
    if (!t) return false;
    try { return extractClaudeUserTurnText(JSON.parse(t)) !== null; } catch { return false; }
  });

  if (!remainingTurns) {
    // 截断点之前已无任何人类轮次 → 等价清空，交由调用方走整会话重置
    return { found: true, cleared: true, filePath };
  }

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  return { found: true, cleared: false, filePath };
}

// 找到某 thread 的全局 rollout 源文件（不含会话隔离副本）
function findCodexSourceRollout(session) {
  const threadId = session?.codexThreadId;
  if (!threadId) return null;
  // cc-web 启动 Codex 时用 CODEX_HOME=<每会话独立目录>，resume 实际读取的是该目录下的
  // rollout（而非全局 ~/.codex/sessions）。因此截断/编辑必须优先定位并改写这份「活」文件，
  // 否则会找不到文件（或改了全局副本但下次 resume 读不到），表现为「点了没反应」。
  const homeDir = session?.codexHomeDir;
  if (homeDir) {
    try {
      for (const filePath of walkJsonlFiles(path.join(homeDir, 'sessions'))) {
        if (filePath.includes(threadId)) return filePath;
      }
    } catch {}
  }
  if (session.importedRolloutPath && fs.existsSync(session.importedRolloutPath)) {
    return session.importedRolloutPath;
  }
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) return filePath;
    }
  } catch {}
  return null;
}

// 改完全局 rollout 后，删除会话隔离副本，使下次 resume 重新拷贝更新版
function invalidateCodexSessionCopy(session) {
  const threadId = session?.codexThreadId;
  const homeDir = session?.codexHomeDir;
  if (!threadId || !homeDir) return;
  const targetSessionsDir = path.join(homeDir, 'sessions');
  try {
    for (const filePath of walkJsonlFiles(targetSessionsDir)) {
      if (filePath.includes(threadId)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  } catch {}
}

// 提取一条 Codex event_msg/user_message 的可见文本，否则 null
function codexEventUserText(entry) {
  if (!entry || entry.type !== 'event_msg') return null;
  const p = entry.payload || {};
  if (p.type !== 'user_message') return null;
  return String(p.message || '').trim();
}

// 回退截断 Codex：在目标用户轮次的 task_started 处切，删除该行及其之后所有内容。
// occurrence：目标内容在更早用户消息中重复出现的次数。
function truncateCodexContext(session, targetContent, occurrence) {
  const filePath = findCodexSourceRollout(session);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');
  const parsed = lines.map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } });

  // 定位目标 event_msg/user_message 行
  const wantEmpty = !String(targetContent || '').trim();
  let seen = 0;
  let targetLine = -1;
  for (let i = 0; i < parsed.length; i++) {
    const text = codexEventUserText(parsed[i]);
    if (text === null) continue;
    const matches = wantEmpty ? false : text === targetContent;
    if (!matches) continue;
    if (seen === occurrence) { targetLine = i; break; }
    seen++;
  }
  if (targetLine < 0) return { found: false };

  // 从目标行往回找最近的 task_started，作为该轮起点
  let cutLine = -1;
  for (let i = targetLine; i >= 0; i--) {
    const e = parsed[i];
    if (e && e.type === 'event_msg' && e.payload?.type === 'task_started') { cutLine = i; break; }
  }
  if (cutLine < 0) return { found: false };

  const kept = lines.slice(0, cutLine);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();

  // 截断点之前是否仍有用户轮次
  const remainingTurns = kept.some((l) => {
    const t = l.trim();
    if (!t) return false;
    try { return codexEventUserText(JSON.parse(t)) !== null; } catch { return false; }
  });
  if (!remainingTurns) return { found: true, cleared: true, filePath };

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  // 注意：此处直接改写的就是 Codex resume 实际读取的「活」rollout（每会话独立目录），
  // 不能再调用 invalidateCodexSessionCopy，否则会把刚改好的文件删掉导致编辑丢失。
  return { found: true, cleared: false, filePath };
}

function countCodexTurnsFromMessage(session, targetContent, occurrence) {
  const filePath = findCodexSourceRollout(session);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const parsed = content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
  });

  let seen = 0;
  let targetLine = -1;
  for (let i = 0; i < parsed.length; i++) {
    const text = codexEventUserText(parsed[i]);
    if (text !== targetContent) continue;
    if (seen === occurrence) {
      targetLine = i;
      break;
    }
    seen++;
  }
  if (targetLine < 0) return { found: false };

  let firstTurnLine = -1;
  for (let i = targetLine; i >= 0; i--) {
    const entry = parsed[i];
    if (entry?.type === 'event_msg' && entry.payload?.type === 'task_started') {
      firstTurnLine = i;
      break;
    }
  }
  if (firstTurnLine < 0) return { found: false };

  let numTurns = 0;
  for (let i = firstTurnLine; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry?.type === 'event_msg' && entry.payload?.type === 'task_started') numTurns++;
  }
  return { found: numTurns > 0, numTurns, filePath };
}

// 编辑 Claude 用户消息：把目标用户轮次的文本块替换为新内容，保留 uuid/parentUuid/附件块
function editClaudeUserContext(claudeSessionId, oldContent, occurrence, newContent) {
  const filePath = findClaudeSessionFile(claudeSessionId);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');

  const wantEmpty = !String(oldContent || '').trim();
  let seen = 0;
  let targetIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const text = extractClaudeUserTurnText(entry);
    if (text === null) continue;
    const matches = wantEmpty ? !text.trim() : text === oldContent;
    if (!matches) continue;
    if (seen === occurrence) { targetIdx = i; break; }
    seen++;
  }
  if (targetIdx < 0) return { found: false };

  let entry;
  try { entry = JSON.parse(lines[targetIdx].trim()); } catch { return { found: false }; }
  const raw = entry.message?.content;
  if (typeof raw === 'string') {
    entry.message.content = newContent;
  } else if (Array.isArray(raw)) {
    let replaced = false;
    const next = [];
    for (const b of raw) {
      if (b && b.type === 'text') {
        if (!replaced) { next.push({ ...b, text: newContent }); replaced = true; }
        // 丢弃多余 text 块，合并为一块
      } else {
        next.push(b);
      }
    }
    if (!replaced) next.unshift({ type: 'text', text: newContent });
    entry.message.content = next;
  } else {
    return { found: false };
  }
  lines[targetIdx] = JSON.stringify(entry);

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n'));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  return { found: true };
}

// 编辑 Claude AI 回复：把第 assistantIndex 个回复轮次塌缩为单条纯文本，删除该轮工具调用/工具结果，
// 并把后续条目重链到保留条目，保证 parentUuid 链与 tool 配对完整。
function editClaudeAssistantContext(claudeSessionId, assistantIndex, newContent) {
  const filePath = findClaudeSessionFile(claudeSessionId);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');
  const parsed = lines.map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } });

  // 找到第 assistantIndex 个「回复轮次的首个 assistant 条目」
  let turnCount = 0;
  let expectingNewTurn = true;
  let keepIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e) continue;
    if (extractClaudeUserTurnText(e) !== null) { expectingNewTurn = true; continue; }
    if (e.type === 'assistant') {
      if (expectingNewTurn) {
        if (turnCount === assistantIndex) { keepIdx = i; break; }
        turnCount++;
        expectingNewTurn = false;
      }
    }
  }
  if (keepIdx < 0) return { found: false };

  // 该轮结束位置：下一个用户文本条目之前
  let nextUserTextIdx = parsed.length;
  for (let i = keepIdx + 1; i < parsed.length; i++) {
    const e = parsed[i];
    if (e && extractClaudeUserTurnText(e) !== null) { nextUserTextIdx = i; break; }
  }

  const keep = parsed[keepIdx];
  if (!keep.message) keep.message = { role: 'assistant', content: [] };
  keep.message.content = [{ type: 'text', text: newContent }];
  const keepUuid = keep.uuid || null;
  lines[keepIdx] = JSON.stringify(keep);

  // 删除保留条目之后、本轮范围内的所有行（工具调用、工具结果、后续 assistant 文本）
  const deleteSet = new Set();
  for (let i = keepIdx + 1; i < nextUserTextIdx; i++) {
    if (lines[i].trim()) deleteSet.add(i);
  }

  // 把本轮之后的首个带 uuid 的条目重链到保留条目
  if (keepUuid && nextUserTextIdx < parsed.length) {
    for (let i = nextUserTextIdx; i < parsed.length; i++) {
      const e = parsed[i];
      if (e && e.uuid) {
        if (Object.prototype.hasOwnProperty.call(e, 'parentUuid')) {
          e.parentUuid = keepUuid;
          lines[i] = JSON.stringify(e);
        }
        break;
      }
    }
  }

  const kept = lines.filter((_, i) => !deleteSet.has(i));

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, kept.join('\n'));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  return { found: true };
}


// 编辑 Codex 用户消息：改 event_msg/user_message 镜像 + 紧邻其前的 response_item(user) 真实上下文文本
function editCodexUserContext(session, oldContent, occurrence, newContent) {
  const filePath = findCodexSourceRollout(session);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');
  const parsed = lines.map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } });

  const wantEmpty = !String(oldContent || '').trim();
  let seen = 0;
  let eventIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    const text = codexEventUserText(parsed[i]);
    if (text === null) continue;
    const matches = wantEmpty ? false : text === oldContent;
    if (!matches) continue;
    if (seen === occurrence) { eventIdx = i; break; }
    seen++;
  }
  if (eventIdx < 0) return { found: false };

  // 改 event_msg 镜像
  parsed[eventIdx].payload.message = newContent;
  lines[eventIdx] = JSON.stringify(parsed[eventIdx]);

  // 往回找紧邻的、文本等于 oldContent 的 response_item(user) 真实上下文项
  let respIdx = -1;
  for (let i = eventIdx - 1; i >= 0; i--) {
    const e = parsed[i];
    if (!e) continue;
    const p = e.payload || {};
    // 遇到上一轮的 task_started 即停止，避免跨轮误改
    if (e.type === 'event_msg' && p.type === 'task_started') break;
    if (e.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') continue;
    const txt = Array.isArray(p.content)
      ? p.content.filter((c) => c && (c.type === 'input_text' || c.type === 'output_text')).map((c) => c.text || '').join('')
      : '';
    if (wantEmpty ? !txt.trim() : txt === oldContent) { respIdx = i; break; }
  }
  if (respIdx >= 0) {
    const p = parsed[respIdx].payload;
    let replaced = false;
    const next = [];
    for (const c of (p.content || [])) {
      if (c && c.type === 'input_text') {
        if (!replaced) { next.push({ ...c, text: newContent }); replaced = true; }
      } else {
        next.push(c);
      }
    }
    if (!replaced) next.unshift({ type: 'input_text', text: newContent });
    p.content = next;
    lines[respIdx] = JSON.stringify(parsed[respIdx]);
  }

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n'));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  // 直接改写的是 resume 实际读取的「活」rollout，不能再删每会话副本（否则编辑丢失）。
  return { found: true };
}

// 编辑 Codex AI 回复：把第 assistantIndex 个回复轮次的 assistant 文本塌缩为单条，
// 删除该轮 function_call/function_call_output。Codex rollout 无 parentUuid 链，删除安全。
function editCodexAssistantContext(session, assistantIndex, newContent) {
  const filePath = findCodexSourceRollout(session);
  if (!filePath) return { found: false, fileMissing: true };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { found: false, fileMissing: true }; }
  const lines = content.split('\n');
  const parsed = lines.map((l) => { const t = l.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } });

  const isAssistantResp = (e) => e && e.type === 'response_item' && e.payload?.type === 'message' && e.payload?.role === 'assistant';
  const isToolResp = (e) => e && e.type === 'response_item' && (e.payload?.type === 'function_call' || e.payload?.type === 'function_call_output' || e.payload?.type === 'reasoning');

  // 找到第 assistantIndex 个回复轮次的首个 assistant response_item
  let turnCount = 0;
  let expectingNewTurn = true;
  let keepIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e) continue;
    if (codexEventUserText(e) !== null) { expectingNewTurn = true; continue; }
    if (isAssistantResp(e)) {
      if (expectingNewTurn) {
        if (turnCount === assistantIndex) { keepIdx = i; break; }
        turnCount++;
        expectingNewTurn = false;
      }
    }
  }
  if (keepIdx < 0) return { found: false };

  // 该轮结束：下一个用户消息之前
  let nextUserIdx = parsed.length;
  for (let i = keepIdx + 1; i < parsed.length; i++) {
    if (codexEventUserText(parsed[i]) !== null) { nextUserIdx = i; break; }
  }

  // 保留首个 assistant 条目，替换文本
  const keep = parsed[keepIdx];
  keep.payload.content = [{ type: 'output_text', text: newContent }];
  lines[keepIdx] = JSON.stringify(keep);

  // 删除本轮内其余 assistant 文本块 + 工具调用/结果/思考
  const deleteSet = new Set();
  for (let i = keepIdx + 1; i < nextUserIdx; i++) {
    const e = parsed[i];
    if (isAssistantResp(e) || isToolResp(e)) deleteSet.add(i);
  }
  const kept = lines.filter((_, i) => !deleteSet.has(i));

  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, kept.join('\n'));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    return { found: false, writeError: err.message };
  }
  // 直接改写的是 resume 实际读取的「活」rollout，不能再删每会话副本（否则编辑丢失）。
  return { found: true };
}

function deleteCodexLocalSession(session) {
  const threadId = session?.codexThreadId;
  if (!threadId) return { removedFiles: 0, removedDbRows: false };

  const rolloutPaths = new Set();
  if (session.importedRolloutPath) rolloutPaths.add(path.resolve(session.importedRolloutPath));
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
    }
  } catch {}
  // 每会话独立目录（CODEX_HOME）里的 rollout 才是 resume 实际使用的文件，一并清理。
  const homeDir = session?.codexHomeDir ? path.resolve(session.codexHomeDir) : null;
  if (homeDir) {
    try {
      for (const filePath of walkJsonlFiles(path.join(homeDir, 'sessions'))) {
        if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
      }
    } catch {}
  }

  let removedFiles = 0;
  for (const filePath of rolloutPaths) {
    try {
      const inGlobal = filePath.startsWith(CODEX_SESSIONS_DIR);
      const inSessionHome = homeDir && filePath.startsWith(homeDir);
      if ((inGlobal || inSessionHome) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles++;
      }
    } catch {}
  }

  let removedDbRows = false;
  try {
    const sqlitePath = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' });
    if (sqlitePath.status === 0) {
      const quotedThreadId = sqlQuote(threadId);
      const stateSql = [
        'PRAGMA foreign_keys = ON;',
        `DELETE FROM thread_dynamic_tools WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM stage1_outputs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM threads WHERE id = ${quotedThreadId};`,
      ].join(' ');
      const stateResult = spawnSync('sqlite3', [CODEX_STATE_DB_PATH, stateSql], { stdio: 'ignore' });
      if (stateResult.status === 0) removedDbRows = true;

      if (fs.existsSync(CODEX_LOG_DB_PATH)) {
        spawnSync('sqlite3', [CODEX_LOG_DB_PATH, `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`], { stdio: 'ignore' });
      }
    }
  } catch {}

  return { removedFiles, removedDbRows };
}

function handleDeleteSession(ws, sessionId) {
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    try { killProcess(entry.pid); } catch {}
    if (entry.tailer) entry.tailer.stop();
    activeProcesses.delete(sessionId);
    if (entry.ws) wsSend(entry.ws, { type: 'done', sessionId });
  }
  cleanRunDir(sessionId);
  try {
    const p = sessionPath(sessionId);
    const session = loadSession(sessionId);
    const sessionAgent = getSessionAgent(session);
    for (const attachmentId of collectSessionAttachmentIds(session)) {
      removeAttachmentById(attachmentId);
    }
    if (fs.existsSync(p)) fs.unlinkSync(p);
    removeSessionMetaCache(sessionId);
    if (sessionAgent === 'codex') {
      const result = deleteCodexLocalSession(session);
      plog('INFO', 'codex_local_session_deleted', {
        sessionId: sessionId.slice(0, 8),
        threadId: session?.codexThreadId || null,
        removedFiles: result.removedFiles,
        removedDbRows: result.removedDbRows,
      });
    } else {
      deleteClaudeLocalSession(session?.claudeSessionId || null);
    }
    sendSessionList(ws);
  } catch {
    wsSend(ws, { type: 'error', message: 'Failed to delete session' });
  }
}

async function rollbackCodexContext(session, numTurns) {
  const spawnSpec = buildCodexSpawnSpec(session);
  if (spawnSpec?.error) return { ok: false, error: spawnSpec.error };

  let proc;
  try {
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    await codexAppServer.rollbackThread(proc, {
      sessionId: session.id,
      threadId: session.codexThreadId,
      numTurns,
    });
    plog('INFO', 'codex_thread_rollback_complete', {
      sessionId: session.id.slice(0, 8),
      threadId: session.codexThreadId,
      numTurns,
    });
    return { ok: true };
  } catch (err) {
    plog('WARN', 'codex_thread_rollback_fail', {
      sessionId: session.id.slice(0, 8),
      threadId: session.codexThreadId,
      numTurns,
      error: err.message,
    });
    return { ok: false, error: err.message };
  } finally {
    if (proc && !proc.killed) {
      try { proc.kill('SIGTERM'); } catch {}
    }
  }
}

// 回退截断：删除目标消息及其之后的全部消息，并同步清理发送给 AI 的上下文
async function handleTruncateSession(ws, msg) {
  const { sessionId, timestamp, content } = msg || {};
  if (!sessionId) return wsSend(ws, { type: 'error', message: '缺少 sessionId' });

  if (activeProcesses.has(sessionId)) {
    return wsSend(ws, { type: 'error', message: '会话正在生成中，无法截断，请稍后再试' });
  }

  const session = loadSession(sessionId);
  if (!session) return wsSend(ws, { type: 'error', message: '会话不存在' });

  const isCodex = getSessionAgent(session) === 'codex';

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const targetContent = typeof content === 'string' ? content : '';
  let index = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (timestamp && m.timestamp !== timestamp) continue;
    if ((m.content || '') !== targetContent) continue;
    index = i;
    break;
  }
  if (index < 0) {
    return wsSend(ws, { type: 'error', message: '未找到对应消息，可能已变化，请刷新后重试' });
  }

  // 目标内容在更早用户消息中重复出现的次数，用于在上下文文件中消歧
  let occurrence = 0;
  for (let i = 0; i < index; i++) {
    const m = messages[i];
    if (m && m.role === 'user' && (m.content || '') === targetContent) occurrence++;
  }

  // 截断点之前是否仍有用户消息
  let hasEarlierUserTurn = false;
  for (let i = 0; i < index; i++) {
    if (messages[i] && messages[i].role === 'user') { hasEarlierUserTurn = true; break; }
  }

  if (isCodex) {
    if (getRuntimeSessionId(session)) {
      if (!hasEarlierUserTurn) {
        // 等价清空：删 rollout + sqlite 行 + 隔离副本，清掉 threadId，下次从全新会话开始
        invalidateCodexSessionCopy(session);
        deleteCodexLocalSession(session);
        clearRuntimeSessionId(session);
      } else {
        const turnCount = countCodexTurnsFromMessage(session, targetContent, occurrence);
        if (!turnCount.found) {
          return wsSend(ws, { type: 'error', message: '无法在 Codex 上下文中定位该消息，已中止清除。请刷新后重试' });
        }
        const result = await rollbackCodexContext(session, turnCount.numTurns);
        if (!result.ok) {
          return wsSend(ws, { type: 'error', message: `Codex 上下文回滚失败，已中止清除：${result.error}` });
        }
      }
    }
  } else if (session.claudeSessionId) {
    if (!hasEarlierUserTurn) {
      // 等价清空整个会话上下文：删除 .jsonl 并清掉 runtime id，下次从全新会话开始
      deleteClaudeLocalSession(session.claudeSessionId);
      session.claudeSessionId = null;
    } else {
      const result = truncateClaudeContext(session.claudeSessionId, targetContent, occurrence);
      if (!result.found) {
        return wsSend(ws, { type: 'error', message: '无法在上下文中定位该消息，已中止以避免破坏会话。请刷新后重试' });
      }
      if (result.cleared) {
        deleteClaudeLocalSession(session.claudeSessionId);
        session.claudeSessionId = null;
      }
    }
  }

  session.messages = messages.slice(0, index);
  session.updated = new Date().toISOString();
  saveSession(session);

  plog('INFO', 'session_truncated', {
    sessionId: sessionId.slice(0, 8),
    fromIndex: index,
    removed: messages.length - index,
  });

  wsSend(ws, { type: 'session_truncated', sessionId, messages: session.messages });
  sendSessionList(ws);
}

// 单条编辑：修改某条用户消息的文本，并同步到发送给 AI 的上下文
function handleEditMessage(ws, msg) {
  const { sessionId, timestamp, content, newContent } = msg || {};
  const role = msg?.role === 'assistant' ? 'assistant' : 'user';
  if (!sessionId) return wsSend(ws, { type: 'error', message: '缺少 sessionId' });

  const next = typeof newContent === 'string' ? newContent : '';
  if (!next.trim()) return wsSend(ws, { type: 'error', message: '编辑后的内容不能为空' });

  if (activeProcesses.has(sessionId)) {
    return wsSend(ws, { type: 'error', message: '会话正在生成中，无法编辑，请稍后再试' });
  }

  const session = loadSession(sessionId);
  if (!session) return wsSend(ws, { type: 'error', message: '会话不存在' });

  const isCodex = getSessionAgent(session) === 'codex';
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const oldContent = typeof content === 'string' ? content : '';

  // 按 时间戳 + 角色 定位（用户消息再要求内容一致，作为额外保险）
  let index = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== role) continue;
    if (timestamp && m.timestamp !== timestamp) continue;
    if (role === 'user' && (m.content || '') !== oldContent) continue;
    index = i;
    break;
  }
  if (index < 0) {
    return wsSend(ws, { type: 'error', message: '未找到对应消息，可能已变化，请刷新后重试' });
  }
  if ((messages[index].content || '') === next) {
    return wsSend(ws, { type: 'message_edited', sessionId, messages });
  }

  const runtimeId = getRuntimeSessionId(session);
  if (runtimeId) {
    let result;
    if (role === 'assistant') {
      // AI 回复按「第几个回复轮次」定位
      let assistantIndex = 0;
      for (let i = 0; i < index; i++) {
        if (messages[i] && messages[i].role === 'assistant') assistantIndex++;
      }
      result = isCodex
        ? editCodexAssistantContext(session, assistantIndex, next)
        : editClaudeAssistantContext(session.claudeSessionId, assistantIndex, next);
    } else {
      let occurrence = 0;
      for (let i = 0; i < index; i++) {
        const m = messages[i];
        if (m && m.role === 'user' && (m.content || '') === oldContent) occurrence++;
      }
      result = isCodex
        ? editCodexUserContext(session, oldContent, occurrence, next)
        : editClaudeUserContext(session.claudeSessionId, oldContent, occurrence, next);
    }
    if (!result.found && !result.fileMissing) {
      return wsSend(ws, { type: 'error', message: '无法在上下文中定位该消息，已中止以避免破坏会话。请刷新后重试' });
    }
  }

  const editedMsg = { ...messages[index], content: next };
  if (role === 'assistant') {
    // 工具调用流程已随上下文删除，展示也同步去掉
    delete editedMsg.toolCalls;
  }
  messages[index] = editedMsg;
  session.messages = messages;
  session.updated = new Date().toISOString();
  saveSession(session);

  plog('INFO', 'message_edited', { sessionId: sessionId.slice(0, 8), index, role });

  wsSend(ws, { type: 'message_edited', sessionId, messages: session.messages });
  sendSessionList(ws);
}

function handleRenameSession(ws, sessionId, title) {
  if (!sessionId || !title) return;
  const session = loadSession(sessionId);
  if (session) {
    session.title = String(title).slice(0, 100);
    session.updated = new Date().toISOString();
    saveSession(session);
    sendSessionList(ws);
    wsSend(ws, { type: 'session_renamed', sessionId, title: session.title });
  }
}

		function handleSetMode(ws, sessionId, mode) {
		  const VALID_MODES = ['default', 'plan', 'yolo'];
		  if (!mode || !VALID_MODES.includes(mode)) return;
		  if (sessionId) {
		    const session = loadSession(sessionId);
		    if (session) {
		      session.permissionMode = mode;
		      // Same rule as /mode: don't clear runtime context on mode changes.
		      session.updated = new Date().toISOString();
		      saveSession(session);
		    }
		  }
		  wsSend(ws, { type: 'mode_changed', mode });
		}

function handleDisconnect(ws, wsId, authToken = null) {
  const affectedSessions = [];
  for (const [sid, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
      affectedSessions.push({ sessionId: sid.slice(0, 8), pid: entry.pid });
    }
  }
  unregisterWsToken(authToken, ws);
  wsSessionMap.delete(ws);
  plog('INFO', 'ws_disconnect', { wsId, activeProcessesAffected: affectedSessions });
}

function handleDetachView(ws) {
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
    }
  }
  wsSessionMap.delete(ws);
}

function handleAbort(ws) {
  const sessionId = wsSessionMap.get(ws);
  if (!sessionId) return;
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  plog('INFO', 'user_abort', { sessionId: sessionId.slice(0, 8), pid: entry.pid });
  killProcess(entry.pid);
  setTimeout(() => {
    killProcess(entry.pid, true);
  }, 3000);
  // handleProcessComplete will be triggered by the PID monitor
}

// === Runtime Message Handler ===
function handleMessage(ws, msg, options = {}) {
  const { text, sessionId, mode } = msg;
  const { hideInHistory = false } = options;
  const clientMessageId = typeof msg.clientMessageId === 'string' ? msg.clientMessageId.trim().slice(0, 128) : '';
  const textValue = typeof text === 'string' ? text : '';
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const normalizedText = textValue.trim();
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return wsSend(ws, { type: 'error', message: '图片附件已过期或不可用，请重新上传后再发送。', clientMessageId });
  }
  if (!normalizedText && resolvedAttachments.length === 0) return;

  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));

  const derivedTitle = normalizedText
    ? textValue.slice(0, 60).replace(/\n/g, ' ')
    : `图片: ${savedAttachments[0]?.filename || 'image'}`;

  let session;
  if (sessionId) session = loadSession(sessionId);
  if (!session && clientMessageId) session = findSessionByClientMessageId(clientMessageId);
  if (session && clientMessageId) {
    const existingMessage = session.messages.find((message) => message?.clientMessageId === clientMessageId);
    if (existingMessage) {
      wsSessionMap.set(ws, session.id);
      wsSend(ws, { type: 'message_accepted', clientMessageId, sessionId: session.id });
      if (activeProcesses.has(session.id)) {
        const entry = activeProcesses.get(session.id);
        entry.ws = ws;
        wsSend(ws, {
          type: 'resume_generating',
          sessionId: session.id,
          text: entry.fullText || '',
          toolCalls: entry.toolCalls || [],
        });
      }
      return;
    }
  }
  if (session && activeProcesses.has(session.id)) {
    return wsSend(ws, { type: 'error', message: '正在处理中，请先点击停止按钮。', clientMessageId });
  }
  if (!session) {
    const id = crypto.randomUUID();
    const agent = normalizeAgent(msg.agent);
    const resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
	    session = {
	      id,
	      title: derivedTitle,
	      created: new Date().toISOString(),
	      updated: new Date().toISOString(),
	      agent,
	      claudeSessionId: null,
	      codexThreadId: null,
	      model: agent === 'codex' ? resolveDefaultCodexModel() : null,
	      permissionMode: mode || 'yolo',
	      totalCost: 0,
	      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
	      messages: [],
	      cwd: resolvedCwd,
	    };
	  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && resolvedAttachments.length > 0) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片。请先发送图片说明，再单独使用 /model 或 /mode。', clientMessageId });
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
  }

  if (!hideInHistory && normalizedText !== '/compact' && getRuntimeSessionId(session)) {
    pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'normal' });
  }

  if (session.title === 'New Chat' || session.title === 'Untitled') {
    session.title = derivedTitle;
  }

  if (!hideInHistory) {
    const requestedTimestamp = typeof msg.timestamp === 'string' ? msg.timestamp : '';
    const parsedTimestamp = requestedTimestamp ? Date.parse(requestedTimestamp) : NaN;
    const messageTimestamp = Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : new Date().toISOString();
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      timestamp: messageTimestamp,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;

  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }
  wsSessionMap.set(ws, currentSessionId);
  if (clientMessageId) {
    wsSend(ws, { type: 'message_accepted', clientMessageId, sessionId: currentSessionId });
  }

  if (!sessionId) {
    wsSend(ws, {
      type: 'session_info',
      sessionId: currentSessionId,
      messages: session.messages,
      title: session.title,
      mode: session.permissionMode || 'yolo',
      model: sessionModelLabel(session),
      agent: getSessionAgent(session),
      cwd: session.cwd || null,
      totalCost: session.totalCost || 0,
      totalUsage: session.totalUsage || null,
      updated: session.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: false,
      taskMode: session.taskMode || 'local',
      sshHostId: session.sshHostId || '',
      remoteCwd: session.remoteCwd || '',
    });
  }
  sendSessionList(ws);

  const spawnSpec = isClaudeSession(session)
    ? buildClaudeSpawnSpec(session, { attachments: resolvedAttachments })
    : buildCodexSpawnSpec(session, { attachments: resolvedAttachments });
  if (spawnSpec?.error) {
    return wsSend(ws, { type: 'error', message: spawnSpec.error, clientMessageId });
  }
  saveSession(session);

  // === Codex app-server: persistent bidirectional process (approval guard) ===
  // Unlike the detached exec path below, we keep stdin open to drive the JSON-RPC turn
  // and relay approval decisions. This process does NOT survive a Node.js restart.
  if (spawnSpec.appServer) {
    const dir = runDir(currentSessionId);
    fs.mkdirSync(dir, { recursive: true });
    const errorPath = path.join(dir, 'error.log');
    const errorFd = fs.openSync(errorPath, 'w');

    let proc;
    try {
      proc = spawn(spawnSpec.command, spawnSpec.args, {
        env: spawnSpec.env,
        cwd: spawnSpec.cwd,
        stdio: ['pipe', 'pipe', errorFd],
        windowsHide: true,
      });
    } catch (err) {
      fs.closeSync(errorFd);
      cleanRunDir(currentSessionId);
      plog('ERROR', 'process_spawn_fail', {
        sessionId: currentSessionId.slice(0, 8),
        error: err.message,
        command: spawnSpec.command,
        cwd: spawnSpec.cwd,
      });
      return wsSend(ws, { type: 'error', message: formatRuntimeError('codex', err.message, { exitCode: null, signal: null }), clientMessageId });
    }
    fs.closeSync(errorFd);

    proc.on('error', (err) => {
      plog('ERROR', 'process_spawn_fail', {
        sessionId: currentSessionId.slice(0, 8),
        error: err.message,
        command: spawnSpec.command,
        cwd: spawnSpec.cwd,
      });
      cleanRunDir(currentSessionId);
      wsSend(ws, { type: 'error', message: formatRuntimeError('codex', err.message, { exitCode: null, signal: null }), clientMessageId });
    });

    fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));

    plog('INFO', 'process_spawn', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      agent: 'codex',
      mode: spawnSpec.mode,
      model: session.model || 'default',
      resume: spawnSpec.resume,
      codexHomeDir: spawnSpec.codexHomeDir || null,
      command: spawnSpec.command,
      cwd: spawnSpec.cwd,
      args: spawnSpec.args.join(' '),
      appServer: true,
    });

    proc.on('exit', (code, signal) => {
      plog('INFO', 'process_exit_event', {
        sessionId: currentSessionId.slice(0, 8),
        pid: proc.pid,
        exitCode: code,
        signal,
      });
      setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
    });

    const entry = {
      pid: proc.pid,
      ws,
      agent: 'codex',
      cwd: spawnSpec.cwd,
      fullText: '',
      attachments: resolvedAttachments,
      toolCalls: [],
      lastCost: null,
      lastUsage: null,
      lastError: null,
      errorSent: false,
      codexHomeDir: spawnSpec.codexHomeDir || '',
      codexRuntimeKey: spawnSpec.codexRuntimeKey || '',
      tailer: null,
      appServer: true,
    };
    activeProcesses.set(currentSessionId, entry);
    sendSessionList(ws);

    codexAppServer.attach(proc, {
      session,
      sessionId: currentSessionId,
      entry,
      promptText: textValue,
      attachments: resolvedAttachments,
      spec: spawnSpec,
    });
    return;
  }

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  const useStreamJson = isClaudeSession(session) && resolvedAttachments.length > 0;

  if (useStreamJson) {
    const content = [];
    if (textValue) content.push({ type: 'text', text: textValue });
    for (const attachment of resolvedAttachments) {
      const data = fs.readFileSync(attachment.path).toString('base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data,
        },
      });
    }
    fs.writeFileSync(inputPath, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })}\n`);
  } else {
    fs.writeFileSync(inputPath, textValue);
  }

  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  try {
    let stdinSource;
    if (useStreamJson) {
      // stream-json requires an open pipe (not a closed file) so Claude doesn't exit on EOF
      stdinSource = 'pipe';
    } else {
      stdinSource = fs.openSync(inputPath, 'r');
    }
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [stdinSource, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
    });
    if (useStreamJson) {
      // Write the stream-json message then close stdin so Claude knows input is done
      proc.stdin.write(fs.readFileSync(inputPath));
      proc.stdin.end();
    } else {
      fs.closeSync(stdinSource);
    }
  } catch (err) {
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    cleanRunDir(currentSessionId);
    plog('ERROR', 'process_spawn_fail', {
      sessionId: currentSessionId.slice(0, 8),
      error: err.message,
      command: spawnSpec.command,
      cwd: spawnSpec.cwd,
      path: spawnSpec.env?.PATH || null,
    });
    const agent = getSessionAgent(session);
    return wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }), clientMessageId });
  }

  proc.on('error', (err) => {
    plog('ERROR', 'process_spawn_fail', {
      sessionId: currentSessionId.slice(0, 8),
      error: err.message,
      command: spawnSpec.command,
      cwd: spawnSpec.cwd,
      path: spawnSpec.env?.PATH || null,
    });
    cleanRunDir(currentSessionId);
    const agent = getSessionAgent(session);
    wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }), clientMessageId });
  });

  fs.closeSync(outputFd);
  fs.closeSync(errorFd);

  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    agent: getSessionAgent(session),
    mode: spawnSpec.mode,
    model: session.model || 'default',
    resume: spawnSpec.resume,
    codexHomeDir: spawnSpec.codexHomeDir || null,
    codexRuntimeKey: spawnSpec.codexRuntimeKey || null,
    command: spawnSpec.command,
    cwd: spawnSpec.cwd,
    args: spawnSpec.args.join(' '),
  });

  // Fast exit detection (while Node.js is running)
  proc.on('exit', (code, signal) => {
    plog('INFO', 'process_exit_event', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      exitCode: code,
      signal: signal,
    });
    // Small delay to ensure file is fully flushed
    setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
  });

  const entry = {
    pid: proc.pid,
    ws,
    agent: getSessionAgent(session),
    cwd: spawnSpec.cwd,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
    codexHomeDir: spawnSpec.codexHomeDir || '',
    codexRuntimeKey: spawnSpec.codexRuntimeKey || '',
    tailer: null,
  };
  activeProcesses.set(currentSessionId, entry);
  sendSessionList(ws);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processRuntimeEvent(entry, event, currentSessionId);
    } catch {}
  });
  entry.tailer.start();
}

function truncateObj(obj, maxLen) {
  const s = JSON.stringify(obj);
  if (s.length <= maxLen) return obj;
  return s.slice(0, maxLen) + '...';
}

function safeJsonParse(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return input;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function sanitizeToolInput(toolName, input) {
  const parsed = safeJsonParse(input);
  if (toolName === 'AskUserQuestion') {
    return parsed;
  }
  return truncateObj(parsed, 500);
}

const {
  buildClaudeSpawnSpec,
  buildCodexSpawnSpec,
  processClaudeEvent,
  processCodexEvent,
  processRuntimeEvent,
} = createAgentRuntime({
  processEnv: process.env,
  CLAUDE_PATH,
  CODEX_PATH,
  MODEL_MAP,
  loadModelConfig,
  applyCustomTemplateToSettings,
  loadCodexConfig,
  prepareCodexCustomRuntime,
  wsSend,
  truncateObj,
  sanitizeToolInput,
  loadSession,
  saveSession,
  setRuntimeSessionId,
  getRuntimeSessionId,
});

const codexAppServer = createCodexAppServer({
  wsSend,
  plog,
  loadSession,
  saveSession,
  setRuntimeSessionId,
});

// === Check Update ===
function handleCheckUpdate(ws) {
  const localVersion = (() => {
    try {
      const cl = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
      const m = cl.match(/##\s*v([\d.]+)/) || cl.match(/\*\*v([\d.]+)\*\*/);
      if (m) return m[1];
    } catch {}
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch {}
    return 'unknown';
  })();

  const https = require('https');
  const options = {
    hostname: 'raw.githubusercontent.com',
    path: '/ZgDaniel/cc-web/main/CHANGELOG.md',
    headers: { 'User-Agent': 'cc-web-update-check' },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'update_info', localVersion, error: `HTTP ${res.statusCode}` });
      }
      const m = body.match(/##\s*v([\d.]+)/) || body.match(/\*\*v([\d.]+)\*\*/);
      const latest = m ? m[1] : null;
      if (!latest) {
        return wsSend(ws, { type: 'update_info', localVersion, error: '无法解析远端版本号' });
      }
      const hasUpdate = latest !== localVersion;
      wsSend(ws, {
        type: 'update_info',
        localVersion,
        latestVersion: latest,
        hasUpdate,
        releaseUrl: 'https://github.com/ZgDaniel/cc-web',
      });
    });
  });
  req.on('error', (e) => {
    wsSend(ws, { type: 'update_info', localVersion, error: '网络请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'update_info', localVersion, error: '请求超时' });
  });
  req.end();
}

// === Native Session Import ===

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions');
const CODEX_STATE_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'state_5.sqlite');
const CODEX_LOG_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'logs_1.sqlite');

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let cwd = null;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.type === 'user' && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {}
        }
        return { cwd, projectDir: dir, filePath };
      } catch {}
    }
  } catch {}
  return null;
}

function parseJsonlToMessages(lines) {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type === 'user') {
      const raw = entry.message?.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // skip tool_result blocks, only take text blocks
        content = raw
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      if (content.trim()) {
        messages.push({ role: 'user', content, timestamp: entry.timestamp || null });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      let content = '';
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          content += b.text;
        } else if (b.type === 'tool_use') {
          toolCalls.push({ name: b.name, id: b.id, input: b.input, done: true });
        }
        // skip thinking blocks
      }
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls, timestamp: entry.timestamp || null });
      }
    }
    // skip other types
  }
  return messages;
}

const {
  parseCodexRolloutLines,
  getCodexRolloutFiles,
  parseCodexRolloutFile,
} = createCodexRolloutStore({
  codexSessionsDir: CODEX_SESSIONS_DIR,
  sanitizeToolInput,
});

function getImportedSessionIds() {
  ensureSessionMetaCache();
  const imported = new Set();
  for (const meta of sessionMetaCache.values()) {
    if (meta.claudeSessionId) imported.add(meta.claudeSessionId);
  }
  return imported;
}

function getImportedCodexThreadIds() {
  ensureSessionMetaCache();
  const imported = new Set();
  for (const meta of sessionMetaCache.values()) {
    if (meta.codexThreadId) imported.add(meta.codexThreadId);
  }
  return imported;
}

// Import dialogs only need a summary per external history file, but the files
// themselves are append-only transcripts. Key the summary on mtime+size so an
// unchanged file is never re-read, and never parse more than one page of them.
const importMetaCache = new Map(); // filePath -> { mtimeMs, size, meta }

function readImportMeta(filePath, parseMeta) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = importMetaCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
  let meta;
  try {
    meta = parseMeta(filePath);
  } catch {
    return null;
  }
  if (!meta) return null;
  if (importMetaCache.size >= MAX_IMPORT_META_CACHE) {
    const oldest = importMetaCache.keys().next().value;
    if (oldest !== undefined) importMetaCache.delete(oldest);
  }
  importMetaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

function parseNativeSessionMeta(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let title = null;
  let cwd = null;
  let lastTs = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.timestamp) lastTs = entry.timestamp;
    if (entry.type === 'user' && !cwd) {
      cwd = entry.cwd || null;
      const raw = entry.message?.content;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
      if (text.trim()) title = text.trim().slice(0, 80).replace(/\n/g, ' ');
    }
  }
  return { title, cwd, updatedAt: lastTs };
}

function handleListNativeSessions(ws) {
  const groups = [];
  let totalFiles = 0;
  try {
    const imported = getImportedSessionIds();
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    const candidates = [];
    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      try {
        for (const f of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
          const filePath = path.join(dirPath, f);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch {}
          candidates.push({ dir, filePath, sessionId: f.replace('.jsonl', ''), mtimeMs });
        }
      } catch {}
    }
    totalFiles = candidates.length;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const byDir = new Map();
    for (const candidate of candidates.slice(0, MAX_IMPORT_LIST_FILES)) {
      const meta = readImportMeta(candidate.filePath, parseNativeSessionMeta);
      if (!meta) continue;
      if (!byDir.has(candidate.dir)) byDir.set(candidate.dir, []);
      byDir.get(candidate.dir).push({
        sessionId: candidate.sessionId,
        title: meta.title || candidate.sessionId.slice(0, 20),
        cwd: meta.cwd,
        updatedAt: meta.updatedAt,
        alreadyImported: imported.has(candidate.sessionId),
      });
    }
    for (const [dir, sessionItems] of byDir) {
      sessionItems.sort((a, b) => {
        if (!a.updatedAt) return 1;
        if (!b.updatedAt) return -1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
      groups.push({ dir, sessions: sessionItems });
    }
  } catch {}
  wsSend(ws, {
    type: 'native_sessions',
    groups,
    totalFiles,
    truncated: totalFiles > MAX_IMPORT_LIST_FILES,
  });
}

function handleImportNativeSession(ws, msg) {
  const { sessionId, projectDir } = msg;
  if (!sessionId || !projectDir) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId 或 projectDir' });
  }
  const filePath = path.join(CLAUDE_PROJECTS_DIR, String(projectDir), `${sanitizeId(sessionId)}.jsonl`);
  if (!filePath.startsWith(CLAUDE_PROJECTS_DIR)) {
    return wsSend(ws, { type: 'error', message: '非法路径' });
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return wsSend(ws, { type: 'error', message: '无法读取会话文件' });
  }
  const lines = content.split('\n');
  const messages = parseJsonlToMessages(lines);

  // Find or create cc-web session with this claudeSessionId
  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.claudeSessionId === sessionId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  // Determine title and cwd from messages/raw
  let title = sessionId.slice(0, 20);
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'user') {
        if (!cwd) cwd = e.cwd || null;
        const raw = e.message?.content;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text.trim()) { title = text.trim().slice(0, 60).replace(/\n/g, ' '); break; }
      }
    } catch {}
  }

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title,
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'claude',
    claudeSessionId: sessionId,
    codexThreadId: null,
    importedFrom: projectDir,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages,
    cwd: cwd || existingSession?.cwd || null,
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListCodexSessions(ws) {
  const imported = getImportedCodexThreadIds();
  const items = [];
  const seen = new Set();
  const files = getCodexRolloutFiles();
  const scanList = files.slice(0, MAX_IMPORT_LIST_FILES);
  for (const filePath of scanList) {
    const meta = readImportMeta(filePath, (p) => parseCodexRolloutFile(p)?.meta || null);
    if (!meta?.threadId) continue;
    if (seen.has(meta.threadId)) continue;
    seen.add(meta.threadId);
    items.push({
      threadId: meta.threadId,
      title: meta.title || meta.threadId.slice(0, 20),
      cwd: meta.cwd || null,
      updatedAt: meta.updatedAt || null,
      cliVersion: meta.cliVersion || '',
      source: meta.source || '',
      rolloutPath: filePath,
      alreadyImported: imported.has(meta.threadId),
    });
  }
  wsSend(ws, {
    type: 'codex_sessions',
    sessions: items,
    totalFiles: files.length,
    truncated: files.length > scanList.length,
  });
}

function handleImportCodexSession(ws, msg) {
  const threadId = String(msg?.threadId || '').trim();
  if (!threadId) {
    return wsSend(ws, { type: 'error', message: '缺少 threadId' });
  }

  let parsed = null;
  const requestedPath = msg?.rolloutPath ? path.resolve(String(msg.rolloutPath)) : '';
  if (requestedPath && requestedPath.startsWith(CODEX_SESSIONS_DIR) && fs.existsSync(requestedPath)) {
    parsed = parseCodexRolloutFile(requestedPath);
  }
  if (!parsed) {
    for (const filePath of getCodexRolloutFiles()) {
      const meta = readImportMeta(filePath, (p) => parseCodexRolloutFile(p)?.meta || null);
      if (meta?.threadId !== threadId) continue;
      const candidate = parseCodexRolloutFile(filePath);
      if (candidate?.meta?.threadId === threadId) {
        parsed = candidate;
        break;
      }
    }
  }

  if (!parsed || parsed.meta.threadId !== threadId) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Codex 会话文件' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (s.codexThreadId === threadId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title: parsed.meta.title || existingSession?.title || threadId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: threadId,
    importedFrom: 'codex',
    importedRolloutPath: parsed.filePath,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
  };

  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListCwdSuggestions(ws) {
  const paths = new Set();
  // Always include HOME
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) paths.add(home);
  wsSend(ws, { type: 'cwd_suggestions', paths: Array.from(paths).sort() });
}

// === Startup ===
recoverProcesses();

// Periodic heartbeat: log active processes status every 60s
setInterval(() => {
  if (activeProcesses.size === 0) return;
  const procs = [];
  for (const [sid, entry] of activeProcesses) {
    const alive = isProcessRunning(entry.pid);
    procs.push({
      sessionId: sid.slice(0, 8),
      pid: entry.pid,
      alive,
      wsConnected: !!entry.ws,
      wsDisconnectTime: entry.wsDisconnectTime || null,
      responseLen: (entry.fullText || '').length,
    });
  }
  plog('INFO', 'heartbeat', { activeCount: procs.length, wsClients: wss.clients.size, processes: procs });
}, 60000);

plog('INFO', 'server_start', { port: PORT });

let shuttingDown = false;

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  plog('INFO', 'server_shutdown_start', { reason, activeProcesses: activeProcesses.size });

  try {
    for (const client of wss.clients) {
      try { client.close(1001, 'server shutting down'); } catch {}
    }
  } catch {}

  try {
    for (const [, entry] of activeProcesses) {
      if (entry.tailer) entry.tailer.stop();
    }
  } catch {}

  const forceTimer = setTimeout(() => {
    plog('WARN', 'server_shutdown_forced', { reason });
    process.exit(exitCode);
  }, 5000);
  forceTimer.unref?.();

  try {
    server.close(() => {
      clearTimeout(forceTimer);
      plog('INFO', 'server_shutdown_complete', { reason });
      process.exit(exitCode);
    });
  } catch (err) {
    clearTimeout(forceTimer);
    plog('ERROR', 'server_shutdown_error', { reason, error: err.message });
    process.exit(exitCode);
  }
}

function killPortOccupant(port) {
  try {
    const result = require('child_process').execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (!result) return false;
    for (const pid of result.split('\n').map(Number).filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    // Wait for port to be released
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const check = require('child_process').execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
        if (!check) return true;
      } catch { return true; }
      require('child_process').execSync('sleep 0.2', { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

function handleServerListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    plog('WARN', 'server_port_in_use_retry', { port: PORT, host: '127.0.0.1' });
    if (killPortOccupant(PORT)) {
      try { server.listen(PORT, '127.0.0.1'); } catch {}
      return;
    }
    plog('ERROR', 'server_port_in_use', { port: PORT, error: err.message });
    console.error(`CC-Web server failed: 127.0.0.1:${PORT} is already in use.`);
    process.exit(98);
    return;
  }
  plog('ERROR', 'server_error', { error: err?.message || String(err) });
  console.error(err);
  process.exit(1);
}

server.on('error', handleServerListenError);

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') return handleServerListenError(err);
  plog('ERROR', 'uncaught_exception', { error: err?.stack || err?.message || String(err) });
  console.error(err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  plog('ERROR', 'unhandled_rejection', { error: reason?.stack || reason?.message || String(reason) });
});

server.listen(PORT, '127.0.0.1', () => {
  ensureAuthLoaded();
  console.log(`CC-Web server listening on 127.0.0.1:${PORT}`);
});
