export type ToastKind = "info" | "ok" | "warn" | "error";

export type ToastItem = {
  id: number;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};
