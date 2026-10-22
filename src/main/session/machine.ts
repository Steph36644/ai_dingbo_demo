import type { SessionState } from "@shared/contracts/session";

export type MachineEvent =
  | "START"
  | "READY"
  | "INIT_FAILED"
  | "DEGRADE"
  | "RECOVER"
  | "STOP"
  | "STOPPED_OK"
  | "STOP_FAILED"
  | "GIVE_UP"
  | "RESET";

const TABLE: Record<SessionState, Partial<Record<MachineEvent, SessionState>>> = {
  idle: { START: "preparing" },
  preparing: { READY: "running", INIT_FAILED: "error", STOP: "stopping" },
  running: { DEGRADE: "degraded", STOP: "stopping" },
  degraded: { RECOVER: "running", DEGRADE: "degraded", STOP: "stopping", GIVE_UP: "error" },
  stopping: { STOPPED_OK: "completed", STOP_FAILED: "error" },
  completed: { RESET: "idle" },
  error: { RESET: "idle", STOP: "stopping" },
};

export function canAcceptStart(state: SessionState): boolean {
  return state === "idle" || state === "completed" || state === "error";
}

export function transition(state: SessionState, event: MachineEvent): SessionState {
  const next = TABLE[state][event];
  if (!next) throw new Error(`illegal session transition: ${state} + ${event}`);
  return next;
}
