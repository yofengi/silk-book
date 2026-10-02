/* global console, process */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdaterSignature } from './verify-updater-signature.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'windows-x64': { target: 'x86_64-pc-windows-msvc', bundle: 'nsis', extension: '.exe', suffix: 'windows-x64-setup.exe', updaterTarget: 'windows-x86_64' },
  'macos-arm64': { target: 'aarch64-apple-darwin', bundle: 'dmg', extension: '.dmg', suffix: 'macos-arm64.dmg', updaterTarget: 'darwin-aarch64', updateSuffix: 'macos-arm64.app.tar.gz' },
  'macos-x64': { target: 'x86_64-apple-darwin', bundle: 'dmg', extension: '.dmg', suffix: 'macos-x64.dmg', updaterTarget: 'darwin-x86_64', updateSuffix: 'macos-x64.app.tar.gz' },
};

async function versionAt(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version) || pkg.version !== config.version) {
    throw new Error('Package and Tauri versions must match a valid release version');
  }
  if (root === projectDir && process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) {
    throw new Error('Release tag must match the package version');
  }
  return pkg.version;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function onlyArtifact(directory, extension, label) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension));
  if (candidates.length !== 1) throw new Error(`Expected one ${label}, found ${candidates.length}`);
  return path.join(directory, candidates[0].name);
}

async function publicKeyAt(root) {
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (!config.bundle?.createUpdaterArtifacts || !config.plugins?.updater?.requireSignedVersion || !config.plugins.updater.pubkey) {
    throw new Error('Signed, version-bound updater artifacts must be enabled');
  }
  return config.plugins.updater.pubkey;
}

async function stage(source, destination) {
  const bytes = await readFile(source);
  if (!bytes.length) throw new Error(`Installer is empty: ${source}`);
  await copyFile(source, destination);
  await writeFile(`${destination}.sha256`, `${sha256(bytes)}  ${path.basename(destination)}\n`);
  return bytes;
}

export async function prepareArtifact(platform, root = projectDir) {
  const options = targets[platform];
  if (!options) throw new Error(`Unsupported platform: ${platform}`);
  const version = await versionAt(root);
  const bundleDir = path.join(root, 'src-tauri', 'target', options.target, 'release', 'bundle', options.bundle);
  const source = await onlyArtifact(bundleDir, options.extension, `${platform} installer`);
  const outputDir = path.join(root, 'release-artifacts');
  const name = `silk-book-${version}-${options.suffix}`;
  await mkdir(outputDir, { recursive: true });
  await stage(source, path.join(outputDir, name));
  const updaterSource = options.updateSuffix
    ? await onlyArtifact(path.join(bundleDir, '..', 'macos'), '.app.tar.gz', `${platform} updater archive`)
    : source;
  const updaterName = `silk-book-${version}-${options.updateSuffix ?? options.suffix}`;
  const signature = (await readFile(`${updaterSource}.sig`, 'utf8')).trim();
  const updaterBytes = await readFile(updaterSource);
  verifyUpdaterSignature(updaterBytes, signature, await publicKeyAt(root), version);
  if (updaterSource !== source) await stage(updaterSource, path.join(outputDir, updaterName));
  await writeFile(path.join(outputDir, `${updaterName}.sig`), signature);
  return name;
}

export async function combineChecksums(root = projectDir) {
  const version = await versionAt(root);
  const outputDir = path.join(root, 'release-artifacts');
  const lines = [];
  const platforms = {};
  const publicKey = await publicKeyAt(root);
  for (const options of Object.values(targets)) {
    for (const suffix of [options.suffix, ...(options.updateSuffix ? [options.updateSuffix] : [])]) {
      const name = `silk-book-${version}-${suffix}`;
      const bytes = await readFile(path.join(outputDir, name));
      const expected = `${sha256(bytes)}  ${name}\n`;
      if (await readFile(path.join(outputDir, `${name}.sha256`), 'utf8') !== expected) {
        throw new Error(`Checksum mismatch: ${name}`);
      }
      lines.push(expected);
    }
    const updaterName = `silk-book-${version}-${options.updateSuffix ?? options.suffix}`;
    const signature = (await readFile(path.join(outputDir, `${updaterName}.sig`), 'utf8')).trim();
    verifyUpdaterSignature(await readFile(path.join(outputDir, updaterName)), signature, publicKey, version);
    platforms[options.updaterTarget] = {
      signature,
      url: `https://github.com/yofengi/silk-book/releases/download/v${version}/${updaterName}`,
    };
    lines.push(`${sha256(Buffer.from(signature))}  ${updaterName}.sig\n`);
  }
  const notes = (await readFile(path.join(root, 'docs', 'releases', `v${version}.md`), 'utf8')).trim();
  if (!notes) throw new Error('Release notes are required');
  const manifest = JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n';
  await writeFile(path.join(outputDir, 'latest.json'), manifest);
  lines.push(`${sha256(Buffer.from(manifest))}  latest.json\n`);
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), lines.sort().join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2];
  if (platform === 'checksums') {
    await combineChecksums();
    console.log('Verified all installers, signed updates and versions; wrote latest.json and SHA256SUMS.txt');
  } else {
    console.log(await prepareArtifact(platform));
  }
}
