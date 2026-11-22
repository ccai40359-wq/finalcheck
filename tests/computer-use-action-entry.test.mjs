import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { host, original, other, reset } from './fixtures/cu-desktop-host.mjs';

register('./fixtures/cu-desktop-host.mjs', import.meta.url);
let instance = 0;
async function session({ grants = ['notepad', 'calc'], target = 'window' } = {}) {
  reset();
  const cu = await import(`../desktop/src/main/computer-use.mjs?regression=${++instance}`);
  cu.grantApps(grants);
  const shot = await cu.captureScreen({ target });
  assert.equal(shot.canAct, true, shot.error || shot.observationOnlyReason);
  return { cu, click: () => cu.performAction('left_click', { screenshotId: shot.screenshotId, x: 10, y: 10 }) };
}

test('refocus checks the target grant before changing focus', async () => {
  const app = await session({ grants: ['calc'] });
  host.foreground = other;
  assert.equal((await app.click()).deniedBy, 'access');
  assert.deepEqual(host.calls, []);
});

test('restored target must retain its grant and the observed geometry', async () => {
  for (const scenario of ['revoked', 'moved', 'stable']) {
    const app = await session();
    host.foreground = other;
    if (scenario === 'revoked') host.onFocus = () => app.cu.revokeApps();
    if (scenario === 'moved') host.target = { ...original, bounds: { ...original.bounds, x: 50 } };
    const result = await app.click();
    if (scenario === 'stable') {
      assert.equal(result.ok, true);
      assert.deepEqual(host.calls, ['focus', 'click']);
    } else {
      assert.equal(result.deniedBy, scenario === 'revoked' ? 'access' : 'screenshot-required');
      assert.deepEqual(host.calls, ['focus']);
    }
  }
});

test('occlusion uses only a window capture and never dispatches a second click', async () => {
  for (const scenario of ['screen', 'success', 'timeout', 'invoke-rpc-error', 'no-pattern']) {
    const app = await session({ target: scenario === 'screen' ? 'screen' : 'window' });
    host.blocker = other;
    const unknown = scenario === 'timeout' || scenario === 'invoke-rpc-error';
    if (unknown || scenario === 'no-pattern') {
      host.invokeResult = { ok: false, code: scenario, message: scenario };
    }
    const result = await app.click();
    if (scenario === 'success') assert.equal(result.ok, true);
    else assert.equal(result.deniedBy, unknown ? 'action-outcome-unknown' : 'occluded');
    if (unknown) assert.equal((await app.click()).deniedBy, 'screenshot-required');
    assert.deepEqual(host.calls, scenario === 'screen' ? [] : ['invoke']);
  }
});

test('a partial observation cannot confirm disappearance; confirmed closure can', async () => {
  const { cu } = await session();
  let calls = 0;
  const observations = [
    { ok: false, message: 'provider unavailable' },
    { ok: true, windowAlive: true, complete: false, elements: [] },
    { ok: true, windowAlive: false, elements: [] }
  ];
  Object.defineProperty(host, 'observation', {
    configurable: true, get: () => observations[calls++]
  });
  try {
    const result = await cu.waitFor({ condition: 'element-gone', target: { selector: 'Save' } });
    assert.equal(result.matched, true);
    assert.equal(result.windowClosed, true);
    assert.equal(result.attempts, 3);
  } finally {
    delete host.observation;
  }
});
