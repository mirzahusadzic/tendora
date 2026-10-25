/** Every CLI example in the README, the CLI reference and the two tours runs as
 * written, from a checkout after `npm run demo`, and shows what the document
 * says it shows. A block whose commands start with `$ ` gives each one's
 * output after it, trimmed where it says `…`. Nothing is acquired. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve('.');
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/doc-examples-'));

/** The CLI commands of a document's fenced blocks: in a block with prompts
 * they start with `$ ` and are followed by their output; in the others they
 * are commands alone. */
function examples(markdown) {
  const found = [];
  for (const [, body] of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) {
    const lines = body.split('\n');
    const prompted = lines.some((line) => line.startsWith('$ '));
    for (let i = 0; i < lines.length; i++) {
      // A bare `tendora` is taken too: it fails as it would in a checkout.
      const start = prompted ? /^\$ (npx )?tendora / : /^(npx )?tendora /;
      if (!start.test(lines[i])) continue;
      let command = lines[i].replace(/^\$ /u, '');
      while (command.endsWith('\\'))
        command = `${command.slice(0, -1).trimEnd()} ${lines[++i].trim()}`;
      const shown = [];
      if (prompted)
        for (let j = i + 1; j < lines.length && !lines[j].startsWith('$ '); j++)
          if (lines[j].trim()) shown.push(lines[j]);
      found.push({ command: command.replace(/\s+#\s.*$/u, ''), shown });
    }
  }
  return found;
}

try {
  // A checkout that already holds an older copy of the demo (a clone of an
  // earlier release, pulled), set up with the README's own demo line as it is
  // written; then `npx tendora` as the checkout runs it, the network refused.
  const copy = join(directory, '.proj/payments-demo');
  execFileSync(process.execPath, ['tools/payments-demo.mjs', '--target', copy], { stdio: 'pipe' });
  const manifest = join(copy, 'project.json'),
    bundled = await readFile(join(repo, 'demo/payments-on-call/project.json'), 'utf8');
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(bundled), name: 'Older' }) + '\n');
  const setup = (await readFile(join(repo, 'README.md'), 'utf8')).match(
    /^npm run demo(?: -- ([^#\n]*?))?\s*(?:#.*)?$/mu,
  );
  assert(setup, 'The README sets the demo up with npm run demo');
  execFileSync(
    process.execPath,
    ['tools/payments-demo.mjs', ...(setup[1]?.split(/\s+/u) ?? []), '--target', copy],
    { stdio: 'pipe' },
  );
  assert.equal(
    await readFile(manifest, 'utf8'),
    bundled,
    "The README's setup renews an older copy of the demo",
  );
  const refuse = join(directory, 'no-network.mjs');
  await writeFile(refuse, 'globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };\n');
  await mkdir(join(directory, 'bin'));
  const shim = join(directory, 'bin', 'npx');
  await writeFile(
    shim,
    `#!/bin/sh\n[ "$1" = tendora ] || exit 127\nshift\nexec "${process.execPath}" --import "${refuse}" "${join(repo, 'src/cli/engine.mjs')}" "$@"\n`,
  );
  await chmod(shim, 0o755);

  let count = 0;
  for (const document of ['README.md', 'docs/cli.md', 'docs/demo.md', 'docs/methods-tour.md']) {
    const markdown = await readFile(join(repo, document), 'utf8');
    const found = examples(markdown);
    assert(found.length, `${document} has CLI examples`);
    // A command in running text cannot be run as written: it belongs in a block.
    const inline = markdown.replace(/```[\s\S]*?```/gu, '').match(/`(npx )?tendora [^`]*`/gu);
    assert.equal(inline, null, `${document} writes a command inline: ${inline}`);
    for (const { command, shown } of found) {
      const result = spawnSync('bash', ['-o', 'pipefail', '-c', command], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}` },
      });
      const where = `${document}: ${command}`;
      assert.equal(result.status, 0, `${where}\n${result.stderr}`);
      assert(!result.stderr.includes('NETWORK_FORBIDDEN'), `${where} acquires nothing`);
      const output = result.stdout.split('\n').map((line) => line.trimEnd());
      // Shown without "…", an output is shown whole: every line it prints, in
      // order, so a document cannot leave a line out unmarked.
      if (shown.length && !shown.some((line) => line.includes('…')))
        assert.deepEqual(
          output.filter(Boolean),
          shown.map((line) => line.trimEnd()),
          `${where}\nshows only part of its output without marking it with …`,
        );
      for (const line of shown) {
        // A trimmed line shows parts of one output line, in order.
        const parts = line
          .trimEnd()
          .split('…')
          .map((part) => part.trim())
          .filter(Boolean);
        assert(
          output.some((actual) => {
            let at = 0;
            for (const part of parts) {
              at = actual.indexOf(part, at);
              if (at < 0) return false;
              at += part.length;
            }
            return line.includes('…') || actual === line.trimEnd();
          }),
          `${where}\nshows a line it does not print: ${line}\n--- printed ---\n${result.stdout}`,
        );
      }
      count++;
    }
  }
  console.log(`ok ${count} documented CLI examples run as written and print what they show`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
