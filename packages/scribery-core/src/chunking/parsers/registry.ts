import type { ChunkingDocument } from "../contracts/chunk.js";
import type {
    CodeParserAdapter,
    ParserOptions,
    ParserTarget,
} from "../contracts/parser.js";
import type { NormalizedSyntaxTree } from "../contracts/syntax-tree.js";
import { ChunkingError } from "../errors/chunking-error.js";
import { throwIfChunkingAborted } from "../utils/throw-if-aborted.js";
import { validateChunkingDocument } from "../validation/document.js";
import { validateNormalizedSyntaxTree } from "../validation/syntax-tree.js";

interface RegisteredParser {
    id: string;
    adapter: CodeParserAdapter;
}

export class ParserRegistry {
    readonly #parsersById = new Map<string, RegisteredParser>();
    readonly #parsersByTarget = new Map<string, RegisteredParser>();

    constructor(adapters: readonly CodeParserAdapter[] = []) {
        for (const adapter of adapters) {
            this.register(adapter);
        }
    }

    register(adapter: CodeParserAdapter): void {
        validateAdapter(adapter);

        if (this.#parsersById.has(adapter.id)) {
            throw new ChunkingError(
                "duplicate-parser",
                `Parser ${adapter.id} is already registered`,
                { parserId: adapter.id },
            );
        }

        const targetKeys = adapter.targets.map((target) => {
            const normalizedTarget = normalizeTarget(target, "invalid-parser");
            return parserTargetKey(normalizedTarget);
        });
        const duplicateTargetKey = targetKeys.find(
            (key, index) => targetKeys.indexOf(key) !== index,
        );

        if (duplicateTargetKey !== undefined) {
            throw new ChunkingError(
                "duplicate-parser-target",
                `Parser ${adapter.id} declares the same target more than once`,
                { parserId: adapter.id, targetKey: duplicateTargetKey },
            );
        }

        for (const targetKey of targetKeys) {
            const existing = this.#parsersByTarget.get(targetKey);

            if (existing !== undefined) {
                throw new ChunkingError(
                    "duplicate-parser-target",
                    `Parser target ${targetKey} is already registered`,
                    {
                        parserId: adapter.id,
                        existingParserId: existing.id,
                        targetKey,
                    },
                );
            }
        }

        const registeredParser = { id: adapter.id, adapter };
        this.#parsersById.set(adapter.id, registeredParser);

        for (const targetKey of targetKeys) {
            this.#parsersByTarget.set(targetKey, registeredParser);
        }
    }

    canParse(target: ParserTarget): boolean {
        return this.#resolveRegisteredParser(target) !== undefined;
    }

    parserIds(): readonly string[] {
        return [...this.#parsersById.keys()].sort();
    }

    resolve(target: ParserTarget): CodeParserAdapter | undefined {
        return this.#resolveRegisteredParser(target)?.adapter;
    }

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        validateChunkingDocument(document);
        throwIfChunkingAborted(options.signal, document.path);

        const registeredParser = this.#resolveRegisteredParser(document);

        if (registeredParser === undefined) {
            throw new ChunkingError(
                "unsupported-parser",
                `No parser is registered for ${document.path}`,
                {
                    path: document.path,
                    language: document.language,
                    ...(document.format === undefined
                        ? {}
                        : { format: document.format }),
                },
            );
        }

        let tree: NormalizedSyntaxTree;

        try {
            tree = await registeredParser.adapter.parse(document, options);
        } catch (error: unknown) {
            throwIfChunkingAborted(options.signal, document.path);

            if (error instanceof ChunkingError) {
                throw error;
            }

            throw new ChunkingError(
                "parser-failure",
                `Parser ${registeredParser.id} failed for ${document.path}`,
                { path: document.path, parserId: registeredParser.id },
                error,
            );
        }

        throwIfChunkingAborted(options.signal, document.path);

        try {
            validateNormalizedSyntaxTree(
                document,
                tree,
                registeredParser.id,
            );
        } catch (error: unknown) {
            if (error instanceof ChunkingError) {
                throw error;
            }

            throw new ChunkingError(
                "invalid-syntax-tree",
                `Parser ${registeredParser.id} returned an invalid syntax tree`,
                { path: document.path, parserId: registeredParser.id },
                error,
            );
        }

        return tree;
    }

    #resolveRegisteredParser(
        target: ParserTarget,
    ): RegisteredParser | undefined {
        const normalizedTarget = normalizeTarget(target, "invalid-document");
        const exactParser = this.#parsersByTarget.get(
            parserTargetKey(normalizedTarget),
        );

        if (exactParser !== undefined || normalizedTarget.format === undefined) {
            return exactParser;
        }

        return this.#parsersByTarget.get(
            parserTargetKey({ language: normalizedTarget.language }),
        );
    }
}

function validateAdapter(adapter: CodeParserAdapter): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(adapter.id)) {
        throw new ChunkingError(
            "invalid-parser",
            "Parser ID must be a lowercase kebab-case identifier",
            { parserId: adapter.id },
        );
    }

    if (!Array.isArray(adapter.targets) || adapter.targets.length === 0) {
        throw new ChunkingError(
            "invalid-parser",
            `Parser ${adapter.id} must declare at least one target`,
            { parserId: adapter.id },
        );
    }

    if (typeof adapter.parse !== "function") {
        throw new ChunkingError(
            "invalid-parser",
            `Parser ${adapter.id} must implement parse`,
            { parserId: adapter.id },
        );
    }
}

function normalizeTarget(
    target: ParserTarget,
    errorCode: "invalid-document" | "invalid-parser",
): ParserTarget {
    if (typeof target.language !== "string" || target.language.trim().length === 0) {
        throw new ChunkingError(
            errorCode,
            "Parser target language must not be empty",
        );
    }

    if (
        target.format !== undefined &&
        (typeof target.format !== "string" || target.format.trim().length === 0)
    ) {
        throw new ChunkingError(
            errorCode,
            "Parser target format must not be empty",
            { language: target.language },
        );
    }

    return {
        language: target.language.trim().toLowerCase(),
        ...(target.format === undefined
            ? {}
            : { format: target.format.trim().toLowerCase() }),
    };
}

function parserTargetKey(target: ParserTarget): string {
    return JSON.stringify([target.language, target.format ?? null]);
}
