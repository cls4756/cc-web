#!/usr/bin/env node
// Offline unit test for the Codex rollout tool-call pairing repair. Reproduces the
// observed failure: a synthetic user warning written between a function_call and its
// function_call_output, which makes strict upstream endpoints answer
// "No tool output found for tool call <id>" on every subsequent resume.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createCodexRolloutStore } = require('../lib/codex-rollouts');

const store = createCodexRolloutStore({ codexSessionsDir: os.tmpdir(), sanitizeToolInput: (x) => x });
const { repairToolCallPairing, repairRolloutFile } = store;

function item(obj) { return { type: 'response_item', payload: obj }; }

// 1) warning user message between call and output -> output moves up to follow the call
{
  const call = item({ type: 'function_call', name: 'exec_command', call_id: 'call_A', arguments: '{}' });
  const warning = item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Warning: apply_patch was requested via exec_command.' }] });
  const output = item({ type: 'function_call_output', call_id: 'call_A', output: 'ok' });
  const before = item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'applying' }] });

  const { entries, moved, synthesized, applyPatchWarnings } = repairToolCallPairing([before, call, warning, output]);
  assert.strictEqual(moved, 1, 'inserted warning should count as one relocation');
  assert.strictEqual(synthesized, 0);
  assert.strictEqual(applyPatchWarnings, 1, 'the synthetic apply_patch warning should be reported');
  assert.deepStrictEqual(entries.map((e) => e.payload.type), ['message', 'function_call', 'function_call_output', 'message']);
  assert.strictEqual(entries[2], output, 'output must immediately follow its call');
  assert.strictEqual(entries[3], warning, 'warning is preserved, just moved after the output');
}

// 2) already-valid pairing is left untouched
{
  const call = item({ type: 'function_call', call_id: 'call_B', name: 'exec_command', arguments: '{}' });
  const output = item({ type: 'function_call_output', call_id: 'call_B', output: 'ok' });
  const { entries, moved, synthesized, applyPatchWarnings } = repairToolCallPairing([call, output]);
  assert.strictEqual(moved, 0);
  assert.strictEqual(synthesized, 0);
  assert.strictEqual(applyPatchWarnings, 0);
  assert.deepStrictEqual(entries, [call, output]);
}

// 3) a call with no output gets a synthetic output so replay cannot fail
{
  const call = item({ type: 'function_call', call_id: 'call_C', name: 'exec_command', arguments: '{}' });
  const { entries, moved, synthesized } = repairToolCallPairing([call]);
  assert.strictEqual(synthesized, 1);
  assert.strictEqual(moved, 0);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[1].payload.type, 'function_call_output');
  assert.strictEqual(entries[1].payload.call_id, 'call_C');
  assert(JSON.parse(entries[1].payload.output).error, 'synthetic output explains itself');
}

// 4) parallel calls (A, B, output A, output B): non-message interleavings are left
//    alone, since each call still has a following output
{
  const callA = item({ type: 'function_call', call_id: 'call_D', name: 'exec_command', arguments: '{}' });
  const callB = item({ type: 'function_call', call_id: 'call_E', name: 'exec_command', arguments: '{}' });
  const outA = item({ type: 'function_call_output', call_id: 'call_D', output: 'a' });
  const outB = item({ type: 'function_call_output', call_id: 'call_E', output: 'b' });
  const { entries, moved } = repairToolCallPairing([callA, callB, outA, outB]);
  assert.strictEqual(moved, 0);
  assert.deepStrictEqual(entries, [callA, callB, outA, outB]);
}

// 5) repairRolloutFile rewrites the file only when needed and keeps unrelated lines
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-repair-'));
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
    JSON.stringify(item({ type: 'function_call', call_id: 'call_F', name: 'exec_command', arguments: '{}' })),
    JSON.stringify(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'warning' }] })),
    JSON.stringify(item({ type: 'function_call_output', call_id: 'call_F', output: 'done' })),
  ];
  fs.writeFileSync(file, lines.join('\n'));

  const first = repairRolloutFile(file);
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.moved, 1);
  assert.strictEqual(first.applyPatchWarnings, 0, 'a generic warning is not the apply_patch one');

  const written = fs.readFileSync(file, 'utf8').split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(written[0].type, 'session_meta');
  assert.strictEqual(written[1].payload.type, 'function_call');
  assert.strictEqual(written[2].payload.type, 'function_call_output');
  assert.strictEqual(written[3].payload.type, 'message');

  const second = repairRolloutFile(file);
  assert.strictEqual(second.changed, false, 'idempotent: a repaired file is left alone');
  assert.strictEqual(second.applyPatchWarnings, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Codex rollout repair checks passed.');
