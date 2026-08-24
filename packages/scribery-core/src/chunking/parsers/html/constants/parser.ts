import type { ParserTarget } from "../../../contracts/parser.js";

export const HTML_PARSER_ID = "parse5-html";

export const HTML_PARSER_TARGETS = [
    { language: "html", format: "html" },
] as const satisfies readonly ParserTarget[];

export const IGNORED_HTML_PARSE_ERROR_CODES = new Set([
    "missing-doctype",
    "non-conforming-doctype",
]);
