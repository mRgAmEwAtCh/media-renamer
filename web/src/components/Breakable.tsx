import { Fragment } from 'react';

/** Text that may wrap after . / - _ instead of mid-word, so long file names stay readable on narrow screens. */
export function Breakable({ text }: { text: string | null | undefined }) {
  return String(text ?? '')
    .split(/(?<=[./_-])/)
    .map((part, index) => (
      <Fragment key={index}>
        {index > 0 && <wbr />}
        {part}
      </Fragment>
    ));
}
