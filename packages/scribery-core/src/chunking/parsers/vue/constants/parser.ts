import type { ParserTarget } from "../../../contracts/parser.js";

export const VUE_PARSER_ID = "vue-composite";

export const VUE_PARSER_TARGETS = [
    { language: "vue", format: "vue" },
] as const satisfies readonly ParserTarget[];
