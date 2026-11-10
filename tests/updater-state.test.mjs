import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialUpdateState,
  cleanVersion,
  humanizeUpdateError,
  reduceUpdateEvent,
  describeUpdate
} from '../desktop/src/renderer/lib/updater-state.mjs';

const CURRENT = '0.1.0';

const textFields = (view) => [
  view.statusText,
  view.errorText,
  view.currentText,
  view.latestText,
  view.checkLabel,
  view.downloadLabel,
  view.installLabel
];

const assertClean = (view) => {
  for (const text of textFields(view)) {
    assert.equal(typeof text, 'string', '文案必须是字符串');
    assert.ok(!text.includes('undefined'), `文案不能出现 undefined：${text}`);
    assert.ok(!/\{\s*"|"\s*:/.test(text), `文案不能出现裸 JSON：${text}`);
  }
};

test('idle：尚未检查，展示当前版本与检查按钮', () => {
  const view = describeUpdate(initialUpdateState, CURRENT);
  assert.equal(view.phase, 'idle');
  assert.equal(view.statusText, '尚未检查更新');
  assert.equal(view.currentText, 'v0.1.0');
  assert.equal(view.showCheck, true);
  assert.equal(view.showDownload, false);
  assert.equal(view.showInstall, false);
  assert.equal(view.hasUpdate, false);
  assertClean(view);
});

test('checking：显示「正在检查…」，检查按钮暂时不可用', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'checking' });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.phase, 'checking');
  assert.equal(view.statusText, '正在检查…');
  assert.equal(view.showCheck, false);
  assert.equal(view.checkDisabled, true);
  assertClean(view);
});

test('not-available：显示已是最新（vX）', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'not-available', version: CURRENT });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.statusText, '已是最新（v0.1.0）');
  assert.equal(view.tone, 'jade');
  assert.equal(view.hasUpdate, false);
  assert.equal(view.showCheck, true);
  assert.equal(view.showInstall, false);
  assertClean(view);
});

test('available：显示发现 vY，是否下载？并露出下载按钮', () => {
  const state = reduceUpdateEvent(initialUpdateState, {
    type: 'available',
    version: '0.2.0',
    notes: '{"releaseNotes":"should not leak"}'
  });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.statusText, '发现 v0.2.0，是否下载？');
  assert.equal(view.errorText, '');
  assert.equal(view.hasUpdate, true);
  assert.equal(view.showDownload, true);
  assert.equal(view.showCheck, true);
  assert.equal(view.showInstall, false);
  assertClean(view);
});

test('available 但缺版本号：不出现 undefined', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'available' });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.statusText, '发现新版本，是否下载？');
  assert.equal(view.latestText, '');
  assertClean(view);
});

test('downloading：显示下载中 42%，带进度且无下载按钮', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'available', version: '0.2.0' });
  const next = reduceUpdateEvent(state, { type: 'progress', percent: 42.4 });
  const view = describeUpdate(next, CURRENT);
  assert.equal(view.phase, 'downloading');
  assert.equal(view.statusText, '下载中 42%');
  assert.equal(view.progress, 42);
  assert.equal(view.hasUpdate, true);
  assert.equal(view.showDownload, false);
  assert.equal(view.showInstall, false);
  assert.equal(view.showCheck, false);
  assertClean(view);
});

test('downloading：异常百分比被夹到 0–100', () => {
  for (const [raw, expect] of [[140, 100], [-3, 0], ['abc', 0], [Number.NaN, 0]]) {
    const state = reduceUpdateEvent(initialUpdateState, { type: 'progress', percent: raw });
    const view = describeUpdate(state, CURRENT);
    assert.equal(view.progress, expect);
    assert.equal(view.statusText, `下载中 ${expect}%`);
    assertClean(view);
  }
});

test('downloaded：已下载，重启安装；只露安装按钮', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'downloaded', version: '0.2.0' });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.phase, 'downloaded');
  assert.equal(view.statusText, '已下载 v0.2.0，重启安装');
  assert.equal(view.tone, 'jade');
  assert.equal(view.showInstall, true);
  assert.equal(view.showCheck, false);
  assert.equal(view.showDownload, false);
  assert.equal(view.hasUpdate, true);
  assertClean(view);
});

test('downloaded 缺版本号：沿用 available 的版本', () => {
  const available = reduceUpdateEvent(initialUpdateState, { type: 'available', version: '0.2.1' });
  const state = reduceUpdateEvent(available, { type: 'downloaded' });
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.statusText, '已下载 v0.2.1，重启安装');
  assertClean(view);
});

test('error：无网络 / 404 / 签名问题各一句中文，且只露一行红字', () => {
  const cases = [
    ['Error: net::ERR_INTERNET_DISCONNECTED', '无法连接更新服务器，请检查网络后重试。'],
    ['HttpError: 404 Not Found (No published versions)', 'GitHub 上还没有可用的正式版本（暂无 Release），请稍后再试。'],
    ['Cannot verify signature: publisherName mismatch', '更新包签名校验未通过，已停止更新，请联系开发者。']
  ];
  for (const [raw, expect] of cases) {
    const state = reduceUpdateEvent(initialUpdateState, { type: 'error', message: raw });
    const view = describeUpdate(state, CURRENT);
    assert.equal(view.phase, 'error');
    assert.equal(view.statusText, '检查更新失败');
    assert.equal(view.errorText, expect);
    assert.equal(view.tone, 'red');
    assert.equal(view.showCheck, true);
    assert.equal(view.hasUpdate, false);
    assertClean(view);
  }
});

test('error：调用方直接塞裸 JSON 时，界面回落为通用人话', () => {
  const state = { ...initialUpdateState, phase: 'error', message: '{"error":"boom","stack":"..."}' };
  const view = describeUpdate(state, CURRENT);
  assert.equal(view.errorText, '检查更新失败，请稍后再试。');
  assertClean(view);
});

test('humanizeUpdateError：空值与未知错误都有默认文案', () => {
  assert.equal(humanizeUpdateError(''), '检查更新失败，请稍后再试。');
  assert.equal(humanizeUpdateError(null), '检查更新失败，请稍后再试。');
  assert.equal(humanizeUpdateError('Something exploded'), '检查更新失败，请稍后再试。');
});

test('cleanVersion：丢弃 undefined/null/JSON，保留正常版本号', () => {
  assert.equal(cleanVersion('v0.2.0'), '0.2.0');
  assert.equal(cleanVersion(undefined), '');
  assert.equal(cleanVersion('undefined'), '');
  assert.equal(cleanVersion('{"version":"1.0.0"}'), '');
  assert.equal(cleanVersion('   '), '');
});

test('未知事件不改状态；当前版本缺失时不出现 undefined', () => {
  const state = reduceUpdateEvent(initialUpdateState, { type: 'mystery' });
  assert.deepEqual(state, initialUpdateState);
  const view = describeUpdate(initialUpdateState, undefined);
  assert.equal(view.currentText, '未知版本');
  assert.equal(describeUpdate(initialUpdateState, undefined).statusText, '尚未检查更新');
  assertClean(view);
});

test('所有状态的所有文案都不含裸 JSON / undefined', () => {
  const states = [
    initialUpdateState,
    reduceUpdateEvent(initialUpdateState, { type: 'checking' }),
    reduceUpdateEvent(initialUpdateState, { type: 'not-available', version: '0.1.0' }),
    reduceUpdateEvent(initialUpdateState, { type: 'available', version: '0.2.0', notes: '{"a":1}' }),
    reduceUpdateEvent(initialUpdateState, { type: 'progress', percent: 42 }),
    reduceUpdateEvent(initialUpdateState, { type: 'downloaded', version: '0.2.0' }),
    reduceUpdateEvent(initialUpdateState, { type: 'error', message: '{"message":"raw"}' })
  ];
  for (const state of states) assertClean(describeUpdate(state, CURRENT));
});
