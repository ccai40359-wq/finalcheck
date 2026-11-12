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
