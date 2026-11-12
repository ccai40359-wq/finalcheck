import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('versions: repository root and desktop package stay aligned', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  assert.equal(rootPkg.version, desktopPkg.version, 'root package.json must match desktop/package.json');
  assert.equal(rootPkg.private, true, 'root package is the CLI source, not a publish target');
  assert.ok(rootPkg.bin?.finalcheck, 'root package must expose the finalcheck CLI');
});

test('versions: CHANGELOG has an entry for the desktop package version', () => {
  const desktopPkg = JSON.parse(readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## [${desktopPkg.version}]`), `CHANGELOG.md must contain ${desktopPkg.version}`);
});

test('versions: both READMEs advertise the same test count', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeZh = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  const badge = (text) => {
    const m = text.match(/img\.shields\.io\/badge\/tests-(\d+)%20passing/);
    assert.ok(m, 'README must carry a tests-<n>%20passing badge');
    return Number(m[1]);
  };
  const badgeEn = badge(readme);
  const badgeZh = badge(readmeZh);
  assert.equal(badgeEn, badgeZh, 'English and Chinese README test badges must match');

  const bodyNumbers = (text) => {
    const patterns = [
      /(\d+)\s+tests passing/g,
      /\(\s*(\d+)\s+passing\s*\)/g,
      /(\d+)\s+项全绿/g,
      /(\d+)\s+项测试/g,
    ];
    return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1])));
  };
  for (const n of bodyNumbers(readme)) assert.equal(n, badgeEn, 'README.md prose must match the badge count');
  for (const n of bodyNumbers(readmeZh)) assert.equal(n, badgeZh, 'README.zh-CN.md prose must match the badge count');
});
