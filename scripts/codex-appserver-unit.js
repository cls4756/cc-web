// Offline unit test: feed lib/codex-appserver.js a scripted stdout stream of REAL
// app-server frames (captured from probes) via a fake process, asserting the module's
// behavior without depending on the (currently flaky) model backend.
const { EventEmitter } = require('events');
const assert = require('assert');
const { createCodexAppServer } = require('../lib/codex-appserver');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.stdout = new EventEmitter();
  proc.killed = false;
  proc.stdin = { written: [], write(s) { this.written.push(s); return true; } };
  proc.kill = function () { proc.killed = true; proc.emit('exit', 0, 'SIGTERM'); return true; };
  return proc;
}

const emitted = [];
const sessions = new Map();
const sid = 's1';
const cwd = '/home/proj';
sessions.set(sid, { id: sid, agent: 'codex', permissionMode: 'default', cwd, codexThreadId: null, totalUsage: {} });

const app = createCodexAppServer({
  wsSend: (ws, obj) => emitted.push(obj),
  plog: () => {},
  loadSession: (id) => sessions.get(id) || null,
  saveSession: (s) => sessions.set(s.id, s),
  setRuntimeSessionId: (s, rid) => { s.codexThreadId = rid; },
});

const proc = makeFakeProc();
const entry = { pid: proc.pid, ws: {}, agent: 'codex', cwd, fullText: '', toolCalls: [], lastUsage: null, lastError: null };

app.attach(proc, {
  session: sessions.get(sid), sessionId: sid, entry,
  promptText: 'do stuff', attachments: [],
  spec: { mode: 'default', threadId: null, model: null, reasoningEffort: null, cwd, codexHomeDir: '', codexRuntimeKey: '' },
});

function feed(obj) { proc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
function lastReq() { return JSON.parse(proc.stdin.written[proc.stdin.written.length - 1]); }

// 1) initialize -> module should have sent initialize request first
let firstSent = JSON.parse(proc.stdin.written[0]);
assert.strictEqual(firstSent.method, 'initialize', 'first frame is initialize');

// respond to initialize -> module sends thread/start
feed({ id: firstSent.id, result: { userAgent: 'x' } });
let afterInit = lastReq();
assert.strictEqual(afterInit.method, 'thread/start', 'after init -> thread/start');
assert.strictEqual(afterInit.params.sandbox, 'workspace-write', 'default mode -> workspace-write');
assert.strictEqual(afterInit.params.approvalPolicy, 'on-request');
assert.strictEqual(afterInit.params.approvalsReviewer, 'user');
assert.strictEqual(afterInit.params.cwd, cwd);

// respond to thread/start -> module sends turn/start, persists threadId
feed({ id: afterInit.id, result: { thread: { id: 'thread-abc' } } });
assert.strictEqual(sessions.get(sid).codexThreadId, 'thread-abc', 'threadId persisted');
let turnReq = lastReq();
assert.strictEqual(turnReq.method, 'turn/start', 'after thread/start -> turn/start');
assert.deepStrictEqual(turnReq.params.input, [{ type: 'text', text: 'do stuff' }]);
feed({ id: turnReq.id, result: { turn: { id: 't1', status: 'inProgress' } } });

// 2) tool_start on item/started (commandExecution)
feed({ method: 'item/started', params: { item: { id: 'call1', type: 'commandExecution', command: 'bash -lc "printf X > /etc/passwd"', status: 'inProgress' } } });
const ts = emitted.find(e => e.type === 'tool_start' && e.toolUseId === 'call1');
assert(ts, 'tool_start emitted');
assert.strictEqual(ts.name, 'CommandExecution');

// 3) approval request for out-of-cwd command -> module forwards codex_approval_request
feed({ id: 0, method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread-abc', turnId: 't1', itemId: 'call1',
  command: 'bash -lc "printf X > /etc/passwd"', cwd,
  reason: 'Do you want to create /etc/passwd outside the writable workspace?',
  availableDecisions: ['accept', 'cancel'],
} });
const appr = emitted.find(e => e.type === 'codex_approval_request');
assert(appr, 'codex_approval_request emitted');
assert.strictEqual(appr.kind, 'command');
assert.strictEqual(appr.command, 'bash -lc "printf X > /etc/passwd"');
assert(appr.paths.includes('/etc/passwd'), 'path extracted from command: ' + JSON.stringify(appr.paths));
assert.strictEqual(appr.reason, 'Do you want to create /etc/passwd outside the writable workspace?');

// 4) approve -> module responds to the server request 0 with decision "accept" (v2)
const ok = app.resolveApproval(sid, appr.approvalId, 'approve');
assert.strictEqual(ok, true, 'resolveApproval returned true');
const resp0 = JSON.parse(proc.stdin.written[proc.stdin.written.length - 1]);
assert.strictEqual(resp0.id, 0, 'responded to server req id 0');
assert.strictEqual(resp0.result.decision, 'accept', 'v2 approve -> accept');

// 5) deny path on a legacy execCommandApproval -> "denied"
feed({ id: 1, method: 'execCommandApproval', params: { callId: 'c2', command: ['bash', '-lc', 'rm -rf /'], cwd, parsedCmd: [] } });
const appr2 = emitted.filter(e => e.type === 'codex_approval_request').pop();
app.resolveApproval(sid, appr2.approvalId, 'deny');
const resp1 = JSON.parse(proc.stdin.written[proc.stdin.written.length - 1]);
assert.strictEqual(resp1.id, 1);
assert.strictEqual(resp1.result.decision, 'denied', 'legacy deny -> denied');

// 6) text streaming via agentMessage delta
feed({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Hello ' } });
feed({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'world' } });
assert.strictEqual(entry.fullText, 'Hello world', 'delta accumulation');
// completed agentMessage already streamed -> should NOT double-append
feed({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'Hello world' } } });
assert.strictEqual(entry.fullText, 'Hello world', 'no double append for streamed message');

// 7) tool_end + usage
feed({ method: 'item/completed', params: { item: { id: 'call1', type: 'commandExecution', command: 'bash -lc "printf X"', status: 'completed', aggregatedOutput: 'done' } } });
assert(emitted.find(e => e.type === 'tool_end' && e.toolUseId === 'call1'), 'tool_end emitted');
feed({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } } } });
feed({ method: 'turn/completed', params: { threadId: 'thread-abc', turn: { id: 't1', status: 'completed' } } });
const usage = emitted.filter(e => e.type === 'usage').pop();
assert(usage, 'usage emitted');
assert.strictEqual(usage.totalUsage.inputTokens, 10);
assert.strictEqual(entry.lastError, null, 'no error on clean completion');

// 8) plan mode -> read-only sandbox
{
  const p2 = makeFakeProc();
  const e2 = { ws: {}, agent: 'codex', cwd, fullText: '', toolCalls: [], lastError: null };
  sessions.set('s2', { id: 's2', agent: 'codex', permissionMode: 'plan', cwd, codexThreadId: null, totalUsage: {} });
  app.attach(p2, { session: sessions.get('s2'), sessionId: 's2', entry: e2, promptText: 'x', attachments: [], spec: { mode: 'plan', threadId: null, cwd } });
  feed2(p2, { id: JSON.parse(p2.stdin.written[0]).id, result: {} });
  const req = JSON.parse(p2.stdin.written[p2.stdin.written.length - 1]);
  assert.strictEqual(req.params.sandbox, 'read-only', 'plan mode -> read-only');
}
function feed2(p, obj) { p.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }

// 9) failed turn via turn/completed status:failed -> lastError set
{
  const p3 = makeFakeProc();
  const e3 = { ws: {}, agent: 'codex', cwd, fullText: '', toolCalls: [], lastError: null };
  sessions.set('s3', { id: 's3', agent: 'codex', permissionMode: 'default', cwd, codexThreadId: 'tX', totalUsage: {} });
  app.attach(p3, { session: sessions.get('s3'), sessionId: 's3', entry: e3, promptText: 'x', attachments: [], spec: { mode: 'default', threadId: 'tX', cwd } });
  feed2(p3, { id: JSON.parse(p3.stdin.written[0]).id, result: {} });
  const resumeReq = JSON.parse(p3.stdin.written[p3.stdin.written.length - 1]);
  assert.strictEqual(resumeReq.method, 'thread/resume', 'existing threadId -> thread/resume');
  assert.strictEqual(resumeReq.params.threadId, 'tX');
  feed2(p3, { id: resumeReq.id, result: { thread: { id: 'tX' } } });
  const turnR = JSON.parse(p3.stdin.written[p3.stdin.written.length - 1]);
  feed2(p3, { id: turnR.id, result: { turn: { id: 'tt', status: 'inProgress' } } });
  feed2(p3, { method: 'turn/completed', params: { turn: { id: 'tt', status: 'failed', error: { message: '{"error":{"message":"boom upstream"}}' } } } });
  assert.strictEqual(e3.lastError, 'boom upstream', 'failed turn -> stripped error, got: ' + e3.lastError);
}

// 10) protocol: `initialized` notification must be sent after the initialize response
{
  const notif = proc.stdin.written.map((s) => JSON.parse(s))
    .find((f) => f.method === 'initialized' && f.id === undefined);
  assert(notif, 'initialized notification sent');
  const order = proc.stdin.written.map((s) => JSON.parse(s).method);
  assert(order.indexOf('initialized') < order.indexOf('thread/start'), 'initialized precedes thread/start');
}

// 11) yolo mode -> unsandboxed, approvals off (the reported "yolo still prompts" bug)
{
  const p4 = makeFakeProc();
  const e4 = { ws: {}, agent: 'codex', cwd, fullText: '', toolCalls: [], lastError: null };
  sessions.set('s4', { id: 's4', agent: 'codex', permissionMode: 'yolo', cwd, codexThreadId: null, totalUsage: {} });
  app.attach(p4, { session: sessions.get('s4'), sessionId: 's4', entry: e4, promptText: 'x', attachments: [], spec: { mode: 'yolo', threadId: null, cwd } });
  feed2(p4, { id: JSON.parse(p4.stdin.written[0]).id, result: {} });
  const req = JSON.parse(p4.stdin.written[p4.stdin.written.length - 1]);
  assert.strictEqual(req.params.sandbox, 'danger-full-access', 'yolo -> danger-full-access');
  assert.strictEqual(req.params.approvalPolicy, 'never', 'yolo -> approvalPolicy never');

  // permissions approval is not sandbox-governed, so it can still arrive: auto-grant it
  // instead of popping a modal.
  feed2(p4, { id: req.id, result: { thread: { id: 'tY' } } });
  const emittedBefore = emitted.filter((e) => e.type === 'codex_approval_request').length;
  const wanted = { fileSystem: { write: ['/etc'] }, network: { enabled: true } };
  feed2(p4, { id: 77, method: 'item/permissions/requestApproval', params: { threadId: 'tY', turnId: 't', itemId: 'i', cwd, permissions: wanted } });
  assert.strictEqual(emitted.filter((e) => e.type === 'codex_approval_request').length, emittedBefore,
    'yolo must not surface a permissions modal');
  const granted = JSON.parse(p4.stdin.written[p4.stdin.written.length - 1]);
  assert.strictEqual(granted.id, 77);
  assert.deepStrictEqual(granted.result.permissions, wanted, 'yolo auto-grants requested permissions');
  assert.strictEqual(granted.result.scope, 'session');
}

// 12) permissions approval outside yolo -> human decides, reply uses {permissions}, not {decision}
{
  const wanted = { fileSystem: { read: ['/opt/data'] } };
  feed({ id: 88, method: 'item/permissions/requestApproval', params: { threadId: 'thread-abc', turnId: 't1', itemId: 'i9', cwd, permissions: wanted } });
  const pa = emitted.filter((e) => e.type === 'codex_approval_request').pop();
  assert.strictEqual(pa.kind, 'permissions', 'permissions approval kind');
  assert(pa.paths.includes('/opt/data'), 'requested path surfaced: ' + JSON.stringify(pa.paths));

  app.resolveApproval(sid, pa.approvalId, 'deny');
  const denied = lastReq();
  assert.strictEqual(denied.id, 88);
  assert.deepStrictEqual(denied.result, { permissions: {}, scope: 'turn' }, 'deny grants nothing');
  assert.strictEqual(denied.result.decision, undefined, 'permissions reply must not use decision');
}

// 13) requests we cannot fulfil must fail loudly, not answer with {} (which Codex cannot
//     deserialize -- this surfaced as bogus "auth failed" / "no tools available")
{
  feed({ id: 90, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } });
  const refused = lastReq();
  assert.strictEqual(refused.id, 90);
  assert(refused.error && refused.error.message, 'token refresh answered with a JSON-RPC error');
  assert.strictEqual(refused.result, undefined, 'no empty result for token refresh');

  feed({ id: 91, method: 'item/tool/call', params: { tool: 'whatever', callId: 'c', threadId: 'thread-abc', turnId: 't1', arguments: {} } });
  assert(lastReq().error, 'unsupported client tool call -> error');

  feed({ id: 92, method: 'some/unknown/method', params: {} });
  assert(lastReq().error, 'unknown server request -> error');

  feed({ id: 93, method: 'item/tool/requestUserInput', params: { questions: [] } });
  assert.deepStrictEqual(lastReq().result, { answers: {} }, 'requestUserInput -> empty answers');

  feed({ id: 94, method: 'mcpServer/elicitation/request', params: {} });
  assert.strictEqual(lastReq().result.action, 'decline', 'elicitation -> decline');
}

console.log('ALL ASSERTIONS PASSED ✓');
process.exit(0);
