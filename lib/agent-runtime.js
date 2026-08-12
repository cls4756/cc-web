function createAgentRuntime(deps) {
  const {
    processEnv,
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
  } = deps;

  const MAX_FULL_TEXT_CHARS = 2 * 1024 * 1024; // 2M UTF-16 code units
  const MAX_TOOL_CALLS = 200;
  const PROXY_ENV_KEYS = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ];

  function applyProxyConfig(env, config) {
    for (const key of PROXY_ENV_KEYS) delete env[key];
    const proxyUrl = String(config?.proxyUrl || '').trim();
    if (!config?.useProxy || !proxyUrl) return;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
  }

  function appendFullText(entry, text) {
    if (!text) return;
    const remaining = MAX_FULL_TEXT_CHARS - entry.fullText.length;
    if (remaining <= 0) {
      entry.fullTextTruncated = true;
      return;
    }
    if (text.length <= remaining) {
      entry.fullText += text;
    } else {
      // Avoid splitting a surrogate pair at the boundary
      let end = remaining;
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1;
      }
      entry.fullText += text.slice(0, end);
      entry.fullTextTruncated = true;
    }
  }

  function buildClaudeSpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (hasAttachments) args.push('--input-format', 'stream-json');
    const permMode = session.permissionMode || 'yolo';
    const isRootOrSudo = (() => {
      try {
        if (typeof processEnv.SUDO_USER === 'string' && processEnv.SUDO_USER) return true;
        if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
        if (typeof process.geteuid === 'function' && process.geteuid() === 0) return true;
      } catch {}
      return false;
    })();
    switch (permMode) {
      case 'yolo':
        if (isRootOrSudo) {
          args.push('--permission-mode', 'default');
        } else {
          args.push('--dangerously-skip-permissions');
        }
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        args.push('--permission-mode', 'default');
        break;
    }
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }

    const env = { ...processEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CC_WEB_PASSWORD;
    for (const k of Object.keys(env)) {
      if (k.startsWith('ANTHROPIC_')) delete env[k];
    }

    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) {
        applyCustomTemplateToSettings(tpl);
        applyProxyConfig(env, tpl);
      }
    }

    return {
      command: CLAUDE_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'claude',
      mode: permMode,
      resume: !!session.claudeSessionId,
    };
  }

  function buildCodexSpawnSpec(session, options = {}) {
    const codexConfig = loadCodexConfig();
    const runtimeConfig = prepareCodexCustomRuntime(codexConfig, session);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
	    }
	    const runtimeId = getRuntimeSessionId(session);
    const permMode = session.permissionMode || 'yolo';

    // Range 1 approval guard: drive Codex through the bidirectional app-server so we can
    // intercept out-of-workspace actions before they run. The turn itself is driven over
    // JSON-RPC by lib/codex-appserver.js; these args only start the server.
    const args = ['app-server'];

    // cc-web UI supports "gpt-5.4(high)" style selection: split base model and effort.
    let model = null;
    let reasoningEffort = null;
    if (session.model) {
      const raw = String(session.model).trim();
      const m = raw.match(/^(.*)\((medium|high|xhigh)\)\s*$/i);
      if (m) {
        model = String(m[1] || '').trim() || null;
        reasoningEffort = String(m[2] || '').trim().toLowerCase();
      } else {
        model = raw;
      }
    }

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    if (runtimeConfig?.homeDir) {
      env.CODEX_HOME = runtimeConfig.homeDir;
    }
    if (runtimeConfig?.mode === 'custom') {
      env.OPENAI_API_KEY = runtimeConfig.apiKey;
      delete env.OPENAI_BASE_URL;
      applyProxyConfig(env, runtimeConfig);
    }

    return {
      command: CODEX_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'codex-appserver',
      appServer: true,
      mode: permMode,
      resume: !!runtimeId,
      threadId: runtimeId || null,
      model,
      reasoningEffort,
      codexRuntimeKey: runtimeConfig?.runtimeKey || '',
      codexHomeDir: runtimeConfig?.homeDir || '',
    };
  }

  function codexToolName(item) {
    switch (item?.type) {
      case 'command_execution':
        return 'CommandExecution';
      case 'mcp_tool_call':
        return 'McpToolCall';
      case 'file_change':
        return 'FileChange';
      case 'reasoning':
        return 'Reasoning';
      default:
        return item?.type || 'CodexItem';
    }
  }

  function codexToolInput(item) {
    if (!item) return null;
    if (item.type === 'command_execution') return { command: item.command || '' };
    return truncateObj(item, 500);
  }

  function codexToolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'command_execution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: item.status || null,
        };
      case 'mcp_tool_call':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.tool_name || item.name || item.server_name || '',
          status: item.status || null,
        };
      case 'file_change':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: item.path || item.file_path || '',
          status: item.status || null,
        };
      case 'reasoning':
        return {
          kind: 'reasoning',
          title: 'Reasoning',
          subtitle: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
          status: item.status || null,
        };
      default:
        return {
          kind: item.type || 'codex_item',
          title: codexToolName(item),
          subtitle: '',
          status: item.status || null,
        };
    }
  }

  function codexToolResult(item) {
    if (!item) return '';
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.text === 'string' && item.text) return item.text;
    return JSON.stringify(truncateObj(item, 1200));
  }

  function ensureCodexToolCall(entry, item, sessionId) {
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.name = codexToolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = codexToolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = codexToolInput(item);
      return tc;
    }
    tc = {
      name: codexToolName(item),
      id: item.id,
      kind: item.type || null,
      meta: codexToolMeta(item),
      input: codexToolInput(item),
      done: false,
    };
    if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
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

  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;

      case 'assistant': {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            appendFullText(entry, block.text);
            wsSend(entry.ws, { type: 'text_delta', sessionId, text: block.text }, true);
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            const tc = { name: block.name, id: block.id, input: toolInput, done: false };
            if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
            else entry.toolCallsTruncated = true;
            wsSend(entry.ws, { type: 'tool_start', sessionId, name: block.name, toolUseId: block.id, input: tc.input });
          } else if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('\n')
                : JSON.stringify(block.content);
            const tc = entry.toolCalls.find((t) => t.id === block.tool_use_id);
            if (tc) {
              tc.done = true;
              tc.result = resultText.slice(0, 2000);
            }
            wsSend(entry.ws, { type: 'tool_end', sessionId, toolUseId: block.tool_use_id, result: resultText.slice(0, 2000) });
          }
        }

        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;
      }

      case 'result': {
        const session = loadSession(sessionId);
        if (session) {
          if (event.session_id) session.claudeSessionId = event.session_id;
          if (event.total_cost_usd) session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
          saveSession(session);
        }
        entry.lastCost = event.total_cost_usd || null;
        if (entry.ws && event.total_cost_usd !== undefined) {
          wsSend(entry.ws, { type: 'cost', costUsd: session?.totalCost || 0 }, true);
        }
        break;
      }
    }
  }

  function processCodexEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'thread.started': {
        if (!event.thread_id) break;
        const session = loadSession(sessionId);
        if (session) {
          setRuntimeSessionId(session, event.thread_id);
          if (entry.codexHomeDir) session.codexHomeDir = entry.codexHomeDir;
          if (entry.codexRuntimeKey) session.codexRuntimeKey = entry.codexRuntimeKey;
          saveSession(session);
        }
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (!item || !item.id || item.type === 'agent_message') break;
        ensureCodexToolCall(entry, item, sessionId);
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (item.type === 'agent_message') {
          if (item.text) {
            appendFullText(entry, item.text);
            wsSend(entry.ws, { type: 'text_delta', sessionId, text: item.text }, true);
          }
          break;
        }
        const tc = ensureCodexToolCall(entry, item, sessionId);
        const resultText = codexToolResult(item).slice(0, 2000);
        tc.done = true;
        tc.result = resultText;
        wsSend(entry.ws, {
          type: 'tool_end',
          sessionId,
          toolUseId: item.id,
          result: resultText,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'turn.completed': {
        const usage = event.usage || null;
        entry.lastUsage = usage;
        const session = loadSession(sessionId);
        if (session && usage) {
          session.totalUsage = {
            inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input_tokens || 0),
            cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cached_input_tokens || 0),
            outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output_tokens || 0),
          };
          saveSession(session);
          wsSend(entry.ws, { type: 'usage', totalUsage: session.totalUsage }, true);
        }
        break;
      }

      case 'turn.failed': {
        const message = event.error?.message || 'Codex 任务失败';
        entry.lastError = message;
        break;
      }

      case 'error':
        if (event.message) {
          if (/^Reconnecting\.\.\./.test(event.message)) {
            wsSend(entry.ws, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;
    }
  }

  function processRuntimeEvent(entry, event, sessionId) {
    if (entry.agent === 'codex') processCodexEvent(entry, event, sessionId);
    else processClaudeEvent(entry, event, sessionId);
  }

  return {
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };
