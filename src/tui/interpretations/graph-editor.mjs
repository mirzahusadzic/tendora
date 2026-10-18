/** Shared graph controls for local interpretations and proposal source corrections. */
import { reviseGraph, splitNodeEdits } from '../../amr/revision.mjs';
import { nodeChoices, relationReading } from '../shell/wording.mjs';

export function openGraphEditor({
  state,
  forms,
  picker,
  title,
  original,
  sourceText,
  getEdits,
  setEdits,
  contextRows,
  evaluate,
  returnForm = state.form,
}) {
  const graph = () => reviseGraph(original, getEdits(), false);
  const command = (key, description, run) => ({ pane: 'reading', key, description, run });
  forms.startForm(
    title,
    [],
    () => {
      const choice = form.move[form.index];
      if (choice?.node) editNode(choice.node);
      else if (choice?.edge) editEdge(choice.edge);
    },
    { submitLabel: 'edit item' },
  );
  const form = state.form;
  form.returnForm = returnForm;
  const update = () => {
    const selected = form.move?.[form.index],
      current = graph();
    form.contextRows = contextRows;
    form.move = [
      ...nodeChoices(current, sourceText, 'Source').map((item) => ({ ...item, group: 'Nodes' })),
      ...current.edges.map((edge) => ({
        label: relationReading(current, edge, sourceText).label,
        edge,
        group: 'Relations',
      })),
    ];
    form.index = Math.max(
      0,
      form.move.findIndex((item) =>
        selected?.node
          ? item.node?.id === selected.node.id
          : selected?.edge
            ? item.edge?.id === selected.edge.id
            : false,
      ),
    );
    let evaluation = [];
    try {
      reviseGraph(current);
      evaluation = evaluate?.(getEdits()) ?? [];
      form.error = '';
    } catch (error) {
      form.error = `${error.message}; finish the graph before accepting`;
    }
    form.graphEditor = { graph: current, original, evaluation };
  };
  const append = (edits) => {
    setEdits([...getEdits(), ...edits]);
    update();
  };
  const finish = (edit) => {
    append([edit]);
    forms.cancelForm();
  };
  const uniqueId = () => {
    const current = graph(),
      used = new Set([...current.nodes, ...current.edges].map((item) => item.id));
    let id = 1;
    while (used.has(`u${id}`)) id++;
    return `u${id}`;
  };
  function editNode(node) {
    forms.startForm(
      node ? 'Change concept' : 'Add node',
      [['Concept', node?.concept ?? '']],
      ([concept]) =>
        finish({ kind: node ? 'node' : 'add-node', id: node?.id ?? uniqueId(), concept }),
    );
    state.form.returnForm = form;
  }
  function editEdge(edge) {
    forms.startForm(
      edge ? 'Change relation' : 'Add edge',
      [
        ['From', edge?.from ?? graph().top],
        ['Role', edge?.role ?? ''],
        ['To', edge?.to ?? ''],
      ],
      ([from, role, to]) => {
        if (
          ![from, to].every((id) => graph().nodes.some((node) => node.id === id)) ||
          !/^:[\w-]+$/u.test(role)
        )
          throw new Error('Choose existing nodes and a valid AMR role');
        finish({ kind: edge ? 'edge' : 'add-edge', id: edge?.id ?? uniqueId(), from, role, to });
      },
    );
    const editor = state.form;
    editor.returnForm = form;
    editor.graphActions = () =>
      [0, 2].includes(editor.index)
        ? [
            command('ALT_N', 'choose node', () =>
              picker(
                editor.fields[editor.index].label,
                nodeChoices(graph(), sourceText, 'Source'),
                ({ node }) => {
                  const field = editor.fields[editor.index];
                  field.value = node.id;
                  field.cursor = node.id.length;
                },
                editor,
              ),
            ),
          ]
        : [];
  }
  form.graphActions = () => {
    const selected = form.move[form.index],
      shared =
        selected?.edge && graph().edges.filter((edge) => edge.to === selected.edge.to).length > 1;
    return [
      command('n', 'add node', () => editNode()),
      command('a', 'add edge', () => editEdge()),
      command('r', 'root', () =>
        picker(
          'Root',
          nodeChoices(graph(), sourceText, 'Source'),
          ({ node }) => append([{ kind: 'top', id: node.id }]),
          form,
        ),
      ),
      ...(selected
        ? [
            command('x', selected.node ? 'delete node' : 'delete edge', () =>
              append([
                {
                  kind: selected.node ? 'remove-node' : 'remove-edge',
                  id: (selected.node ?? selected.edge).id,
                },
              ]),
            ),
          ]
        : []),
      ...(shared
        ? [
            command('s', 'split shared node', () =>
              append(splitNodeEdits(graph(), selected.edge.id, uniqueId())),
            ),
          ]
        : []),
      command('v', 'review changes', () => {
        forms.cancelForm();
        state.form?.onResume?.();
      }),
    ];
  };
  form.onResume = update;
  update();
  return form;
}
