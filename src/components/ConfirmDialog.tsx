import { useEffect, useRef } from 'preact/hooks';
import { useRemote } from '../nav/useRemote';
import { Key } from '../nav/keys';

interface Props {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Centred confirmation overlay for a single yes/no decision. It owns the remote
// while open — the caller must disable its own useRemote so the two handlers
// don't both fire. Only two buttons, so navigation is handled locally (Left/
// Right shift focus between them, Enter fires the focused one, Back cancels)
// rather than through the geometric focus engine, which would otherwise score
// candidates against the grid still mounted behind the scrim.
//
// The primary action is focused on open (tvOS-style alert), lifted above the
// secondary choice below it.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Intercept arrows so focus stays trapped on the two stacked buttons and never
  // leaks to the grid behind the scrim. Confirm sits on top, cancel below, so Up
  // reaches confirm and Down reaches cancel. Enter falls through to useRemote's
  // default (clicks the focused button); Back is routed to onCancel.
  const onKey = (code: number): boolean => {
    if (code === Key.Up || code === Key.Left) {
      confirmRef.current?.focus();
      return true;
    }
    if (code === Key.Down || code === Key.Right) {
      cancelRef.current?.focus();
      return true;
    }
    return false;
  };

  useRemote({ onKey, onBack: onCancel });

  return (
    <div class="confirm-scrim" onClick={onCancel}>
      {/* stop clicks on the card from bubbling to the scrim's cancel handler */}
      <div class="confirm-card" onClick={(e) => e.stopPropagation()}>
        <h2 class="confirm-title">{title}</h2>
        {message && <p class="confirm-message">{message}</p>}
        <div class="confirm-actions">
          <button
            ref={confirmRef}
            data-focusable
            class={'confirm-btn focusable' + (destructive ? ' confirm-btn--danger' : '')}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            ref={cancelRef}
            data-focusable
            class="confirm-btn focusable"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
