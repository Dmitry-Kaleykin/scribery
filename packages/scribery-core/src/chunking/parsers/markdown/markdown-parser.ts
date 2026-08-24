import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import {
    MARKDOWN_PARSER_ID,
    MARKDOWN_PARSER_TARGETS,
} from "./constants/parser.js";
import { normalizeMarkdownSyntaxTree } from "./normalize-syntax-tree.js";

export class MarkdownParser implements CodeParserAdapter {
    readonly id = MARKDOWN_PARSER_ID;
    readonly targets = MARKDOWN_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        throwIfChunkingAborted(options.signal, document.path);

        if (
            document.language !== "markdown" ||
            document.format !== "markdown"
        ) {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                { path: document.path, language: document.language },
            );
        }

        const root = fromMarkdown(document.content, {
            extensions: [gfm()],
            mdastExtensions: [gfmFromMarkdown()],
        });

        throwIfChunkingAborted(options.signal, document.path);

        return normalizeMarkdownSyntaxTree(
            root,
            document.content,
            document.path,
            this.id,
            options.signal,
        );
    }
}
