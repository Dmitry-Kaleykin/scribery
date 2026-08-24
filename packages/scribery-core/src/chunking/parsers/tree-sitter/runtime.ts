import { createRequire } from "node:module";

import type {
    Language,
    Parser,
} from "@vscode/tree-sitter-wasm";

import {
    TREE_SITTER_RUNTIME_WASM_FILE_NAME,
    TREE_SITTER_WASM_PACKAGE,
} from "./constants/runtime.js";

interface TreeSitterRuntimeModule {
    Language: {
        load(path: string): Promise<Language>;
    };
    Parser: {
        init(options: {
            locateFile(file: string, folder: string): string;
        }): Promise<void>;
        new (): Parser;
    };
}

const require = createRequire(import.meta.url);
const treeSitterRuntime = require(
    TREE_SITTER_WASM_PACKAGE,
) as TreeSitterRuntimeModule;
const languageByWasmFileName = new Map<string, Promise<Language>>();
let runtimeInitialization: Promise<void> | undefined;

export async function createTreeSitterParser(
    languageWasmFileName: string,
): Promise<Parser> {
    await initializeTreeSitterRuntime();

    let language = languageByWasmFileName.get(languageWasmFileName);

    if (language === undefined) {
        language = treeSitterRuntime.Language.load(
            resolveWasmFile(languageWasmFileName),
        );
        languageByWasmFileName.set(languageWasmFileName, language);
    }

    const loadedLanguage = await language;
    const parser = new treeSitterRuntime.Parser();

    try {
        parser.setLanguage(loadedLanguage);
    } catch (error: unknown) {
        parser.delete();
        throw error;
    }

    return parser;
}

function initializeTreeSitterRuntime(): Promise<void> {
    runtimeInitialization ??= treeSitterRuntime.Parser.init({
        locateFile: () => resolveWasmFile(TREE_SITTER_RUNTIME_WASM_FILE_NAME),
    });

    return runtimeInitialization;
}

function resolveWasmFile(fileName: string): string {
    return require.resolve(
        `${TREE_SITTER_WASM_PACKAGE}/wasm/${fileName}`,
    );
}
