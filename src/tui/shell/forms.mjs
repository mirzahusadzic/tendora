/** Editable forms, step navigation and proposal review. */
import { join } from 'node:path';
import { canSaveForm } from './form-actions.mjs';
import { editorCursor, pageStep } from './layout.mjs';
import { confirmationKey } from './confirmation.mjs';

export function createForms({
  state,
  text,
  projectsHome,
  setNotice,
  saveError,
  scrollKey,
  reloadProject,
}) {
  const { clean, editorMeasure } = text;
  function startForm(title, fields, submit, { submitLabel = null } = {}) {
    const back = { form: state.form, focus: state.focus, offset: state.offset };
    state.form = {
      title,
      fields: fields.map(([label, value = '', multiline = false, required = true]) => ({
        label,
        value,
        multiline,
        required,
        cursor: Array.from(value).length,
      })),
      index: 0,
      submit,
      submitLabel,
      back,
      previousFocus: state.focus,
      previousOffset: state.offset,
      error: '',
    };
    state.focus = 'reading';
    state.offset = 0;
    setNotice('');
    state.failure = '';
  }
  // Related selectors share one form. Changing a selector never adds a back step.
  function selectPair(title, selectors, submit, { returnForm = state.form } = {}) {
    startForm(
      title,
      [],
      () => {
        const form = state.form,
          selected = form.move[form.index];
        form.selectors[form.selectorIndex].selected = selected;
        if (form.selectorIndex < form.selectors.length - 1) switchSelector(form.selectorIndex + 1);
        else {
          const missing = form.selectors.findIndex((item) => !item.selected);
          if (missing >= 0) switchSelector(missing);
          else submit(form.selectors.map((item) => item.selected));
        }
      },
      { submitLabel: 'preview' },
    );
    const form = state.form;
    form.selectors = selectors;
    form.selectorIndex = 0;
    form.returnForm = returnForm;
    function switchSelector(index) {
      if (form.move) form.selectors[form.selectorIndex].index = form.index;
      form.selectorIndex = index;
      const selector = selectors[index];
      form.move = selector.choices;
      form.index = selector.index ?? Math.max(0, selector.choices.indexOf(selector.selected));
      form.detailsOpen = false;
      state.offset = 0;
    }
    form.onKey = (key) => {
      if (!['TAB', 'SHIFT_TAB'].includes(key)) return false;
      switchSelector(
        (form.selectorIndex + (key === 'TAB' ? 1 : selectors.length - 1)) % selectors.length,
      );
      return true;
    };
    form.selectSelector = switchSelector;
    switchSelector(0);
    return form;
  }
  function inspectContext() {
    const parent = state.form;
    startForm(
      parent.contextGroups.length === 1 ? parent.contextGroups[0][0] : 'Context',
      [],
      () => {},
      { submitLabel: null },
    );
    state.form.confirm = true;
    state.form.returnForm = parent;
    state.form.sections = parent.contextGroups.map(([label, lines, tone = 'plain']) => ({
      label,
      table: {
        headers: [`Sentences - ${lines.length}`],
        widths: [null],
        minWidth: 0,
        repeatColumns: 0,
        entries: lines.map((line) => ({ cells: [line], tone })),
      },
    }));
  }
  function inspectChoice() {
    const parent = state.form,
      choice = parent.move[parent.index];
    startForm(
      choice.detailsTitle ?? `${parent.title} - details`,
      [],
      async () => {
        const back = { form: state.form, focus: state.focus, offset: state.offset };
        state.form = parent;
        await submitForm();
        if (state.form && state.form !== parent) state.form.back = back;
      },
      { submitLabel: choice.detailsAction ?? parent.submitLabel ?? 'select' },
    );
    state.form.confirm = true;
    state.form.returnForm = parent;
    state.form.contextRows = [[choice.detailsLabel ?? 'Selection', choice.label, 'input']];
    if (choice.detailTree) state.form.changeTree = choice.detailTree;
    else
      state.form.sections = [
        {
          label: 'Details',
          table: {
            headers: ['Field', 'Value'],
            widths: [18, null],
            minWidth: 48,
            repeatColumns: 0,
            entries: choice.details.flatMap(([label, lines]) =>
              lines.map((value) => ({ cells: [label, value], cellTones: { 0: 'muted' } })),
            ),
          },
        },
      ];
  }
  function actions() {
    const form = state.form;
    if (!form || form.busy || state.help || state.quitPrompt) return [];
    const command = (key, description, run) => ({ pane: 'reading', key, description, run });
    return [
      ...(form.projectChanged && form.onProjectReload
        ? [
            command('ALT_R', 'reload project', async () => {
              await reloadProject();
              form.projectChanged = false;
              form.error = '';
              form.recovery = null;
              await form.onProjectReload();
            }),
          ]
        : []),
      ...(form.graphActions?.() ?? []),
      ...(form.contextGroups?.some(([, lines]) => lines.length)
        ? [
            command(
              'ALT_C',
              form.contextGroups.length === 1
                ? `review ${form.contextGroups[0][0].split(' - ')[0].toLowerCase()}`
                : 'review context',
              inspectContext,
            ),
          ]
        : []),
      ...(form.move?.[form.index]?.details?.length &&
      !form.interpretationConnections &&
      !form.investigationBrowser &&
      !form.graphEditor
        ? [command('i', 'details', inspectChoice)]
        : []),
      ...(form.move?.[form.index]?.tree?.length
        ? [
            command(
              form.move[form.index].collapsed ? 'RIGHT' : 'LEFT',
              form.move[form.index].collapsed ? 'expand' : 'collapse',
              () => {
                form.move[form.index].collapsed = !form.move[form.index].collapsed;
                form.browseContext = false;
              },
            ),
          ]
        : []),
      ...(sectionCount(form) > 1
        ? [
            command('TAB', 'next tab', () => section(1)),
            command('SHIFT_TAB', 'previous tab', () => section(-1)),
          ]
        : []),
    ];
  }
  const sectionCount = (form) => form.sections?.length ?? 0;
  function section(delta) {
    state.form.sectionIndex =
      ((state.form.sectionIndex ?? 0) + delta + sectionCount(state.form)) %
      sectionCount(state.form);
    state.offset = 0;
  }
  function cancelForm() {
    if (state.form.busy) cancelServices(state.form);
    state.form.controller?.abort();
    if (state.form.returnForm) {
      const previous = state.form.returnForm,
        offset = state.form.previousOffset,
        focus = state.form.previousFocus;
      state.form = previous;
      state.offset = offset;
      state.focus = focus;
      return;
    }
    const onCancel = state.form.onCancel;
    state.focus = state.form.previousFocus;
    state.offset = state.form.previousOffset;
    state.form = null;
    onCancel?.();
  }
  function cancelServices(form) {
    if (form.engineInquiry) {
      for (const client of ['egemma', 'penman', 'semcat', 'language'])
        if (['working', 'running'].includes(state.serviceStatus[client]))
          state.serviceStatus[client] = 'cancelled';
    } else state.serviceStatus.egemma = 'cancelled';
  }
  function backForm() {
    const active = state.form;
    if (active.busy) {
      if (active.committing) return;
      active.controller?.abort();
      active.busy = false;
      active.error = '';
      active.progress = '';
      cancelServices(active);
      if (active.engineInquiry || active.materialEditor || active.developingContribution) {
        active.error = active.roleStatements
          ? 'Save cancelled. Your edits are still here.'
          : 'Stopped before the operation finished.';
        active.recovery = {
          saved: Boolean(active.corpusSaved),
          state: active.engineInquiry
            ? 'Question draft retained; no answer established'
            : undefined,
          steps: active.corpusSaved
            ? 'The material was saved. Return to the corpus and ask again to finish checking it.'
            : 'Your text is still here. Edit it or submit again to retry; returning leaves the operation stopped.',
        };
      }
      return;
    }

    if (active.back) {
      active.controller?.abort();
      state.form = active.back.form;
      state.focus = active.back.focus;
      state.offset = active.back.offset;
      if (state.form) state.form.onResume?.();
      else active.onCancel?.();
    } else cancelForm();
  }
  const canDeleteSentence = () =>
    state.form?.passageEditor &&
    state.form.index >= state.form.sentenceStart &&
    (state.form.index < state.form.fields.length - 1 ||
      Boolean(state.form.fields[state.form.index].value.trim()));
  async function submitForm() {
    if (state.form.readOnly) return;
    const missing = state.form.fields.find((f) => f.required && !f.value.trim());
    if (missing) {
      state.form.error = `${missing.label} is required.`;
      state.form.index = state.form.fields.indexOf(missing);
      state.form.recovery = {
        saved: false,
        steps: `Enter ${missing.label.toLowerCase()} in the selected field, then submit. Returning cancels the unsaved entry.`,
      };
      return;
    }
    const active = state.form;
    try {
      await active.submit(active.fields.map((f) => f.value));
    } catch (error) {
      active.error = saveError(error);
    }
  }
  async function formKey(key, data) {
    if (data?.isPaste) {
      const field = state.form.fields[state.form.index];
      const value = clean(key.replace(/\r\n?/gu, '\n'));
      const inserted = Array.from(field.multiline ? value : value.replace(/\n/gu, ' '));
      const chars = Array.from(field.value);
      chars.splice(field.cursor, 0, ...inserted);
      field.cursor += inserted.length;
      field.value = chars.join('');
      state.form.browseContext = false;
      return;
    }
    if (key === 'ESCAPE') {
      backForm();
      return;
    }
    if (state.form.busy) return;
    if (state.form.readOnly) {
      scrollKey(key);
      return;
    }
    if (state.form.multiSelect && [' ', 'SPACE'].includes(key)) {
      state.form.toggleChoice();
      return;
    }
    if (['PAGE_UP', 'PAGE_DOWN'].includes(key)) {
      if (state.form.move && !state.form.tree && !state.form.continuation && !state.form.sections) {
        const page = state.form.investigationBrowser
          ? pageStep(state.viewport?.nodeHits)
          : pageStep(state.viewport?.choiceHits, 'index');
        state.form.index = Math.max(
          0,
          Math.min(
            state.form.move.length - 1,
            state.form.index + (key === 'PAGE_UP' ? -page : page),
          ),
        );
        state.form.browseContext = false;
      } else {
        state.form.browseContext = true;
        scrollKey(key);
      }
      return;
    }
    state.form.browseContext = false;
    if (await state.form.onKey?.(key)) return;
    if (sectionCount(state.form) > 1 && ['LEFT', 'RIGHT'].includes(key)) {
      section(key === 'LEFT' ? -1 : 1);
      return;
    }

    if (state.form.move) {
      if (['ENTER', 'KP_ENTER'].includes(key)) await submitForm();
      else if (key === 'HOME') state.form.index = 0;
      else if (key === 'END') state.form.index = state.form.move.length - 1;
      else if (['UP', 'k', 'SHIFT_TAB', 'DOWN', 'j', 'TAB'].includes(key)) {
        const delta = ['UP', 'k', 'SHIFT_TAB'].includes(key) ? -1 : 1;
        state.form.index = Math.max(
          0,
          Math.min(state.form.move.length - 1, state.form.index + delta),
        );
      }
      return;
    }
    if (state.form.confirm) {
      if (state.form.yesNo) {
        const decision = confirmationKey(state.form.yesNo, key);
        if (decision === 'yes') await submitForm();
        else if (decision === 'no') backForm();
      } else if (key === 'ENTER' || key === 'KP_ENTER') await submitForm();
      else scrollKey(key);
      return;
    }
    if (key === 'ALT_D') {
      if (!canDeleteSentence()) return;
      state.form.fields.splice(state.form.index, 1);
      if (
        state.form.fields.length === state.form.sentenceStart ||
        state.form.fields.at(-1).value.trim()
      )
        state.form.fields.push({
          label: '',
          value: '',
          cursor: 0,
          multiline: true,
          required: false,
        });
      for (let i = state.form.sentenceStart; i < state.form.fields.length; i++)
        state.form.fields[i].label =
          `Sentence ${i - state.form.sentenceStart + 1}${i === state.form.fields.length - 1 ? ' (add sentence)' : ''}`;
      state.form.index = Math.min(state.form.index, state.form.fields.length - 1);
      state.form.error = '';
      return;
    }
    if (!['ENTER', 'KP_ENTER'].includes(key)) state.form.error = '';
    if (
      state.form.newProject &&
      state.form.index === 0 &&
      ['ENTER', 'KP_ENTER', 'TAB', 'CTRL_S'].includes(key)
    ) {
      const directory = state.form.fields[1];
      if (!directory.value) {
        const slug = state.form.fields[0].value
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_-]+/gu, '-')
          .replace(/^-+|-+$/gu, '');
        if (slug) {
          directory.value = join(projectsHome, slug);
          directory.cursor = Array.from(directory.value).length;
        }
      }
    }
    const field = state.form.fields[state.form.index],
      chars = Array.from(field.value);
    if (!['UP', 'DOWN'].includes(key)) delete field.column;
    if (key === 'CTRL_S') {
      if (canSaveForm(state.form)) await submitForm();
      return;
    }
    if (['ENTER', 'KP_ENTER', 'TAB', 'SHIFT_TAB'].includes(key)) {
      const enter = key === 'ENTER' || key === 'KP_ENTER';
      if (
        state.form.passageEditor &&
        key !== 'SHIFT_TAB' &&
        state.form.index === state.form.fields.length - 1
      ) {
        if (field.value.trim()) {
          field.label = `Sentence ${state.form.index - state.form.sentenceStart + 1}`;
          state.form.fields.push({
            label: `Sentence ${state.form.fields.length - state.form.sentenceStart + 1} (add sentence)`,
            value: '',
            cursor: 0,
            multiline: true,
            required: false,
          });
        } else if (enter) return;
      }
      if (enter && !state.form.passageEditor && state.form.index === state.form.fields.length - 1)
        await submitForm();
      else
        state.form.index =
          (state.form.index + (key === 'SHIFT_TAB' ? state.form.fields.length - 1 : 1)) %
          state.form.fields.length;
    } else if (key === 'LEFT') field.cursor = Math.max(0, field.cursor - 1);
    else if (key === 'RIGHT') field.cursor = Math.min(chars.length, field.cursor + 1);
    else if (key === 'CTRL_A') field.cursor = 0;
    else if (key === 'CTRL_E') field.cursor = chars.length;
    else if (['HOME', 'END', 'UP', 'DOWN'].includes(key)) {
      field.cursor = editorCursor(
        field,
        key,
        Math.max(1, (state.viewport?.readingWidth ?? 40) - 3),
        editorMeasure,
      );
    } else if (key === 'ALT_U') {
      field.value = '';
      field.cursor = 0;
    } else if (key === 'BACKSPACE' && field.cursor) {
      chars.splice(--field.cursor, 1);
      field.value = chars.join('');
    } else if (key === 'DELETE') {
      chars.splice(field.cursor, 1);
      field.value = chars.join('');
    } else if (data?.isCharacter) {
      const inserted = Array.from(clean(key).replace(/[\r\n]/gu, ' '));
      chars.splice(field.cursor, 0, ...inserted);
      field.cursor += inserted.length;
      field.value = chars.join('');
    }
  }

  return {
    startForm,
    selectPair,
    cancelForm,
    backForm,
    canDeleteSentence,
    submitForm,
    formKey,
    actions,
  };
}
