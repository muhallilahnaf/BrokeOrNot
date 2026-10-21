import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ToastContext, type ToastContextValue } from "./toast-context";
import type { ToastKind } from "./toast-types";
type ToastItem = { id: number; kind: ToastKind; message: string };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<ToastContextValue>((kind, message) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    const id = ++nextId.current;
    setToasts((current) => [...current.slice(-2), { id, kind, message: trimmedMessage }]);
    timers.current.set(id, window.setTimeout(() => {
      timers.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5000));
  }, []);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-stack" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`app-toast app-toast-${toast.kind}`}
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live={toast.kind === "error" ? "assertive" : "polite"}
          >
            <span className="app-toast-message">{toast.message}</span>
            <button
              type="button"
              className="app-toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
