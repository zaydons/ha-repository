// Internal problem record before redaction and excerpts are applied.
import type { Severity } from "../types.ts";

export interface Issue {
  severity: Severity;
  file: string;
  line?: number;
  col?: number;
  code: string;
  message: string;
  tileId?: string;
}
