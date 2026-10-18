/** Every graph occurrence is an entity; acquired categories may specialize it. */
export const sourceSemanticTypes = (node) => [
  ...new Set(['entity', ...(node.semanticTypes ?? [])]),
];
