// State of the rename page, shared by app.js and the modules it uses.

/** Preview statuses the user may select for renaming. */
export const RENAMABLE = new Set(['ok', 'warning', 'edited']);

export const state = {
  root: '',
  previewed: false,
  previewTargets: null, // destinations requested for the current preview
  items: [],
  busy: false,
  jobId: null,
};

const willChange = (item) => item.newRel && (item.target || item.newRel !== item.rel);

/** Items that are selected and would actually be renamed or moved. */
export const selectedItems = () => state.items.filter((item) => item.selected && RENAMABLE.has(item.status) && willChange(item));
