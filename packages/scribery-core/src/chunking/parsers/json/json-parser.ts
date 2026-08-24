import ts from "@typescript/typescript6";

import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import { normalizeTypeScriptSyntaxTree } from "../typescript/normalize-syntax-tree.js";
import { getParseDiagnostics } from "../typescript/utils/get-parse-diagnostics.js";
import {
    JSON_PARSER_ID,
    JSON_PARSER_TARGETS,
} from "./constants/parser.js";

export class JsonParser implements CodeParserAdapter {
    readonly id = JSON_PARSER_ID;
    readonly targets = JSON_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        throwIfChunkingAborted(options.signal, document.path);

        if (document.language !== "json" || document.format !== "json") {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                { path: document.path, language: document.language },
            );
        }

        const sourceFile = ts.parseJsonText(document.path, document.content);
        const diagnostics = getParseDiagnostics(sourceFile);
        let strictJson = true;

        try {
            JSON.parse(document.content);
        } catch {
            strictJson = false;
        }

        if (diagnostics.length > 0 || !strictJson) {
            throw new ChunkingError(
                "parser-failure",
                `Parser ${this.id} found invalid syntax in ${document.path}`,
                {
                    path: document.path,
                    parserId: this.id,
                    diagnostics: diagnostics.length > 0
                        ? diagnostics.map((diagnostic) => ({
                            code: diagnostic.code,
                            startOffset: diagnostic.start,
                            length: diagnostic.length,
                        }))
                        : [{ code: "invalid-json" }],
                },
            );
        }

        return normalizeTypeScriptSyntaxTree(
            sourceFile,
            document.content,
            this.id,
            options.signal,
        );
    }
}
