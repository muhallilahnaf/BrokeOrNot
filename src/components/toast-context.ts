import { createContext, useCallback, useContext } from "react";
import type { ToastKind } from "./toast-types";

export type ToastContextValue = (kind: ToastKind, message: string) => void;
export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast must be used within ToastProvider.");
  return notify;
}

export function useToastFeedback() {
  const notify = useToast();
  const setError = useCallback((message: string) => {
    if (message) notify("error", message);
  }, [notify]);
  const setSuccess = useCallback((message: string) => {
    if (message) notify("success", message);
  }, [notify]);
  return {
    setError,
    setSuccess,
    setMessage: setSuccess,
    setNotice: setSuccess,
  };
}
