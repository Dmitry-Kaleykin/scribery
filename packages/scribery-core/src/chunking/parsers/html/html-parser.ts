import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import {
    HTML_PARSER_ID,
    HTML_PARSER_TARGETS,
} from "./constants/parser.js";
import { parseHtmlSyntaxTree } from "./parse-html.js";

export class HtmlParser implements CodeParserAdapter {
    readonly id = HTML_PARSER_ID;
    readonly targets = HTML_PARSER_TARGETS;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        if (document.language !== "html" || document.format !== "html") {
            throw new ChunkingError(
                "unsupported-parser",
                `Parser ${this.id} does not support ${document.path}`,
                { path: document.path, language: document.language },
            );
        }

        return parseHtmlSyntaxTree(
            document.content,
            document.path,
            this.id,
            "html_document",
            options.signal === undefined ? {} : { signal: options.signal },
        );
    }
}
