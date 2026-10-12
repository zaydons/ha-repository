// YAML parsing with positions (design §4.8). Turns a file's text into a small
// positioned tree (PNode) that the validator walks, plus fatal problems.
// The yaml library's own "pretty" error context is never used: it prints raw
// source lines, which may contain secrets. Excerpts are built by excerpt.ts.
import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Document, Node as YamlNode, ScalarTag } from "yaml";
import type { Problem } from "../types.ts";

export type ScalarValue = string | number | boolean | null;

interface PBase {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  /** Last line the node spans (block scalars, flow collections). */
  endLine: number;
}
export interface PScalar extends PBase {
  kind: "scalar";
  value: ScalarValue;
  /** Original source text for plain scalars (keeps "0123" when YAML reads a number). */
  source?: string;
  /** e.g. "!secret". */
  tag?: string;
}
export interface PEntry {
  key: string;
  keyLine: number;
  keyCol: number;
  value: PNode;
}
export interface PMap extends PBase {
  kind: "map";
  entries: PEntry[];
}
export interface PSeq extends PBase {
  kind: "seq";
  items: PNode[];
}
export type PNode = PScalar | PMap | PSeq;

export interface ParsedFile {
  file: string;
  /** null for an empty document. */
  root: PNode | null;
  /** Fatal parse errors (code "yaml.parse"); root is null when present. */
  errors: Problem[];
  /** Non-fatal parser warnings. */
  warnings: Problem[];
  lines: string[];
}

/** Hard cap on nodes visited while expanding aliases (billion-laughs guard). */
export const MAX_NODES = 100_000;

const SECRET_TAG: ScalarTag = {
  tag: "!secret",
  identify: () => false,
  resolve: (str: string) => str,
};

/** Rewrites for common parser messages (UX copy deck C-27). */
function rewriteMessage(code: string, raw: string): string {
  switch (code) {
    case "TAB_AS_INDENT":
      return "Tabs aren't allowed in YAML. Use spaces.";
    case "BAD_INDENT":
    case "MISSING_CHAR":
    case "UNEXPECTED_TOKEN":
      return "Bad indentation. Check the spaces before this line.";
    case "DUPLICATE_KEY":
      return "A key appears twice in the same block.";
    case "MULTIPLE_DOCS":
      return "The file contains more than one YAML document (a second ---). Keep one.";
    case "MULTILINE_IMPLICIT_KEY":
      return "A key must be on one line. Check for a missing colon or quote.";
    case "BLOCK_AS_IMPLICIT_KEY":
      return "Bad indentation. Check the spaces before this line.";
    case "ALIAS_PROPS":
    case "BAD_ALIAS":
      return "Unknown or invalid alias (*name).";
    default: {
      // The library's own messages don't quote source text when prettyErrors is off.
      const first = raw.split("\n")[0] ?? "";
      return `YAML error: ${first.slice(0, 160)}`;
    }
  }
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

class NodeBudget {
  count = 0;
  take(): void {
    this.count += 1;
    if (this.count > MAX_NODES) throw new BudgetError();
  }
}
class BudgetError extends Error {
  constructor() {
    super("too many nodes");
    this.name = "BudgetError";
  }
}

export function parseYaml(file: string, text: string): ParsedFile {
  const lines = splitLines(text);
  const lc = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, {
      lineCounter: lc,
      prettyErrors: false,
      uniqueKeys: true,
      merge: true,
      strict: true,
      customTags: [SECRET_TAG],
    });
  } catch (err) {
    return {
      file,
      root: null,
      errors: [{ severity: "error", file, code: "yaml.parse", message: rewriteMessage("", err instanceof Error ? err.message : String(err)) }],
      warnings: [],
      lines,
    };
  }

  const toProblem = (severity: "error" | "warning", e: { code: string; message: string; pos: [number, number] }): Problem => {
    const pos = lc.linePos(e.pos[0]);
    let message = rewriteMessage(e.code, e.message);
    // A tab in the indentation is the real cause of most indentation errors on that line.
    if (/^[ ]*\t/.test(lines[pos.line - 1] ?? "")) message = rewriteMessage("TAB_AS_INDENT", "");
    if (e.code === "DUPLICATE_KEY") {
      // Key names aren't secret; quote the key the parser stopped at.
      const m = /^\s*(?:-\s+)?["']?([^"':#]{1,80}?)["']?\s*:/.exec((lines[pos.line - 1] ?? "").slice(Math.max(0, pos.col - 1)));
      if (m?.[1]) message = `"${m[1].trim()}" appears twice in the same block.`;
    }
    return { severity, file, line: pos.line, col: pos.col, code: severity === "error" ? "yaml.parse" : "yaml.warning", message };
  };

  const dedupe = (ps: Problem[]) => ps.filter((p, i) => ps.findIndex((q) => q.line === p.line && q.message === p.message) === i);
  const errors = dedupe(doc.errors.map((e) => toProblem("error", e)));
  const warnings = doc.warnings.map((e) => toProblem("warning", e));
  if (errors.length > 0) return { file, root: null, errors, warnings, lines };

  const pos = (offset: number) => lc.linePos(offset);
  const budget = new NodeBudget();

  const convert = (node: unknown, stack: Set<unknown>): PNode => {
    budget.take();
    if (isAlias(node)) {
      const target = node.resolve(doc);
      if (!target || stack.has(target)) {
        const p = pos(node.range?.[0] ?? 0);
        return { kind: "scalar", value: null, line: p.line, col: p.col, endLine: p.line };
      }
      stack.add(target);
      try {
        return convert(target, stack);
      } finally {
        stack.delete(target);
      }
    }
    const yn = node as YamlNode | null | undefined;
    const range = yn?.range ?? [0, 0, 0];
    const start = pos(range[0]);
    const end = pos(Math.max(range[0], range[1] - 1));
    if (isMap(node)) {
      const entries: PEntry[] = [];
      for (const pair of node.items) {
        const keyNode = pair.key as YamlNode | null;
        const kStart = pos(keyNode?.range?.[0] ?? range[0]);
        const isMerge = isScalar(keyNode) && (typeof keyNode.value === "symbol" || keyNode.source === "<<");
        if (isMerge) {
          // `<<: *anchor` or `<<: [*a, *b]`: copy entries not already present.
          const mergeSrc = convert(pair.value, stack);
          const sources = mergeSrc.kind === "seq" ? mergeSrc.items : [mergeSrc];
          for (const src of sources) {
            if (src.kind !== "map") continue;
            for (const e of src.entries) if (!entries.some((x) => x.key === e.key)) entries.push(e);
          }
          continue;
        }
        let key: string;
        if (isScalar(keyNode)) key = keyNode.value === null || keyNode.value === undefined ? "" : String(keyNode.value);
        else key = ""; // complex keys aren't meaningful in Homepage config
        const value: PNode =
          pair.value === null || pair.value === undefined
            ? { kind: "scalar", value: null, line: kStart.line, col: kStart.col, endLine: kStart.line }
            : convert(pair.value, stack);
        const existing = entries.findIndex((x) => x.key === key);
        const entry = { key, keyLine: kStart.line, keyCol: kStart.col, value };
        if (existing >= 0) entries[existing] = entry; // explicit keys override merged ones
        else entries.push(entry);
      }
      return { kind: "map", entries, line: start.line, col: start.col, endLine: end.line };
    }
    if (isSeq(node)) {
      const items = node.items.map((it) => convert(it, stack));
      return { kind: "seq", items, line: start.line, col: start.col, endLine: end.line };
    }
    if (isScalar(node)) {
      const v = node.value;
      let value: ScalarValue;
      if (v === null || v === undefined) value = null;
      else if (typeof v === "string" || typeof v === "boolean") value = v;
      else if (typeof v === "number") value = v;
      else if (typeof v === "bigint") value = v.toString();
      else if (v instanceof Date) value = node.source ?? v.toISOString();
      else value = String(v);
      const out: PScalar = { kind: "scalar", value, line: start.line, col: start.col, endLine: end.line };
      if (typeof node.source === "string" && node.type === "PLAIN") out.source = node.source;
      if (node.tag) out.tag = node.tag;
      return out;
    }
    return { kind: "scalar", value: null, line: start.line, col: start.col, endLine: start.line };
  };

  let root: PNode | null = null;
  try {
    root = doc.contents === null ? null : convert(doc.contents, new Set());
  } catch (err) {
    if (err instanceof BudgetError) {
      return {
        file,
        root: null,
        errors: [{ severity: "error", file, code: "yaml.parse", message: "The file expands to too many entries (check for recursive aliases)." }],
        warnings,
        lines,
      };
    }
    throw err;
  }
  // A document holding only a null scalar ("~" or comments) is empty.
  if (root && root.kind === "scalar" && root.value === null) root = null;
  return { file, root, errors: [], warnings, lines };
}

/** Plain string form of a scalar: keeps the source text for numbers (e.g. "0123"). */
export function scalarText(n: PScalar): string | null {
  if (n.value === null) return null;
  if (typeof n.value === "string") return n.value;
  if (n.source !== undefined) return n.source;
  return String(n.value);
}

export function getEntry(map: PMap, key: string): PEntry | undefined {
  return map.entries.find((e) => e.key === key);
}
