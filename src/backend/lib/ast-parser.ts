// AST parser helpers for Bundle 2 (Coding Cache).
// Uses @babel/parser for JS/TS/JSX parsing — pure JS, no native deps.

import { parse } from "@babel/parser";
import type { File } from "@babel/types";

export interface DependencyTree {
  imports: string[];
  exports: string[];
  depth: number;
}

export interface SyntaxReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  lines: number;
}

// Extract all static import/export sources from source code.
export async function buildDependencyTree(code: string, _filename = "input.ts"): Promise<DependencyTree> {
  let ast: File;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    });
  } catch {
    return { imports: [], exports: [], depth: 0 };
  }

  const imports: string[] = [];
  const exports: string[] = [];

  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      imports.push(node.source.value);
    } else if (
      node.type === "ExportNamedDeclaration" && node.source
    ) {
      exports.push(node.source.value);
    } else if (node.type === "ExportAllDeclaration") {
      exports.push(node.source.value);
    }
  }

  return { imports, exports, depth: imports.length };
}

// Validate syntax via @babel/parser, collecting parse errors.
export async function checkSyntax(code: string): Promise<SyntaxReport> {
  const lines = code.split("\n").length;
  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    });
    const errors = (ast.errors ?? []).map((e) => `${e.reasonCode} (pos ${e.pos})`);
    return { valid: errors.length === 0, errors, warnings: [], lines };
  } catch (err) {
    return { valid: false, errors: [String(err)], warnings: [], lines };
  }
}

// Strip comments and collapse whitespace — pure string ops, no AST needed.
export function compressTokens(code: string): { compressed: string; ratio: number } {
  const original = code.length;
  const compressed = code
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    compressed,
    ratio: original > 0 ? Math.round((1 - compressed.length / original) * 100) : 0,
  };
}
