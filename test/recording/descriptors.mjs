/** "What kind of device did a person design?" asks for a description. A
 * source that describes the device ("a spectral device") answers with it; a
 * source that names the device bare says nothing about its kind and leaves
 * the question open: "device" is no answer to "what kind". */
import assert from 'node:assert/strict';
import { evaluateAnswer } from '../../src/recording/answers.mjs';

const graph = (id, top, nodes, edges) => ({
  id,
  top,
  nodes: Object.entries(nodes).map(([id, concept]) => ({ id, concept })),
  edges: edges.map(([from, role, to], i) => ({ id: `e${i}`, from, role, to })),
});
const record = (query, source, text) => ({
  inquiry: { text: 'What kind of device did a person design?', graphId: query.id },
  project: { placementId: 'root' },
  graphs: [query, source],
  sources: [{ id: 's0', nodeId: 'root', text, graphId: source.id }],
});
const asked = graph('q', 'd', { d: 'design-01', p: 'person', v: 'device', u: 'amr-unknown' }, [
  ['d', ':ARG0', 'p'],
  ['d', ':ARG1', 'v'],
  ['v', ':mod', 'u'],
]);
const bare = graph('s', 'd', { d: 'design-01', p: 'person', v: 'device' }, [
  ['d', ':ARG0', 'p'],
  ['d', ':ARG1', 'v'],
]);
const said = evaluateAnswer(record(asked, bare, 'A person designed a device.'));
assert.equal(said.status, 'open', 'A bare device says nothing about its kind');
assert.deepEqual(said.answers, []);

const described = graph('s', 'd', { d: 'design-01', p: 'person', v: 'device', k: 'spectral' }, [
  ['d', ':ARG0', 'p'],
  ['d', ':ARG1', 'v'],
  ['v', ':mod', 'k'],
]);
const kind = evaluateAnswer(record(asked, described, 'A person designed a spectral device.'));
assert.equal(kind.status, 'supported');
assert.match(kind.answers[0].text, /spectral/u, 'A described device answers with its description');
// "Which person …?" has the same reading; a name describes the person.
const which = graph('q2', 'd', { d: 'design-01', p: 'person', v: 'device', u: 'amr-unknown' }, [
  ['d', ':ARG0', 'p'],
  ['d', ':ARG1', 'v'],
  ['p', ':mod', 'u'],
]);
const named = graph('s2', 'd', { d: 'design-01', p: 'person', n: 'name', v: 'device' }, [
  ['d', ':ARG0', 'p'],
  ['d', ':ARG1', 'v'],
  ['p', ':name', 'n'],
  ['n', ':op1', 'o'],
]);
named.nodes.push({ id: 'o', concept: '"Mira"', literal: '"Mira"' });
const person = evaluateAnswer({
  ...record(which, named, 'Mira designed a device.'),
  inquiry: { text: 'Which person designed a device?', graphId: 'q2' },
});
assert.deepEqual(
  person.answers.map((answer) => answer.text),
  ['Mira'],
);
assert.equal(
  evaluateAnswer({
    ...record(which, bare, 'A person designed a device.'),
    inquiry: { text: 'Which person designed a device?', graphId: 'q2' },
  }).status,
  'open',
  'An unnamed, undescribed person is not "which"',
);
console.log('ok descriptors: a kind or a "which" is answered by a description, never bare');
