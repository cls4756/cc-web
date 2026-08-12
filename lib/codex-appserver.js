// Codex app-server (bidirectional JSON-RPC over stdio) client.
//
// Unlike `codex exec` (one-shot, detached, output tailed from a file), the app-server
// is a persistent process we talk to over stdin/stdout. This is what lets us intercept
// Codex's approval requests before an action runs and route the decision to a human in
// the web UI.
//
// Which actions escalate is decided by the sandbox + approval policy we send on
// thread/start; `approvalsReviewer: user` is what routes those escalations to us
// instead of to a Codex-side subagent.

const crypto = require('crypto');

function createCodexAppServer(deps) {
  const {
    wsSend,
    plog,
    loadSession,
    saveSession,
    setRuntimeSessionId,
  } = deps;

  // sessionId -> connection state. One active Codex turn per session at a time,
  // matching server.js's activeProcesses model.
  const connections = new Map();

  function sendFrame(conn, obj) {
    try {
      conn.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      plog('WARN', 'codex_appserver_write_fail', { sessionId: conn.sessionId.slice(0, 8), error: err.message });
    }
  }

  function request(conn, method, params) {
    const id = conn.nextId++;
    conn.pending.set(id, method);
    sendFrame(conn, { jsonrpc: '2.0', id, method, params });
    return id;
  }

  function notify(conn, method, params) {
    sendFrame(conn, { jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  function respond(conn, id, result) {
    sendFrame(conn, { jsonrpc: '2.0', id, result });
  }

  function respondError(conn, id, message, code = -32601) {
    sendFrame(conn, { jsonrpc: '2.0', id, error: { code, message } });
  }

  // Map cc-web permission mode -> Codex sandbox + approval policy.
  // yolo runs unsandboxed with approvals off; default keeps `workspace-write`, where
  // out-of-cwd actions escalate to `approvalsReviewer: user` and land in the web UI.
  function sandboxForMode(mode) {
    if (mode === 'plan') return 'read-only';
    if (mode === 'yolo') return 'danger-full-access';
    return 'workspace-write';
  }

  function approvalPolicyForMode(mode) {
    return mode === 'yolo' ? 'never' : 'on-request';
  }

  function attach(proc, ctx) {
    const { session, sessionId, entry, promptText, attachments, spec } = ctx;
    const conn = {
      proc,
      sessionId,
      entry,
      get ws() { return entry.ws; },
      session,
      spec,
      promptText: promptText || '',
      attachments: Array.isArray(attachments) ? attachments : [],
      nextId: 1,
      pending: new Map(),
      threadId: spec.threadId || null,
      cwd: spec.cwd,
      buffer: '',
      deltaSeen: new Set(),
      approvals: new Map(), // approvalId -> { serverReqId, method }
      lastTokenUsage: null,
      finished: false,
      turnStarted: false,
    };
    connections.set(sessionId, conn);

    proc.stdout.on('data', (chunk) => {
      conn.buffer += chunk.toString();
      let idx;
      while ((idx = conn.buffer.indexOf('\n')) >= 0) {
        const line = conn.buffer.slice(0, idx).trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        try { handleMessage(conn, msg); } catch (err) {
          plog('WARN', 'codex_appserver_handle_fail', { sessionId: sessionId.slice(0, 8), error: err.message });
        }
      }
    });

    proc.on('exit', () => { connections.delete(sessionId); });

    // Kick off the protocol.
    request(conn, 'initialize', {
      clientInfo: { name: 'cc-web', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
  }

  function handleMessage(conn, msg) {
    // Server -> client request (has both id and method): approvals, elicitations, etc.
    if (msg.method && msg.id !== undefined) {
      handleServerRequest(conn, msg);
      return;
    }
    // Notification (method, no id).
    if (msg.method) {
      handleNotification(conn, msg);
      return;
    }
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      handleResponse(conn, msg);
    }
  }

  function handleResponse(conn, msg) {
    const method = conn.pending.get(msg.id);
    conn.pending.delete(msg.id);
    if (msg.error) {
      plog('WARN', 'codex_appserver_rpc_error', {
        sessionId: conn.sessionId.slice(0, 8),
        method: method || null,
        error: JSON.stringify(msg.error).slice(0, 300),
      });
      if (method === 'initialize' || method === 'thread/start' || method === 'thread/resume') {
        conn.entry.lastError = (msg.error && msg.error.message) || 'Codex app-server 初始化失败';
        endTurn(conn);
      }
      return;
    }
    if (method === 'initialize') {
      notify(conn, 'initialized');
      startOrResumeThread(conn);
    } else if (method === 'thread/start' || method === 'thread/resume') {
      const threadId = msg.result?.thread?.id || msg.result?.threadId || conn.threadId;
      if (threadId) {
        conn.threadId = threadId;
        const s = loadSession(conn.sessionId);
        if (s) {
          setRuntimeSessionId(s, threadId);
          if (conn.spec.codexHomeDir) s.codexHomeDir = conn.spec.codexHomeDir;
          if (conn.spec.codexRuntimeKey) s.codexRuntimeKey = conn.spec.codexRuntimeKey;
          saveSession(s);
        }
      }
      startTurn(conn);
    }
  }

  function startOrResumeThread(conn) {
    const base = {
      cwd: conn.cwd,
      sandbox: sandboxForMode(conn.spec.mode),
      approvalPolicy: approvalPolicyForMode(conn.spec.mode),
      approvalsReviewer: 'user',
    };
    if (conn.spec.model) base.model = conn.spec.model;
    if (conn.spec.reasoningEffort) base.config = { model_reasoning_effort: conn.spec.reasoningEffort };
    if (conn.threadId) {
      request(conn, 'thread/resume', { threadId: conn.threadId, ...base });
    } else {
      request(conn, 'thread/start', base);
    }
  }

  function startTurn(conn) {
    if (conn.turnStarted) return;
    conn.turnStarted = true;
    const input = [];
    if (conn.promptText) input.push({ type: 'text', text: conn.promptText });
    for (const att of conn.attachments) {
      if (att && att.path) input.push({ type: 'localImage', path: att.path });
    }
    if (input.length === 0) input.push({ type: 'text', text: '' });
    request(conn, 'turn/start', { threadId: conn.threadId, input });
  }

  function handleNotification(conn, msg) {
    const { entry, sessionId } = conn;
    const method = msg.method;
    const params = msg.params || {};

    switch (method) {
      case 'item/started': {
        const item = params.item;
        if (!item || !item.id) break;
        if (item.type === 'agentMessage' || item.type === 'userMessage' || item.type === 'reasoning') break;
        ensureToolCall(conn, item);
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!delta) break;
        if (params.itemId) conn.deltaSeen.add(params.itemId);
        appendText(entry, delta);
        wsSend(entry.ws, { type: 'text_delta', sessionId, text: delta }, true);
        break;
      }
      case 'item/completed': {
        const item = params.item;
        if (!item || !item.id) break;
        if (item.type === 'agentMessage') {
          // Only emit text for messages we did not already stream via deltas, and
          // skip intermediate "commentary" to avoid duplicating the final answer.
          if (!conn.deltaSeen.has(item.id) && item.phase !== 'commentary' && item.text) {
            appendText(entry, item.text);
            wsSend(entry.ws, { type: 'text_delta', sessionId, text: item.text }, true);
          }
          break;
        }
        if (item.type === 'userMessage' || item.type === 'reasoning') break;
        const tc = ensureToolCall(conn, item);
        tc.done = true;
        const result = toolResult(item).slice(0, 2000);
        tc.result = result;
        tc.meta = toolMeta(item) || tc.meta;
        wsSend(entry.ws, { type: 'tool_end', sessionId, toolUseId: item.id, result, kind: tc.kind, meta: tc.meta });
        break;
      }
      case 'thread/tokenUsage/updated': {
        conn.lastTokenUsage = params.tokenUsage || null;
        break;
      }
      case 'turn/completed': {
        if (params?.turn?.status === 'failed') {
          entry.lastError = stripUpstreamJson(params.turn.error?.message || 'Codex 任务失败');
        }
        applyUsage(conn);
        endTurn(conn);
        break;
      }
      case 'turn/failed': {
        const message = params?.turn?.error?.message || params?.error?.message || 'Codex 任务失败';
        entry.lastError = stripUpstreamJson(message);
        endTurn(conn);
        break;
      }
      case 'error': {
        const message = params?.error?.message || params?.message || '';
        if (!message) break;
        // Transient reconnects are informational, not turn-fatal.
        if (/^Reconnecting\.\.\./.test(message)) {
          wsSend(entry.ws, { type: 'system_message', message });
        } else {
          entry.lastError = stripUpstreamJson(message);
        }
        break;
      }
    }
  }

  function handleServerRequest(conn, msg) {
    const method = msg.method;
    const params = msg.params || {};

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        routeApproval(conn, msg.id, method, params);
        return;

      // Grants extra filesystem/network access. Not governed by the sandbox policy, so
      // it can still arrive under yolo — auto-grant exactly what was asked for there.
      case 'item/permissions/requestApproval':
        if (conn.spec.mode === 'yolo') {
          respond(conn, msg.id, { permissions: params.permissions || {}, scope: 'session' });
        } else {
          routeApproval(conn, msg.id, method, params);
        }
        return;

      // Codex hit a 401 and wants the client to hand back a fresh ChatGPT token. cc-web
      // has no token of its own (Codex owns the credentials), so decline explicitly and
      // let Codex surface its own auth error instead of failing to parse an empty reply.
      case 'account/chatgptAuthTokens/refresh':
        respondError(conn, msg.id, 'cc-web does not manage Codex ChatGPT credentials', -32000);
        return;

      case 'item/tool/call':
        respondError(conn, msg.id, `Unsupported client tool: ${params.tool || 'unknown'}`, -32601);
        return;

      case 'item/tool/requestUserInput':
        respond(conn, msg.id, { answers: {} });
        return;

      case 'mcpServer/elicitation/request':
        respond(conn, msg.id, { action: 'decline' });
        return;

      default:
        plog('INFO', 'codex_appserver_unhandled_server_request', {
          sessionId: conn.sessionId.slice(0, 8),
          method,
        });
        respondError(conn, msg.id, `Unsupported method: ${method}`, -32601);
    }
  }

  // === Approval routing ===

  function routeApproval(conn, serverReqId, method, params) {
    const info = extractApprovalInfo(method, params, conn);
    const approvalId = crypto.randomUUID();
    conn.approvals.set(approvalId, { serverReqId, method, params });

    plog('INFO', 'codex_approval_request', {
      sessionId: conn.sessionId.slice(0, 8),
      method,
      command: info.command || null,
      paths: info.paths,
      cwd: conn.cwd,
    });

    wsSend(conn.entry.ws, {
      type: 'codex_approval_request',
      sessionId: conn.sessionId,
      approvalId,
      kind: info.kind,
      title: info.title,
      command: info.command,
      cwd: conn.cwd,
      paths: info.paths,
      reason: info.reason,
    });
  }

  function extractApprovalInfo(method, params, conn) {
    const paths = [];
    let kind = 'command';
    let title = '命令执行';
    let command = null;

    if (/fileChange/i.test(method) || method === 'applyPatchApproval') {
      kind = 'file_change';
      title = '文件修改';
      // Legacy applyPatchApproval carries the paths directly.
      if (params.fileChanges && typeof params.fileChanges === 'object') {
        for (const p of Object.keys(params.fileChanges)) paths.push(p);
      }
      // v2 fileChange approval references an itemId; recover paths from the tracked item.
      if (params.itemId) {
        const tracked = conn.entry.toolCalls.find((t) => t.id === params.itemId);
        if (tracked && tracked.meta && tracked.meta.subtitle) paths.push(tracked.meta.subtitle);
      }
    } else if (method === 'item/permissions/requestApproval') {
      kind = 'permissions';
      title = '扩展权限申请';
      const fs = params.permissions?.fileSystem || {};
      for (const p of [...(fs.read || []), ...(fs.write || [])]) {
        if (typeof p === 'string') paths.push(p);
      }
      for (const e of fs.entries || []) {
        if (e && typeof e.path === 'string') paths.push(e.path);
      }
      if (params.permissions?.network?.enabled) paths.push('（网络访问）');
    } else {
      command = params.command || null;
      // Best-effort: surface absolute paths mentioned in the command for display.
      if (command) {
        const m = String(command).match(/(?:^|\s)(\/[^\s"'`|;&>]+)/g);
        if (m) for (const s of m) paths.push(s.trim());
      }
    }

    return {
      kind,
      title,
      command,
      paths: Array.from(new Set(paths)),
      reason: params.reason || null,
    };
  }

  // Called by server.js when the frontend replies to an approval request.
  function resolveApproval(sessionId, approvalId, decision) {
    const conn = connections.get(sessionId);
    if (!conn) return false;
    const pending = conn.approvals.get(approvalId);
    if (!pending) return false;
    conn.approvals.delete(approvalId);

    const value = decisionValue(pending.method, decision, pending.params);
    respond(conn, pending.serverReqId, value);
    plog('INFO', 'codex_approval_resolved', {
      sessionId: sessionId.slice(0, 8),
      approvalId,
      decision,
      method: pending.method,
    });
    return true;
  }

  // Different approval methods expect different reply shapes:
  // v1 (execCommandApproval/applyPatchApproval): { decision: approved | denied | abort }
  // v2 command/fileChange:                      { decision: accept | decline | cancel }
  // v2 permissions:                             { permissions: <granted profile>, scope }
  function decisionValue(method, decision, params) {
    const approve = decision === 'approve' || decision === 'accept' || decision === true;
    if (method === 'item/permissions/requestApproval') {
      if (!approve) return { permissions: {}, scope: 'turn' };
      return { permissions: params?.permissions || {}, scope: 'session' };
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: approve ? 'approved' : 'denied' };
    }
    return { decision: approve ? 'accept' : 'decline' };
  }

  // === helpers shared shape with agent-runtime codex parsing ===

  function ensureToolCall(conn, item) {
    const { entry, sessionId } = conn;
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.name = toolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = toolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = toolInput(item);
      return tc;
    }
    tc = {
      name: toolName(item),
      id: item.id,
      kind: item.type || null,
      meta: toolMeta(item),
      input: toolInput(item),
      done: false,
    };
    if (entry.toolCalls.length < 200) entry.toolCalls.push(tc);
    else entry.toolCallsTruncated = true;
    wsSend(entry.ws, {
      type: 'tool_start',
      sessionId,
      name: tc.name,
      toolUseId: item.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  function toolName(item) {
    switch (item?.type) {
      case 'commandExecution': return 'CommandExecution';
      case 'mcpToolCall': return 'McpToolCall';
      case 'fileChange': return 'FileChange';
      case 'reasoning': return 'Reasoning';
      default: return item?.type || 'CodexItem';
    }
  }

  function toolInput(item) {
    if (!item) return null;
    if (item.type === 'commandExecution') return { command: item.command || '' };
    return null;
  }

  function toolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'commandExecution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
          status: item.status || null,
        };
      case 'mcpToolCall':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.toolName || item.name || item.serverName || '',
          status: item.status || null,
        };
      case 'fileChange':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: item.path || item.filePath || filePathFromChanges(item) || '',
          status: item.status || null,
        };
      default:
        return { kind: item.type || 'codex_item', title: toolName(item), subtitle: '', status: item.status || null };
    }
  }

  function filePathFromChanges(item) {
    if (Array.isArray(item.changes) && item.changes[0]) return item.changes[0].path || '';
    return '';
  }

  function toolResult(item) {
    if (!item) return '';
    if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) return item.aggregatedOutput;
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.text === 'string' && item.text) return item.text;
    if (item.status) return `status: ${item.status}`;
    return '';
  }

  function applyUsage(conn) {
    const tu = conn.lastTokenUsage;
    if (!tu) return;
    const last = tu.last || tu.total || null;
    if (!last) return;
    const s = loadSession(conn.sessionId);
    if (!s) return;
    s.totalUsage = {
      inputTokens: (s.totalUsage?.inputTokens || 0) + (last.inputTokens || 0),
      cachedInputTokens: (s.totalUsage?.cachedInputTokens || 0) + (last.cachedInputTokens || 0),
      outputTokens: (s.totalUsage?.outputTokens || 0) + (last.outputTokens || 0),
    };
    conn.entry.lastUsage = s.totalUsage;
    saveSession(s);
    wsSend(conn.entry.ws, { type: 'usage', totalUsage: s.totalUsage }, true);
  }

  function endTurn(conn) {
    if (conn.finished) return;
    conn.finished = true;
    // Closing the app-server process makes server.js's proc 'exit' handler fire
    // handleProcessComplete, which persists the assistant message and cleans up.
    setTimeout(() => {
      try { conn.proc.kill('SIGTERM'); } catch {}
    }, 150);
  }

  const MAX_FULL_TEXT = 2 * 1024 * 1024;
  function appendText(entry, text) {
    if (!text) return;
    const remaining = MAX_FULL_TEXT - entry.fullText.length;
    if (remaining <= 0) { entry.fullTextTruncated = true; return; }
    if (text.length <= remaining) entry.fullText += text;
    else { entry.fullText += text.slice(0, remaining); entry.fullTextTruncated = true; }
  }

  function stripUpstreamJson(message) {
    if (typeof message !== 'string') return String(message || '');
    const trimmed = message.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const inner = obj?.error?.message || obj?.message;
        if (inner) return String(inner);
      } catch {}
    }
    return message;
  }

  function has(sessionId) {
    return connections.has(sessionId);
  }

  function rollbackThread(proc, { sessionId, threadId, numTurns, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let nextId = 1;
      let initializeId = null;
      let rollbackId = null;
      let settled = false;

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.off('error', onError);
        proc.off('exit', onExit);
        if (error) reject(error);
        else resolve(result);
      };
      const writeRequest = (method, params) => {
        const id = nextId++;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return id;
      };
      const onError = (error) => finish(error);
      const onExit = (code, signal) => {
        finish(new Error(`Codex app-server 在回滚完成前退出（code=${code}, signal=${signal || 'none'}）`));
      };
      const onData = (chunk) => {
        buffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === initializeId) {
            if (message.error) return finish(new Error(message.error.message || 'Codex app-server 初始化失败'));
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            rollbackId = writeRequest('thread/rollback', { threadId, numTurns });
          } else if (message.id === rollbackId) {
            if (message.error) return finish(new Error(message.error.message || 'Codex 会话回滚失败'));
            finish(null, message.result || {});
          }
        }
      };
      const timer = setTimeout(() => finish(new Error('Codex 会话回滚超时')), timeoutMs);
      timer.unref?.();
      proc.stdout.on('data', onData);
      proc.once('error', onError);
      proc.once('exit', onExit);
      initializeId = writeRequest('initialize', {
        clientInfo: { name: 'cc-web', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      plog('INFO', 'codex_thread_rollback_start', {
        sessionId: sessionId.slice(0, 8),
        threadId,
        numTurns,
      });
    });
  }

  return { attach, resolveApproval, has, rollbackThread };
}

module.exports = { createCodexAppServer };
