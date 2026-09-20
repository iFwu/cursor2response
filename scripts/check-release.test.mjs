import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-release.mjs', import.meta.url));
function repository(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const write = (name, content) => writeFileSync(path.join(directory, name), content);
    const check = (...args) => spawnSync(process.execPath, [checker, ...args], { cwd: directory, encoding: 'utf8' });
    run({ directory, write, check });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('accepts a clean source tree and directory links, excluding ignored local configuration', () => repository(({ directory, write, check }) => {
  mkdirSync(path.join(directory, 'docs'));
  write('README.md', '[docs](docs/)');
  write('docs/guide.md', 'A public guide.');
  write('.gitignore', '.env\n');
  write('.env', 'TOKEN=local-only');
  assert.equal(check().status, 0);
}));

test('rejects credentials without printing the credential value', () => repository(({ write, check }) => {
  const secret = 'crsr_' + 'A'.repeat(30);
  write('config.json', JSON.stringify({ token: secret }));
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provider credential/);
  assert.ok(!result.stderr.includes(secret));
}));

test('checks the staged tree even when the working file has been cleaned', () => repository(({ directory, write, check }) => {
  write('.env', 'TOKEN=local-only');
  write('README.md', '[missing](missing.md)');
  execFileSync('git', ['add', '.env', 'README.md'], { cwd: directory });
  write('README.md', 'Clean working copy.');
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local configuration/);
  assert.match(result.stderr, /missing local link/);
}));

test('rejects a staged symlink even when its target name looks harmless', () => repository(({ directory, check }) => {
  symlinkSync('../.env', path.join(directory, 'config'));
  execFileSync('git', ['add', 'config'], { cwd: directory });
  const result = check('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-regular index entry/);
}));

test('accepts reviewed documentation PNGs in both the working tree and index', () => repository(({ directory, write, check }) => {
  mkdirSync(path.join(directory, 'docs/images'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  write('docs/images/overview-en.png', png);
  assert.equal(check().status, 0);
  execFileSync('git', ['add', '.'], { cwd: directory });
  assert.equal(check('--staged').status, 0);
}));

test('rejects disguised, truncated, and unreviewed binary assets', () => repository(({ directory, write, check }) => {
  mkdirSync(path.join(directory, 'docs/images'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  for (const [name, bytes] of [
    ['docs/images/overview-en.png', Buffer.from('not a PNG')],
    ['docs/images/overview-en.png', png.subarray(0, 20)],
    ['docs/images/overview-en.png', Buffer.concat([png, Buffer.from('trailing data')])],
    ['docs/images/unreviewed.png', png],
    ['artifact.png', png],
  ]) {
    write(name, bytes);
    const result = check();
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /PNG|binary asset/);
    rmSync(path.join(directory, name));
  }
}));
