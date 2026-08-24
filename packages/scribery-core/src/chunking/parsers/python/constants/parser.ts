import type { ParserTarget } from "../../../contracts/parser.js";

export const PYTHON_PARSER_ID = "tree-sitter-python";

export const PYTHON_LANGUAGE_WASM_FILE_NAME = "tree-sitter-python.wasm";

export const PYTHON_PARSER_TARGETS = [
    { language: "python", format: "python" },
    { language: "python", format: "python-stub" },
] as const satisfies readonly ParserTarget[];
