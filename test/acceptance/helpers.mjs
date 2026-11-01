/**
 * The repository's own checks fail cleanly, and only when they should: the link
 * check in a path with a space, on a malformed escape, past a pipe named *.md
 * and in vendored guides; the evidence check on a missing, unparseable or
 * mismatched file; the recompute on a report Gadfly reads differently. Each case
 * runs a copy of the shipped script in a fixture tree under the system's
 * temporary folder, and removes exactly the files it made.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const made = [];
const base = mkdtempSync(join(tmpdir(), 'tendora-helpers-'));
// Every folder lies under the fresh base, so each one made here is recorded and removed.
const folder = (path) => {
  let at = base;
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    at = join(at, part);
    if (!existsSync(at)) {
      mkdirSync(at);
      made.push({ dir: at });
    }
  }
  return path;
};
const file = (path, text) => {
  folder(dirname(path));
  writeFileSync(path, text);
  made.push({ file: path });
};
const remove = (path) => {
  unlinkSync(path);
  made.splice(made.findIndex((entry) => entry.file === path), 1);
};
const copy = (from, to) => file(to, readFileSync(join(repo, from)));
const run = (script, env = {}) =>
  spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
try {
  // The link check, from a folder whose name has a space.
  const links = join(base, 'with space');
  copy('tools/check-links.mjs', join(links, 'tools/check-links.mjs'));
  file(join(links, 'README.md'), '[guide](docs/guide.md)\n');
  file(join(links, 'docs/guide.md'), 'ok\n');
  let result = run(join(links, 'tools/check-links.mjs'));
  assert.equal(result.status, 0, `a path with a space: ${result.stderr}`);

  file(join(links, 'docs/bad.md'), '[x](missing%2G.md)\n');
  result = run(join(links, 'tools/check-links.mjs'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Broken links:[\s\S]*missing%2G\.md/u, 'a malformed escape is a broken link, not a crash');
  remove(join(links, 'docs/bad.md'));

  file(join(links, 'vendor/data/README.md'), '[source](../../src/missing.mjs)\n');
  result = run(join(links, 'tools/check-links.mjs'));
  assert.equal(result.status, 1, 'a vendored guide is checked too');
  assert.match(result.stderr, /vendor\/data\/README\.md → \.\.\/\.\.\/src\/missing\.mjs/u);
  remove(join(links, 'vendor/data/README.md'));

  const pipe = join(links, 'docs/pipe.md');
  if (spawnSync('mkfifo', [pipe]).status === 0) {
    made.push({ file: pipe });
    result = run(join(links, 'tools/check-links.mjs'));
    assert.equal(result.signal, null, 'a pipe named *.md is not read');
    assert.equal(result.status, 0);
  }

  // The evidence check and the recompute, on a one-frame copy of the kept evidence.
  const evidence = join(base, 'evidence-case');
  copy('test/acceptance/evidence.mjs', join(evidence, 'test/acceptance/evidence.mjs'));
  copy('test/acceptance/recompute.mjs', join(evidence, 'test/acceptance/recompute.mjs'));
  // One kept frame, found by its question rather than its check's id.
  const name = readdirSync(join(repo, 'evidence/payments-demo/frames'))
    .find((file) => file.startsWith('tendora-are-access-logs-reviewed-'))
    .replace(/\.json$/u, '');
  const kept = (part, ending) => join('evidence/payments-demo', part, `${name}${ending}`);
  for (const [part, ending] of [['frames', '.json'], ['runs', '.jsonl'], ['reports', '.json']])
    copy(kept(part, ending), join(evidence, kept(part, ending)));
  folder(join(evidence, 'evidence/payments-demo/gemma-temperature-0/frames'));
  result = run(join(evidence, 'test/acceptance/evidence.mjs'));
  assert.equal(result.status, 1, 'a set with fewer frames than expected fails');
  assert.match(result.stderr, /1 frames, 62 expected/u);

  writeFileSync(join(evidence, kept('reports', '.json')), '{"frame":');
  result = run(join(evidence, 'test/acceptance/evidence.mjs'));
  assert.match(result.stderr, new RegExp(`reports/${name}\\.json: does not parse`, 'u'));

  const report = JSON.parse(readFileSync(join(repo, kept('reports', '.json')), 'utf8'));
  writeFileSync(join(evidence, kept('reports', '.json')), JSON.stringify({ ...report, hash: '0'.repeat(64) }));
  result = run(join(evidence, 'test/acceptance/evidence.mjs'));
  assert.match(result.stderr, /made under another frame/u, 'a record and its report must name the same frame');

  // A report Gadfly reads differently fails the recompute (a stand-in gadfly prints the true report).
  writeFileSync(
    join(evidence, kept('reports', '.json')),
    JSON.stringify({ ...report, overall: { ...report.overall, category: 'stale' } }),
  );
  const { reader, ...truth } = report;
  file(join(evidence, 'fake-gadfly.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(truth))});\n`);
  result = spawnSync(process.execPath, [join(evidence, 'test/acceptance/recompute.mjs')], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, GADFLY: `${process.execPath} ${join(evidence, 'fake-gadfly.mjs')}` },
  });
  assert.equal(result.status, 1, 'a stale report fails the recompute');
  assert.match(result.stderr, /reads 1 of 1 reports differently/u);
  console.log('ok helpers: the link, evidence and recompute checks fail cleanly, and only when they should');
} finally {
  for (const entry of made.reverse()) {
    if (entry.file) unlinkSync(entry.file);
    else rmdirSync(entry.dir);
  }
  rmdirSync(base);
}
