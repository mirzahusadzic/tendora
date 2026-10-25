/** Mouse hit testing, pane resizing and navigation. */
import { sidebarSize } from './layout.mjs';

export function createMouse({
  state,
  term,
  queue,
  draw,
  setNotice,
  scrollKey,
  handleKey,
  loadProjectRecording,
  change,
  navigationSelection,
  saveLayout,
}) {
  const pointerSupported =
    process.env.TERM_PROGRAM === 'ghostty' || process.env.TERM === 'xterm-ghostty';
  const reviewing = () =>
    state.form &&
    !state.form.busy &&
    (state.form.confirm || state.form.readOnly || state.form.sections);
  const onDivider = (position) =>
    state.viewport?.sidebarWidth &&
    position &&
    !state.quitPrompt &&
    position.x === state.viewport.sidebarWidth + 1 &&
    position.y > state.viewport.headerHeight &&
    position.y <= state.viewport.headerHeight + state.viewport.bodyHeight;
  const nodeAt = (position) =>
    (!state.form || state.form.workspace || state.form.investigationBrowser || reviewing()) &&
    !state.help &&
    !state.quitPrompt &&
    position &&
    position.x > 1 &&
    position.x < state.viewport?.nodeWidth
      ? state.viewport.nodeHits.find((item) => item.y === position.y)
      : null;
  const onLowerDivider = (position) =>
    !state.help &&
    !state.quitPrompt &&
    (state.viewport?.developmentHeight || state.viewport?.recordingsHeight) &&
    position &&
    position.x > 1 &&
    position.x < state.viewport.nodeWidth &&
    [state.viewport.recordingsTop, state.viewport.recordingsTop + 1].includes(position.y);
  function updatePointer(
    shape = state.resizing?.axis === 'rows'
      ? 'ns-resize'
      : state.resizing || onDivider(state.mousePosition)
        ? 'ew-resize'
        : onLowerDivider(state.mousePosition)
          ? 'ns-resize'
          : nodeAt(state.mousePosition) ||
              recordingAt(state.mousePosition) ||
              developmentAt(state.mousePosition)
            ? 'pointer'
            : 'default',
  ) {
    if (!pointerSupported || shape === state.pointerShape) return;
    state.pointerShape = shape;
    term.raw(`\x1b]22;${shape}\x1b\\`);
  }
  const recordingAt = (position) =>
    (!state.form || state.form.workspace || reviewing()) &&
    !state.help &&
    !state.quitPrompt &&
    position &&
    position.x > 1 &&
    position.x < state.viewport?.nodeWidth
      ? state.viewport.recordingHits?.find((item) => item.y === position.y)
      : null;
  const developmentAt = (position) =>
    (!state.form || reviewing()) &&
    !state.help &&
    !state.quitPrompt &&
    position &&
    position.x > 1 &&
    position.x < state.viewport?.nodeWidth
      ? state.viewport.developmentHits?.find((item) => item.y === position.y)
      : null;
  function finishResize(save) {
    if (!state.resizing) return;
    if (!save) {
      if (state.resizing.axis === 'rows') state[state.resizing.fraction] = state.resizing.previous;
      else state.preferredSidebar = state.resizing.previous;
      if (state.resizing.layouts) state.projectLayouts = state.resizing.layouts;
    }
    state.resizing = null;
  }
  function dragDivider(data) {
    if (state.resizing.axis === 'rows') {
      const height = Math.max(
        state.resizing.minimum,
        Math.min(
          state.viewport.bodyHeight - state.viewport.minimumNodeHeight,
          state.resizing.height + state.resizing.y - data.y,
        ),
      );
      const fraction = height / state.viewport.bodyHeight;
      // Development's height belongs to the project it was chosen in; the
      // default another project starts from is left as it was (review
      // 2026-10-25, #12).
      const id = state.project?.data.id;
      if (state.resizing.fraction === 'developmentFraction' && id)
        state.projectLayouts = {
          ...state.projectLayouts,
          [id]: { developmentFraction: fraction },
        };
      else state[state.resizing.fraction] = fraction;
    } else state.preferredSidebar = sidebarSize((term.width ?? 80) - 1, data.x - 1);
  }
  /** The list entry under the pointer, in the left column: every line of it
   * shows what a click selects. True when it changed. */
  function updateHover(position = state.mousePosition) {
    const node = nodeAt(position),
      developed = !node && developmentAt(position),
      recording = !node && !developed && recordingAt(position);
    const hover = node
      ? { key: 'navigationId', id: node.id }
      : developed
        ? { key: 'developmentId', id: developed.id }
        : recording
          ? { key: 'recordingPath', id: recording.path }
          : null;
    if (hover?.key === state.hover?.key && hover?.id === state.hover?.id) return false;
    state.hover = hover;
    return true;
  }
  function handleMouse(name, data) {
    // terminal-kit decodes wheel buttons 6/7 as UP/DOWN too. Their raw code
    // retains bit 1: horizontal trackpad movement must not scroll vertically.
    if (['MOUSE_WHEEL_UP', 'MOUSE_WHEEL_DOWN'].includes(name) && data.code & 2) return;
    state.mousePosition = data;
    updatePointer();
    if (state.closed || !state.viewport || state.quitPrompt) return;
    if (name === 'MOUSE_MOTION') {
      if (!state.resizing && updateHover()) draw();
      return;
    }
    updateHover();
    if (!state.resizing && ['MOUSE_WHEEL_UP', 'MOUSE_WHEEL_DOWN'].includes(name)) {
      if (
        (!state.form || state.form.workspace) &&
        !state.help &&
        state.recordingsVisible &&
        state.viewport.recordingsHeight &&
        data.x < state.viewport.nodeWidth &&
        data.y > state.viewport.recordingsTop
      ) {
        const delta = name === 'MOUSE_WHEEL_UP' ? -1 : 1;
        if (state.focus === 'recordings')
          state.recordingIndex = Math.max(
            0,
            Math.min(state.recordings.length - 1, state.recordingIndex + delta),
          );
        else
          state.recordingsOffset = Math.max(
            0,
            Math.min(state.viewport.recordingsMaxOffset, state.recordingsOffset + delta * 2),
          );
        draw();
        return;
      }
      // Trackpad momentum can outpace drawing. Keep a short backlog so scrolling
      // stops promptly instead of replaying every queued step after release.
      if (queue.wheel >= 4) return;
      queue.wheel++;
      queue.pending = queue.pending
        .then(async () => {
          if (state.closed || !state.viewport || state.quitPrompt || state.form?.busy) return;
          const key = name === 'MOUSE_WHEEL_UP' ? 'UP' : 'DOWN';
          const trace =
            !state.form &&
            (state.engineReadingView?.()?.engineReview || state.projectReadingTab === 'Meaning');
          if (
            !state.help &&
            trace &&
            !['Corpus', 'Material'].includes(state.projectReadingTab) &&
            data.x > (state.viewport.sidebarWidth || 0) + 1
          ) {
            state.focus = 'reading';
            scrollKey(key);
          } else if (state.form?.workspace || state.form?.investigationBrowser) {
            state.focus = data.x < state.viewport.nodeWidth ? 'nodes' : 'reading';
            if (state.focus === 'nodes') await handleKey(key, {});
            else scrollKey(key);
          } else if (state.form) {
            if (state.form.continuation || state.form.tree || state.form.passageEditor) {
              state.form.browseContext = true;
              scrollKey(key);
            } else if (state.form.confirm) scrollKey(key);
          } else if (state.help) scrollKey(key);
          else {
            state.focus =
              state.viewport?.sidebarWidth && data.x <= state.viewport.sidebarWidth
                ? state.viewport.developmentHeight && data.y > state.viewport.developmentTop
                  ? 'development'
                  : 'nodes'
                : 'reading';
            if (['nodes', 'development'].includes(state.focus))
              state.projectReadingOrigin = state.focus;
            await handleKey(key, {});
          }
          draw();
        })
        .catch((error) => {
          state.failure = error.message;
          draw();
        })
        .finally(() => queue.wheel--);
      return;
    }
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED' && !state.resizing) {
      if (
        reviewing() &&
        !state.help &&
        data.x >= 1 &&
        data.x <= state.viewport.nodeWidth &&
        data.y > state.viewport.headerHeight &&
        data.y <= state.viewport.headerHeight + state.viewport.bodyHeight &&
        !onLowerDivider(data)
      ) {
        const clickedMode = state.mode;
        queue.pending = queue.pending
          .then(async () => {
            if (
              state.closed ||
              state.help ||
              state.quitPrompt ||
              state.form?.busy ||
              state.mode !== clickedMode
            )
              return;
            // Use the same back/cancel lifecycle as Esc, including nested evidence
            // and saved evidence views. An underlying Ask keeps its draft.
            while (state.form && !state.form.workspace && !state.form.investigationBrowser) {
              if (state.form.busy) return;
              const active = state.form;
              state.focus = 'reading';
              await handleKey('ESCAPE', {});
              if (state.form === active) return;
            }
            // Returning from a review may restore a different sidebar (for
            // example the saved inquiry browser). Resolve its current targets.
            draw();
            const node = nodeAt(data),
              recording = recordingAt(data),
              developed = developmentAt(data);
            const focus =
              state.viewport.developmentHeight && data.y > state.viewport.developmentTop
                ? 'development'
                : state.viewport.recordingsHeight && data.y > state.viewport.recordingsTop
                  ? 'recordings'
                  : 'nodes';
            state.focus = focus;
            setNotice('');
            state.failure = '';
            if (['nodes', 'development'].includes(focus)) state.projectReadingOrigin = focus;
            if (developed) await state.selectProjectEntry(developed.id);
            else if (recording) {
              if (state.form?.workspace) {
                await state.saveAsk();
                state.form = null;
              }
              state.projectPanel = 'recordings';
              await loadProjectRecording(recording.path);
              state.focus = 'recordings';
            } else if (node) {
              if (state.form?.investigationBrowser) {
                state.form.index = node.id;
                state.offset = 0;
                await state.form.onSelect?.();
              } else if (state.mode === 'recording')
                change(() => navigationSelection(node.id), true);
              else if (state.mode === 'project') {
                if (state.form?.workspace) {
                  state.placementId = node.id;
                  await state.saveAsk();
                } else state.selectProjectEntry(node.id);
              } else {
                if (state.homeIndex !== node.id) state.offset = 0;
                state.homeIndex = node.id;
              }
            }
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            draw();
          });
        return;
      }
      const developed = developmentAt(data);
      if (developed) {
        state.focus = 'development';
        queue.pending = queue.pending
          .then(async () => {
            if (state.closed) return;
            await state.selectProjectEntry(developed.id);
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            draw();
          });
        return;
      }
      const action = state.viewport.actionHits?.find(
        (item) => item.y === data.y && data.x >= item.x && data.x <= item.endX,
      );
      if (action) {
        queue.pending = queue.pending
          .then(async () => {
            if (state.closed) return;
            if (action.pane !== 'global') state.focus = action.pane;
            await handleKey(action.inputKey, {});
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            draw();
          });
        return;
      }
      const review = state.form ?? state.projectReadingView?.() ?? state.engineReadingView?.();
      const section =
        review &&
        state.viewport.sectionHits?.find(
          (item) => item.y === data.y && data.x >= item.x && data.x <= item.endX,
        );
      if (section) {
        queue.pending = queue.pending.then(() => {
          if (
            (state.form ?? state.projectReadingView?.() ?? state.engineReadingView?.()) !==
              review ||
            review.busy
          )
            return;
          state.focus = 'reading';
          if (review.selectSection) review.selectSection(section.index);
          else {
            review.sectionIndex = section.index;
            state.offset = 0;
          }
          draw();
        });
        return;
      }
      const selector =
        state.form?.selectors &&
        data.x > (state.viewport.sidebarWidth || 0) &&
        state.viewport.selectorHits?.find((item) => item.y === data.y);
      if (selector) {
        queue.pending = queue.pending.then(() => {
          state.form?.selectSelector?.(selector.index);
          draw();
        });
        return;
      }
      const choice =
        (review?.move || review?.onChoice) &&
        data.x > (state.viewport.sidebarWidth || 0) &&
        state.viewport.choiceHits?.find((item) => item.y === data.y);
      if (choice) {
        queue.pending = queue.pending
          .then(async () => {
            const currentReview =
              state.form ?? state.projectReadingView?.() ?? state.engineReadingView?.();
            if (
              currentReview !== review &&
              (!review.choiceKey || currentReview?.choiceKey !== review.choiceKey)
            )
              return;
            state.focus = 'reading';
            if (review.onChoice) {
              review.onChoice(choice.index);
              draw();
              return;
            }
            if (!state.form?.move || state.form.busy) return;
            state.form.index = choice.index;
            if (state.form.multiSelect) state.form.toggleChoice();
            else await handleKey('ENTER', {});
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            draw();
          });
        return;
      }
      if (onLowerDivider(data)) {
        const development = Boolean(state.viewport.developmentHeight),
          fraction = development ? 'developmentFraction' : 'recordingsFraction';
        state.resizing = {
          axis: 'rows',
          fraction,
          previous: state[fraction],
          layouts: state.projectLayouts,
          minimum: development ? 8 : 6,
          height: development ? state.viewport.developmentHeight : state.viewport.recordingsHeight,
          y: data.y,
          dragging: true,
        };
        setNotice('');
        draw();
        return;
      }
      const recordingHit = recordingAt(data);
      if (recordingHit) {
        queue.pending = queue.pending
          .then(async () => {
            if (
              state.closed ||
              (state.form && !state.form.workspace) ||
              state.help ||
              state.quitPrompt
            )
              return;
            if (state.form?.workspace) {
              await state.saveAsk();
              state.form = null;
            }
            state.projectPanel = 'recordings';
            await loadProjectRecording(recordingHit.path);
            state.focus = 'recordings';
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            setNotice(error.message);
            draw();
          });
        return;
      }
      if (
        (!state.form || state.form.workspace || state.form.investigationBrowser) &&
        !state.help &&
        state.viewport.sidebarWidth &&
        data.x > state.viewport.sidebarWidth + 1 &&
        data.y > state.viewport.headerHeight &&
        data.y <= state.viewport.headerHeight + state.viewport.bodyHeight
      ) {
        state.focus = 'reading';
        draw();
        return;
      }
      const hit = nodeAt(data);
      if (hit) {
        const clickedMode = state.mode;
        queue.pending = queue.pending
          .then(async () => {
            if (
              state.closed ||
              (state.form && !state.form.workspace && !state.form.investigationBrowser) ||
              state.help ||
              state.quitPrompt ||
              state.mode !== clickedMode
            )
              return;
            state.focus = 'nodes';
            setNotice('');
            state.failure = '';
            if (state.form?.investigationBrowser) {
              state.form.index = hit.id;
              state.offset = 0;
              await state.form.onSelect?.();
            } else if (state.mode === 'recording') {
              state.projectReadingOrigin = 'nodes';
              change(() => navigationSelection(hit.id), true);
            } else if (state.mode === 'project') {
              if (state.form?.workspace) {
                state.placementId = hit.id;
                await state.saveAsk();
              } else state.selectProjectEntry(hit.id);
            } else {
              if (state.homeIndex !== hit.id) state.offset = 0;
              state.homeIndex = hit.id;
            }
            draw();
          })
          .catch((error) => {
            state.failure = error.message;
            draw();
          });
        return;
      }
      if (
        (!state.form || state.form.workspace) &&
        !state.help &&
        data.x >= 1 &&
        data.x <= state.viewport.nodeWidth &&
        data.y > state.viewport.headerHeight &&
        data.y <= state.viewport.headerHeight + state.viewport.bodyHeight
      ) {
        state.focus =
          state.viewport.developmentHeight && data.y > state.viewport.developmentTop
            ? 'development'
            : state.viewport.recordingsHeight && data.y > state.viewport.recordingsTop
              ? 'recordings'
              : 'nodes';
        if (['nodes', 'development'].includes(state.focus))
          state.projectReadingOrigin = state.focus;
        draw();
        return;
      }
    }
    if (!state.viewport.sidebarWidth && !state.resizing) return;
    if (name === 'MOUSE_LEFT_BUTTON_PRESSED') {
      if (onDivider(data)) {
        state.resizing = { previous: state.preferredSidebar, dragging: true };
        setNotice('');
        draw();
      }
    } else if (name === 'MOUSE_DRAG' && state.resizing?.dragging) {
      dragDivider(data);
      draw();
    } else if (name === 'MOUSE_LEFT_BUTTON_RELEASED' && state.resizing?.dragging) {
      dragDivider(data);
      finishResize(true);
      draw();
      queue.pending = queue.pending.then(async () => {
        try {
          await saveLayout();
          setNotice('Layout saved…');
        } catch (error) {
          state.failure = `Could not save layout: ${error.message}`;
          setNotice('Not saved…');
        }
        draw();
      });
    }
  }

  return { updatePointer, finishResize, handleMouse };
}
