import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMELINE_PAGE_SIZE, planTimelineWindow } from '../desktop/src/renderer/lib/timeline-window.mjs';

test('empty, exact boundary and partial final segments remain bounded and reachable', () => {
  for (const total of [0, 1, 39, 40, 41, 80, 81]) {
    const view = planTimelineWindow(total);
    assert.ok(view.end - view.start <= TIMELINE_PAGE_SIZE);
    assert.equal(view.end, total, 'default view includes the newest available entry');
    assert.equal(view.hasLater, false);
    assert.equal(view.hasEarlier, total > TIMELINE_PAGE_SIZE);
    assert.equal(planTimelineWindow(total, 0).start, 0);
  }
});

test('all 1044 historical records and full detail objects remain reachable across segments', () => {
  const records = Array.from({ length: 1044 }, (_, i) => ({ callId: `call-${i}`, args: { path: `file-${i}` }, result: { content: 'detail '.repeat(100) }, status: i % 2 ? 'ok' : 'fail' }));
  const visited = [];
  const first = planTimelineWindow(records.length, 0);
  for (let page = 0; page < first.pages; page++) {
    const view = planTimelineWindow(records.length, page);
    const segment = records.slice(view.start, view.end);
    assert.ok(segment.length <= TIMELINE_PAGE_SIZE);
    assert.equal(view.hasEarlier, page > 0);
    assert.equal(view.hasLater, page < first.lastPage);
    visited.push(...segment);
  }
  assert.equal(new Set(visited.map((entry) => entry.callId)).size, records.length);
  visited.forEach((entry, i) => assert.equal(entry, records[i], 'paging keeps the original result/args/status object intact'));
});

test('live growth follows newest by default while manual earlier-page navigation stays fixed', () => {
  assert.equal(planTimelineWindow(40).page, 0);
  assert.equal(planTimelineWindow(41).page, 1);
  assert.equal(planTimelineWindow(81).page, 2);
  const earlier = planTimelineWindow(81, 0);
  const afterNewCalls = planTimelineWindow(121, earlier.page);
  assert.equal(afterNewCalls.page, 0);
  assert.equal(afterNewCalls.start, earlier.start);
  assert.equal(afterNewCalls.end, earlier.end);
  assert.equal(afterNewCalls.hasLater, true);
  assert.equal(planTimelineWindow(121, null).page, 3, 'explicit newest navigation resumes following');
});

test('first/last navigation and shrinking history clamp without gaps or invalid ranges', () => {
  const total = 203;
  assert.equal(planTimelineWindow(total, -100).start, 0);
  assert.equal(planTimelineWindow(total, 999).end, total);
  assert.equal(planTimelineWindow(3, 5).page, 0);
  assert.equal(planTimelineWindow(3, 5).end, 3);
  assert.equal(planTimelineWindow(0, 999).end, 0);
});
