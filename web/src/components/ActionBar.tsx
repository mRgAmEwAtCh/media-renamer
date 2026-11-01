import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function ActionBar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const update = () => document.documentElement.style.setProperty('--action-bar-height', `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--action-bar-height');
    };
  }, []);
  return (
    <div ref={bar} className="action-bar">
      <div className="action-bar-content row">{children}</div>
    </div>
  );
}
