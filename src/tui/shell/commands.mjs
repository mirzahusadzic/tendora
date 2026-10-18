/** The same situated commands drive rendering and dispatch. */
export const situatedCommands = (state) => state.actionProvider?.() ?? [];
export const activeCommand = (state, key) =>
  situatedCommands(state).find(
    (item) => item.key === key && (item.pane === state.focus || item.pane === 'global'),
  );
