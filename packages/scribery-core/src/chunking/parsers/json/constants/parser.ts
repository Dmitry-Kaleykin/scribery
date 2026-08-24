import type { ParserTarget } from "../../../contracts/parser.js";

export const JSON_PARSER_ID = "typescript-json-v2";

export const JSON_PARSER_TARGETS = [
    { language: "json", format: "json" },
] as const satisfies readonly ParserTarget[];
