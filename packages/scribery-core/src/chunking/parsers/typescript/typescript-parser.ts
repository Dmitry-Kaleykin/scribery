import ts from "@typescript/typescript6";

import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import {
    SCRIPT_KIND_BY_FORMAT,
    TYPESCRIPT_PARSER_ID,
    TYPESCRIPT_PARSER_TARGETS,
} from "./constants/parser.js";
import { normalizeTypeScriptSyntaxTree } from "./normalize-syntax-tree.js";
import { getParseDiagnostics } from "./utils/get-parse-diagnostics.js";

export class TypeScriptParser implements CodeParserAdapter {
    readonly id = TYPESCRIPT_PARSER_ID;
    readonly targets = TYPESCRIPT_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        throwIfChunkingAborted(options.signal, document.path);

        const scriptKind = scriptKindFor(document);
        const sourceFile = ts.createSourceFile(
            document.path,
            document.content,
            ts.ScriptTarget.Latest,
            false,
            scriptKind,
        );
        const diagnostics = getParseDiagnostics(sourceFile);

        throwIfChunkingAborted(options.signal, document.path);

        if (diagnostics.length > 0) {
            throw new ChunkingError(
                "parser-failure",
                `Parser ${this.id} found invalid syntax in ${document.path}`,
                {
                    path: document.path,
                    parserId: this.id,
                    diagnostics: diagnostics.map((diagnostic) => ({
                        code: diagnostic.code,
                        ...(diagnostic.start === undefined
                            ? {}
                            : { startOffset: diagnostic.start }),
                        ...(diagnostic.length === undefined
                            ? {}
                            : { length: diagnostic.length }),
                    })),
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

function scriptKindFor(document: ChunkingDocument): ts.ScriptKind {
    const target = TYPESCRIPT_PARSER_TARGETS.find(
        ({ language, format }) =>
            document.language === language && document.format === format,
    );

    if (target === undefined) {
        throw new ChunkingError(
            "unsupported-parser",
            `Parser ${TYPESCRIPT_PARSER_ID} does not support ${document.path}`,
            {
                path: document.path,
                language: document.language,
                ...(document.format === undefined
                    ? {}
                    : { format: document.format }),
            },
        );
    }

    return SCRIPT_KIND_BY_FORMAT[target.format];
}
