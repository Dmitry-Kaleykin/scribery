import ts from "@typescript/typescript6";

import type { ParserTarget } from "../../../contracts/parser.js";

export const TYPESCRIPT_PARSER_ID = "typescript-compiler-v2";

export const TYPESCRIPT_PARSER_TARGETS = [
    { language: "typescript", format: "typescript" },
    { language: "typescript", format: "typescript-jsx" },
    { language: "javascript", format: "javascript" },
    { language: "javascript", format: "javascript-jsx" },
] as const satisfies readonly ParserTarget[];

export type TypeScriptParserFormat =
    (typeof TYPESCRIPT_PARSER_TARGETS)[number]["format"];

export const SCRIPT_KIND_BY_FORMAT: Readonly<
    Record<TypeScriptParserFormat, ts.ScriptKind>
> = {
    typescript: ts.ScriptKind.TS,
    "typescript-jsx": ts.ScriptKind.TSX,
    javascript: ts.ScriptKind.JS,
    "javascript-jsx": ts.ScriptKind.JSX,
};
