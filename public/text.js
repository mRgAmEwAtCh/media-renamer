/**
 * Text that may wrap after . / - _ instead of in the middle of a word, so long
 * file names stay readable on narrow screens.
 */
export function breakable(text) {
  const fragment = document.createDocumentFragment();
  for (const part of String(text ?? '').split(/(?<=[./_-])/)) {
    if (fragment.childNodes.length) fragment.append(document.createElement('wbr'));
    fragment.append(part);
  }
  return fragment;
}

/** Grow a textarea to fit its content. */
export function fitHeight(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
}
