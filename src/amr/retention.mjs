/** A narrow ingress guard: did AMR retain any literal content anchor?
 * Zero overlap is ambiguous (ran/run, ate/eat, making/make), except for a
 * question-marker-only collapse with no content node. Overlap never proves fidelity.
 */
const grammar = new Set(
  `a an and are as at be been being but by can could did do does
  for from had has have how i in is it may might must of on or shall should
  that the their them there these they this those to was were what when where
  whether which who why will with would you your`.split(/\s+/u),
);

const words = (value) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function variants(word) {
  const forms = [word];
  if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) forms.push(word.slice(0, -2));
  if (word.endsWith('s')) forms.push(word.slice(0, -1));
  if (word.endsWith('ing')) forms.push(word.slice(0, -3));
  if (word.endsWith('ed')) forms.push(word.slice(0, -2));
  return forms;
}

export function queryRetention(text, graph) {
  const anchors = [...new Set(words(text).filter((word) => word.length > 2 && !grammar.has(word)))];
  const graphConcepts = [...new Set(graph.labels.values())];
  const represented = new Set(
    graphConcepts.flatMap((label) => words(label.replace(/-\d\d$/u, '').replaceAll('-', ' '))),
  );
  const retained = anchors.filter((word) => variants(word).some((form) => represented.has(form)));
  const markerOnly =
    graphConcepts.length > 0 &&
    graphConcepts.every((label) => ['have-polarity-91', 'amr-unknown', '-'].includes(label));
  return {
    anchors,
    retained,
    graphConcepts,
    status:
      anchors.length && !retained.length
        ? markerOnly
          ? 'no-content-anchor'
          : 'uncertain'
        : 'not-ruled-out',
  };
}
