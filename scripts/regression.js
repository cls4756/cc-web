#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { createAgentRuntime } = require('../lib/agent-runtime');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', 'mock-codex.js');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close(() => resolve(port));
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testProfileProxyEnv() {
  let claudeConfig = {
    mode: 'custom',
    activeTemplate: 'Direct',
    templates: [{ name: 'Direct', useProxy: false, proxyUrl: '' }],
  };
  let codexConfig = {
    mode: 'custom',
    activeProfile: 'Proxy',
    profiles: [{ name: 'Proxy', useProxy: true, proxyUrl: 'socks5://127.0.0.1:7890' }],
  };
  const runtime = createAgentRuntime({
    processEnv: {
      HOME: '/tmp',
      HTTP_PROXY: 'http://global-proxy:8080',
      HTTPS_PROXY: 'http://global-proxy:8080',
      NO_PROXY: 'localhost',
    },
    CLAUDE_PATH: 'claude',
    CODEX_PATH: 'codex',
    MODEL_MAP: {},
    loadModelConfig: () => claudeConfig,
    applyCustomTemplateToSettings: () => {},
    loadCodexConfig: () => codexConfig,
    prepareCodexCustomRuntime: (config) => ({
      mode: 'custom',
      homeDir: '/tmp/codex-proxy-test',
      apiKey: 'test-key',
      ...config.profiles[0],
    }),
    wsSend: () => {},
    truncateObj: (value) => value,
    sanitizeToolInput: (value) => value,
    loadSession: () => null,
    saveSession: () => {},
    setRuntimeSessionId: () => {},
    getRuntimeSessionId: () => null,
  });

  const directClaude = runtime.buildClaudeSpawnSpec({ permissionMode: 'default' });
  assert(!directClaude.env.HTTP_PROXY && !directClaude.env.HTTPS_PROXY && !directClaude.env.ALL_PROXY, 'Claude direct template should clear inherited proxy variables');

  claudeConfig = {
    mode: 'custom',
    activeTemplate: 'Proxy',
    templates: [{ name: 'Proxy', useProxy: true, proxyUrl: 'http://127.0.0.1:7890' }],
  };
  const proxyClaude = runtime.buildClaudeSpawnSpec({ permissionMode: 'default' });
  assert(proxyClaude.env.HTTP_PROXY === 'http://127.0.0.1:7890', 'Claude proxy template should inject HTTP_PROXY');
  assert(!proxyClaude.env.NO_PROXY, 'Claude proxy template should clear inherited NO_PROXY');

  const proxyCodex = runtime.buildCodexSpawnSpec({ permissionMode: 'default' });
  assert(proxyCodex.env.ALL_PROXY === 'socks5://127.0.0.1:7890', 'Codex proxy profile should inject ALL_PROXY');

  codexConfig = {
    mode: 'custom',
    activeProfile: 'Direct',
    profiles: [{ name: 'Direct', useProxy: false, proxyUrl: '' }],
  };
  const directCodex = runtime.buildCodexSpawnSpec({ permissionMode: 'default' });
  assert(!directCodex.env.HTTP_PROXY && !directCodex.env.HTTPS_PROXY && !directCodex.env.ALL_PROXY, 'Codex direct profile should clear inherited proxy variables');
}

function sql(dbPath, statement) {
  const result = spawnSync('sqlite3', [dbPath, statement], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 failed: ${statement}`);
  return result.stdout.trim();
}

async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = spawnSync('bash', ['-lc', `ss -tln | grep -q ':${port} '`], { encoding: 'utf8' });
    if (probe.status === 0) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function withServer(env, fn) {
  const child = spawn('/usr/bin/node', [SERVER_PATH], {
    cwd: REPO_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForPort(env.PORT, 10000);
    await fn({ child, stdout: () => stdout, stderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
}

function connectWs(port, password) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password }));
    });
    ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf));
      messages.push(msg);
      if (msg.type === 'auth_result' && msg.success) resolve({ ws, messages, token: msg.token });
      if (msg.type === 'auth_result' && !msg.success) reject(new Error('Auth failed'));
    });
    ws.on('error', reject);
  });
}

async function uploadAttachment(port, token, { filename, mime, data }) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const { status, text } = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/attachments',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mime,
        'X-Filename': encodeURIComponent(filename),
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Attachment upload returned non-JSON (${status}): ${text.slice(0, 200)}`);
  }
  assert(status >= 200 && status < 300 && payload.ok, `Attachment upload failed: ${payload.message || status}`);
  return payload.attachment;
}

function nextMessage(messages, ws, predicate, timeoutMs = 15000) {
  const callSite = (() => {
    const stack = String(new Error().stack || '').split('\n');
    return (stack[3] || stack[2] || '').trim();
  })();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = messages.findIndex(predicate);
      if (idx !== -1) {
        clearInterval(timer);
        const found = messages.splice(idx, 1)[0];
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        const recentTypes = messages.slice(-12).map((m) => m?.type).join(', ');
        const pendingTypes = messages.slice(0, 12).map((m) => m?.type).join(', ');
        reject(new Error(`Timed out waiting for expected WebSocket message (wsState=${ws.readyState}, callSite=${callSite}, pendingTypes=[${pendingTypes}], recentTypes=[${recentTypes}])`));
      }
    }, 50);
  });
}

function createFakeClaudeHistory(homeDir) {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'tmp-project');
  mkdirp(projectDir);
  const sessionId = 'claude-import-test';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/project-a',
      timestamp: '2026-03-12T00:00:00.000Z',
      message: { content: 'Claude import prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-12T00:00:02.000Z',
      message: { content: [{ type: 'text', text: 'Claude import answer' }] },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return { sessionId, projectDir: 'tmp-project', filePath };
}

function createFakeCodexHistory(homeDir) {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const threadId = 'codex-import-thread';
  const rolloutPath = path.join(sessionsDir, 'rollout-2026-03-12T00-00-00-codex-import-thread.jsonl');
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project-b', cli_version: '0.114.0', source: 'exec' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md wrapper should be ignored' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex import prompt' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex import answer' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } },
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`);

  const stateDb = path.join(homeDir, '.codex', 'state_5.sqlite');
  mkdirp(path.dirname(stateDb));
  sql(stateDb, `
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled'
    );
    CREATE TABLE IF NOT EXISTS stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL,
      raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
    VALUES ('${threadId}', '${rolloutPath.replace(/'/g, "''")}', 1, 2, 'exec', 'OpenAI', '/tmp/project-b', 'Codex import prompt', '{}', 'never', '0.114.0');
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  const logsDb = path.join(homeDir, '.codex', 'logs_1.sqlite');
  sql(logsDb, `
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  return { threadId, rolloutPath, stateDb, logsDb };
}

async function main() {
  testProfileProxyEnv();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-regression-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  fs.writeFileSync(path.join(configDir, 'notify.json'), JSON.stringify({
    provider: 'off',
    pushplus: { token: '' },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
  }, null, 2));

  createFakeClaudeHistory(homeDir);
  const codexFixture = createFakeCodexHistory(homeDir);

  const historicalSessionId = 'historical-session-time';
  const historicalSessionPath = path.join(sessionsDir, `${historicalSessionId}.json`);
  const pollutedUpdated = '2026-08-09T13:20:31.700Z';
  const historicalLastMessageAt = '2024-02-03T04:05:06.000Z';
  fs.writeFileSync(historicalSessionPath, JSON.stringify({
    id: historicalSessionId,
    title: 'Historical session time',
    agent: 'codex',
    model: 'gpt-old',
    updated: pollutedUpdated,
    messages: [
      { role: 'user', content: 'old question', timestamp: '2024-02-03T04:00:00.000Z' },
      { role: 'assistant', content: 'old answer', timestamp: historicalLastMessageAt },
    ],
  }, null, 2));

  const port = await getFreePort();
  const password = 'Regression!234';

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  }, async () => {
    const { ws, messages, token } = await connectWs(port, password);

    const initialSessionList = await nextMessage(messages, ws, (msg) => msg.type === 'session_list');
    const historicalSession = initialSessionList.sessions.find((session) => session.id === historicalSessionId);
    assert(historicalSession?.updated === historicalLastMessageAt, 'Session list should use the last message timestamp instead of polluted metadata time');

    ws.send(JSON.stringify({
      type: 'save_codex_config',
      config: {
        mode: 'custom',
        activeProfile: 'Regression Profile',
        profiles: [{
          name: 'Regression Profile',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          useProxy: true,
          proxyUrl: 'http://127.0.0.1:7890',
          model: 'gpt-5.5',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
        }],
        enableSearch: true,
      },
    }));
    const codexConfigMsg = await nextMessage(messages, ws, (msg) => msg.type === 'codex_config');
    assert(codexConfigMsg.config.mode === 'custom', 'Codex config mode save/load failed');
    assert(codexConfigMsg.config.activeProfile === 'Regression Profile', 'Codex active profile save/load failed');
    assert(Array.isArray(codexConfigMsg.config.profiles) && codexConfigMsg.config.profiles[0]?.apiKey.includes('****'), 'Codex profile API key should be masked');
    assert(codexConfigMsg.config.profiles[0]?.model === 'gpt-5.5', 'Codex profile model save/load failed');
    assert(codexConfigMsg.config.profiles[0]?.useProxy === true, 'Codex profile proxy toggle save/load failed');
    assert(codexConfigMsg.config.profiles[0]?.proxyUrl === 'http://127.0.0.1:7890', 'Codex profile proxy URL save/load failed');
    assert(Array.isArray(codexConfigMsg.config.profiles[0]?.models) && codexConfigMsg.config.profiles[0].models.length === 3, 'Codex profile model list save/load failed');
    assert(codexConfigMsg.config.supportsSearch === false, 'Codex config should expose unsupported search capability');
    assert(codexConfigMsg.config.enableSearch === false, 'Codex config should ignore unsupported search toggle');
    const historicalSessionAfterConfig = JSON.parse(fs.readFileSync(historicalSessionPath, 'utf8'));
    assert(historicalSessionAfterConfig.updated === pollutedUpdated, 'Bulk Codex model sync should not change chat activity time');
    assert(historicalSessionAfterConfig.model === 'gpt-5.5', 'Bulk Codex model sync should still update the session model');

    const codexInitCwd = path.join(tempRoot, 'codex-space');
    mkdirp(codexInitCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: codexInitCwd, mode: 'plan' }));
    const codexSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === codexInitCwd);
    assert(codexSession.mode === 'plan', 'Codex new_session should follow requested mode');
    assert(codexSession.model === 'gpt-5.5', 'Codex new_session should inject configured profile model');

    ws.send(JSON.stringify({ type: 'message', text: '/init', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexInitStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /AGENTS\.md/.test(msg.message || ''));
    assert(/AGENTS\.md/.test(codexInitStart.message || ''), 'Codex /init should announce AGENTS.md generation');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codexSession.sessionId);
    assert(fs.existsSync(path.join(codexInitCwd, 'AGENTS.md')), 'Codex /init should generate AGENTS.md in the workspace');

    ws.send(JSON.stringify({ type: 'message', text: '/model gpt-5.3-codex', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexModelChanged = await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'gpt-5.3-codex');
    assert(codexModelChanged.model === 'gpt-5.3-codex', 'Codex /model should accept arbitrary Codex model names');

    const codexAttachment = await uploadAttachment(port, token, {
      filename: 'codex-test.png',
      mime: 'image/png',
      data: Buffer.from('codex-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'first codex prompt', attachments: [codexAttachment], mode: 'yolo', agent: 'codex' }));
    const firstMessageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'first codex prompt');
    assert(firstMessageSession.agent === 'codex', 'First-message path created wrong agent');
    const runningSessionList = await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && msg.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning));
    assert(runningSessionList.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning), 'Running Codex session should be marked as isRunning');
    const firstMessageDone = await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    assert(Number.isFinite(Date.parse(firstMessageDone.timestamp)), 'Done event should include the persisted assistant message timestamp');

    // Switching permission mode must not clear Codex thread id (otherwise resume loses context).
    const codexSessionPath = path.join(sessionsDir, `${firstMessageSession.sessionId}.json`);
    await waitForFile(codexSessionPath, 15000);
    const storedAfterFirst = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    const threadIdBeforeMode = storedAfterFirst.codexThreadId;
    assert(threadIdBeforeMode, 'Codex thread id should be persisted after first run');
    assert(storedAfterFirst.messages.at(-1)?.timestamp === firstMessageDone.timestamp, 'Displayed assistant timestamp should match the persisted message timestamp');

    ws.send(JSON.stringify({ type: 'set_mode', sessionId: firstMessageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    await waitForFile(codexSessionPath, 15000);
    const storedAfterMode = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(storedAfterMode.codexThreadId === threadIdBeforeMode, 'Codex thread id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second codex prompt', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    const codexFrames = (sessionId) => {
      const p = path.join(configDir, 'codex-session-home', sessionId, 'frames.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    };
    const framesOf = (sessionId, method) => codexFrames(sessionId).filter((f) => f.method === method);
    const firstFrame = (sessionId, method) => framesOf(sessionId, method)[0] || null;
    const lastFrame = (sessionId, method) => framesOf(sessionId, method).pop() || null;

    const storedBeforeTruncate = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    const secondUserMessage = storedBeforeTruncate.messages.find((message) => message.role === 'user' && message.content === 'second codex prompt');
    assert(secondUserMessage?.timestamp, 'Second Codex user message should be persisted with a timestamp');
    ws.send(JSON.stringify({
      type: 'truncate_session',
      sessionId: firstMessageSession.sessionId,
      timestamp: secondUserMessage.timestamp,
      content: secondUserMessage.content,
    }));
    const truncatedCodex = await nextMessage(messages, ws, (msg) => msg.type === 'session_truncated' && msg.sessionId === firstMessageSession.sessionId);
    assert(truncatedCodex.messages.filter((message) => message.role === 'user').length === 1, 'Codex truncate should keep only earlier user turns');
    const rollbackFrame = lastFrame(firstMessageSession.sessionId, 'thread/rollback');
    assert(rollbackFrame, 'Codex truncate should call thread/rollback');
    assert(rollbackFrame.params.threadId === threadIdBeforeMode, 'Codex rollback should target the active thread');
    assert(rollbackFrame.params.numTurns === 1, 'Codex rollback should remove the target turn and everything after it');
    const rollbackFrames = codexFrames(firstMessageSession.sessionId);
    let rollbackIndex = -1;
    for (let i = rollbackFrames.length - 1; i >= 0; i--) {
      const frame = rollbackFrames[i];
      if (frame.method !== 'thread/rollback') continue;
      if (frame.params?.threadId !== threadIdBeforeMode || frame.params?.numTurns !== 1) continue;
      rollbackIndex = i;
      break;
    }
    assert(rollbackIndex >= 0, 'Codex rollback frame should remain present in the frame log');
    const rollbackResumeFrame = rollbackFrames.slice(0, rollbackIndex).reverse().find((frame) => frame.method === 'thread/resume');
    assert(rollbackResumeFrame, 'Codex rollback should resume the thread in the temporary app-server first');
    assert(rollbackResumeFrame.params.threadId === threadIdBeforeMode, 'Codex rollback resume should target the active thread');

    // Codex now runs over the app-server, so the turn config travels as JSON-RPC params
    // rather than argv. Assert on the frames the mock actually received.
    const firstTurn = firstFrame(firstMessageSession.sessionId, 'turn/start');
    assert(firstTurn, 'Codex turn/start should reach the app-server');
    assert(firstTurn.params.input.some((i) => i.type === 'localImage'), 'Codex attachments should be sent as localImage input');

    // yolo must run unsandboxed with approvals off, otherwise Codex prompts for every edit.
    const yoloStart = firstFrame(firstMessageSession.sessionId, 'thread/start');
    assert(yoloStart.params.sandbox === 'danger-full-access', 'Codex yolo mode should disable the sandbox');
    assert(yoloStart.params.approvalPolicy === 'never', 'Codex yolo mode should not ask for approvals');

    // The app-server handshake requires an `initialized` notification before thread/start.
    const handshake = codexFrames(firstMessageSession.sessionId).map((f) => f.method).filter(Boolean);
    assert(handshake.indexOf('initialized') > handshake.indexOf('initialize'), 'Codex client should send initialized after initialize');
    assert(handshake.indexOf('initialized') < handshake.indexOf('thread/start'), 'Codex client should send initialized before thread/start');

	    const resumeFrame = lastFrame(firstMessageSession.sessionId, 'thread/resume');
	    assert(resumeFrame, 'Codex should resume an existing thread instead of starting a new one');
	    assert(resumeFrame.params.threadId === threadIdBeforeMode, 'Codex mode switch should keep resume thread id');
	    assert(resumeFrame.params.sandbox === 'read-only', 'Codex plan mode should set sandbox read-only');
	    assert(resumeFrame.params.approvalPolicy === 'on-request', 'Codex plan mode should keep approvals on-request');

    ws.send(JSON.stringify({
      type: 'save_codex_config',
      config: {
        mode: 'custom',
        activeProfile: 'Regression Profile 2',
        profiles: [{
          name: 'Regression Profile 2',
          apiKey: 'sk-regression-2',
          apiBase: 'https://example.org/v1',
          model: 'gpt-5.4',
          models: ['gpt-5.4'],
        }],
      },
    }));
    await nextMessage(messages, ws, (msg) => msg.type === 'codex_config' && msg.config.activeProfile === 'Regression Profile 2');
    const storedAfterProfileSwitch = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(storedAfterProfileSwitch.codexThreadId === threadIdBeforeMode, 'Codex profile switch should not clear thread id');
    assert(storedAfterProfileSwitch.model === 'gpt-5.4', 'Codex profile switch should update existing session model');

    ws.send(JSON.stringify({ type: 'message', text: 'third codex prompt', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const profileSwitchResume = lastFrame(firstMessageSession.sessionId, 'thread/resume');
    assert(profileSwitchResume.params.threadId === threadIdBeforeMode, 'Codex profile switch should keep resume context');
    assert(profileSwitchResume.params.model === 'gpt-5.4', 'Codex profile switch should run with new profile model');

    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-session-home', firstMessageSession.sessionId, 'config.toml'), 'utf8');
    assert(runtimeToml.includes('preferred_auth_method = "apikey"'), 'Codex custom profile should write isolated runtime auth mode');
    assert(runtimeToml.includes('base_url = "https://example.org/v1"'), 'Codex custom profile should write isolated runtime base_url');
    assert(runtimeToml.includes('model = "gpt-5.4"'), 'Codex custom profile should write isolated runtime model');

    ws.send(JSON.stringify({ type: 'message', text: '/compact', sessionId: firstMessageSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在执行/.test(msg.message || '') && /Codex \/compact/.test(msg.message || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const compactDoneMsg = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(compactDoneMsg.message || ''), 'Codex /compact should complete with Codex-specific status message');

    const autoCompactCwd = path.join(tempRoot, 'codex-auto-compact');
    mkdirp(autoCompactCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: autoCompactCwd, mode: 'yolo' }));
    const autoCompactSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === autoCompactCwd);
    ws.send(JSON.stringify({ type: 'message', text: 'warm up auto compact', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId);
    ws.send(JSON.stringify({ type: 'message', text: 'trigger codex context limit', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    const autoCompactStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在按 Codex \/compact 自动压缩/.test(msg.message || ''));
    assert(/Codex \/compact/.test(autoCompactStart.message || ''), 'Codex auto /compact should announce auto compact start');
    const autoCompactDone = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(autoCompactDone.message || ''), 'Codex auto /compact should finish compact step');
	    const autoCompactResume = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /按 Codex 压缩计划继续执行/.test(msg.message || ''));
	    assert(/继续执行/.test(autoCompactResume.message || ''), 'Codex auto /compact should announce retry');
	    // Some Codex builds won't echo the original prompt text as a text delta on retry; accept either.
	    const autoCompactRetry = await nextMessage(messages, ws, (msg) => (
	      (msg.type === 'text_delta' && /trigger codex context limit/.test(msg.text || '')) ||
	      (msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId)
	    ), 20000);
	    if (autoCompactRetry.type === 'text_delta') {
	      assert(/trigger codex context limit/.test(autoCompactRetry.text || ''), 'Codex auto /compact should replay the failed prompt after compact');
	    }

    const claudeAttachment = await uploadAttachment(port, token, {
      filename: 'claude-test.png',
      mime: 'image/png',
      data: Buffer.from('claude-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'describe attachment', attachments: [claudeAttachment], mode: 'yolo', agent: 'claude' }));
    const claudeImageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'describe attachment');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawnLine = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should switch stdin to stream-json');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');
    assert(storedClaudeSession.claudeSessionId, 'Claude session id should be persisted after first run');
    const claudeSessionIdBeforeMode = storedClaudeSession.claudeSessionId;

    // Mode switching must not clear Claude runtime session id (resume should keep context).
    ws.send(JSON.stringify({ type: 'set_mode', sessionId: claudeImageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    const storedClaudeAfterMode = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeAfterMode.claudeSessionId === claudeSessionIdBeforeMode, 'Claude session id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second claude prompt', sessionId: claudeImageSession.sessionId, mode: 'plan', agent: 'claude' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    const lastClaudeSpawn = claudeSpawns[claudeSpawns.length - 1] || '';
    assert(lastClaudeSpawn.includes(`--resume ${claudeSessionIdBeforeMode}`), 'Claude mode switch should keep --resume session id');
    assert(lastClaudeSpawn.includes('--permission-mode plan'), 'Claude plan mode should set --permission-mode plan');

    ws.send(JSON.stringify({ type: 'list_native_sessions' }));
    const nativeSessions = await nextMessage(messages, ws, (msg) => msg.type === 'native_sessions');
    assert(nativeSessions.groups?.length > 0, 'Claude native session listing failed');
    const firstClaude = nativeSessions.groups[0].sessions[0];
    ws.send(JSON.stringify({ type: 'import_native_session', sessionId: firstClaude.sessionId, projectDir: nativeSessions.groups[0].dir }));
    const importedClaude = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'Claude import prompt');
    assert(importedClaude.messages?.[0]?.content === 'Claude import prompt', 'Claude import parsed wrong first message');
    assert(firstClaude.alreadyImported === false, 'Claude session should not be flagged as imported before import');
    ws.send(JSON.stringify({ type: 'list_native_sessions' }));
    const nativeSessionsAfter = await nextMessage(messages, ws, (msg) => msg.type === 'native_sessions');
    const reListedClaude = nativeSessionsAfter.groups
      .flatMap((group) => group.sessions)
      .find((item) => item.sessionId === firstClaude.sessionId);
    assert(reListedClaude?.alreadyImported === true, 'Imported Claude session should be flagged as already imported');

    ws.send(JSON.stringify({ type: 'list_codex_sessions' }));
    const codexSessions = await nextMessage(messages, ws, (msg) => msg.type === 'codex_sessions');
    const importedCodexItem = codexSessions.sessions.find((item) => item.threadId === codexFixture.threadId);
    assert(importedCodexItem, 'Codex session listing failed');

    ws.send(JSON.stringify({ type: 'import_codex_session', threadId: importedCodexItem.threadId, rolloutPath: importedCodexItem.rolloutPath }));
    const importedCodex = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'Codex import prompt');
    assert(importedCodex.messages?.[0]?.content === 'Codex import prompt', 'Codex import kept wrapper instructions');
    assert(importedCodex.totalUsage?.inputTokens === 20, 'Codex import usage parse failed');
    assert(importedCodexItem.alreadyImported === false, 'Codex session should not be flagged as imported before import');
    ws.send(JSON.stringify({ type: 'list_codex_sessions' }));
    const codexSessionsAfter = await nextMessage(messages, ws, (msg) => msg.type === 'codex_sessions');
    const reListedCodex = codexSessionsAfter.sessions.find((item) => item.threadId === codexFixture.threadId);
    assert(reListedCodex?.alreadyImported === true, 'Imported Codex session should be flagged as already imported');

    const importedSessionId = importedCodex.sessionId;
    ws.send(JSON.stringify({ type: 'delete_session', sessionId: importedSessionId }));
    await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && !msg.sessions.some((s) => s.id === importedSessionId));

    assert(!fs.existsSync(path.join(sessionsDir, `${importedSessionId}.json`)), 'Deleting Codex session did not remove session JSON');
    assert(!fs.existsSync(codexFixture.rolloutPath), 'Deleting Codex session did not remove rollout file');
    assert(sql(codexFixture.stateDb, `select count(*) from threads where id='${codexFixture.threadId}'`) === '0', 'Deleting Codex session did not remove thread row');

    // A session longer than the initial window must arrive as a bounded window
    // plus ordered older chunks, with the total reported independently of how
    // much has been delivered so far.
    const longSessionId = '11111111-2222-3333-4444-555555555555';
    const longMessages = [];
    for (let i = 0; i < 40; i++) {
      longMessages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `history-${i}`,
        attachments: [],
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    fs.writeFileSync(path.join(sessionsDir, `${longSessionId}.json`), JSON.stringify({
      id: longSessionId,
      title: 'long history session',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:40.000Z',
      agent: 'claude',
      claudeSessionId: null,
      codexThreadId: null,
      model: null,
      permissionMode: 'yolo',
      totalCost: 0,
      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      messages: longMessages,
      cwd: null,
    }, null, 2));

    ws.send(JSON.stringify({ type: 'load_session', sessionId: longSessionId }));
    const longInfo = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.sessionId === longSessionId);
    assert(longInfo.historyTotal === 40, `Long session should report 40 total, got ${longInfo.historyTotal}`);
    assert(longInfo.messages.length < 40, 'Initial window must not carry the whole history');
    assert(longInfo.messages.length === longInfo.historyBuffered, 'historyBuffered must match the delivered window');
    assert(longInfo.historyPending === true, 'Long session must report that older history remains');
    assert(
      longInfo.messages[longInfo.messages.length - 1].content === 'history-39',
      'Initial window must end at the newest message',
    );

    let reassembled = longInfo.messages.slice();
    let chunkCount = 0;
    for (;;) {
      const chunk = await nextMessage(messages, ws, (msg) => msg.type === 'session_history_chunk' && msg.sessionId === longSessionId);
      reassembled = chunk.messages.concat(reassembled);
      chunkCount++;
      if (!chunk.remaining) break;
      assert(chunkCount < 20, 'History chunk stream did not terminate');
    }
    assert(reassembled.length === 40, `History chunks should reassemble to 40 messages, got ${reassembled.length}`);
    assert(
      reassembled.every((message, index) => message.content === `history-${index}`),
      'History chunks should reassemble in original order',
    );

    // A resent clientMessageId with no sessionId must resolve back to the
    // original session, and must stop doing so once that session is deleted.
    const retryClientMessageId = 'retry-probe-1';
    ws.send(JSON.stringify({ type: 'message', text: 'dedupe probe', clientMessageId: retryClientMessageId, mode: 'yolo', agent: 'claude' }));
    const firstAccept = await nextMessage(messages, ws, (msg) => msg.type === 'message_accepted' && msg.clientMessageId === retryClientMessageId);
    const dedupeSessionId = firstAccept.sessionId;
    assert(dedupeSessionId, 'First send should report the session it created');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === dedupeSessionId);

    ws.send(JSON.stringify({ type: 'message', text: 'dedupe probe', clientMessageId: retryClientMessageId, mode: 'yolo', agent: 'claude' }));
    const secondAccept = await nextMessage(messages, ws, (msg) => msg.type === 'message_accepted' && msg.clientMessageId === retryClientMessageId);
    assert(secondAccept.sessionId === dedupeSessionId, 'Resent clientMessageId should map back to the original session');
    const dedupeStored = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${dedupeSessionId}.json`), 'utf8'));
    assert(
      dedupeStored.messages.filter((message) => message?.clientMessageId === retryClientMessageId).length === 1,
      'Resent clientMessageId should not be appended twice',
    );

    ws.send(JSON.stringify({ type: 'delete_session', sessionId: dedupeSessionId }));
    await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && !msg.sessions.some((s) => s.id === dedupeSessionId));
    ws.send(JSON.stringify({ type: 'message', text: 'dedupe probe', clientMessageId: retryClientMessageId, mode: 'yolo', agent: 'claude' }));
    const thirdAccept = await nextMessage(messages, ws, (msg) => msg.type === 'message_accepted' && msg.clientMessageId === retryClientMessageId);
    assert(thirdAccept.sessionId !== dedupeSessionId, 'Deleted session must not keep answering for its clientMessageIds');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === thirdAccept.sessionId);

    ws.close();
    console.log('Regression checks passed.');
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
