/** Concept development follows retained graph structure, grammar occurrences and ownership. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProject, openProject, saveProject } from '../../src/project/authoring/project.mjs';
import { developContribution, withdrawContributionPart } from '../../src/engine/develop.mjs';
import { developedConcepts } from '../../src/engine/concepts.mjs';
import { conceptMaterial } from '../../src/amr/concept-material.mjs';
import {
  projectOutlineIndex,
  developmentOutline,
} from '../../src/tui/concepts/project-outline.mjs';
import { frozenParser } from '../support/development-acquisition.mjs';

await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/qa-concepts-test-'));
const before = globalThis.fetch;
globalThis.fetch = frozenParser();
let project = await createProject(join(directory, 'workshop'), 'Workshop', 'Question-driven work');
const scope = project.data.placements[0].id;
async function develop(question, answer = '', options = {}) {
  const next = await developContribution(project, {
    scopePlacementId: scope,
    question,
    answer,
    ...options,
  });
  project = await saveProject(project, next.data);
  return next.contribution;
}
try {
  const repair = await develop('Who repairs bicycles?', 'Sam.');
  let material = developedConcepts(project.data);
  const root = material.roots[0];
  assert(root.children.some((n) => n.name === 'Sam'));
  assert(root.children.some((n) => n.name === 'bicycles'));
  assert(
    root.children.every((n) => n.relationProof),
    'Every visible attachment has a grounded HRG terminal',
  );
  const index = projectOutlineIndex(project.data);
  assert(
    !index.all.some((n) => n.label === 'Question-driven work'),
    'Workflow shell is not a material concept',
  );
  assert(developmentOutline(index, root.children[0].id).some((i) => i.entry.id === repair.id));
  const location = await develop('Where does Sam repair bicycles?', '', { anchor: root.anchor });
  material = developedConcepts(project.data);
  assert(material.entries.get(root.id).children.some((n) => n.contributionId === location.id));
  assert([...material.entries.values()].some((n) => n.contributionId === location.id && n.open));
  await develop(location.question.text, 'The workshop.', { contributionId: location.id });
  material = developedConcepts(project.data);
  assert([...material.entries.values()].some((n) => n.name === 'The workshop' && !n.open));

  // Different response occurrences do not become equal because their labels match.
  const second = await develop('Who repairs bicycles?', 'Sam.');
  material = developedConcepts(project.data);
  const sams = [...material.entries.values()].filter((n) => n.name === 'Sam' && !n.referenceTo);
  assert(sams.length >= 2);
  assert.equal(new Set(sams.map((n) => n.conceptId)).size, sams.length);
  const reordered = developedConcepts({
    ...project.data,
    contributions: [...project.data.contributions].reverse(),
  });
  assert.deepEqual([...material.entries.keys()].sort(), [...reordered.entries.keys()].sort());
  project = await openProject(join(directory, 'workshop'));
  assert.deepEqual(
    [...developedConcepts(project.data).entries.keys()].sort(),
    [...material.entries.keys()].sort(),
  );

  // The UI source editor replaces evidence; it does not mutate a graph or keep old support active.
  const revised = await develop(repair.question.text, 'The mechanic repairs bicycles.', {
    contributionId: repair.id,
    replaceResponseId: repair.responses[0].id,
  });
  assert(revised.responses[0].withdrawn);
  assert.equal(revised.responses.at(-1).replaces, repair.responses[0].id);
  material = developedConcepts(project.data);
  assert(!material.entries.has(root.id));
  assert(material.roots.some((n) => n.contributionId === location.id && n.contextNote));
  assert(
    [...material.entries.values()].some((n) => n.contributionId === second.id && n.name === 'Sam'),
  );

  // A concrete question anchor survives filling the parent's answer interface.
  const interfaceQuestion = await develop(
    'Does the programmer recognize intention in the interface?',
  );
  const face = [...developedConcepts(project.data).entries.values()].find(
    (n) => n.contributionId === interfaceQuestion.id && n.name === 'interface',
  );
  const aporia = await develop(
    'How does the design of the interface participate in recognizing intention?',
    '',
    { anchor: face.anchor },
  );
  await develop(interfaceQuestion.question.text, 'Yes', { contributionId: interfaceQuestion.id });
  material = developedConcepts(project.data);
  const anchored = [...material.entries.values()].find(
    (n) => n.contributionId === aporia.id && n.contextLink,
  );
  assert(anchored?.anchorDerivation, 'HRG alignment relocates the exact anchor after answering');
  assert.equal(material.entries.get(anchored.parentId).name, 'interface');

  const conditional = await develop(
    'What helps the programmer?',
    'If a simulation supports exploration, the simulation helps the programmer.',
  );
  const part = conditional.responses[0];
  const projected = conceptMaterial(part.graph, {
    sourceId: `contribution:${conditional.id}:${part.id}`,
  });
  assert(projected.entries.some((n) => n.relation === 'if'));
  const ref = projected.entries.find((n) => n.referenceTo);
  assert(
    ref && projected.entries.some((n) => n.id === ref.referenceTo && n.conceptId === ref.conceptId),
  );
  const ablated = structuredClone(projected.grammar);
  ablated.rules = [];
  assert.equal(
    conceptMaterial(part.graph, { sourceId: projected.sourceId, grammar: ablated }).entries.length,
    0,
  );
  const changed = structuredClone(part.graph);
  const edge = changed.edges.find((e) => e.from === changed.top && e.role === ':ARG2');
  edge.role = ':ARG0';
  assert.notDeepEqual(
    conceptMaterial(changed, { sourceId: projected.sourceId }).entries,
    projected.entries,
  );
  project = await saveProject(
    project,
    withdrawContributionPart(project.data, conditional.id, part.id),
  );
  assert(
    ![...developedConcepts(project.data).entries.values()].some(
      (n) => n.sourceId === projected.sourceId,
    ),
  );
  assert.equal(
    developedConcepts(project.data).roots.find((n) => n.contributionId === conditional.id)
      .materialState,
    'Question',
  );
  console.log(
    'ok concepts develop from HRG material: readable roles, anchored openings, references, independent occurrences, source revision/withdrawal and reload',
  );
} finally {
  globalThis.fetch = before;
  await rm(directory, { recursive: true, force: true });
}
