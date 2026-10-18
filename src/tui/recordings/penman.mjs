/** Locate recorded edges in the original PENMAN without rewriting its graph. */
export function penmanEdgeLocations(penman, graph) {
  if (!graph) return [];
  const tokens = [...penman.matchAll(/"(?:[^"\\]|\\.)*"|#[^\n]*|[()/]|[^\s()/]+/gu)].filter(
    (token) => !token[0].startsWith('#'),
  );
  const locations = [],
    used = new Set();
  let at = 0;
  const node = () => {
    if (tokens[at++]?.[0] !== '(') throw new Error('Expected node');
    const variable = tokens[at++]?.[0];
    if (tokens[at++]?.[0] !== '/') throw new Error('Expected concept');
    at++;
    while (at < tokens.length && tokens[at][0] !== ')') {
      const role = tokens[at++];
      if (!role[0].startsWith(':')) throw new Error('Expected role');
      const nested = tokens[at]?.[0] === '(';
      const value = nested ? tokens[at + 1]?.[0] : tokens[at]?.[0];
      const literal = (id) =>
        id.startsWith('literal:') &&
        graph.nodes.find((item) => item.id === id)?.concept === value?.replace(/^"|"$/gu, '');
      const matches = graph.edges.filter(
        (edge) =>
          !used.has(edge.id) &&
          ((edge.from === variable &&
            edge.role === role[0] &&
            (edge.to === value || literal(edge.to))) ||
            (role[0].endsWith('-of') &&
              edge.to === variable &&
              edge.from === value &&
              edge.role === role[0].slice(0, -3))),
      );
      if (matches.length === 1) {
        used.add(matches[0].id);
        locations.push({
          edgeId: matches[0].id,
          start: role.index,
          end: role.index + role[0].length,
        });
      }
      if (nested) node();
      else at++;
    }
    if (tokens[at++]?.[0] !== ')') throw new Error('Expected closing parenthesis');
  };
  try {
    node();
  } catch {
    return [];
  }
  return locations;
}
