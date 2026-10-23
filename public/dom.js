export const $ = (id) => document.getElementById(id);

/** Create an element with properties and children; null, undefined and false children are skipped. */
export const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};

/** The status line under the action buttons; kind is '', 'error' or 'success'. */
export function setStatus(message, kind = '') {
  const status = $('status');
  status.textContent = message;
  status.className = kind;
}
