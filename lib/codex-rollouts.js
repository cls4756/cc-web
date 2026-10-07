const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createCodexRolloutStore(deps) {
  const { codexSessionsDir, sanitizeToolInput } = deps;

  function extractCodexMessageText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && (item.type === 'input_text' || item.type === 'output_text'))
      .map((item) => item.text || '')
      .join('');
  }

  function appendAssistantContent(turn, text) {
    if (!turn || !text || !text.trim()) return;
    turn.content = turn.content ? `${turn.content}\n\n${text}` : text;
  }

  function parseCodexRolloutLines(lines) {
    const messages = [];
    const pendingToolCalls = new Map();
    const meta = { threadId: null, cwd: null, title: '', updatedAt: null, cliVersion: null, source: null };
    const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let currentAssistant = null;
    let sawRealUserMessage = false;
    const fallbackUserMessages = [];

    function ensureAssistant(ts) {
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', content: '', toolCalls: [], timestamp: ts || null };
      } else if (!currentAssistant.timestamp && ts) {
        currentAssistant.timestamp = ts;
      }
      return currentAssistant;
    }

    function flushAssistant() {
      if (!currentAssistant) return;
      if ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0) {
        messages.push(currentAssistant);
      }
      currentAssistant = null;
      pendingToolCalls.clear();
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = entry.timestamp || null;
      if (ts) meta.updatedAt = ts;

      if (entry.type === 'session_meta') {
        meta.threadId = entry.payload?.id || meta.threadId;
        meta.cwd = entry.payload?.cwd || meta.cwd;
        meta.cliVersion = entry.payload?.cli_version || meta.cliVersion;
        meta.source = entry.payload?.source || meta.source;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const total = entry.payload?.info?.total_token_usage || null;
        const usage = entry.payload?.info?.last_token_usage || null;
        if (total) {
          totalUsage.inputTokens = Math.max(totalUsage.inputTokens, total.input_tokens || 0);
          totalUsage.cachedInputTokens = Math.max(totalUsage.cachedInputTokens, total.cached_input_tokens || 0);
          totalUsage.outputTokens = Math.max(totalUsage.outputTokens, total.output_tokens || 0);
        } else if (usage) {
          totalUsage.inputTokens += usage.input_tokens || 0;
          totalUsage.cachedInputTokens += usage.cached_input_tokens || 0;
          totalUsage.outputTokens += usage.output_tokens || 0;
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = String(entry.payload?.message || '').trim();
        if (text) {
          sawRealUserMessage = true;
          flushAssistant();
          if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', content: text, timestamp: ts });
        }
        continue;
      }

      if (entry.type !== 'response_item') continue;

      const payload = entry.payload || {};
      switch (payload.type) {
      case 'message': {
        if (payload.role === 'assistant') {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
            if (currentAssistant && ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0)) {
              flushAssistant();
            }
            appendAssistantContent(ensureAssistant(ts), text);
          }
        } else if (payload.role === 'user' && !sawRealUserMessage) {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
              fallbackUserMessages.push({ role: 'user', content: text, timestamp: ts });
          }
        }
        break;
      }
        case 'function_call': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || payload.id || crypto.randomUUID();
          const tc = {
            name: payload.name || 'FunctionCall',
            id: toolUseId,
            input: sanitizeToolInput(payload.name || 'FunctionCall', payload.arguments || ''),
            done: false,
          };
          assistant.toolCalls.push(tc);
          pendingToolCalls.set(toolUseId, tc);
          break;
        }
        case 'function_call_output': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || crypto.randomUUID();
          let tc = pendingToolCalls.get(toolUseId);
          if (!tc) {
            tc = { name: 'FunctionCall', id: toolUseId, input: null, done: false };
            assistant.toolCalls.push(tc);
            pendingToolCalls.set(toolUseId, tc);
          }
          tc.done = true;
          tc.result = (typeof payload.output === 'string'
            ? payload.output
            : JSON.stringify(payload.output || '')).slice(0, 2000);
          break;
        }
        default:
          break;
      }
    }

    flushAssistant();
    if (!sawRealUserMessage && fallbackUserMessages.length > 0) {
      const fallback = fallbackUserMessages[0];
      if (!meta.title) meta.title = fallback.content.trim().slice(0, 80).replace(/\n/g, ' ');
      return { meta, messages: fallbackUserMessages.concat(messages), totalUsage };
    }
    return { meta, messages, totalUsage };
  }

  function walkFiles(dir, files = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(fullPath, files);
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  function getCodexRolloutFiles() {
    if (!fs.existsSync(codexSessionsDir)) return [];
    return walkFiles(codexSessionsDir, []).filter((filePath) => filePath.endsWith('.jsonl')).sort().reverse();
  }

  function parseCodexRolloutFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parseCodexRolloutLines(content.split('\n'));
      parsed.filePath = filePath;
      return parsed;
    } catch {
      return null;
    }
  }

  // Responses-API tool items must appear as call -> output, with no other item in
  // between. Codex sometimes injects a synthetic user warning between a function_call
  // and its function_call_output (e.g. "apply_patch was requested via exec_command"),
  // and an aborted turn can leave a call with no output at all. Strict upstream
  // endpoints then reject the whole replayed history with
  // "No tool output found for tool call <id>". Repair the persisted rollout so the
  // next resume replays a valid conversation.
  const TOOL_CALL_OUTPUT_TYPE = {
    function_call: 'function_call_output',
    custom_tool_call: 'custom_tool_call_output',
    local_shell_call: 'local_shell_call_output',
  };
  const TOOL_OUTPUT_CALL_TYPE = {
    function_call_output: 'function_call',
    custom_tool_call_output: 'custom_tool_call',
    local_shell_call_output: 'local_shell_call',
  };

  function toolCallItemInfo(entry) {
    if (!entry || entry.type !== 'response_item' || !entry.payload) return null;
    const p = entry.payload;
    if (TOOL_CALL_OUTPUT_TYPE[p.type]) {
      return { kind: 'call', id: p.call_id || p.id || null, outputType: TOOL_CALL_OUTPUT_TYPE[p.type] };
    }
    if (TOOL_OUTPUT_CALL_TYPE[p.type]) {
      return { kind: 'output', id: p.call_id || p.id || null };
    }
    return null;
  }

  function makeSyntheticToolOutput(callEntry, info) {
    return {
      timestamp: callEntry.timestamp || new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: info.outputType,
        call_id: info.id,
        output: JSON.stringify({
          error: 'tool result unavailable: the previous turn was interrupted before a result was recorded',
        }),
      },
    };
  }

  function isResponseItem(entry) {
    return !!(entry && entry.type === 'response_item' && entry.payload);
  }

  function findToolOutputIndex(entries, callId, fromIndex) {
    for (let i = fromIndex + 1; i < entries.length; i++) {
      const info = toolCallItemInfo(entries[i]);
      if (info && info.kind === 'output' && info.id === callId) return i;
    }
    return -1;
  }

  // Pure reordering. Non-response_item entries (event_msg, turn_context, ...) are
  // metadata that is never replayed to the model, so they are left untouched; only
  // model-visible messages that sit between a call and its output are relocated.
  // Calls that never got an output are given a synthetic one so replay stays valid.
  function repairToolCallPairing(entries) {
    const result = entries.slice();
    let moved = 0;
    let synthesized = 0;

    for (let i = 0; i < result.length; i++) {
      const info = toolCallItemInfo(result[i]);
      if (!info || info.kind !== 'call' || !info.id) continue;

      const outputAt = findToolOutputIndex(result, info.id, i);
      if (outputAt < 0) {
        result.splice(i + 1, 0, makeSyntheticToolOutput(result[i], info));
        synthesized++;
        i++; // skip over the inserted output
        continue;
      }

      // Relocate any model-visible message wedged between the call and its output.
      const wedged = [];
      for (let k = i + 1; k < outputAt; k++) {
        const entry = result[k];
        if (isResponseItem(entry) && entry.payload.type === 'message') wedged.push(k);
      }
      if (wedged.length === 0) continue;

      const movedItems = wedged.map((k) => result[k]);
      for (let x = wedged.length - 1; x >= 0; x--) result.splice(wedged[x], 1);
      const newOutputAt = findToolOutputIndex(result, info.id, i);
      result.splice(newOutputAt + 1, 0, ...movedItems);
      moved += movedItems.length;
    }

    return { entries: result, moved, synthesized };
  }

  // Read a rollout file, repair tool-call pairing, and write it back atomically.
  function repairRolloutFile(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { ok: false, changed: false, moved: 0, synthesized: 0 };
    }

    const parsed = content.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return { raw: line, entry: null };
      try {
        return { raw: line, entry: JSON.parse(trimmed) };
      } catch {
        return { raw: line, entry: null };
      }
    });

    const repaired = repairToolCallPairing(parsed.map((p) => p.entry));
    const changed = repaired.moved > 0 || repaired.synthesized > 0;
    if (!changed) return { ok: true, changed: false, moved: 0, synthesized: 0 };

    const rawByEntry = new Map();
    for (const p of parsed) {
      if (p.entry) rawByEntry.set(p.entry, p.raw);
    }
    const lines = repaired.entries.map((entry) => {
      if (!entry) return '';
      if (rawByEntry.has(entry)) return rawByEntry.get(entry);
      return JSON.stringify(entry);
    });

    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, lines.join('\n'));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      return { ok: false, changed: false, moved: 0, synthesized: 0, error: err.message };
    }
    return { ok: true, changed: true, moved: repaired.moved, synthesized: repaired.synthesized };
  }

  return {
    parseCodexRolloutLines,
    getCodexRolloutFiles,
    parseCodexRolloutFile,
    repairToolCallPairing,
    repairRolloutFile,
  };
}

module.exports = { createCodexRolloutStore };
