import type { ParserTarget } from "../../../contracts/parser.js";

export const PHP_PARSER_ID = "tree-sitter-php";

export const PHP_LANGUAGE_WASM_FILE_NAME = "tree-sitter-php.wasm";

export const PHP_PARSER_TARGETS = [
    { language: "php", format: "php" },
] as const satisfies readonly ParserTarget[];
