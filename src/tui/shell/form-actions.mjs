/** Available form actions, presented in the form's own pinned footer. */
export const canSaveForm = (form) =>
  Boolean(
    form &&
    !form.busy &&
    !form.move &&
    !form.confirm &&
    (form.workspace || form.continuation || (!form.inquiry && form.submitLabel !== 'open')),
  );

export function formActions(form, { quitPrompt = false, canDeleteSentence = false } = {}) {
  if (quitPrompt) return ['←→ choose', 'Enter confirm', 'y yes', 'n no', 'Esc back'];
  if (!form) return [];
  if (form.busy) return form.committing ? [] : ['Esc cancel'];
  if (form.readOnly) return ['↑↓ scroll', 'Esc back'];

  if (form.interpretationEditor)
    return [...(form.move ? [`Enter ${form.submitLabel}`] : []), 'Esc back'];
  if (form.selectors)
    return [
      `Enter ${form.selectorIndex === form.selectors.length - 1 ? 'preview' : 'select'}`,
      'Tab selector',
      'Esc back',
    ];

  if (form.sections && !form.submitLabel) return ['Esc back'];

  if (form.move) return ['↑↓ select', `Enter ${form.submitLabel ?? 'move branch'}`, 'Esc back'];
  if (form.confirm)
    return [
      ...(form.yesNo ? ['←→ choose', 'y yes', 'n no'] : []),
      form.yesNo ? 'Enter confirm' : `Enter ${form.submitLabel ?? 'delete'}`,
      'Esc back',
    ];
  const submit = form.submitLabel ?? (form.inquiry ? 'ask' : form.newProject ? 'create' : 'save');
  const enter = form.passageEditor
    ? form.index < form.sentenceStart
      ? 'Enter next field'
      : form.index < form.fields.length - 1 || form.fields.at(-1).value.trim()
        ? 'Enter next sentence'
        : null
    : form.index < form.fields.length - 1
      ? 'Enter next field'
      : `Enter ${submit}`;
  return [
    enter,
    ...(form.fields.length > 1 && !form.workspace
      ? ['Tab next field', 'Shift-Tab previous field']
      : []),
    'Esc back',
    ...(canSaveForm(form) ? [`Ctrl-S ${form.continuation ? 'save draft' : 'save'}`] : []),
    ...(canDeleteSentence ? ['Alt-D delete sentence'] : []),
    'Alt-U clear field',
  ].filter(Boolean);
}

/** Group actions by what they affect, independent of terminal width. */
export function formActionSection(label) {
  const normalized = label.toLowerCase(),
    key = normalized.split(' ')[0].replace(/[-_]/gu, '+');
  if (
    ['alt+d', 'alt+u', 'tab', 'shift+tab'].includes(key) ||
    ['enter next field', 'enter next sentence'].includes(normalized)
  )
    return 'field';
  return 'form';
}

/** Keep the footer height stable as editable fields and their available actions change. */
export function formActionReserve(form, options) {
  const actions = formActions(form, options);
  if (!form || form.busy || form.move || form.confirm || form.readOnly) return actions;

  const submit = form.submitLabel ?? (form.inquiry ? 'ask' : form.newProject ? 'create' : 'save');
  return [
    ...new Set([
      ...actions,
      'Enter next field',
      ...(form.passageEditor
        ? ['Enter next sentence', 'Alt-D delete sentence']
        : [`Enter ${submit}`]),
    ]),
  ];
}
