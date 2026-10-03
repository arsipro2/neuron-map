import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({ title, children, onClose, busy = false, wide = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header className="modal-head"><h2>{title}</h2><button onClick={onClose} disabled={busy} aria-label="Close dialog">×</button></header>
    {children}
  </dialog>
}
