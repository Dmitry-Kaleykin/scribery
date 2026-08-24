import {
    CONTENT_KIND,
    DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH,
    FILE_TRAIT,
    IndexingPolicyError,
    type IndexingDecision,
    type IndexingPolicy,
    type IndexingPolicyInput,
} from "scribery-core";

export interface TextAndCodeIndexingPolicyOptions {
    maxByteLength?: number;
}

export class TextAndCodeIndexingPolicy implements IndexingPolicy {
    readonly #maxByteLength: number;

    constructor(options: TextAndCodeIndexingPolicyOptions = {}) {
        this.#maxByteLength = options.maxByteLength ??
            DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH;

        if (!Number.isSafeInteger(this.#maxByteLength) || this.#maxByteLength < 0) {
            throw new IndexingPolicyError(
                "invalid-options",
                "maxByteLength must be a non-negative safe integer",
            );
        }
    }

    evaluate(input: IndexingPolicyInput): IndexingDecision {
        if (input.path.trim().length === 0 || input.byteLength < 0) {
            throw new IndexingPolicyError(
                "invalid-input",
                "Text-and-code indexing input is invalid",
                { path: input.path },
            );
        }

        if (input.classification.contentKind === CONTENT_KIND.BINARY) {
            return { action: "skip", reason: "binary-content" };
        }

        if (input.classification.contentKind === CONTENT_KIND.UNKNOWN) {
            return { action: "skip", reason: "unknown-content" };
        }

        if (
            input.byteLength === 0 ||
            input.classification.traits.includes(FILE_TRAIT.EMPTY)
        ) {
            return { action: "skip", reason: "empty-file" };
        }

        if (input.byteLength > this.#maxByteLength) {
            return {
                action: "skip",
                reason: "file-too-large",
                byteLength: input.byteLength,
                maxByteLength: this.#maxByteLength,
            };
        }

        return {
            action: "index",
            strategy: input.capabilities.canChunkWithCast
                ? "cast"
                : "sliding-window",
        };
    }
}
