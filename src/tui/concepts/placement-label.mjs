/** A placement is identified by its route, including repeated concept names. */
import { readableScopeLabel } from '../../project/inquiries/scope.mjs';
const indexes = new WeakMap();
export function placementLabel(data, id) {
  if (!indexes.has(data))
    indexes.set(data, {
      placements: new Map(data.placements.map((item) => [item.id, item])),
      concepts: new Map(data.concepts.map((item) => [item.id, item])),
    });
  const { placements, concepts } = indexes.get(data);
  const path = [],
    seen = new Set();
  for (
    let placement = placements.get(id);
    placement && !seen.has(placement.id);
    placement = placements.get(placement.parentId)
  ) {
    seen.add(placement.id);
    path.push(readableScopeLabel(concepts.get(placement.conceptId)?.name ?? placement.id));
  }
  return path.reverse().join(' → ') || id;
}
