import type { ReactNode } from "react";
import { useEffect } from "react";

type ConsoleDocsDrawerProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

/**
 * Lightweight right-side drawer for contextual API notes (no separate docs section).
 */
export function ConsoleDocsDrawer({ open, onClose, title, children }: ConsoleDocsDrawerProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="docs-drawer-root" role="presentation">
      <button type="button" className="docs-drawer-backdrop" aria-label="Close documentation" onClick={onClose} />
      <aside className="docs-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="docs-drawer-title">
        <div className="docs-drawer-head">
          <h2 id="docs-drawer-title" className="docs-drawer-title">
            {title}
          </h2>
          <button type="button" className="ghost ghost--xs docs-drawer-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="docs-drawer-body">{children}</div>
      </aside>
    </div>
  );
}
