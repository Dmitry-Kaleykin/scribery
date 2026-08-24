import postcss, { CssSyntaxError } from "postcss";
import scss from "postcss-scss";

import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import {
    STYLESHEET_PARSER_ID,
    STYLESHEET_PARSER_TARGETS,
} from "./constants/parser.js";
import { normalizePostCssSyntaxTree } from "./normalize-syntax-tree.js";

export class StylesheetParser implements CodeParserAdapter {
    readonly id = STYLESHEET_PARSER_ID;
    readonly targets = STYLESHEET_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        throwIfChunkingAborted(options.signal, document.path);
        this.assertSupportedTarget(document);

        try {
            const root = document.format === "scss"
                ? scss.parse(document.content, { from: document.path })
                : postcss.parse(document.content, { from: document.path });

            throwIfChunkingAborted(options.signal, document.path);

            return normalizePostCssSyntaxTree(
                root,
                document.content,
                document.path,
                this.id,
                options.signal,
            );
        } catch (error: unknown) {
            if (error instanceof ChunkingError) {
                throw error;
            }

            if (error instanceof CssSyntaxError) {
                throw new ChunkingError(
                    "parser-failure",
                    `Parser ${this.id} found invalid syntax in ${document.path}`,
                    {
                        path: document.path,
                        parserId: this.id,
                        diagnostics: [{
                            code: "stylesheet-syntax-error",
                            line: error.line,
                            column: error.column,
                        }],
                    },
                    error,
                );
            }

            throw error;
        }
    }

    private assertSupportedTarget(document: ChunkingDocument): void {
        const supported = this.targets.some(
            ({ language, format }) =>
                document.language === language && document.format === format,
        );

        if (!supported) {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                {
                    path: document.path,
                    language: document.language,
                    ...(document.format === undefined
                        ? {}
                        : { format: document.format }),
                },
            );
        }
    }
}
