/** Real editor proof: source language, one interpretation, transfer and retraction. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject } from '../src/project/authoring/project.mjs';
import { retainAcquisitions } from '../src/project/storage/acquisitions.mjs';
import { listEngineRuns } from '../src/project/storage/engine-runs.mjs';
import { terminalCapture, captureGallery } from './support/terminal-capture.mjs';

const args = process.argv.slice(2),
  live = args.includes('--live');
if (live) args.splice(args.indexOf('--live'), 1);
if (args.length > 1)
  throw new Error('Usage: node tools/capture-semantic-reuse.mjs [output-directory] [--live]');
await mkdir('tmp', { recursive: true });
const output = args[0] ? resolve(args[0]) : await mkdtemp(resolve('tmp/semantic-reuse-capture-'));
await mkdir(output, { recursive: true });
const captures = JSON.parse(
  await readFile(new URL('../test/support/qa-development-acquisitions.json', import.meta.url)),
).entries;
const domains = [
  {
    name: 'workshop',
    statements: ['Sam repairs bicycles.'],
    question: 'Who repairs bikes?',
    heldout: 'Does Sam repair bikes?',
    independent: 'Does Sam repair bicycles?',
    answer: 'Sam',
  },
  {
    name: 'hand',
    statements: [
      'A simulation rehearses possibilities in the digital work.',
      'If a simulation rehearses possibilities in digital work, it supports exploration.',
      'If a simulation supports exploration, the simulation helps the programmer.',
    ],
    question: 'Who is helped by a simulation?',
    heldout: 'Does a simulation help the programmer?',
    independent: 'What rehearses possibilities in the digital work?',
    answer: 'programmer',
  },
];
const sessions = [],
  retractions = [];
for (const domain of domains) {
  const projectPath = join(output, domain.name);
  const project = await createProject(projectPath, domain.name, domain.name);
  if (!live) {
    const texts = [...domain.statements, domain.question, domain.heldout, domain.independent];
    await retainAcquisitions(
      project,
      texts.map((text) => {
        const entry = captures.find((e) => e.text === text);
        assert(entry, text);
        return {
          text,
          penman: entry.acquisition.penman,
          acquisition: entry.acquisition,
          origin: { kind: 'original-parser-capture' },
        };
      }),
    );
  }
  const retraction = { domain: domain.name };
  const run = async (name, flow) => {
    sessions.push(
      await terminalCapture(
        { project: projectPath, output, name: `${domain.name}-${name}`, live },
        async (capture) => {
          const { step, screen } = capture;
          const observedAnswer = () => {
            const match = screen().match(/│\s+Answer: ([^│┃┆]+?)\s*[│┃┆]\s*$/mu);
            assert(match, screen());
            return match[1];
          };
          const ask = async (text, answer) => {
            await step({ keys: ['a', 'ALT_U'], text, expect: ['Ask'] });
            await step({
              keys: ['ENTER'],
              waitFor: `Answer: ${answer}`,
              expect: [`Question: ${text}`],
              reject: ['Earlier assessment', 'Check pending', 'Saved result:'],
              timeout: 120,
            });
            return observedAnswer();
          };
          await flow({ step, ask, observedAnswer });
        },
      ),
    );
  };
  await run('author', async ({ step, ask }) => {
    await step({ keys: ['n'], text: domain.statements.join(' '), expect: ['Add statements'] });
    await step({
      keys: ['CTRL_S'],
      waitFor: 'Source statements',
      expect: [domain.statements[0]],
      timeout: 120,
    });
    retraction.beforeConfirmation = await ask(domain.heldout, 'Still open.');
    if (domain.name === 'workshop') {
      await step({
        keys: ['d', 'DOWN'],
        expect: ['Confirm source connection', domain.heldout, domain.statements[0]],
        reject: ['This relationship', 'Would answer'],
      });
      await step({ keys: ['ESC'], expect: ['Answer: Still open.'] });
    }
    await ask(domain.question, 'Still open.');
    await step({ keys: ['d'], expect: ['Clarify connection', 'Keep open'] });
    await step({ keys: ['ENTER'], expect: ['Answer: Still open.'] });
    await step({ keys: ['d', 'DOWN'], expect: ['Would answer', domain.answer] });
    await step({ keys: ['ENTER'], waitFor: `Answer: ${domain.answer}`, timeout: 120 });
    retraction.confirmed = await ask(domain.heldout, 'Yes');
    await step({ expect: ['Uses your confirmed connection', domain.statements[0]] });
  });
  const confirmed = await openProject(projectPath);
  const connection = confirmed.data.contributions.find((c) =>
    c.wordings.some((w) => w.kind === 'clarification'),
  );
  assert(connection);
  const proof = (await listEngineRuns(confirmed)).find(
    (run) => run.questions[0]?.text === domain.heldout && run.status === 'supported',
  );
  assert(proof.answer.answers[0].ruleIds.some((id) => id.includes(connection.id)));
  assert(proof.answer.answers[0].derivation.tree);
  await run('reopen', async ({ step, ask, observedAnswer }) => {
    await ask(domain.heldout, 'Yes');
    await step({ keys: ['u'], expect: ['Confirmed connections'] });
    await step({ keys: ['ENTER'], expect: ['Withdraw connection'] });
    await step({
      keys: ['y'],
      waitFor: 'Answer: Still open.',
      expect: [`Question: ${domain.heldout}`],
      timeout: 120,
    });
    retraction.withdrawn = observedAnswer();
    assert.equal(retraction.withdrawn, retraction.beforeConfirmation);
    await ask(domain.independent, domain.name === 'workshop' ? 'Yes' : 'simulation');
  });
  await run('withdrawn-reopen', async ({ ask }) => {
    retraction.reloaded = await ask(domain.heldout, 'Still open.');
    assert.equal(retraction.reloaded, retraction.beforeConfirmation);
    await ask(domain.independent, domain.name === 'workshop' ? 'Yes' : 'simulation');
  });
  retractions.push(retraction);
}
await captureGallery(output, sessions);
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      acquisition: live
        ? 'Fresh ordinary AMRBART acquisition only'
        : 'Unchanged parser acquisitions replayed offline',
      retractions,
      sessions: sessions.map(({ name, path, frames }) => ({
        name,
        path,
        frames: frames.length,
        errors: frames.filter((frame) => frame.error).length,
        exitCode: frames.at(-1).exitCode,
      })),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Verified captures: ${join(output, 'captures.html')}`);
