import {
    CONTENT_KIND,
    DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH,
    FILE_TRAIT,
    FILE_TRAIT_ORDER,
    INDEXING_ACTION,
    INDEXING_DECISION_REASON,
    INDEXING_STRATEGY,
    IndexingPolicyError,
    OVERSIZED_FILE_ACTION,
    type CodeOnlyIndexingPolicyOptions,
    type FileTrait,
    type IndexingDecision,
    type IndexingPolicy,
    type IndexingPolicyInput,
    type OversizedFileAction,
} from "scribery-core";
import { DEFAULT_CODE_ONLY_EXCLUDED_TRAITS } from "../defaults.js";

const KNOWN_FILE_TRAITS = new Set<FileTrait>(FILE_TRAIT_ORDER);

export class CodeOnlyIndexingPolicy implements IndexingPolicy {
    readonly #maxByteLength: number;
    readonly #excludedTraits: ReadonlySet<FileTrait>;
    readonly #oversizedFileAction: OversizedFileAction;

    constructor(options: CodeOnlyIndexingPolicyOptions = {}) {
        this.#maxByteLength =
            options.maxByteLength ?? DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH;
        this.#oversizedFileAction =
            options.oversizedFileAction ?? OVERSIZED_FILE_ACTION.SKIP;

        validateOptions(
            this.#maxByteLength,
            this.#oversizedFileAction,
            options.excludedTraits,
        );

        this.#excludedTraits = new Set(
            options.excludedTraits ?? DEFAULT_CODE_ONLY_EXCLUDED_TRAITS,
        );
    }

    evaluate(input: IndexingPolicyInput): IndexingDecision {
        validateInput(input);

        if (input.classification.contentKind === CONTENT_KIND.BINARY) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.BINARY_CONTENT,
            };
        }

        if (input.classification.contentKind === CONTENT_KIND.UNKNOWN) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.UNKNOWN_CONTENT,
            };
        }

        if (
            input.byteLength === 0 ||
            input.classification.traits.includes(FILE_TRAIT.EMPTY)
        ) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.EMPTY_FILE,
            };
        }

        if (input.classification.language === undefined) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.PLAIN_TEXT,
            };
        }

        const excludedTrait = FILE_TRAIT_ORDER.find(
            (trait) =>
                this.#excludedTraits.has(trait) &&
                input.classification.traits.includes(trait),
        );

        if (excludedTrait !== undefined) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.EXCLUDED_TRAIT,
                trait: excludedTrait,
            };
        }

        if (input.byteLength > this.#maxByteLength) {
            return {
                action: this.#oversizedFileAction,
                reason: INDEXING_DECISION_REASON.FILE_TOO_LARGE,
                byteLength: input.byteLength,
                maxByteLength: this.#maxByteLength,
            };
        }

        if (!input.capabilities.canChunkWithCast) {
            return {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.CAST_PARSER_UNAVAILABLE,
            };
        }

        return {
            action: INDEXING_ACTION.INDEX,
            strategy: INDEXING_STRATEGY.CAST,
        };
    }
}

function validateOptions(
    maxByteLength: number,
    oversizedFileAction: OversizedFileAction,
    excludedTraits: readonly FileTrait[] | undefined,
): void {
    if (!Number.isSafeInteger(maxByteLength) || maxByteLength < 0) {
        throw new IndexingPolicyError(
            "invalid-options",
            "maxByteLength must be a non-negative safe integer",
        );
    }

    if (
        oversizedFileAction !== OVERSIZED_FILE_ACTION.SKIP &&
        oversizedFileAction !== OVERSIZED_FILE_ACTION.REJECT
    ) {
        throw new IndexingPolicyError(
            "invalid-options",
            `Unsupported oversized-file action ${JSON.stringify(oversizedFileAction)}`,
        );
    }

    if (excludedTraits !== undefined && !Array.isArray(excludedTraits)) {
        throw new IndexingPolicyError(
            "invalid-options",
            "excludedTraits must be an array",
        );
    }

    for (const trait of excludedTraits ?? []) {
        if (!KNOWN_FILE_TRAITS.has(trait)) {
            throw new IndexingPolicyError(
                "invalid-options",
                `Unknown excluded file trait ${JSON.stringify(trait)}`,
            );
        }
    }
}

function validateInput(input: IndexingPolicyInput): void {
    if (input.path.trim().length === 0) {
        throw new IndexingPolicyError(
            "invalid-input",
            "Indexing-policy path must not be empty",
            { path: input.path },
        );
    }

    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
        throw new IndexingPolicyError(
            "invalid-input",
            `Byte length for ${input.path} must be a non-negative safe integer`,
            { path: input.path },
        );
    }

    if (
        input.classification.contentKind !== CONTENT_KIND.TEXT &&
        input.classification.contentKind !== CONTENT_KIND.BINARY &&
        input.classification.contentKind !== CONTENT_KIND.UNKNOWN
    ) {
        throw new IndexingPolicyError(
            "invalid-input",
            `Classification for ${input.path} has an invalid content kind`,
            { path: input.path },
        );
    }

    if (
        !Array.isArray(input.classification.traits) ||
        input.classification.traits.some((trait) => !KNOWN_FILE_TRAITS.has(trait))
    ) {
        throw new IndexingPolicyError(
            "invalid-input",
            `Classification for ${input.path} has invalid file traits`,
            { path: input.path },
        );
    }

    if (
        input.classification.language !== undefined &&
        input.classification.language.trim().length === 0
    ) {
        throw new IndexingPolicyError(
            "invalid-input",
            `Classification language for ${input.path} must not be empty`,
            { path: input.path },
        );
    }

    if (typeof input.capabilities.canChunkWithCast !== "boolean") {
        throw new IndexingPolicyError(
            "invalid-input",
            `cAST capability for ${input.path} must be a boolean`,
            { path: input.path },
        );
    }
}
