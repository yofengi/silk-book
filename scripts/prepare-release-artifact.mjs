/* global console, process */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'windows-x64': { target: 'x86_64-pc-windows-msvc', bundle: 'nsis', extension: '.exe', suffix: 'windows-x64-setup.exe' },
  'macos-arm64': { target: 'aarch64-apple-darwin', bundle: 'dmg', extension: '.dmg', suffix: 'macos-arm64.dmg' },
  'macos-x64': { target: 'x86_64-apple-darwin', bundle: 'dmg', extension: '.dmg', suffix: 'macos-x64.dmg' },
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

export async function prepareArtifact(platform, root = projectDir) {
  const options = targets[platform];
  if (!options) throw new Error(`Unsupported platform: ${platform}`);
  const version = await versionAt(root);
  const bundleDir = path.join(root, 'src-tauri', 'target', options.target, 'release', 'bundle', options.bundle);
  const candidates = (await readdir(bundleDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(options.extension));
  if (candidates.length !== 1) throw new Error(`Expected one ${platform} installer, found ${candidates.length}`);
  const source = path.join(bundleDir, candidates[0].name);
  const outputDir = path.join(root, 'release-artifacts');
  const name = `silk-book-${version}-${options.suffix}`;
  const bytes = await readFile(source);
  if (!bytes.length) throw new Error(`Installer is empty: ${source}`);
  await mkdir(outputDir, { recursive: true });
  await copyFile(source, path.join(outputDir, name));
  await writeFile(path.join(outputDir, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
  return name;
}

export async function combineChecksums(root = projectDir) {
  const version = await versionAt(root);
  const outputDir = path.join(root, 'release-artifacts');
  const lines = [];
  for (const options of Object.values(targets)) {
    const name = `silk-book-${version}-${options.suffix}`;
    const bytes = await readFile(path.join(outputDir, name));
    const expected = `${sha256(bytes)}  ${name}\n`;
    if (await readFile(path.join(outputDir, `${name}.sha256`), 'utf8') !== expected) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
    lines.push(expected);
  }
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), lines.sort().join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2];
  if (platform === 'checksums') {
    await combineChecksums();
    console.log('Verified all three installers and wrote SHA256SUMS.txt');
  } else {
    console.log(await prepareArtifact(platform));
  }
}
