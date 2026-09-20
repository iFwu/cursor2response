import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const staged = process.argv.includes('--staged');
const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const names = [...new Set(git(['ls-files', '-z', ...(staged ? [] : ['--cached', '--others', '--exclude-standard'])]).toString().split('\0').filter(Boolean))];
const failures = [];
const reviewedImages = new Set([
  'overview-en', 'overview-zh-CN', 'runtime-flow-en', 'runtime-flow-zh-CN',
  'trace-timeline', 'trace-runtime',
].map((name) => `docs/images/${name}.png`));
const modes = new Map(git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map((entry) => {
  const tab = entry.indexOf('\t');
  return [entry.slice(tab + 1), entry.slice(0, 6)];
}));
const forbidden = [
  ['private hostname', /(?<![\w.-])(?!host\.docker\.internal\b)(?:[\w-]+\.)+internal\b/i],
  ['personal home path', /\/(?:home|Users)\/(?!example(?:\/|\b)|node(?:\/|\b))[a-z][\w.-]*\//i],
  ['private network address', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/],
  ['provider credential', /\b(?:crsr_|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}\b/],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

for (const name of names) {
  if (/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars|.*\.(?:pem|key|db|sqlite|log))$/.test(name) && !name.endsWith('.env.example')) {
    failures.push(`${name}: local configuration or runtime artifact`);
  }
  if (/^(?:node_modules|\.validation|\.runtime|\.local|dist)\//.test(name)) failures.push(`${name}: generated or private directory`);
  let bytes;
  if (staged) {
    if (!['100644', '100755'].includes(modes.get(name))) { failures.push(`${name}: non-regular index entry requires review`); continue; }
    bytes = git(['show', `:${name}`]);
  }
  else {
    const info = lstatSync(path.join(root, name));
    if (!info.isFile()) { failures.push(`${name}: non-regular file requires review`); continue; }
    bytes = readFileSync(path.join(root, name));
  }
  if (reviewedImages.has(name)) {
    // These names require visual/privacy review on every change; signatures only identify the format.
    if (bytes.length < 45
      || !bytes.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
      || !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
      failures.push(`${name}: expected a complete PNG image`);
    }
    continue;
  }
  if (bytes.includes(0)) { failures.push(`${name}: binary asset requires manual review`); continue; }
  const text = bytes.toString('utf8');
  for (const [label, pattern] of forbidden) if (pattern.test(text)) failures.push(`${name}: ${label}`);
  if (name.endsWith('.md')) {
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), decodeURIComponent(target))).replace(/\/$/, '');
      if (!names.some((entry) => entry === resolved || entry.startsWith(`${resolved}/`))) failures.push(`${name}: missing local link ${target}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release tree check passed (${names.length} files, ${staged ? 'index' : 'working tree'}). Review attribution, commit identity, and outgoing history separately.`);
}
