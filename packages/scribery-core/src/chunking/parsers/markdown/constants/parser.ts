import type { ParserTarget } from "../../../contracts/parser.js";

export const MARKDOWN_PARSER_ID = "mdast-gfm-v1";

export const MARKDOWN_PARSER_TARGETS = [
    { language: "markdown", format: "markdown" },
] as const satisfies readonly ParserTarget[];
