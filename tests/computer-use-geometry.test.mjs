import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionPoints, mapScreenshotPoint, matchesImageGeometry, matchesProcess, overlapBounds, sameBounds,
  sameObservation, sameWindow, selectCaptureSource, thumbnailSize
} from '../desktop/src/main/computer-use-geometry.mjs';

const bounds = { x: -2560, y: -144, width: 2560, height: 1440 };
const shot = { width: 1560, height: 877, bounds };

test('matches the primary screen by display ID even when it is returned second', () => {
  const other = { id: 'screen:0:0', display_id: '6' };
  const primary = { id: 'screen:1:0', display_id: '3' };
  const options = { target: 'screen', displayId: 3 };
  assert.equal(selectCaptureSource([other, primary], options).source, primary);
  assert.ok(selectCaptureSource([other], options).error);
  assert.ok(selectCaptureSource([primary, { ...primary }], options).error);
});

test('window selection requires an exact ID or uniquely matching name', () => {
  const first = { id: 'window:1:0', name: 'Budget draft' };
  const second = { id: 'window:2:0', name: 'Budget final' };
  const sources = [first, second];
  const select = (windowTitle) => selectCaptureSource(sources, { target: 'window', windowTitle });
  assert.equal(select(second.id).source, second);
  assert.equal(select(' BUDGET FINAL ').source, second);
  assert.equal(select('draft').source, first);
  assert.ok(select('Budget').error);
  assert.ok(select('Calendar').error);
  assert.ok(select('').error);
});

test('sizing preserves physical aspect ratio and rejects letterboxed geometry', () => {
  assert.deepEqual(thumbnailSize({ width: 3840, height: 2160 }, 1560), { width: 1560, height: 878 });
  assert.deepEqual(thumbnailSize({ width: 2160, height: 3840 }, 1560), { width: 900, height: 1600 });
  assert.deepEqual(thumbnailSize({ width: 900, height: 600 }, 1560), { width: 900, height: 600 });
  assert.equal(matchesImageGeometry({ width: 1560, height: 877 }, bounds), true);
  assert.equal(matchesImageGeometry({ width: 1560, height: 1000 }, bounds), false);
  assert.equal(matchesImageGeometry({ width: 1560, height: 1 }, bounds), false);
});

test('maps each resized axis independently to the physical desktop with negative origins', () => {
  assert.deepEqual(mapScreenshotPoint(shot, 0, 0), { x: -2560, y: -144 });
  assert.deepEqual(mapScreenshotPoint(shot, 1559, 876), { x: -1, y: 1295 });
  assert.deepEqual(mapScreenshotPoint(shot, 780, 439), { x: -1280, y: 577 });
  assert.deepEqual(mapScreenshotPoint(shot, 1559.9, 876.9), { x: -1, y: 1295 });
});

test('rejects invalid and partial coordinates before mapping', () => {
  for (const [x, y] of [[-1, 10], [10, -1], [1560, 10], [10, 877], [Infinity, 5], [2, NaN], ['12', 10], [undefined, 0]]) {
    assert.throws(() => mapScreenshotPoint(shot, x, y), RangeError);
  }
  assert.throws(() => actionPoints('scroll', { x: 9 }, shot), RangeError);
  assert.throws(() => actionPoints('drag', { x: 1, y: 2, x2: 12345, y2: 4 }, shot), RangeError);
});

test('drag maps both endpoints; scroll and keyboard defer to the native cursor or focus guard', () => {
  const end = { x2: 1559, y2: 876 };
  const expected = [{ x: -2560, y: -144 }, { x: -1, y: 1295 }];
  assert.deepEqual(actionPoints('drag', { x: 0, y: 0, ...end }, shot), expected);
  assert.deepEqual(actionPoints('left_click_drag', { x1: 0, y1: 0, ...end }, shot), expected);
  assert.deepEqual(actionPoints('scroll', {}, shot), []);
  assert.deepEqual(actionPoints('type', {}, shot), []);
});

test('window identity requires HWND and PID even if another window has the same process and title', () => {
  const window = { hwnd: 100, pid: 40, process: 'editor', bounds, title: 'Draft' };
  assert.ok(sameObservation(window, { ...window, bounds: { ...bounds } }));
  assert.equal(sameWindow(window, { ...window, hwnd: 101 }), false);
  assert.equal(sameWindow(window, { ...window, pid: 41 }), false);
  assert.equal(sameWindow({ ...window, pid: 0 }, { ...window, pid: 0 }), false);
  assert.equal(sameObservation(window, { ...window, title: 'Other' }), false);
  assert.equal(sameObservation(window, { ...window, bounds: { ...bounds, width: 2048 } }), false);
  assert.equal(matchesProcess('editor', ' EDITOR.exe '), true);
  assert.equal(matchesProcess('editor', 'edit'), false);
  assert.equal(matchesProcess('editor', 'Draft'), false);
});

test('display comparisons include offsets and require visible overlap with the foreground window', () => {
  assert.ok(sameBounds(bounds, { ...bounds }));
  assert.equal(sameBounds(bounds, { ...bounds, y: 0 }), false);
  assert.ok(overlapBounds(bounds, { x: -50, y: 0, width: 120, height: 400 }));
  assert.equal(overlapBounds(bounds, { x: 0, y: 0, width: 120, height: 400 }), false);
  assert.equal(overlapBounds(bounds, { x: -50, y: 0, width: 0, height: 400 }), false);
});
