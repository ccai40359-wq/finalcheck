// 产物路径闸回归（P1，lane A 实测链：agent 把 config.json / ~/.ssh/id_rsa 登记成产物，
// 用户点开就经 artifact:read 读出来，绕开 read_file 的敏感路径限制）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { assertArtifactPath } from '../desktop/src/main/artifact-gate.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';

const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const home = os.homedir();

test('artifact gate: 拒绝 %APPDATA%/FinalCheck 下的 config.json（含真 API Key）', () => {
  const p = path.join(appdata, 'FinalCheck', 'config.json');
  const out = assertArtifactPath(p);
  assert.equal(out.ok, false, 'APPDATA/FinalCheck 必须命中敏感目录');
  assert.match(String(out.reason), /敏感路径|APPDATA/);
});

test('artifact gate: 拒绝 SSH 私钥与 .ssh 目录', () => {
  for (const p of [path.join(home, '.ssh', 'id_rsa'), path.join(home, '.ssh', 'known_hosts')]) {
    assert.equal(assertArtifactPath(p).ok, false, p + ' 必须被拒绝');
  }
  assert.equal(assertArtifactPath(path.join(home, '.aws', 'credentials')).ok, false);
});

test('artifact gate: 普通产物路径照常放行（临时目录 / 项目外的报告文件）', () => {
  assert.equal(assertArtifactPath('D:/tmp/report.html').ok, true);
  assert.equal(assertArtifactPath(path.join(os.tmpdir(), 'shot.png')).ok, true);
});

test('artifact gate: 传 workspace 策略时仍是同一道闸（模式不会放宽敏感目录）', () => {
  const policy = createPolicy({ projectPath: 'D:/demo', mode: 'workspace' });
  const p = path.join(appdata, 'FinalCheck', 'config.json');
  assert.equal(assertArtifactPath(p, { policy }).ok, false, 'workspace 模式下敏感目录依旧拒绝');
  assert.equal(assertArtifactPath(path.join(home, '.ssh', 'id_rsa'), { policy }).ok, false);
});
