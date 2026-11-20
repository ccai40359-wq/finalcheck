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

test('artifact gate: 拒绝应用自己的 config.json（含真 API Key）', () => {
  // 2026-11-20 Linux 移植：原来这条只测 %APPDATA%\FinalCheck（Windows）。
  // Linux 上配置在 ~/.config/FinalCheck（XDG），macOS 在 Application Support ——
  // 里面的 config.json 同样存着 API Key，必须一样被挡住。按平台取实际路径，
  // 断言只要求「被拒 + 原因里带敏感字样」，不写死目录名。
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(appdata, 'FinalCheck', 'config.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'FinalCheck', 'config.json'));
  } else {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'FinalCheck', 'config.json'));
  }
  for (const p of candidates) {
    const out = assertArtifactPath(p);
    assert.equal(out.ok, false, `${p} 必须命中敏感目录`);
    assert.match(String(out.reason), /敏感路径|APPDATA|API Key/);
  }
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
