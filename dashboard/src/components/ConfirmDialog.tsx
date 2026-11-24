import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Tab and Shift+Tab cycle inside the dialog; a native modal lets focus escape to the browser's own UI. */
function trapTab(e: KeyboardEvent<HTMLDialogElement>) {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.hasAttribute("disabled"));
  if (!items.length) return;
  const first = items[0]!, last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function ConfirmDialog({ title, children, onCancel, onConfirm, busy=false, label="Confirm removal" }: {title:string; children:ReactNode; onCancel:()=>void; onConfirm:()=>void; busy?:boolean; label?:string}) {
  const ref = useRef<HTMLDialogElement>(null);
  // React removes the dialog before this cleanup runs, so the browser can't restore focus itself.
  useEffect(() => { const d=ref.current!, opener=document.activeElement as HTMLElement | null; d.showModal(); return () => { d.close(); opener?.focus(); }; },[]);
  return <dialog ref={ref} aria-labelledby="confirm-title" onKeyDown={trapTab} onCancel={e => {e.preventDefault();if(!busy) onCancel();}}><div className="stack"><h2 id="confirm-title">{title}</h2>{children}<div className="row"><button autoFocus onClick={onCancel} disabled={busy}>Cancel</button><button className="danger" disabled={busy} onClick={onConfirm}>{busy ? "Working…" : label}</button></div></div></dialog>;
}
