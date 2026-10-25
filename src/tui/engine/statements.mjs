/** Role metadata and knowledge have separate actions; all source text has one editor. */
import { roleStatements, reviseRoleStatements } from '../../engine/statements.mjs';
import { placementLabel } from '../concepts/placement-label.mjs';

export function createStatementsEditor({ state, config = {}, forms, projects, draw, setNotice }) {
  return function statementsEditor({ add = false, source = null } = {}) {
    let project = state.project;
    const placementId = state.placementId;
    const blocks = roleStatements(project.data, placementId);
    const fields = blocks.flatMap((block, i) =>
      block.kind === 'answer'
        ? [
            [`Question for source ${i + 1}`, block.texts[0], true],
            ...block.texts
              .slice(1)
              .map((text, j) => [
                `Answer ${i + 1}${block.texts.length > 2 ? '.' + (j + 1) : ''}`,
                text,
                true,
                false,
              ]),
          ]
        : [
            [
              blocks.length === 1 ? 'Statements' : `Statements ${i + 1}`,
              block.texts[0],
              true,
              false,
            ],
          ],
    );
    fields.push([blocks.length ? 'Add statements' : 'Statements', '', true, false]);
    forms.startForm(
      add ? 'Add statements' : 'Edit statements',
      fields,
      (values) => {
        const form = state.form;
        form.controller = new AbortController();
        form.busy = true;
        form.error = '';
        form.recovery = null;
        form.progress = 'Reading your changes';
        form.execution = reviseRoleStatements(
          project,
          { placementId, blocks, values },
          {
            signal: form.controller.signal,
            actor: config.actor ?? 'participant',
            via: 'editor',
            progress: (message) => {
              form.progress = message;
              draw();
            },
          },
        )
          .then(async ({ data, changed }) => {
            form.controller.signal.throwIfAborted();
            if (changed) {
              form.committing = true;
              form.progress = 'Writing the statements';
              draw();
              state.project = await projects.persistProject(project, data);
            }
            form.corpusSaved = true;
            await projects.refreshOutline();
            if (state.form === form) {
              state.form = null;
              state.workflow.select(placementId, 'reading');
              state.workflow.sync();
              setNotice(changed ? 'Statements saved' : 'No changes');
            }
          })
          .catch((error) => {
            if (state.form !== form || form.controller.signal.aborted) return;
            form.busy = false;
            form.committing = false;
            form.error = projects.saveError(error);
            form.recovery = {
              saved: Boolean(form.corpusSaved),
              steps: form.corpusSaved
                ? 'The statements are saved. Return to the role and check the question again.'
                : 'Your edits are still here. Nothing has been saved. Correct the text or restore the AMR service, then save again.',
            };
          })
          .finally(draw);
      },
      { submitLabel: 'save statements' },
    );
    state.form.materialEditor = true;
    state.form.roleStatements = true;
    const form = state.form;
    form.onProjectReload = () => {
      const exists = state.project.data.placements.some((p) => p.id === placementId);
      const current = exists ? roleStatements(state.project.data, placementId) : [];
      if (exists && JSON.stringify(current) === JSON.stringify(blocks)) {
        project = state.project;
        return;
      }
      form.readOnly = true;
      form.title = 'Unsaved statement draft';
      state.offset = 0;
      form.error = exists
        ? 'The saved statements changed. This unsaved draft has not replaced them.'
        : 'The role was removed. This unsaved draft has not been saved.';
      form.contextRows = current.flatMap((block) =>
        block.texts.map((text) => ['Saved statement', text, 'input']),
      );
      if (exists)
        form.graphActions = () => [
          {
            pane: 'reading',
            key: 'ALT_E',
            description: 'edit current statements',
            run: () => {
              state.placementId = placementId;
              statementsEditor();
            },
          },
        ];
    };
    state.form.index = add ? fields.length - 1 : 0;
    if (source) {
      let offset = 0;
      for (const block of blocks) {
        if (
          (block.source && block.source.id === source.sentenceId) ||
          (block.contributionId && block.contributionId === source.development?.contributionId)
        ) {
          const contribution = project.data.contributions?.find(
            (c) => c.id === block.contributionId,
          );
          const part =
            block.kind === 'answer'
              ? contribution.responses
                  .filter((r) => !r.withdrawn)
                  .findIndex((r) => r.id === source.development?.partId) + 1
              : 0;
          state.form.index = offset + part;
          const field = state.form.fields[state.form.index];
          const start = field.value.indexOf(source.text);
          if (start >= 0) field.cursor = Array.from(field.value.slice(0, start)).length;
          break;
        }
        offset += block.texts.length;
      }
    }
    state.form.contextRows = [['At', placementLabel(project.data, placementId)]];
  };
}
