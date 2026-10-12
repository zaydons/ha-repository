// Shared result shape for the status checkers (design §4.7). The scheduler
// adds checkedAt / downSince to turn an outcome into a StatusResult.
import type { StatusResult } from "../types.ts";

export type CheckOutcome = Omit<StatusResult, "checkedAt" | "downSince">;

/** Our own failure to run a check (not the target's fault): pill "Unknown". */
export function checkFailed(kind: CheckOutcome["kind"], detail: string, host?: string): CheckOutcome {
  const out: CheckOutcome = { state: "unknown", kind, reason: "check_failed", detail };
  if (host) out.host = host;
  return out;
}
