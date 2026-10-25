/** The trim benchmark builds its native program in a fresh checkout: the
 * directory it builds into is made first (a clone has no tmp/lean). A copy of
 * bench.mjs runs in a temporary tree with a stand-in swiftc that records
 * whether the output directory existed. No Swift toolchain is needed. The
 * tree is left in tmp/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

await mkdir('tmp', { recursive: true });
const tree = await mkdtemp(resolve('tmp/bench-build-'));
await mkdir(join(tree, 'bench/lean-core'), { recursive: true });
await copyFile('bench/lean-core/bench.mjs', join(tree, 'bench/lean-core/bench.mjs'));
const capture = join(tree, 'capture');
await mkdir(capture);
await writeFile(join(capture, 'oracle.bin'), '');
await mkdir(join(tree, 'bin'));
const record = join(tree, 'swiftc.txt');
await writeFile(
  join(tree, 'bin/swiftc'),
  `#!/bin/sh
out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
if [ -d "$(dirname "$out")" ]; then echo built > "${record}"; else echo "no directory" > "${record}"; exit 1; fi
`,
);
await chmod(join(tree, 'bin/swiftc'), 0o755);
spawnSync(process.execPath, [join(tree, 'bench/lean-core/bench.mjs'), '--rounds', '1', capture], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${join(tree, 'bin')}:${process.env.PATH}` },
});
assert.equal(
  (await readFile(record, 'utf8')).trim(),
  'built',
  'bench.mjs makes the directory it builds into',
);
console.log(`ok bench build: the native program's directory is made first (${tree})`);
