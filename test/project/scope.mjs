/** Bare labels prefer roots; nested ambiguity must not select an arbitrary branch. */
import assert from 'node:assert/strict';
import {
  resolveInquiryPlacement,
  projectInquiryCandidates,
} from '../../src/project/inquiries/scope.mjs';

const project = {
  data: {
    concepts: [
      { id: 'making', name: 'Touchable making', passages: ['Making remains touchable.'] },
      { id: 'testimony', name: 'Bounded testimony', passages: [] },
      { id: 'root-only', name: 'Root evidence', passages: ['Only the root has this child.'] },
      {
        id: 'nested-only',
        name: 'Nested evidence',
        passages: ['Only the nested branch has this.'],
      },
      { id: 'slash', name: 'Input/output ~ review', passages: [] },
    ],
    placements: [
      { id: 'root', conceptId: 'making', parentId: null },
      { id: 'testimony', conceptId: 'testimony', parentId: null },
      { id: 'nested', conceptId: 'making', parentId: 'testimony' },
      { id: 'root-child', conceptId: 'root-only', parentId: 'root' },
      { id: 'nested-child', conceptId: 'nested-only', parentId: 'nested' },
      { id: 'slash', conceptId: 'slash', parentId: 'root' },
    ],
  },
};
const select = (selector) => resolveInquiryPlacement(project, selector);
assert.equal(select(), 'root');
assert.equal(select('Bounded testimony'), 'testimony');
assert.equal(select('nested'), 'nested');
assert.equal(select('Touchable making'), 'root');
for (const [selector, expected] of [
  ['Touchable making', ['root', 'root-child']],
  ['/Touchable making', ['root', 'root-child']],
  ['/Bounded testimony/Touchable making', ['nested', 'nested-child']],
]) {
  assert.deepEqual(
    projectInquiryCandidates(project, select(selector)).map((entry) => entry.placementId),
    expected,
    'Readable paths select the intended evidence branch',
  );
}
assert.equal(select('Input/output ~ review'), 'slash');
assert.equal(select('Nested evidence'), 'nested-child');
assert.equal(select('/Touchable making/Input~1output ~0 review'), 'slash');
assert.throws(() => select('/Touchable making/Nested evidence'), /No placement matches/);
assert.throws(() => select('Missing label'), /Available root label paths/);
// Changing placement order must not change a label/path decision.
project.data.placements.reverse();
assert.equal(select('/Touchable making'), 'root');
assert.equal(select('Bounded testimony'), 'testimony');
assert.equal(select('Touchable making'), 'root');

// Without a matching root, duplicate nested names still need a full path.
project.data.placements.push({
  id: 'other-nested-child',
  conceptId: 'nested-only',
  parentId: 'root',
});
assert.throws(
  () => select('Nested evidence'),
  (error) => {
    assert.match(error.message, /Ambiguous placement/);
    assert(error.message.includes('"/Touchable making/Nested evidence"'));
    assert(error.message.includes('"/Bounded testimony/Touchable making/Nested evidence"'));
    return true;
  },
);
assert.equal(select('/Touchable making/Nested evidence'), 'other-nested-child');
assert.equal(select('/Bounded testimony/Touchable making/Nested evidence'), 'nested-child');

// Identical label paths still require an ID; the diagnostic provides both.
project.data.placements.push({ id: 'duplicate', conceptId: 'making', parentId: null });
for (const selector of ['Touchable making', '/Touchable making'])
  assert.throws(
    () => select(selector),
    (error) => {
      assert(error.message.includes('placement ID: "root"'));
      assert(error.message.includes('placement ID: "duplicate"'));
      return true;
    },
  );
assert.equal(select('root'), 'root');
assert.equal(select('duplicate'), 'duplicate');

// Display aliases remain selectable without rewriting authored labels.
const label = 'Engineering composition · candidate';
project.data.concepts.push({ id: 'candidate', name: label, passages: [] });
project.data.placements.push({ id: 'candidate', conceptId: 'candidate', parentId: null });
assert.equal(select('Engineering composition - candidate'), 'candidate');
assert.equal(select('/Engineering composition - candidate'), 'candidate');
assert.equal(select(label), 'candidate');
assert.equal(select('/' + label), 'candidate');
assert.equal(project.data.concepts.at(-1).name, label);
assert.throws(
  () => select('Unknown'),
  (error) => {
    assert(error.message.includes('/Engineering composition - candidate'));
    assert(!error.message.includes('·'));
    return true;
  },
);
project.data.concepts.push({
  id: 'hyphen',
  name: 'Engineering composition - candidate',
  passages: [],
});
project.data.placements.push({ id: 'hyphen', conceptId: 'hyphen', parentId: null });
assert.throws(() => select('/Engineering composition - candidate'), /Ambiguous placement/);
assert.equal(select('/' + label), 'candidate');
console.log('ok scope labels, readable paths, branch isolation, ambiguity and escaped names');
