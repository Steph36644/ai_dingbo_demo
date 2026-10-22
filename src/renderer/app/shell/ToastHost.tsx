import type { ToastItem } from "./toast";

export function ToastHost({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="region" aria-label="提示">
      {toasts.slice(0, 3).map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <p>{toast.message}</p>
          <div className="toast-actions">
            {toast.actionLabel && toast.onAction ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.onAction?.();
                  onDismiss(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            ) : null}
            <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => onDismiss(toast.id)}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
