import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentEvent, mergeTraceIntoEvents, timelineEntries } from '../desktop/src/renderer/lib/process-events.mjs';

const start = (id, args = id, name = 'read_file') => ({ kind: 'tool-start', id, name, args: JSON.stringify({ path: args }), at: 10 });
const end = (id, result = { content: id }, ok = true, name = 'read_file') => ({ kind: 'tool-end', id, name, result, ok, ms: 25 });
const reduce = (events, initial = { events: [] }) => events.reduce(applyAgentEvent, initial);

test('same-name parallel calls finish by id; duplicate start/end remains one entry per call', () => {
  const msg = reduce([start('a'), start('b'), end('a'), end('b', { error: 'denied' }, false), start('a'), end('a')]);
  assert.deepEqual(msg.events.map(({ id, status, result }) => ({ id, status, result })), [
    { id: 'a', status: 'ok', result: { content: 'a' } },
    { id: 'b', status: 'fail', result: { error: 'denied' } }
  ]);
});

test('missing start recovers from end and late start fills args without resetting status', () => {
  const msg = reduce([start('other'), end('lost'), start('lost')]);
  assert.equal(msg.events[0].status, 'running');
  assert.equal(msg.events[1].id, 'lost');
  assert.equal(msg.events[1].status, 'ok');
  assert.deepEqual(JSON.parse(msg.events[1].args), { path: 'lost' });
});

test('legacy calls without ids pair by start order', () => {
  const msg = reduce([start(undefined, 'first'), start(undefined, 'second'), end(undefined, { content: 'first' }), end(undefined, { content: 'second' })]);
  assert.deepEqual(msg.events.map((e) => [JSON.parse(e.args).path, e.result.content]), [['first', 'first'], ['second', 'second']]);
});

test('partial event list is filled from full trace in original order; full args/results replace previews', () => {
  const events = reduce([start('two', 'two'), end('two'), start('four', 'four')]).events;
  const trace = ['one', 'two', 'three', 'four'].map((id) => ({ tool: 'read_file', args: { path: id }, result: { content: id } }));
  const merged = mergeTraceIntoEvents(events, trace);
  assert.deepEqual(merged.map((e) => [JSON.parse(e.args).path, e.result.content, e.status]),
    ['one', 'two', 'three', 'four'].map((id) => [id, id, 'ok']));
  assert.deepEqual(mergeTraceIntoEvents(merged, trace), merged, 'repeated reconciliation must be idempotent');
  assert.equal(events.at(-1).status, 'running', 'merge must not mutate source events');
});

test('trace ids override same-name position and never consume a different known id', () => {
  const events = reduce([start('a', 'same'), start('b', 'same')]).events;
  const trace = [{ tool: 'read_file', callId: 'b', args: { path: 'same' }, result: { content: 'B' } },
    { tool: 'read_file', callId: 'c', args: { path: 'same' }, result: { content: 'C' } }];
  const out = mergeTraceIntoEvents(events, trace, null, { completed: false });
  assert.equal(out.length, 3);
  assert.equal(out.find((e) => e.id === 'a').status, 'running');
  assert.equal(out.find((e) => e.id === 'b').result.content, 'B');
  assert.equal(out.find((e) => e.id === 'c').result.content, 'C');
});

test('stale pending trace cannot erase IPC result; live restore retains actual pending call', () => {
  const msg = reduce([start('done'), end('done'), start('running')]);
  const trace = ['done', 'running'].map((id) => ({ tool: 'read_file', callId: id, status: 'running', args: { path: id }, result: null }));
  const entries = timelineEntries({ ...msg, streaming: true, trace });
  assert.deepEqual(entries.map((e) => e.status), ['ok', 'running']);
  assert.deepEqual(entries[0].result, { content: 'done' });
});

test('completion/stop/reload never leaves running tools or live thoughts, including trace-only history', () => {
  const events = reduce([{ kind: 'reasoning', text: 'checking' }, start('unfinished')]).events;
  const complete = mergeTraceIntoEvents(events, [], 50, { now: 1000, interrupted: true });
  assert.equal(complete.find((e) => e.type === 'tool').status, 'fail');
  assert.equal(complete.find((e) => e.type === 'thought').live, false);
  const loaded = timelineEntries({ interrupted: true, trace: [{ tool: 'run_command', status: 'running', args: '{}', result: null }] });
  assert.equal(loaded[0].status, 'fail');
  assert.equal(timelineEntries({ trace: [{ tool: 'run_command', result: { error: 'failed' } }] })[0].status, 'fail');
});

test('ask/todo remain dedicated cards; workflow and reasoning do not duplicate on trace recovery', () => {
  const msg = reduce([{ kind: 'workflow-start', at: 1 }, { kind: 'workflow', steps: [{ id: 's1' }] },
    { kind: 'reasoning', text: 'checking' }, start('wf', 'workflow', 'run_workflow'), end('wf', {}, true, 'run_workflow')]);
  const trace = [{ tool: 'ask_user', callId: 'ask', args: '{}', result: { answer: 'yes' } },
    { tool: 'todo_write', args: '{}', result: {} }, { tool: 'run_workflow', args: { path: 'workflow' }, result: { done: true } }];
  for (const streaming of [true, false]) {
    const entries = timelineEntries({ ...msg, trace, streaming, reasoning: 'checking' });
    assert.equal(entries.filter((e) => e.type === 'thought').length, 1);
    assert.deepEqual(entries.filter((e) => e.type === 'tool').map((e) => e.name), ['run_workflow']);
  }
});
