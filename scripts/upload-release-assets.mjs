/* global console, process */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'yofengi/silk-book';
const workflow = '.github/workflows/build-installers.yml';
const checksumName = 'SHA256SUMS.txt';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();

export function validateRun(run, settings) {
  assert.equal(run.repository?.full_name, repository, 'Build repository mismatch');
  assert.equal(run.head_repository?.full_name, repository, 'Build source repository mismatch');
  assert.equal(String(run.id), settings.runId, 'Build run ID mismatch');
  assert.equal(run.path, workflow, 'Build workflow mismatch');
  assert.equal(run.status, 'completed', 'Build is incomplete');
  assert.equal(run.conclusion, 'success', 'Build did not pass');
  assert.equal(run.head_sha, settings.sha, 'Build source SHA mismatch');
}

export function selectArtifact(artifacts, settings) {
  const matches = artifacts.filter(artifact => artifact.name === 'silk-book-installers');
  assert.equal(matches.length, 1, 'Expected one silk-book-installers artifact');
  const artifact = matches[0];
  assert.equal(artifact.expired, false, 'Build artifact expired');
  assert.ok(Date.parse(artifact.expires_at) > Date.now(), 'Build artifact retention expired');
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'Invalid artifact ID');
  assert.equal(String(artifact.workflow_run?.id), settings.runId, 'Artifact run mismatch');
  assert.equal(artifact.workflow_run?.head_sha, settings.sha, 'Artifact source SHA mismatch');
  return artifact;
}

export function validateDraft(release, settings, notes) {
  assert.equal(release.tag_name, settings.tag, 'Release tag changed');
  assert.equal(release.target_commitish, settings.sha, 'Draft targets a different source SHA');
  assert.equal(release.draft, true, 'Release must remain a draft');
  assert.equal(release.prerelease, false, 'Prereleases are not supported');
  const normalizeNotes = value => value.replace(/\r\n/g, '\n').trim();
  assert.equal(normalizeNotes(release.body ?? ''), normalizeNotes(notes), 'Draft release notes differ from the tested source');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid draft release ID');
}

export function checkRemoteAssets(remote, local, complete = false) {
  const expected = new Map(local.map(asset => [asset.name, asset]));
  const seen = new Set();
  for (const asset of remote) {
    assert.ok(expected.has(asset.name), `Unexpected remote asset: ${asset.name}`);
    assert.ok(!seen.has(asset.name), `Duplicate remote asset: ${asset.name}`);
    seen.add(asset.name);
    const wanted = expected.get(asset.name);
    assert.equal(asset.state, 'uploaded', `Remote asset is not uploaded: ${asset.name}`);
    assert.equal(asset.size, wanted.size, `Remote asset size mismatch: ${asset.name}`);
    assert.equal(asset.digest, wanted.digest, `Remote asset digest mismatch: ${asset.name}`);
  }
  if (complete) assert.equal(seen.size, 10, 'Release must contain exactly ten verified assets');
  return local.filter(asset => !seen.has(asset.name));
}

function settingsFrom(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    assert.ok(['--verify-run', '--check-only', '--build-run-id', '--release-tag', '--source-sha', '--source', '--assets'].includes(name), `Unknown option: ${name}`);
    assert.ok(!flags.has(name), `Duplicate option: ${name}`);
    if (name === '--verify-run' || name === '--check-only') flags.set(name, true);
    else {
      assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value: ${name}`);
      flags.set(name, args[++index]);
    }
  }
  const runId = flags.get('--build-run-id') ?? process.env.BUILD_RUN_ID;
  const tag = flags.get('--release-tag') ?? process.env.RELEASE_TAG;
  const sha = flags.get('--source-sha') ?? process.env.SOURCE_SHA;
  assert.match(runId ?? '', /^[1-9]\d*$/, 'Build run ID must be a positive integer');
  assert.match(tag ?? '', /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release tag must be a stable vX.Y.Z');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'Source SHA must be the full lowercase commit SHA');
  assert.ok(!(flags.has('--verify-run') && flags.has('--check-only')), 'Choose one verification mode');
  return {
    runId, tag, sha, version: tag.slice(1), verifyRun: flags.has('--verify-run'), checkOnly: flags.has('--check-only'),
    source: path.resolve(flags.get('--source') ?? process.env.SOURCE_DIRECTORY ?? 'source'),
    directory: path.resolve(flags.get('--assets') ?? process.env.ASSET_DIRECTORY ?? 'release-assets'),
  };
}

function gh(args, timeout = 120000) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function api(endpoint, paginated = false) {
  const args = ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (paginated) args.push('--paginate', '--slurp');
  return JSON.parse(gh([...args, endpoint]));
}
function git(source, args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}
async function verifiedBuild(settings) {
  const run = api(`repos/${repository}/actions/runs/${settings.runId}`);
  validateRun(run, settings);
  const pages = api(`repos/${repository}/actions/runs/${settings.runId}/artifacts?per_page=100`, true);
  return selectArtifact(pages.flatMap(page => page.artifacts), settings);
}

export async function verifyLocalAssets(settings) {
  assert.equal(git(settings.source, ['rev-parse', 'HEAD']), settings.sha, 'Checkout must match the tested SHA');
  const notesFile = `docs/releases/${settings.tag}.md`;
  assert.equal(git(settings.source, ['status', '--porcelain', '--untracked-files=no', '--',
    'package.json', 'src-tauri/tauri.conf.json', notesFile, 'scripts/verify-updater-signature.mjs']), '', 'Tested release source files must be unchanged');
  const pkg = JSON.parse(await readFile(path.join(settings.source, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(settings.source, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(pkg.version, settings.version, 'Package version does not match the tag');
  assert.equal(config.version, settings.version, 'Tauri version does not match the tag');
  assert.equal(config.bundle?.createUpdaterArtifacts, true, 'Updater artifacts must be enabled');
  assert.equal(config.plugins?.updater?.requireSignedVersion, true, 'Version-bound signatures are required');
  const notes = (await readFile(path.join(settings.source, notesFile), 'utf8')).trim();
  assert.ok(notes, 'Release notes are empty');
  const platformFiles = {
    'windows-x86_64': `silk-book-${settings.version}-windows-x64-setup.exe`,
    'darwin-aarch64': `silk-book-${settings.version}-macos-arm64.app.tar.gz`,
    'darwin-x86_64': `silk-book-${settings.version}-macos-x64.app.tar.gz`,
  };
  const binaries = [...Object.values(platformFiles), `silk-book-${settings.version}-macos-arm64.dmg`, `silk-book-${settings.version}-macos-x64.dmg`];
  const hashedNames = [...binaries, ...Object.values(platformFiles).map(name => `${name}.sig`), 'latest.json'];
  const uploadNames = [...hashedNames, checksumName];
  const allowedNames = new Set([...uploadNames, ...binaries.map(name => `${name}.sha256`)]);
  for (const entry of await readdir(settings.directory, { withFileTypes: true })) {
    assert.ok(entry.isFile() && allowedNames.has(entry.name), `Unexpected artifact entry: ${entry.name}`);
  }
  const checksums = await readFile(path.join(settings.directory, checksumName), 'utf8');
  const lines = checksums.trimEnd().split('\n');
  assert.equal(lines.length, 9, 'SHA256SUMS.txt must contain exactly nine entries');
  const expected = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    assert.ok(match, 'Invalid checksum entry');
    assert.ok(!expected.has(match[2]), `Duplicate checksum entry: ${match[2]}`);
    expected.set(match[2], match[1]);
  }
  assert.deepEqual(sorted(expected.keys()), sorted(hashedNames), 'Unexpected checksum asset names');
  const local = [], bytesByName = new Map();
  for (const name of uploadNames) {
    const file = path.join(settings.directory, name);
    const info = await lstat(file);
    assert.ok(info.isFile() && info.size > 0 && info.size <= 512 * 1024 * 1024, `Invalid artifact file: ${name}`);
    const bytes = await readFile(file);
    const digest = sha256(bytes);
    if (name !== checksumName) assert.equal(digest, expected.get(name), `Local checksum mismatch: ${name}`);
    bytesByName.set(name, bytes);
    local.push({ name, file, size: bytes.length, digest: `sha256:${digest}` });
  }
  const feed = JSON.parse(bytesByName.get('latest.json').toString('utf8'));
  assert.equal(feed.version, settings.version, 'Updater feed version mismatch');
  assert.equal(feed.notes, notes, 'Updater feed notes mismatch');
  assert.ok(typeof feed.pub_date === 'string' && new Date(feed.pub_date).toISOString() === feed.pub_date, 'Invalid feed publication date');
  assert.deepEqual(sorted(Object.keys(feed.platforms ?? {})), sorted(Object.keys(platformFiles)), 'Updater feed platforms mismatch');
  const { verifyUpdaterSignature } = await import(pathToFileURL(path.join(settings.source, 'scripts/verify-updater-signature.mjs')).href);
  for (const [platform, name] of Object.entries(platformFiles)) {
    const signature = bytesByName.get(`${name}.sig`).toString('utf8').trim();
    assert.equal(feed.platforms[platform].signature, signature, `Updater signature mismatch: ${platform}`);
    assert.equal(feed.platforms[platform].url, `https://github.com/${repository}/releases/download/${settings.tag}/${name}`, `Updater URL mismatch: ${platform}`);
    verifyUpdaterSignature(bytesByName.get(name), signature, config.plugins.updater.pubkey, settings.version);
  }
  for (const name of binaries) {
    const sidecar = path.join(settings.directory, `${name}.sha256`);
    try { assert.equal(await readFile(sidecar, 'utf8'), `${expected.get(name)}  ${name}\n`, `Sidecar checksum mismatch: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { local, notes };
}

function findDraft(settings, notes) {
  const releases = api(`repos/${repository}/releases?per_page=100`, true).flat();
  const matches = releases.filter(release => release.tag_name === settings.tag);
  assert.equal(matches.length, 1, 'Expected one existing release for the requested tag');
  validateDraft(matches[0], settings, notes);
  return matches[0];
}
function remoteAssets(id) {
  return api(`repos/${repository}/releases/${id}/assets?per_page=100`, true).flat();
}

async function main() {
  const settings = settingsFrom(process.argv.slice(2));
  const artifact = await verifiedBuild(settings);
  if (settings.verifyRun) {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `source_sha=${settings.sha}\nartifact_id=${artifact.id}\n`);
    console.log(JSON.stringify({ verifiedBuild: settings.runId, source: settings.sha, artifactId: artifact.id }));
    return;
  }
  const { local, notes } = await verifyLocalAssets(settings);
  const draft = findDraft(settings, notes);
  let missing = checkRemoteAssets(remoteAssets(draft.id), local);
  if (!settings.checkOnly) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Uploads must run in GitHub Actions');
    assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Uploader repository mismatch');
    for (const asset of missing) {
      validateDraft(api(`repos/${repository}/releases/${draft.id}`), settings, notes);
      if (!checkRemoteAssets(remoteAssets(draft.id), local).some(value => value.name === asset.name)) continue;
      console.log(`Uploading missing asset: ${asset.name}`);
      gh(['release', 'upload', settings.tag, asset.file, '--repo', repository], 15 * 60 * 1000);
      checkRemoteAssets(remoteAssets(draft.id), local);
    }
    validateDraft(api(`repos/${repository}/releases/${draft.id}`), settings, notes);
    checkRemoteAssets(remoteAssets(draft.id), local, true);
    missing = [];
  }
  const summary = { releaseId: draft.id, tag: settings.tag, source: settings.sha, buildRunId: settings.runId,
    expected: local.length, matched: local.length - missing.length, missing: missing.map(asset => asset.name), draft: true, checkOnly: settings.checkOnly };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```json\n' + JSON.stringify(summary, null, 2) + '\n```\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
