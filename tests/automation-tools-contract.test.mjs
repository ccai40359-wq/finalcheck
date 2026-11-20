import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_TOOLS_SCHEMA, runAgentTurn, runToolCall } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createAskUserRegistry } from '../desktop/src/main/ask-user.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function toolsFor(engines, askUser) {
  return createAgentTools({ repoRoot, getDesktopToolsAsync: async () => engines, askUser });
}

test('browser navigation returns the initial snapshot by default without a fixed wait or a separate snapshot call', async () => {
  const calls = [];
  const snapshot = { ok: true, tree: '- button "Save" [ref=e1]', nodeCount: 1, truncated: false };
  const loadError = { ok: false, error: 'Load failed', code: 'LOAD_FAILED' };
  const url = 'http://localhost:4090/form';
  const tools = toolsFor({ browserUse: {
    async navigate(target, options) {
      calls.push({ target, ...options });
      if (target.endsWith('/fail')) return loadError;
      return { ok: true, url: target, title: 'Form', ...(options.observe ? { snapshot } : {}) };
    }
  } });

  assert.deepEqual(await tools.browser_navigate({ url }), { ok: true, url, title: 'Form', snapshot });
  assert.deepEqual(calls, [{ target: url, show: false, width: undefined, height: undefined, waitMs: 0, observe: true }]);
  assert.deepEqual(await tools.browser_navigate({ url, width: 800, height: 600, wait_ms: 25, show: true, observe: false }), { ok: true, url, title: 'Form' });
  assert.deepEqual(calls[1], { target: url, show: true, width: 800, height: 600, waitMs: 25, observe: false });
  assert.deepEqual(await tools.browser_navigate({ url: 'http://localhost:4090/fail' }), loadError);
});

test('browser click and snapshot preserve structured results, and snapshots forward filters', async () => {
  const calls = [];
  const snapshot = { ok: true, tree: '- button "Save" [ref=e8]', nodeCount: 1, truncated: false };
  const stale = { ok: false, error: 'Element reference expired', code: 'STALE_REF' };
  const observationFailure = { ok: false, error: 'Page went away while observing' };
  const tools = toolsFor({ browserUse: {
    async snapshot(options) { calls.push(options); return snapshot; },
    async click(ref, options) {
      calls.push({ ref, ...options });
      if (ref === 'stale') return stale;
      return { ok: true, ...(options.observe ? { snapshot: observationFailure } : {}) };
    }
  } });

  assert.deepEqual(await tools.browser_snapshot({ query: 'save', include_text: false, max_nodes: 9 }), snapshot);
  assert.deepEqual(await tools.browser_click({ ref: 'e8' }), { ok: true });
  assert.deepEqual(await tools.browser_click({ ref: 'e8', observe: true }), { ok: true, snapshot: observationFailure });
  assert.deepEqual(await tools.browser_click({ ref: 'stale', observe: true }), stale);
  assert.deepEqual(calls, [
    { maxNodes: 9, includeText: false, query: 'save' },
    { ref: 'e8', observe: false },
    { ref: 'e8', observe: true },
    { ref: 'stale', observe: true }
  ]);
});

test('browser type rejects missing or non-string text and forwards explicit empty text', async () => {
  const typed = [];
  const tools = toolsFor({ browserUse: {
    async typeInto(ref, text) { typed.push({ ref, text }); return { ok: true }; }
  } });
  for (const args of [{ ref: 'e1' }, { ref: 'e1', text: null }, { ref: 'e1', text: 42 }]) {
    assert.match((await tools.browser_type(args)).error, /text 必须是字符串/);
  }
  assert.deepEqual(typed, []);
  assert.equal((await tools.browser_type({ ref: 'e1', text: '' })).ok, true);
  assert.deepEqual(typed, [{ ref: 'e1', text: '' }]);
});

const foreground = { process: 'NOTEPAD', title: 'Scratch', tier: 'full', tierLabel: '可操作', granted: true };
const image = Buffer.from('fake image bytes');

function screenshot(screenshotId, additions = {}) {
  return { ok: true, width: 300, height: 200, scale: 2, buf: image, mime: 'image/png', foreground, screenshotId, canAct: true, ...additions };
}

test('computer screenshot provides an actionable ID only for an actionable image, and action observe attaches the new image', async () => {
  const calls = [];
  const captureResults = [screenshot('shot-1'), screenshot('shot-2'), screenshot('window-id', { canAct: false, observationOnlyReason: 'Window capture' })];
  const tools = toolsFor({ computerUse: {
    async captureScreen(options) { calls.push(['capture', options]); return captureResults.shift(); },
    async performAction(action, options) {
      calls.push([action, options]);
      return { ok: true, action, foregroundAtAction: foreground };
    }
  } });

  const before = await tools.computer_screenshot({});
  assert.equal(before.screenshot_id, 'shot-1');
  assert.equal(before.canAct, true);
  assert.equal(before.__images[0].base64, image.toString('base64'));

  const action = await runToolCall({ id: 'observed-action', function: {
    name: 'computer_action', arguments: JSON.stringify({ action: 'left_click', x: 29, y: 50, screenshot_id: before.screenshot_id, scale: 900, observe: true })
  } }, tools);
  const result = JSON.parse(action.modelContent);
  assert.equal(result.ok, true);
  assert.equal(result.observation.screenshot_id, 'shot-2');
  assert.equal(result.observation.canAct, true);
  assert.equal(result.imagesAttached, 1);
  assert.ok(!action.modelContent.includes(image.toString('base64')));
  assert.equal(action.images[0].base64, image.toString('base64'));

  const observedWindow = await tools.computer_screenshot({ target: 'window', window_title: 'Scratch' });
  assert.equal(observedWindow.canAct, false);
  assert.equal(observedWindow.screenshot_id, null);
  assert.equal(observedWindow.observationOnlyReason, 'Window capture');
  assert.deepEqual(calls, [
    ['capture', { target: 'screen', windowTitle: '' }],
    ['left_click', { x: 29, y: 50, screenshotId: 'shot-1' }],
    ['capture', { target: 'screen', windowTitle: '' }],
    ['capture', { target: 'window', windowTitle: 'Scratch' }]
  ]);
});

test('computer action does not observe a denial and preserves successful input if requested observation fails', async () => {
  const calls = [];
  const denial = { ok: false, deniedBy: 'foreground-mismatch', code: 'FOREGROUND_MISMATCH', error: 'Window changed', foreground };
  const captureFailure = { ok: false, code: 'NO_SCREEN', error: 'Screen unavailable' };
  const tools = toolsFor({ computerUse: {
    async performAction(action, options) {
      calls.push([action, options]);
      return action === 'left_click' ? denial : { ok: true, action, foregroundAtAction: foreground };
    },
    async captureScreen() {
      calls.push(['capture']);
      if (calls.length === 3) return captureFailure;
      throw new Error('Capturer unavailable');
    }
  } });

  assert.deepEqual(await tools.computer_action({ action: 'left_click', screenshot_id: 'old', observe: true }), denial);
  const typed = await tools.computer_action({ action: 'type', text: 'Draft', screenshot_id: 'same', observe: true });
  assert.equal(typed.ok, true);
  assert.deepEqual(typed.observationError, captureFailure);
  const keyed = await tools.computer_action({ action: 'key', keys: 'Tab', screenshot_id: 'same', observe: true });
  assert.equal(keyed.ok, true);
  assert.equal(keyed.observationError.error, 'Capturer unavailable');
  const keyWithoutObservation = await tools.computer_action({ action: 'key', keys: 'Right', screenshot_id: 'same' });
  assert.equal(keyWithoutObservation.ok, true);
  assert.equal(keyWithoutObservation.observationError, undefined);
  assert.deepEqual(calls, [
    ['left_click', { screenshotId: 'old' }],
    ['type', { text: 'Draft', screenshotId: 'same' }],
    ['capture'],
    ['key', { keys: 'Tab', screenshotId: 'same' }],
    ['capture'],
    ['key', { keys: 'Right', screenshotId: 'same' }]
  ]);
});

test('computer access grants every requested app only after an explicit full approval', async () => {
  const responses = [
    { selected: ['拒绝'] },
    { text: '不同意' },
    { text: '只同意部分' },
    { text: '只允许 WINWORD' },
    { selected: ['同意'], text: '只有 WINWORD' },
    { selected: ['同意'] }
  ];
  const grants = [];
  const approvals = createAskUserRegistry({ maxPerTurn: responses.length, emit: ({ callId, options }) => {
    assert.deepEqual(options.map(({ label }) => label), ['同意', '拒绝']);
    assert.equal(approvals.answer({ callId, ...responses.shift() }).ok, true);
  } });
  const tools = toolsFor({ computerUse: { grantApps(apps) { grants.push(apps); return apps; } } }, approvals.ask);
  const apps = ['WINWORD', 'EXCEL'];

  while (responses.length > 1) {
    const result = await tools.computer_request_access({ apps });
    assert.equal(result.ok, false);
    assert.deepEqual(result.granted, []);
  }
  assert.deepEqual(grants, []);
  assert.equal((await tools.computer_request_access({ apps })).ok, true);
  assert.deepEqual(grants, [apps]);
});

test('agent schemas expose observation and full-screen screenshot ID parameters', () => {
  const props = (name) => AGENT_TOOLS_SCHEMA.find((item) => item.function.name === name).function.parameters.properties;
  const desktop = props('computer_action');
  assert.equal(desktop.screenshot_id.type, 'string');
  assert.equal(desktop.observe.type, 'boolean');
  assert.equal(desktop.scale, undefined);
  assert.equal(desktop.text.minLength, 1);
  assert.equal(desktop.text.maxLength, 4096);
  assert.equal(desktop.repeat.minimum, 1);
  assert.equal(desktop.repeat.maximum, 100);
  assert.equal(props('browser_navigate').observe.type, 'boolean');
  assert.equal(props('browser_click').observe.type, 'boolean');
  assert.equal(props('browser_snapshot').query.type, 'string');
  assert.equal(props('browser_snapshot').include_text.type, 'boolean');
});

function automationToolPacket(calls) {
  return {
    tool_calls: calls.map(([id, name, args = {}], index) => ({
      index, id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
    }))
  };
}

async function runAutomationTurn(tools, packets) {
  const requests = [];
  const lifecycle = [];
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'fake', model: 'fake' },
    messages: [],
    tools,
    onToolLifecycle: (event) => lifecycle.push(event),
    fetchImpl: async (_url, opts) => {
      const delta = packets[requests.length] ?? { content: 'Finished' };
      requests.push(JSON.parse(opts.body));
      const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });
  assert.equal(out.answer, 'Finished');
  return { trace: out.trace, requests, lifecycle };
}

test('agent stops only the failed automation family for this response and keeps each tool ID and lifecycle', async () => {
  const executed = [];
  const record = (name, result) => async () => { executed.push(name); return result; };
  const { trace, requests, lifecycle } = await runAutomationTurn({
    browser_navigate: record('browser_navigate', { ok: true }),
    browser_type: record('browser_type', { ok: false, error: 'Ref is stale' }),
    browser_click: record('browser_click', { ok: true }),
    read_file: record('read_file', { content: 'Local fixture' }),
    computer_action: record('computer_action', { ok: true }),
    computer_request_access: record('computer_request_access', { ok: false, granted: [] }),
    computer_screenshot: record('computer_screenshot', { ok: true })
  }, [automationToolPacket([
    ['nav', 'browser_navigate'], ['type', 'browser_type'], ['read', 'read_file'],
    ['click', 'browser_click'], ['action', 'computer_action'], ['request', 'computer_request_access'],
    ['shot', 'computer_screenshot']
  ]), automationToolPacket([['later-click', 'browser_click'], ['later-shot', 'computer_screenshot']])]);

  assert.deepEqual(executed, [
    'browser_navigate', 'browser_type', 'read_file', 'computer_action', 'computer_request_access', 'browser_click', 'computer_screenshot'
  ]);
  const firstPacketIds = ['nav', 'type', 'read', 'click', 'action', 'request', 'shot'];
  assert.deepEqual(requests[1].messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), firstPacketIds);
  assert.deepEqual(trace.map(({ callId }) => callId), [...firstPacketIds, 'later-click', 'later-shot']);
  assert.deepEqual(lifecycle.filter(({ phase }) => phase === 'end').map(({ id }) => id), trace.map(({ callId }) => callId));
  assert.equal(trace[3].result.code, 'AUTOMATION_SEQUENCE_SKIPPED');
  assert.equal(trace[3].result.previousToolCallId, 'type');
  assert.equal(trace[6].result.code, 'AUTOMATION_SEQUENCE_SKIPPED');
  assert.equal(trace[6].result.previousToolCallId, 'request');
  assert.equal(lifecycle.find(({ id, phase }) => id === 'request' && phase === 'end').status, 'fail');
});

test('agent treats malformed arguments as an in-order automation failure while allowing later tools outside the family', async () => {
  const executed = [];
  const record = (name) => async () => { executed.push(name); return { ok: true }; };
  const { trace, requests } = await runAutomationTurn({
    browser_navigate: record('browser_navigate'),
    browser_type: record('browser_type'),
    browser_click: record('browser_click'),
    computer_screenshot: record('computer_screenshot')
  }, [automationToolPacket([
    ['nav', 'browser_navigate'], ['bad-type', 'browser_type', '{"ref":, "text":"draft"}'],
    ['click', 'browser_click'], ['shot', 'computer_screenshot']
  ])]);

  assert.deepEqual(executed, ['browser_navigate', 'computer_screenshot']);
  assert.equal(trace[1].result.code, 'ARGS_INVALID_JSON');
  assert.equal(trace[2].result.code, 'AUTOMATION_SEQUENCE_SKIPPED');
  assert.equal(trace[2].result.previousToolCallId, 'bad-type');
  assert.deepEqual(requests[1].messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['nav', 'bad-type', 'click', 'shot']);
});

test('agent skips the remaining browser actions after valid JSON omits the required type text', async () => {
  const executed = [];
  const tools = toolsFor({ browserUse: {
    async typeInto() { executed.push('typeInto'); return { ok: true }; },
    async click() { executed.push('click'); return { ok: true }; }
  } });
  const { trace, requests } = await runAutomationTurn(tools, [automationToolPacket([
    ['missing-text', 'browser_type', { ref: 'e1' }], ['click', 'browser_click', { ref: 'e2' }]
  ])]);

  assert.deepEqual(executed, []);
  assert.match(trace[0].result.error, /text 必须是字符串/);
  assert.equal(trace[1].result.code, 'AUTOMATION_SEQUENCE_SKIPPED');
  assert.equal(trace[1].result.previousToolCallId, 'missing-text');
  assert.deepEqual(requests[1].messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['missing-text', 'click']);
});

test('agent stops an automation sequence after a failed observation without changing the successful action result', async () => {
  const observed = { ok: true, snapshot: { ok: false, error: 'Observation failed' } };
  const { trace } = await runAutomationTurn({
    browser_click: async () => observed,
    browser_snapshot: async () => ({ ok: true })
  }, [automationToolPacket([
    ['click', 'browser_click', { observe: true }], ['snapshot', 'browser_snapshot']
  ])]);

  assert.deepEqual(trace[0].result, observed);
  assert.equal(trace[1].result.code, 'AUTOMATION_SEQUENCE_SKIPPED');
  assert.equal(trace[1].result.previousToolCallId, 'click');
});
