// SPDX-License-Identifier: GPL-3.0-only

/**
 * Test the tray helper's JSON reader.
 *
 * Two halves. First the C test binary runs its own fixtures — input nobody
 * would think to generate, like a machine named `Ben"s Mac`. Then this script
 * encodes commands exactly as `TrayController` does and feeds them to the same
 * parser, so the encoder and the reader cannot drift apart without a failure.
 *
 * It runs everywhere, not just on Windows. The parser ships only on Windows,
 * but it is hand-written C with fixed buffers reading input the user can
 * influence, and testing it only on the platform that ships it would mean
 * testing it only in the job that has the least reason to fail loudly.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;

function check(what, got, want) {
  checks++;
  const gotText = typeof got === 'string' ? got : JSON.stringify(got);
  const wantText = typeof want === 'string' ? want : JSON.stringify(want);
  if (gotText === wantText) {
    console.log(`  ok   ${what}`);
    return;
  }
  console.log(`  FAIL ${what}\n       got  ${gotText}\n       want ${wantText}`);
  failures++;
}

/** Find a C compiler. Named explicitly so the failure says which are missing. */
async function findCompiler() {
  for (const candidate of ['cc', 'gcc', 'clang']) {
    try {
      await execFile(candidate, ['--version']);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

const compiler = await findCompiler();
if (compiler === null) {
  // Not a failure: a machine with no C compiler cannot build the helper either,
  // and the bridge runs without one. Say so rather than failing the suite.
  console.log('No C compiler found (tried cc, gcc, clang); skipping the tray parser tests.');
  process.exit(0);
}

const work = await mkdtemp(join(tmpdir(), 'vrmc-tray-'));
const binary = join(work, 'json_test');

try {
  await execFile(compiler, [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O1',
    join(here, 'json_test.c'),
    '-o',
    binary,
  ]);
} catch (err) {
  console.error('The tray JSON reader did not compile cleanly:\n');
  console.error(err.stderr || err.message);
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

// --- the C fixtures ---
console.log('Fixtures:');
try {
  const { stdout } = await execFile(binary, []);
  process.stdout.write(
    stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (l.startsWith('  ') ? l : `  ${l}`))
      .join('\n') + '\n',
  );
  checks += Number(/(\d+)\/(\d+) checks passed/.exec(stdout)?.[2] ?? 0);
} catch (err) {
  process.stdout.write(err.stdout ?? '');
  console.error('\nThe C fixtures failed.');
  failures++;
}

/** Feed one line to the parser and return its `key=value` dump. */
function parse(line) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--parse']);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(`${line}\n`);
  });
}

/** Read one field out of the dump. */
function field(dump, key) {
  for (const line of dump.split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return null;
}

// --- the round trip against the real encoder ---
//
// This mirrors what TrayController.setMenu sends. Encoding it here rather than
// importing the bridge keeps the test runnable before anything is built, and
// the shape is asserted against the TypeScript type in tray.test.ts.
console.log('\nRound trip from the encoder:');

const command = {
  type: 'menu',
  tooltip: "VRMC — Ben's \"studio\" Mac",
  items: [
    { id: 'status', label: 'Headset connected', enabled: false },
    { id: 'sep', label: '', separator: true },
    { id: 'code', label: 'Pairing code: K7M-2QX' },
    { id: 'login', label: 'Start at login', checked: true },
    { id: 'quit', label: 'Quit VRMC' },
  ],
};

const dump = await parse(JSON.stringify(command));
check('type survives the round trip', field(dump, 'type'), 'menu');
check('every item is parsed', field(dump, 'count'), '5');
check(
  'a disabled status row',
  field(dump, 'item'),
  '0 id=status enabled=0 separator=0 checked=0 label=Headset connected',
);
check(
  'a checked row',
  dump.split('\n').find((l) => l.startsWith('item=3')),
  'item=3 id=login enabled=1 separator=0 checked=1 label=Start at login',
);
check(
  'a separator row',
  dump.split('\n').find((l) => l.startsWith('item=1')),
  'item=1 id=sep enabled=1 separator=1 checked=0 label=',
);

// The tooltip carries the machine's own name, which is the one string here a
// user controls. JSON.stringify leaves non-ASCII as raw UTF-8, so it has to
// arrive intact — the helper widens it to UTF-16 before Windows sees it, and a
// parser that mangled these bytes would put mojibake in the menu bar.
check('the tooltip survives byte for byte', field(dump, 'tooltip'), 'VRMC — Ben\'s "studio" Mac');

// A label containing what looks like JSON must not be able to add or hide rows.
const hostile = {
  type: 'menu',
  tooltip: 'x',
  items: [
    { id: 'a', label: '"},{"id":"evil","label":"Injected' },
    { id: 'b', label: 'Real' },
  ],
};
const hostileDump = await parse(JSON.stringify(hostile));
check('a label cannot inject a menu row', field(hostileDump, 'count'), '2');
check(
  'the hostile label is kept as text',
  hostileDump.split('\n').find((l) => l.startsWith('item=0')),
  'item=0 id=a enabled=1 separator=0 checked=0 label="},{"id":"evil","label":"Injected',
);

const quit = await parse(JSON.stringify({ type: 'quit' }));
check('a quit command has no items', field(quit, 'items'), 'none');
check('quit is recognised', field(quit, 'type'), 'quit');

await rm(work, { recursive: true, force: true });

console.log(`\n${checks - failures} of ${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
