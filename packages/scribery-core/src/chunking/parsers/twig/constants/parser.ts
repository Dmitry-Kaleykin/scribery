import type { ParserTarget } from "../../../contracts/parser.js";

export const TWIG_PARSER_ID = "twig-composite";

export const TWIG_PARSER_TARGETS = [
    { language: "twig", format: "twig" },
] as const satisfies readonly ParserTarget[];
