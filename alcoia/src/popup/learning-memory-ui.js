/* learning-memory-ui.js -- the Account-based learning card on the settings page
 *
 * mountLearningMemory({ root, manager, saveFile }) wires the markup in
 * settings.html (the #learningMemory card) to a learning-memory manager. All
 * state comes from the server through the manager; nothing is stored here.
 * The UI only ever reflects what the server last confirmed: a failed call
 * leaves the previous, server-confirmed state on screen and shows an error.
 *
 * Kept as its own module (not inside settings.js) so it can be tested without
 * the rest of the settings page's chrome.* wiring.
 */
const STATE_TEXT = {
  enabled: {
    label: 'On',
    detail: 'On. Alcoia remembers your learning state in your account, for you. This is the default.',
  },
  disabled: {
    label: 'Off',
    detail: 'Off. Alcoia is not using or adding to your learning memory. Anything stored earlier is kept until you delete it.',
  },
};

const ERROR_TEXT = {
  no_session: 'Sign in again to change this setting.',
  invalid_session: 'Your session expired. Sign in again to change this setting.',
  scope_version_mismatch: 'The description changed while this page was open. It has been refreshed. Read it and try again.',
};
const errorText = (code) => ERROR_TEXT[code] || 'That did not work. Nothing was changed. Try again.';

export function mountLearningMemory({ root, manager, saveFile }) {
  const $ = (sel) => root.querySelector(sel);
  const toggle = $('[data-lm="toggle"]');
  const stateLabel = $('[data-lm="state-label"]');
  const stateDetail = $('[data-lm="state-detail"]');
  const message = $('[data-lm="message"]');
  const enablePanel = $('[data-lm="enable-panel"]');
  const deletePanel = $('[data-lm="delete-panel"]');
  const controls = $('[data-lm="controls"]');

  let state = null; // last state the SERVER confirmed
  let busy = false;

  function say(text, kind = 'info') {
    message.textContent = text || '';
    message.dataset.kind = kind;
    message.hidden = !text;
    message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function paint() {
    if (!state) {
      controls.hidden = true;
      return;
    }
    controls.hidden = false;
    const text = STATE_TEXT[state.status];
    const on = state.status === 'enabled';
    toggle.setAttribute('aria-checked', String(on));
    toggle.textContent = on ? 'Turn off' : 'Turn on';
    stateLabel.textContent = text.label; // visible words, never only a colour
    stateDetail.textContent = text.detail;
    toggle.disabled = busy;
    for (const b of root.querySelectorAll('[data-lm-action]')) b.disabled = busy;
  }

  function closePanels() {
    enablePanel.hidden = true;
    deletePanel.hidden = true;
  }

  async function run(fn) {
    if (busy) return null;
    busy = true;
    paint();
    try {
      return await fn();
    } finally {
      busy = false;
      paint();
    }
  }

  async function refresh() {
    const r = await manager.getState();
    if (r.ok) {
      state = r.state;
      say('');
    } else {
      // Keep whatever the server last confirmed; never invent a state.
      say(state ? errorText(r.error) : 'Could not load this setting. Try again later.', 'error');
    }
    paint();
    return r;
  }

  // The toggle never changes anything silently: turning on opens the
  // confirmation (which shows what is being agreed to), turning off is a
  // single deliberate click that deletes nothing.
  toggle.addEventListener('click', async () => {
    if (!state) return;
    say('');
    if (state.status === 'enabled') {
      closePanels();
      await run(async () => {
        const r = await manager.disable();
        if (r.ok) {
          state = r.state;
          say('Turned off. Alcoia no longer uses or adds to your learning memory. Nothing was deleted.');
        } else {
          say(errorText(r.error), 'error');
        }
      });
    } else {
      deletePanel.hidden = true;
      enablePanel.hidden = false;
      $('[data-lm="enable-confirm"]').focus();
    }
  });

  $('[data-lm="enable-confirm"]').addEventListener('click', async () => {
    const shownVersion = state.currentScopeVersion; // what the server told us the learner is agreeing to
    await run(async () => {
      const r = await manager.enable({ scopeVersion: shownVersion });
      if (r.ok) {
        state = r.state;
        closePanels();
        say('Turned on. You can turn it off, export it or delete it here at any time.');
        toggle.focus();
      } else {
        if (r.error === 'scope_version_mismatch') {
          const again = await manager.getState();
          if (again.ok) state = again.state;
        }
        say(errorText(r.error), 'error');
      }
    });
  });
  $('[data-lm="enable-cancel"]').addEventListener('click', () => {
    closePanels();
    toggle.focus();
  });

  $('[data-lm="delete-open"]').addEventListener('click', () => {
    say('');
    enablePanel.hidden = true;
    deletePanel.hidden = false;
    $('[data-lm="delete-cancel"]').focus(); // the safe choice has focus first
  });
  $('[data-lm="delete-cancel"]').addEventListener('click', () => {
    closePanels();
    $('[data-lm="delete-open"]').focus();
  });
  $('[data-lm="delete-confirm"]').addEventListener('click', async () => {
    await run(async () => {
      const r = await manager.resetMemory();
      if (r.ok) {
        closePanels();
        // The setting itself is untouched by a reset; show what the server says.
        const again = await manager.getState();
        if (again.ok) state = again.state;
        say('Your learning memory was deleted. Your account, classes and settings are unchanged.');
        $('[data-lm="delete-open"]').focus();
      } else {
        say(errorText(r.error), 'error');
      }
    });
  });

  $('[data-lm="export"]').addEventListener('click', async () => {
    say('');
    await run(async () => {
      const r = await manager.exportMemory();
      if (r.ok) {
        saveFile(r.filename, r.text);
        say('Downloaded.');
      } else {
        say(errorText(r.error), 'error');
      }
    });
  });

  return { refresh, getState: () => state };
}
