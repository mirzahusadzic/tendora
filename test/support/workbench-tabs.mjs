import assert from 'node:assert/strict';

export async function selectWorkbenchTab({ state, term, app }, label) {
  const view = state.form ?? state.projectReadingView();
  const index = view.sections.findIndex((s) => s.label === label);
  assert(index >= 0, `Missing tab: ${label}`);
  const hit = state.viewport.sectionHits.find((h) => h.index === index);
  assert(hit, `Tab is visible: ${label}`);
  term.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: hit.x, y: hit.y });
  await app.idle();
  assert.equal(view.sections[view.sectionIndex].label, label);
}
