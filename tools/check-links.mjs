/** Every relative link in this repository's Markdown, and every HTML href, src or srcset in it, reaches its file. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['node_modules', '.git', '.proj', '.venv', 'evidence', 'runs']);
const documents = [];
// Only real folders and regular files: a link, a pipe or a device is never read.
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) skip.has(entry.name) || walk(join(dir, entry.name));
    else if (entry.isFile() && entry.name.endsWith('.md')) documents.push(join(dir, entry.name));
};
walk(root);
const broken = [];
for (const document of documents)
  for (const [, , target] of readFileSync(document, 'utf8').matchAll(/(\]\(|(?:href|src|srcset)=")([^)\s"]+)/gu)) {
    if (/^(https?:|mailto:|#)/u.test(target)) continue;
    let path;
    try {
      path = join(dirname(document), decodeURIComponent(target.split('#')[0]));
    } catch {
      path = null; // a malformed escape is a broken link, not a crash
    }
    if (!path || !existsSync(path)) broken.push(`${relative(root, document)} → ${target}`);
  }
if (broken.length) {
  console.error(`Broken links:\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok links: ${documents.length} documents`);
