/** Licensing says one thing everywhere: LICENSE, NOTICE, package.json, the
 * lockfile, the README and the licensing page agree, and every installed
 * package whose metadata does not state its license clearly is named, with its
 * terms, on the licensing page. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await read('package.json')),
  lock = JSON.parse(await read('package-lock.json'));
const [license, notice, notices, readme] = await Promise.all(
  ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md'].map(read),
);

assert.match(license, /Apache License\s+Version 2\.0, January 2004/u);
assert.match(notice, /Licensed under the Apache License, Version 2\.0/u);
assert.equal(pkg.license, 'Apache-2.0 AND GPL-3.0-only AND CC-BY-SA-4.0 AND CC-BY-4.0');
assert.equal(lock.packages[''].license, pkg.license, 'The lockfile names the same license');
assert(notices.includes(`\`${pkg.license}\``), 'The licensing page gives the SPDX expression');
assert.match(readme, /badge\/code-Apache--2\.0/u);
assert.match(readme, /\[Apache License 2\.0\]\(LICENSE\)/u);

// Python components setup installs name their terms too (review of v0.2.0, #12).
assert.match(notices, /\| PENMAN[^|\n]*\| MIT, Copyright \(c\) 2016-2019 Michael Wayne Goodman/u);

// A precise SPDX expression of known identifiers, or the package is named.
const known =
  /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1\.0\.0|Python-2\.0|CC0-1\.0|Unlicense)$/u;
const precise = (expression) =>
  typeof expression === 'string' &&
  expression
    .replace(/[()]/gu, ' ')
    .split(/\s+(?:AND|OR)\s+|\s+/u)
    .filter(Boolean)
    .every((id) => known.test(id));
const unclear = Object.entries(lock.packages)
  .filter(([path, entry]) => path.startsWith('node_modules/') && !precise(entry.license))
  .map(([path, entry]) => ({ name: path.split('node_modules/').at(-1), license: entry.license }));
// A platform build (sqlite-vec-darwin-arm64) is named with its package.
const named = (name) =>
  name.split('-').some((_, i, parts) => notices.includes(`\`${parts.slice(0, i + 1).join('-')}\``));
for (const { name, license: stated } of unclear)
  assert(
    named(name),
    `${name} states ${stated ?? 'no license'}: the licensing page must name its terms`,
  );
console.log(
  `ok licensing: one license everywhere; ${unclear.length} packages with unclear metadata named`,
);
