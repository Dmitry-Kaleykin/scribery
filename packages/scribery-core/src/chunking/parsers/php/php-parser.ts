import { TreeSitterParserAdapter } from "../tree-sitter/tree-sitter-parser.js";
import {
    PHP_LANGUAGE_WASM_FILE_NAME,
    PHP_PARSER_ID,
    PHP_PARSER_TARGETS,
} from "./constants/parser.js";

export class PhpParser extends TreeSitterParserAdapter {
    readonly id = PHP_PARSER_ID;
    readonly targets = PHP_PARSER_TARGETS;
    protected readonly languageWasmFileName = PHP_LANGUAGE_WASM_FILE_NAME;
}
