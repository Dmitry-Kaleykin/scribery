import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH,
    INDEXING_ACTION,
    INDEXING_DECISION_REASON,
    INDEXING_STRATEGY,
    IndexingPolicyError,
    OVERSIZED_FILE_ACTION,
    CONTENT_KIND,
    FILE_TRAIT,
} from "scribery-core";
import type {
    CodeOnlyIndexingPolicyOptions,
    FileClassification,
    FileTrait,
    IndexingPolicyInput,
} from "scribery-core";
import {
    CodeOnlyIndexingPolicy,
} from "../index.js";

function classification(
    overrides: Partial<FileClassification> = {},
): FileClassification {
    return {
        contentKind: CONTENT_KIND.TEXT,
        language: "typescript",
        format: "typescript",
        confidence: 0.98,
        evidence: [],
        traits: [],
        ...overrides,
    };
}

function input(
    fileClassification: FileClassification,
    overrides: Partial<IndexingPolicyInput> = {},
): IndexingPolicyInput {
    return {
        path: "src/example.ts",
        byteLength: 128,
        classification: fileClassification,
        capabilities: { canChunkWithCast: true },
        ...overrides,
    };
}

function expectPolicyError(
    error: unknown,
    code: IndexingPolicyError["code"],
): boolean {
    assert.ok(error instanceof IndexingPolicyError);
    assert.equal(error.code, code);
    return true;
}

describe("CodeOnlyIndexingPolicy", () => {
    it("indexes accepted code with the cAST strategy", () => {
        const policy = new CodeOnlyIndexingPolicy();

        assert.deepEqual(policy.evaluate(input(classification())), {
            action: INDEXING_ACTION.INDEX,
            strategy: INDEXING_STRATEGY.CAST,
        });
    });

    it("skips binary and unknown content before other checks", () => {
        const policy = new CodeOnlyIndexingPolicy();

        assert.deepEqual(
            policy.evaluate(
                input(
                    classification({
                        contentKind: CONTENT_KIND.BINARY,
                        traits: [FILE_TRAIT.GENERATED],
                    }),
                    { capabilities: { canChunkWithCast: false } },
                ),
            ),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.BINARY_CONTENT,
            },
        );
        assert.deepEqual(
            policy.evaluate(
                input(classification({ contentKind: CONTENT_KIND.UNKNOWN })),
            ),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.UNKNOWN_CONTENT,
            },
        );
    });

    it("skips empty code and plain-text documents", () => {
        const policy = new CodeOnlyIndexingPolicy();

        assert.deepEqual(
            policy.evaluate(
                input(classification({ traits: [FILE_TRAIT.EMPTY] })),
            ),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.EMPTY_FILE,
            },
        );
        assert.deepEqual(
            policy.evaluate(
                input(
                    {
                        contentKind: CONTENT_KIND.TEXT,
                        confidence: 0.98,
                        evidence: [],
                        traits: [],
                    },
                ),
            ),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.PLAIN_TEXT,
            },
        );
    });

    it("skips code when no cAST parser is available", () => {
        const policy = new CodeOnlyIndexingPolicy();

        assert.deepEqual(
            policy.evaluate(
                input(classification(), {
                    capabilities: { canChunkWithCast: false },
                }),
            ),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.CAST_PARSER_UNAVAILABLE,
            },
        );
    });

    it("skips every trait excluded by the default policy", () => {
        const policy = new CodeOnlyIndexingPolicy();
        const excludedTraits: readonly FileTrait[] = [
            FILE_TRAIT.GENERATED,
            FILE_TRAIT.MINIFIED,
            FILE_TRAIT.LOCKFILE,
            FILE_TRAIT.CONFIGURATION,
        ];

        for (const trait of excludedTraits) {
            assert.deepEqual(
                policy.evaluate(input(classification({ traits: [trait] }))),
                {
                    action: INDEXING_ACTION.SKIP,
                    reason: INDEXING_DECISION_REASON.EXCLUDED_TRAIT,
                    trait,
                },
            );
        }
    });

    it("indexes parseable documentation by default", () => {
        const policy = new CodeOnlyIndexingPolicy();

        assert.deepEqual(
            policy.evaluate(
                input(classification({ traits: [FILE_TRAIT.DOCUMENTATION] })),
            ),
            {
                action: INDEXING_ACTION.INDEX,
                strategy: INDEXING_STRATEGY.CAST,
            },
        );
    });

    it("uses canonical trait precedence regardless of classification order", () => {
        const policy = new CodeOnlyIndexingPolicy();
        const fileClassification = classification({
            traits: [FILE_TRAIT.DOCUMENTATION, FILE_TRAIT.GENERATED],
        });

        assert.deepEqual(policy.evaluate(input(fileClassification)), {
            action: INDEXING_ACTION.SKIP,
            reason: INDEXING_DECISION_REASON.EXCLUDED_TRAIT,
            trait: FILE_TRAIT.GENERATED,
        });
    });

    it("allows callers to include traits excluded by default", () => {
        const policy = new CodeOnlyIndexingPolicy({ excludedTraits: [] });

        assert.deepEqual(
            policy.evaluate(
                input(
                    classification({
                        traits: [FILE_TRAIT.GENERATED, FILE_TRAIT.TEST],
                    }),
                ),
            ),
            {
                action: INDEXING_ACTION.INDEX,
                strategy: INDEXING_STRATEGY.CAST,
            },
        );
    });

    it("skips oversized code by default and records both sizes", () => {
        const policy = new CodeOnlyIndexingPolicy();
        const byteLength = DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH + 1;

        assert.deepEqual(
            policy.evaluate(input(classification(), { byteLength })),
            {
                action: INDEXING_ACTION.SKIP,
                reason: INDEXING_DECISION_REASON.FILE_TOO_LARGE,
                byteLength,
                maxByteLength: DEFAULT_MAX_INDEXABLE_FILE_BYTE_LENGTH,
            },
        );
    });

    it("can reject oversized code in strict builds", () => {
        const policy = new CodeOnlyIndexingPolicy({
            maxByteLength: 10,
            oversizedFileAction: OVERSIZED_FILE_ACTION.REJECT,
        });

        assert.deepEqual(
            policy.evaluate(input(classification(), { byteLength: 11 })),
            {
                action: INDEXING_ACTION.REJECT,
                reason: INDEXING_DECISION_REASON.FILE_TOO_LARGE,
                byteLength: 11,
                maxByteLength: 10,
            },
        );
    });

    it("accepts a file exactly at the configured size limit", () => {
        const policy = new CodeOnlyIndexingPolicy({ maxByteLength: 128 });

        assert.equal(
            policy.evaluate(input(classification(), { byteLength: 128 })).action,
            INDEXING_ACTION.INDEX,
        );
    });

    it("does not mutate classification or caller-owned options", () => {
        const excludedTraits: FileTrait[] = [FILE_TRAIT.GENERATED];
        const options: CodeOnlyIndexingPolicyOptions = { excludedTraits };
        const policy = new CodeOnlyIndexingPolicy(options);
        excludedTraits.length = 0;

        const fileClassification = classification({
            traits: [FILE_TRAIT.GENERATED],
        });
        const before = structuredClone(fileClassification);

        assert.equal(
            policy.evaluate(input(fileClassification)).action,
            INDEXING_ACTION.SKIP,
        );
        assert.deepEqual(fileClassification, before);
    });

    it("rejects invalid options and inputs with structured errors", () => {
        assert.throws(
            () => new CodeOnlyIndexingPolicy({ maxByteLength: -1 }),
            (error: unknown) => expectPolicyError(error, "invalid-options"),
        );
        assert.throws(
            () =>
                new CodeOnlyIndexingPolicy({
                    excludedTraits: [
                        "vendored" as unknown as FileTrait,
                    ],
                }),
            (error: unknown) => expectPolicyError(error, "invalid-options"),
        );

        const policy = new CodeOnlyIndexingPolicy();

        assert.throws(
            () => policy.evaluate(input(classification(), { path: "" })),
            (error: unknown) => expectPolicyError(error, "invalid-input"),
        );
        assert.throws(
            () =>
                policy.evaluate(
                    input(classification(), {
                        capabilities: {
                            canChunkWithCast: "yes" as unknown as boolean,
                        },
                    }),
                ),
            (error: unknown) => expectPolicyError(error, "invalid-input"),
        );
    });
});
