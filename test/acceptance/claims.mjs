/**
 * What the documents claim agrees with the kept evidence and the package: the
 * README's totals and how many questions only Tendora carries, the open checks behind every "carried",
 * one row per question asked, the battery loop as it runs on a fresh clone, the
 * reports' provenance, the citation's license, and every dependency's license.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const text = (path) => readFileSync(join(repo, path), 'utf8');
const reports = (dir, reader) =>
  readdirSync(join(repo, dir))
    .filter((name) => name.startsWith(`${reader}-`) && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(repo, dir, name), 'utf8')));
const main = 'evidence/payments-demo/reports';
const reads = {
  tendora: reports(main, 'tendora'),
  gemma: reports(main, 'gemma'),
  gemma0: reports('evidence/payments-demo/gemma-temperature-0/reports', 'gemma'),
};
const verdict = (report) => report.overall.category.replace(/^coupled but /u, '');
const count = (list, name) => list.filter((report) => verdict(report) === name).length;
const readme = text('README.md');
const [evidenceAt, editorAt] = ['## Evidence', '## The editor'].map((title) => readme.indexOf(title));
assert(evidenceAt >= 0 && editorAt > evidenceAt, 'the README has its Evidence, then its editor section');
const evidenceSection = readme.slice(evidenceAt, editorAt);

// The totals table and how many questions only Tendora carries.
for (const [row, list] of [
  ['Tendora (deterministic engine)', reads.tendora],
  ['Gemma 4, temperature 0.7', reads.gemma],
  ['Gemma 4, temperature 0', reads.gemma0],
]) {
  const cells = evidenceSection
    .split('\n')
    .find((line) => line.startsWith(`| ${row} `))
    ?.split('|')
    .slice(2, 6)
    .map((cell) => cell.replace(/\*/gu, '').trim());
  assert.deepEqual(
    cells,
    [
      `${count(list, 'carried')} / ${list.length}`,
      String(count(list, 'unresolved')),
      String(count(list, 'misaligned')),
      String(count(list, 'cooled')),
    ],
    `README totals for ${row}`,
  );
}
const carriedBy = (list) => new Set(list.filter((r) => verdict(r) === 'carried').map((r) => r.frame.replace(/^[a-z]+-/u, '')));
const gemmaCarried = new Set([...carriedBy(reads.gemma), ...carriedBy(reads.gemma0)]);
const onlyTendora = [...carriedBy(reads.tendora)].filter((frame) => !gemmaCarried.has(frame)).length;
const words = 'Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen Twenty'.split(' ');
assert.match(evidenceSection, new RegExp(`(${words[onlyTendora] ?? onlyTendora}|${onlyTendora}) questions are carried by Tendora and by neither Gemma read`, 'u'));

// Every "carried" here still has its bypass and presentation checks open: the documents say so.
const open = reads.tendora.filter((r) => verdict(r) === 'carried' && (r.overall.obligations ?? []).length);
if (open.length) {
  for (const [name, doc] of [['README.md', evidenceSection], ['docs/evidence.md', text('docs/evidence.md')]]) {
    assert.match(doc, /bypass/iu, `${name} names the bypass check left open`);
    assert.match(doc, /presentation/iu, `${name} names the presentation check left open`);
    assert.doesNotMatch(doc, /and nothing else does/u, `${name} does not overstate "carried"`);
  }
}

// One row per question asked: two asks of the same wording say what differs.
const rows = text('docs/evidence.md')
  .split('\n')
  .filter((line) => /^\| [A-Z]/u.test(line) && /carried|unresolved|misaligned|cooled/u.test(line))
  .map((line) => line.split('|')[1].trim());
assert.equal(new Set(rows).size, rows.length, 'every question row in docs/evidence.md is distinct');
assert.equal(rows.length, reads.tendora.length, 'docs/evidence.md has a row for every frame');

// The battery loop runs on a fresh clone, and the no-network claim is not made for it.
const loop = readme.slice(readme.indexOf('## Run Gadfly'), readme.indexOf('## Evidence'));
assert.match(loop, /mkdir -p runs[\s\S]*for f in evidence/u, 'the loop makes runs/ first');
assert.doesNotMatch(
  (readme.split('\n').find((line) => /no Python and no network/u.test(line)) ?? '').split('no Python and no network')[0],
  /battery/u,
  "the battery fetches Gadfly, so it is not among what needs no network",
);

// The reports' provenance: written by Gadfly's Tendora integration, which adds the reader's name.
if ([...reads.tendora, ...reads.gemma, ...reads.gemma0].some((report) => 'reader' in report)) {
  assert.match(text('SECURITY.md'), /`reader`/u, 'SECURITY.md says the reports carry the reader added by the integration');
  assert.doesNotMatch(text('SECURITY.md'), /and report is as Gadfly wrote it/u, 'SECURITY.md does not claim the reports are untouched Gadfly output');
}

// The citation names no single license for a repository with several.
const parts = ['Tendora Demo Engine License', 'Attribution 4.0', 'Attribution-ShareAlike 4.0', 'Apache License'].filter((name) => text('LICENSE').includes(name)).length;
if (parts > 1) assert.doesNotMatch(text('CITATION.cff'), /^license:/mu, 'CITATION.cff names no single license');

// Every installed package without a declared license is named with the license it carries.
const notices = text('THIRD_PARTY_NOTICES.md');
for (const [path, entry] of Object.entries(JSON.parse(text('package-lock.json')).packages ?? {}))
  if (path && !entry.license) {
    const name = path.replace(/^.*node_modules\//u, '');
    const line = notices.split('\n').find((row) => row.includes(name)) ?? '';
    assert.match(line, new RegExp(`${name}[^|]*(MIT|BSD|Apache|ISC)`, 'u'), `the notices give ${name}'s license`);
  }
assert.match(notices, /PropBank/u);
assert.match(notices, /dist\/[\s\S]*PropBank|PropBank[\s\S]*frame identifiers/u, "the notices say the engine's packs reference PropBank");
console.log('ok claims: the documents agree with the evidence and the package');
