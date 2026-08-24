import type { ParserTarget } from "../../../contracts/parser.js";

export const STYLESHEET_PARSER_ID = "postcss-stylesheet";

export const STYLESHEET_PARSER_TARGETS = [
    { language: "css", format: "css" },
    { language: "scss", format: "scss" },
] as const satisfies readonly ParserTarget[];
