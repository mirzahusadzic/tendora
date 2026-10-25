/** Every relative link in the maintained documentation reaches its file and,
 * when it names one, its heading; a link reads as what it names, not as a
 * file name. Vendored and fixture documents are left as they came. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The documentation this checks: the top-level documents and docs/.
const scope = (path) => /^[^/]+\.md$/u.test(path) || path.startsWith('docs/');
const documents = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter((path) => path && (scope(path) || path === 'bench/lean-core/README.md'));
assert(documents.includes('README.md'));
// GitHub's anchor for a heading.
const anchor = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replaceAll(' ', '-');
const fileName = /^`?[\w./-]+\.(md|mjs|js|json|txt|swift|py)`?$/u;
let links = 0;
for (const document of documents) {
  const text = readFileSync(document, 'utf8').replace(/```[\s\S]*?```/gu, '');
  for (const [, label, target] of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu)) {
    if (/^(https?|mailto):/u.test(target)) continue;
    links++;
    const [path, heading] = target.split('#');
    const file = path ? resolve(dirname(document), path) : resolve(document);
    assert(existsSync(file), `${document}: ${target} does not exist`);
    if (heading && file.endsWith('.md'))
      assert(
        [...readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gmu)]
          .map(([, title]) => anchor(title))
          .includes(heading),
        `${document}: ${target} names no heading`,
      );
    assert(!fileName.test(label), `${document}: the link “${label}” reads as a file name`);
  }
}
console.log(`ok documentation links: ${links} links in ${documents.length} documents resolve`);
