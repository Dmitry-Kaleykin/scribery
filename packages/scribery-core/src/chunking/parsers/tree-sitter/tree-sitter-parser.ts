import type { Tree } from "@vscode/tree-sitter-wasm";

import type { ChunkingDocument } from "../../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
    ParserTarget,
} from "../../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../../contracts/syntax-tree.js";
import { ChunkingError } from "../../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";
import { normalizeTreeSitterSyntaxTree } from "./normalize-syntax-tree.js";
import { createTreeSitterParser } from "./runtime.js";
import { getTreeSitterParseDiagnostics } from "./utils/get-parse-diagnostics.js";

export abstract class TreeSitterParserAdapter implements CodeParserAdapter {
    abstract readonly id: string;
    abstract readonly targets: readonly ParserTarget[];
    protected abstract readonly languageWasmFileName: string;

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        throwIfChunkingAborted(options.signal, document.path);
        this.assertSupportedTarget(document);

        const parser = await createTreeSitterParser(
            this.languageWasmFileName,
        );
        let tree: Tree | null = null;

        try {
            throwIfChunkingAborted(options.signal, document.path);

            tree = parser.parse(document.content, null, {
                progressCallback: () => options.signal?.aborted === true,
            });

            throwIfChunkingAborted(options.signal, document.path);

            if (tree === null) {
                throw new ChunkingError(
                    "parser-failure",
                    `Parser ${this.id} did not produce a syntax tree for ${document.path}`,
                    { path: document.path, parserId: this.id },
                );
            }

            const rootNode = tree.rootNode;

            if (rootNode.hasError) {
                throw new ChunkingError(
                    "parser-failure",
                    `Parser ${this.id} found invalid syntax in ${document.path}`,
                    {
                        path: document.path,
                        parserId: this.id,
                        diagnostics: getTreeSitterParseDiagnostics(
                            rootNode,
                            document.path,
                            options.signal,
                        ),
                    },
                );
            }

            return normalizeTreeSitterSyntaxTree(
                rootNode,
                document.content,
                document.path,
                this.id,
                options.signal,
            );
        } finally {
            tree?.delete();
            parser.delete();
        }
    }

    private assertSupportedTarget(document: ChunkingDocument): void {
        const supportsDocument = this.targets.some(
            ({ language, format }) =>
                document.language === language && document.format === format,
        );

        if (!supportsDocument) {
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
