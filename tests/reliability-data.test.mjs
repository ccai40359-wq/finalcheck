import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkBackup, checkPrivacy } from '../src/checks/data.mjs';

async function fixture(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-data-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

test('L3 backup needs executable backup, schedule and a recent explicit restore confirmation', async (t) => {
  const dir = await fixture(t, { 'backup.sh': 'pg_dump mydb > snapshot.sql\n' });
  const scriptOnly = await checkBackup(dir, { tier: 'L3' });
  assert.ok(scriptOnly.findings.some((f) => f.rule === 'D2.schedule-missing'));
  assert.ok(scriptOnly.findings.some((f) => f.rule === 'D2.restore-unverified'));
  await writeFile(path.join(dir, 'crontab'), '0 2 * * * /app/backup.sh\n');
  const scheduled = await checkBackup(dir, { tier: 'L3' });
  assert.ok(!scheduled.findings.some((f) => f.rule === 'D2.schedule-missing'));
  assert.ok(scheduled.findings.some((f) => f.rule === 'D2.restore-unverified'));
  await writeFile(path.join(dir, 'restore-drill.txt'), 'Restored snapshot into isolated database and verified row counts.\n');
  const evidence = { backupRestore: { status: 'confirmed', checkedAt: new Date().toISOString(), reviewer: 'test reviewer', evidence: 'restore-drill.txt' } };
  await writeFile(path.join(dir, 'finalcheck.evidence.json'), JSON.stringify(evidence));
  const confirmed = await checkBackup(dir, { tier: 'L3' });
  assert.deepEqual(confirmed.findings, []);
  assert.match(confirmed.warnings.join(' '), /人工确认/);
  evidence.backupRestore.checkedAt = '2000-01-01T00:00:00Z';
  await writeFile(path.join(dir, 'finalcheck.evidence.json'), JSON.stringify(evidence));
  assert.ok((await checkBackup(dir, { tier: 'L3' })).findings.some((f) => f.rule === 'D2.restore-unverified'));
});

test('privacy compares declared fields against persisted object fields and preserves unknown declarations', async (t) => {
  const dir = await fixture(t, {
    'app.js': "app.post('/users', (req, res) => { const data = { email: req.body.email, phone: req.body.phone }; users.create(data); });\n",
    'PRIVACY.md': 'We do not collect email addresses or phone numbers. Retention: 30 days.\n',
  });
  const unknown = await checkPrivacy(dir, { tier: 'L3' });
  assert.ok(unknown.coverageGap, 'free text alone is not a verified field declaration');
  await writeFile(path.join(dir, 'PRIVACY.md'), 'We collect no email addresses or phone numbers. Retention: 30 days.\n');
  assert.ok((await checkPrivacy(dir, { tier: 'L3' })).findings.some((f) => f.rule === 'D3.declaration-conflict'));
  await writeFile(path.join(dir, 'finalcheck.privacy.json'), JSON.stringify({ collectedFields: ['email'] }));
  const mismatch = await checkPrivacy(dir, { tier: 'L3' });
  assert.ok(mismatch.findings.some((f) => f.rule === 'D3.undeclared-field' && f.snippet === 'phone'));
  await writeFile(path.join(dir, 'finalcheck.privacy.json'), JSON.stringify({ collectedFields: ['email', 'phone'] }));
  const matched = await checkPrivacy(dir, { tier: 'L3' });
  assert.ok(!matched.findings.some((f) => f.rule === 'D3.undeclared-field'));
  assert.equal(matched.coverageGap, null);
  await writeFile(path.join(dir, 'finalcheck.privacy.json'), JSON.stringify({ collectedFields: ['email', 'phone', 'idcard'] }));
  assert.ok((await checkPrivacy(dir, { tier: 'L3' })).findings.some((f) => f.rule === 'D3.declared-field-unverified'));
});
