import { SourcePositionIndex } from "../../metadata/index.js";
import { CHUNKING_STRATEGY } from "../../shared/index.js";
import { CHUNK_SIZE_UNIT } from "../constants/size-units.js";
import type {
    Chunk,
    ChunkingDocument,
    ChunkingOptions,
} from "../contracts/chunk.js";
import type { ChunkingStrategy } from "../contracts/strategy.js";
import type { SyntaxNode } from "../contracts/syntax-tree.js";
import { ChunkingError } from "../errors/chunking-error.js";
import { ParserRegistry } from "../parsers/registry.js";
import { throwIfChunkingAborted } from "../utils/throw-if-aborted.js";
import type {
    BoundaryAffinity,
    SourceFragment,
} from "./cast/contracts/fragment.js";
import {
    boundaryAffinityFor,
    combineBoundaryAffinities,
    compactBoundaryFragments,
} from "./cast/utils/boundary-fragments.js";
import {
    compactDanglingPrefixes,
    isDanglingPrefix,
} from "./cast/utils/dangling-prefixes.js";

interface EmitFragmentTask {
    operation: "emit";
    fragment: SourceFragment;
}

interface SplitNodeTask {
    operation: "split";
    node: SyntaxNode;
    startOffset: number;
    endOffset: number;
}

type CastTask = EmitFragmentTask | SplitNodeTask;

interface PendingSiblingGroup {
    startOffset: number;
    endOffset: number;
    kind: string | undefined;
    boundaryAffinity: BoundaryAffinity | undefined;
    nodeCount: number;
}

export class CastChunkingStrategy implements ChunkingStrategy {
    readonly id = CHUNKING_STRATEGY.CAST;
    readonly #parserRegistry: ParserRegistry;

    constructor(parserRegistry: ParserRegistry) {
        this.#parserRegistry = parserRegistry;
    }

    async chunk(
        document: ChunkingDocument,
        options: ChunkingOptions,
    ): Promise<Chunk[]> {
        validateOptions(document.path, options);
        throwIfChunkingAborted(options.signal, document.path);

        const tree = await this.#parserRegistry.parse(
            document,
            options.signal === undefined
                ? {}
                : { signal: options.signal },
        );
        const fragments = splitAndMerge(
            tree.root,
            document.content,
            options.maximumSize,
            document.path,
            options.signal,
        );

        return createChunks(document, fragments, this.id, options.signal);
    }
}

function splitAndMerge(
    root: SyntaxNode,
    content: string,
    maximumSize: number,
    path: string,
    signal?: AbortSignal,
): readonly SourceFragment[] {
    const fragments: SourceFragment[] = [];
    const pending: CastTask[] = [
        {
            operation: "split",
            node: root,
            startOffset: root.range.startOffset,
            endOffset: root.range.endOffset,
        },
    ];

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, path);

        const task = pending.pop();

        if (task === undefined) {
            break;
        }

        if (task.operation === "emit") {
            fragments.push(task.fragment);
            continue;
        }

        const size = task.endOffset - task.startOffset;

        if (size <= maximumSize || task.node.children.length === 0) {
            const boundaryAffinity = boundaryAffinityFor(
                task.node,
                task.startOffset,
                task.endOffset,
                content,
            );
            fragments.push({
                startOffset: task.startOffset,
                endOffset: task.endOffset,
                kind: task.node.type,
                ...(boundaryAffinity === undefined
                    ? {}
                    : { boundaryAffinity }),
            });
            continue;
        }

        const childTasks = createChildTasks(
            task,
            content,
            maximumSize,
            path,
            signal,
        );

        for (let index = childTasks.length - 1; index >= 0; index -= 1) {
            const childTask = childTasks[index];

            if (childTask !== undefined) {
                pending.push(childTask);
            }
        }
    }

    const boundaryCompacted = compactBoundaryFragments(
        fragments,
        maximumSize,
        path,
        signal,
    );

    return compactDanglingPrefixes(
        boundaryCompacted,
        content,
        maximumSize,
        path,
        signal,
    );
}

function createChildTasks(
    parent: SplitNodeTask,
    content: string,
    maximumSize: number,
    path: string,
    signal?: AbortSignal,
): readonly CastTask[] {
    const tasks: CastTask[] = [];
    let siblingGroup: PendingSiblingGroup | undefined;

    for (let index = 0; index < parent.node.children.length; index += 1) {
        throwIfChunkingAborted(signal, path);

        const child = parent.node.children[index];

        if (child === undefined) {
            continue;
        }

        const nextChild = parent.node.children[index + 1];
        const startOffset = index === 0
            ? parent.startOffset
            : child.range.startOffset;
        const endOffset = nextChild?.range.startOffset ?? parent.endOffset;
        const size = endOffset - startOffset;

        if (size > maximumSize) {
            const danglingPrefix = sourceFragmentFrom(siblingGroup);

            if (
                danglingPrefix !== undefined &&
                danglingPrefix.endOffset === startOffset &&
                isDanglingPrefix(danglingPrefix, content, maximumSize)
            ) {
                siblingGroup = undefined;
                tasks.push({
                    operation: "split",
                    node: child,
                    startOffset: danglingPrefix.startOffset,
                    endOffset,
                });
                continue;
            }

            appendSiblingGroup(tasks, siblingGroup);
            siblingGroup = undefined;
            tasks.push({
                operation: "split",
                node: child,
                startOffset,
                endOffset,
            });
            continue;
        }

        if (
            siblingGroup !== undefined &&
            endOffset - siblingGroup.startOffset <= maximumSize
        ) {
            siblingGroup.boundaryAffinity = combineBoundaryAffinities(
                siblingGroup.boundaryAffinity,
                boundaryAffinityFor(child, startOffset, endOffset, content),
            );
            siblingGroup.endOffset = endOffset;
            siblingGroup.nodeCount += 1;
            siblingGroup.kind = undefined;
            continue;
        }

        appendSiblingGroup(tasks, siblingGroup);
        siblingGroup = {
            startOffset,
            endOffset,
            kind: child.type,
            boundaryAffinity: boundaryAffinityFor(
                child,
                startOffset,
                endOffset,
                content,
            ),
            nodeCount: 1,
        };
    }

    appendSiblingGroup(tasks, siblingGroup);
    return tasks;
}

function appendSiblingGroup(
    tasks: CastTask[],
    siblingGroup: PendingSiblingGroup | undefined,
): void {
    const fragment = sourceFragmentFrom(siblingGroup);

    if (fragment !== undefined) {
        tasks.push({ operation: "emit", fragment });
    }
}

function sourceFragmentFrom(
    siblingGroup: PendingSiblingGroup | undefined,
): SourceFragment | undefined {
    if (siblingGroup === undefined) {
        return undefined;
    }

    return {
        startOffset: siblingGroup.startOffset,
        endOffset: siblingGroup.endOffset,
        ...(siblingGroup.nodeCount === 1 && siblingGroup.kind !== undefined
            ? { kind: siblingGroup.kind }
            : {}),
        ...(siblingGroup.boundaryAffinity === undefined
            ? {}
            : { boundaryAffinity: siblingGroup.boundaryAffinity }),
    };
}

function createChunks(
    document: ChunkingDocument,
    fragments: readonly SourceFragment[],
    strategy: "cast",
    signal?: AbortSignal,
): Chunk[] {
    const sourcePositions = new SourcePositionIndex(document.content);
    const chunks: Chunk[] = [];
    let expectedStartOffset = 0;

    for (const fragment of fragments) {
        throwIfChunkingAborted(signal, document.path);

        if (fragment.startOffset !== expectedStartOffset) {
            throw invalidChunks(
                document.path,
                "cAST fragments must provide contiguous source coverage",
                {
                    expectedStartOffset,
                    actualStartOffset: fragment.startOffset,
                },
            );
        }

        const sourceSlice = sourcePositions.createSlice(
            fragment.startOffset,
            fragment.endOffset,
        );
        chunks.push({
            content: sourceSlice.content,
            range: sourceSlice.range,
            strategy,
            ...(fragment.kind === undefined ? {} : { kind: fragment.kind }),
            ...(fragment.boundaryAffinity === undefined
                ? {}
                : { searchable: false }),
        });
        expectedStartOffset = fragment.endOffset;
    }

    if (expectedStartOffset !== document.content.length) {
        throw invalidChunks(
            document.path,
            "cAST fragments must cover the complete document",
            {
                coveredEndOffset: expectedStartOffset,
                contentLength: document.content.length,
            },
        );
    }

    return chunks;
}

function validateOptions(path: string, options: ChunkingOptions): void {
    if (
        !Number.isSafeInteger(options.maximumSize) ||
        options.maximumSize <= 0
    ) {
        throw new ChunkingError(
            "invalid-options",
            `The maximum chunk size for ${path} must be a positive safe integer`,
            { path, maximumSize: options.maximumSize },
        );
    }

    if (options.sizeUnit !== CHUNK_SIZE_UNIT.UTF_16_CODE_UNITS) {
        throw new ChunkingError(
            "invalid-options",
            `Unsupported chunk size unit for ${path}`,
            { path, sizeUnit: options.sizeUnit },
        );
    }
}

function invalidChunks(
    path: string,
    message: string,
    details: Readonly<Record<string, unknown>>,
): ChunkingError {
    return new ChunkingError(
        "invalid-chunks",
        message,
        { path, ...details },
    );
}
