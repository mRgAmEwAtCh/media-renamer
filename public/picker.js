const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const ICONS = { home: '⌂', folder: '▸', drive: '⛁', volume: '⏏' };

/**
 * Show the folder picker dialog and resolve with the chosen absolute path,
 * or null when the user cancels.
 */
export function createFolderPicker({ api }) {
  const dialog = document.getElementById('picker');
  const list = document.getElementById('pickerFolders');
  const placesList = document.getElementById('pickerPlaces');
  const crumbs = document.getElementById('pickerCrumbs');
  const pathInput = document.getElementById('pickerPath');
  const info = document.getElementById('pickerInfo');
  const error = document.getElementById('pickerError');
  const upButton = document.getElementById('pickerUp');
  const showHidden = document.getElementById('pickerHidden');
  const nativeButton = document.getElementById('pickerNative');
  const selectButton = document.getElementById('pickerSelect');

  let current = null;
  let places = null;
  let resolvePick = null;
  let requestId = 0;

  function finish(value) {
    if (dialog.open) dialog.close();
    resolvePick?.(value);
    resolvePick = null;
  }

  function setBusy(busy) {
    for (const control of [upButton, nativeButton, selectButton, pathInput]) control.disabled = busy;
    if (!busy) upButton.disabled = !current?.parent;
    dialog.setAttribute('aria-busy', String(busy));
  }

  function renderPlaces() {
    placesList.replaceChildren(
      ...places.places.map((place) =>
        element(
          'li',
          {},
          element('button', { type: 'button', title: place.path, onclick: () => navigate(place.path) }, `${ICONS[place.kind] ?? '▸'} ${place.label}`),
        ),
      ),
    );
    nativeButton.hidden = !places.nativeDialog;
  }

  function renderListing() {
    pathInput.value = current.path;
    upButton.disabled = !current.parent;
    crumbs.replaceChildren(
      ...current.breadcrumbs.flatMap((crumb, index) => {
        const last = index === current.breadcrumbs.length - 1;
        const button = element('button', { type: 'button', onclick: () => navigate(crumb.path) }, crumb.label);
        if (last) button.setAttribute('aria-current', 'location');
        return index === 0 || current.breadcrumbs[index - 1].label.endsWith(current.separator)
          ? [button]
          : [element('span', { className: 'sep', ariaHidden: 'true' }, current.separator), button];
      }),
    );

    if (current.folders.length === 0) {
      list.replaceChildren(element('li', { className: 'empty' }, 'No subfolders'));
    } else {
      list.replaceChildren(
        ...current.folders.map((folder) =>
          element('li', {}, element('button', { type: 'button', className: 'folder', onclick: () => navigate(folder.path) }, `📁 ${folder.name}`)),
        ),
      );
    }
    const media = current.mediaFiles === 1 ? '1 media file' : `${current.mediaFiles} media files`;
    info.textContent = `${media} directly in this folder${current.truncated ? ' · folder list truncated' : ''}`;
  }

  async function navigate(target, { fallback } = {}) {
    const id = ++requestId;
    error.textContent = '';
    setBusy(true);
    try {
      const listing = await api('/api/browse', { path: target, showHidden: showHidden.checked });
      if (id !== requestId) return;
      current = listing;
      renderListing();
      list.querySelector('button')?.focus({ preventScroll: true });
    } catch (failure) {
      if (id !== requestId) return;
      if (fallback) return navigate(fallback);
      error.textContent = failure.message;
      if (current) pathInput.value = current.path;
    } finally {
      if (id === requestId) setBusy(false);
    }
  }

  async function useNativeDialog() {
    error.textContent = '';
    info.textContent = 'Waiting for the system folder dialog…';
    setBusy(true);
    try {
      const result = await api('/api/pick-folder', { start: current?.path ?? '' });
      if (result.path) return finish(result.path);
      info.textContent = 'System dialog cancelled.';
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      setBusy(false);
    }
  }

  upButton.addEventListener('click', () => current?.parent && navigate(current.parent));
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(pathInput.value);
    }
  });
  showHidden.addEventListener('change', () => current && navigate(current.path));
  nativeButton.addEventListener('click', useNativeDialog);
  selectButton.addEventListener('click', () => current && finish(current.path));
  document.getElementById('pickerCancel').addEventListener('click', () => finish(null));
  document.getElementById('pickerClose').addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', () => finish(null));
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && current?.parent) {
      event.preventDefault();
      navigate(current.parent);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
    event.preventDefault();
  });

  return async function pick(initialPath, { title = 'Choose a folder' } = {}) {
    error.textContent = '';
    document.getElementById('pickerTitle').textContent = title;
    dialog.showModal();
    const result = new Promise((resolve) => {
      resolvePick = resolve;
    });
    try {
      places ??= await api('/api/places', {});
      renderPlaces();
      const home = places.places[0]?.path ?? '/';
      await navigate(initialPath || current?.path || home, { fallback: home });
    } catch (failure) {
      error.textContent = failure.message;
    }
    return result;
  };
}
