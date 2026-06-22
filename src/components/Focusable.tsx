import { ComponentChildren, JSX } from 'preact';

interface Props {
  onSelect?: () => void;
  class?: string;
  children?: ComponentChildren;
  autofocus?: boolean;
  style?: JSX.CSSProperties;
}

// A button that participates in spatial navigation. Enter/click both fire
// onSelect. data-focusable marks it for the focus engine.
export function Focusable({ onSelect, class: cls, children, autofocus, style }: Props) {
  return (
    <button
      type="button"
      data-focusable
      class={'focusable ' + (cls || '')}
      style={style}
      ref={(el) => {
        if (autofocus && el) el.focus();
      }}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
