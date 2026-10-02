import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import test from 'node:test';
import { combineChecksums, prepareArtifact } from './prepare-release-artifact.mjs';
import { verifyUpdaterSignature } from './verify-updater-signature.mjs';

// Ephemeral test keys, never a release signing credential.
function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicText = `untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, rawPublic]).toString('base64')}\n`;
  return {
    pubkey: Buffer.from(publicText).toString('base64'),
    signature(bytes, version = '0.2.0') {
      const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
      const comment = `timestamp:1\tfile:fixture\tversion:${version}`;
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'silk-book-artifacts-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = signer();
  await mkdir(path.join(root, 'src-tauri'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'releases'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'releases', 'v0.2.0.md'), 'Background updates');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
    version: '0.2.0', bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: keys.pubkey, requireSignedVersion: true } },
  }));
  return { root, keys };
}

async function installer(root, target, bundle, name, keys) {
  const dir = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle', bundle);
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(`test installer ${target}`);
  await writeFile(path.join(dir, name), bytes);
  if (keys) await writeFile(path.join(dir, `${name}.sig`), keys.signature(bytes));
  return dir;
}

test('stages signed platform artifacts, verifies checksums and writes a complete pinned feed', async (t) => {
  const { root, keys } = await fixture(t);
  await installer(root, 'x86_64-pc-windows-msvc', 'nsis', 'Boshu_0.2.0_x64-setup.exe', keys);
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    await installer(root, target, 'dmg', 'Boshu.dmg');
    await installer(root, target, 'macos', 'Boshu.app.tar.gz', keys);
  }
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const name = await prepareArtifact(platform, root);
    assert.match(name, new RegExp(`^silk-book-0\\.2\\.0-${platform}`));
  }
  await combineChecksums(root);
  const output = path.join(root, 'release-artifacts');
  const feed = JSON.parse(await readFile(path.join(output, 'latest.json'), 'utf8'));
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
  assert.equal(feed.version, '0.2.0');
  assert.equal(feed.notes, 'Background updates');
  for (const platform of Object.values(feed.platforms)) {
    assert.match(platform.url, /^https:\/\/github.com\/yofengi\/silk-book\/releases\/download\/v0\.2\.0\//);
    assert.ok(platform.signature.length > 100);
  }
  const sums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(sums.trim().split('\n').length, 9);
  await writeFile(path.join(output, 'silk-book-0.2.0-macos-arm64.dmg'), 'tampered');
  await assert.rejects(combineChecksums(root), /Checksum mismatch/);
});

test('rejects missing signatures, invalid signatures, ambiguous output and version mismatch', async (t) => {
  const { root, keys } = await fixture(t);
  const dir = await installer(root, 'x86_64-pc-windows-msvc', 'nsis', 'first.exe');
  await assert.rejects(prepareArtifact('windows-x64', root), /ENOENT/);
  await writeFile(path.join(dir, 'first.exe.sig'), keys.signature(Buffer.from('wrong bytes')));
  await assert.rejects(prepareArtifact('windows-x64', root), /verification failed/);
  await writeFile(path.join(dir, 'second.exe'), 'other installer');
  await assert.rejects(prepareArtifact('windows-x64', root), /Expected one/);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  await assert.rejects(prepareArtifact('windows-x64', root), /versions must match/);
});

test('signature verifies payload, key, signed version and trusted comment', () => {
  const keys = signer();
  const bytes = Buffer.from('fixture installer');
  const signature = keys.signature(bytes);
  verifyUpdaterSignature(bytes, signature, keys.pubkey, '0.2.0');
  assert.throws(() => verifyUpdaterSignature(Buffer.from('tampered'), signature, keys.pubkey, '0.2.0'), /verification failed/);
  assert.throws(() => verifyUpdaterSignature(bytes, signature, signer().pubkey, '0.2.0'), /algorithm or key/);
  assert.throws(() => verifyUpdaterSignature(bytes, signature, keys.pubkey, '0.3.0'), /signed version/);
  const tampered = Buffer.from(Buffer.from(signature, 'base64').toString().replace('version:0.2.0', 'version:0.3.0')).toString('base64');
  assert.throws(() => verifyUpdaterSignature(bytes, tampered, keys.pubkey, '0.3.0'), /verification failed/);
  assert.throws(() => verifyUpdaterSignature(bytes, signature, 'invalid key', '0.2.0'), /encoding/);
});

test('accepts the real Tauri CLI signed fixture used by the native verifier', async () => {
  const root = new URL('../src-tauri/tests/fixtures/', import.meta.url);
  const [bytes, signature, pubkey] = await Promise.all([
    readFile(new URL('update-package.txt', root)),
    readFile(new URL('update-package.txt.sig', root), 'utf8'),
    readFile(new URL('update-package.pub', root), 'utf8'),
  ]);
  verifyUpdaterSignature(bytes, signature, pubkey, '0.3.0');
});
