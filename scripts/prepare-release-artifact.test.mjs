import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { combineChecksums, prepareArtifact } from './prepare-release-artifact.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'silk-book-artifacts-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src-tauri'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '0.1.0' }));
  return root;
}

async function installer(root, target, bundle, name) {
  const dir = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle', bundle);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), `test installer ${target}`);
  return dir;
}

test('uses fixed platform filenames and verifies every checksum', async (t) => {
  const root = await fixture(t);
  await installer(root, 'x86_64-pc-windows-msvc', 'nsis', 'Boshu_0.1.0_x64-setup.exe');
  await installer(root, 'aarch64-apple-darwin', 'dmg', 'Boshu_0.1.0_aarch64.dmg');
  await installer(root, 'x86_64-apple-darwin', 'dmg', 'Boshu_0.1.0_x64.dmg');
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const name = await prepareArtifact(platform, root);
    assert.match(name, new RegExp(`^silk-book-0\\.1\\.0-${platform}`));
  }
  await combineChecksums(root);
  const sums = await readFile(path.join(root, 'release-artifacts', 'SHA256SUMS.txt'), 'utf8');
  assert.equal(sums.trim().split('\n').length, 3);
  await writeFile(path.join(root, 'release-artifacts', 'silk-book-0.1.0-macos-arm64.dmg'), 'tampered');
  await assert.rejects(combineChecksums(root), /Checksum mismatch/);
});

test('rejects ambiguous bundle output and mismatched versions', async (t) => {
  const root = await fixture(t);
  const dir = await installer(root, 'x86_64-pc-windows-msvc', 'nsis', 'first.exe');
  await writeFile(path.join(dir, 'second.exe'), 'other installer');
  await assert.rejects(prepareArtifact('windows-x64', root), /Expected one/);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await assert.rejects(prepareArtifact('windows-x64', root), /versions must match/);
});
