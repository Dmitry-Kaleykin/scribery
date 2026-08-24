import { TreeSitterParserAdapter } from "../tree-sitter/tree-sitter-parser.js";
import {
    PYTHON_LANGUAGE_WASM_FILE_NAME,
    PYTHON_PARSER_ID,
    PYTHON_PARSER_TARGETS,
} from "./constants/parser.js";

export class PythonParser extends TreeSitterParserAdapter {
    readonly id = PYTHON_PARSER_ID;
    readonly targets = PYTHON_PARSER_TARGETS;
    protected readonly languageWasmFileName =
        PYTHON_LANGUAGE_WASM_FILE_NAME;
}
