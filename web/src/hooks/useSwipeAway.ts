import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';

/** How far a finger moves before the gesture counts as a swipe or a scroll. */
const START_PX = 10;
/** Share of the card's width a swipe must cover to remove it. */
const DISMISS_SHARE = 0.4;
const LEAVE_MS = 180;

interface Gesture {
  pointer: number;
  x: number;
  y: number;
  /** null until the first move decides between a swipe and a scroll. */
  horizontal: boolean | null;
}

/**
 * Swipe an element sideways to dismiss it. The element follows the finger (or
 * mouse); far enough and `onDismiss` runs after it slides out, otherwise it
 * snaps back. Vertical moves are left to the page (CSS `touch-action: pan-y`).
 */
export function useSwipeAway(onDismiss: () => void, enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);

  const end = () => {
    gesture.current = null;
    setDragging(false);
  };

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, horizontal: null };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (current.horizontal === null) {
        if (Math.abs(dx) < START_PX && Math.abs(dy) < START_PX) return;
        current.horizontal = Math.abs(dx) > Math.abs(dy);
        if (!current.horizontal) return end();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }
      setOffset(dx);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = gesture.current;
      end();
      if (!current?.horizontal) return;
      const dx = event.clientX - current.x;
      const width = event.currentTarget.getBoundingClientRect().width;
      if (Math.abs(dx) < width * DISMISS_SHARE) return setOffset(0);
      setOffset(Math.sign(dx) * width);
      setTimeout(onDismiss, LEAVE_MS);
    },
    onPointerCancel() {
      end();
      setOffset(0);
    },
  };

  const style: CSSProperties | undefined = offset
    ? { transform: `translateX(${offset}px)`, transition: dragging ? 'none' : undefined }
    : undefined;

  return enabled ? { style, handlers, dragging } : { style: undefined, handlers: {}, dragging: false };
}
