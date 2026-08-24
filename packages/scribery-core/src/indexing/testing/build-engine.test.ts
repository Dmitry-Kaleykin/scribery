import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    CastChunkingStrategy,
    SlidingWindowChunkingStrategy,
    createInitialParserRegistry,
} from "../../chunking/index.js";
import { DefaultFileClassifier } from "../../classification/index.js";
import { DefaultDocumentDecoder } from "../../decoding/index.js";
import { DeterministicFakeEmbeddingProvider } from "../../embeddings/index.js";
import {
    createRepositoryId,
    hashBytes,
    hashText,
} from "../../metadata/index.js";
import type { PreparedSourceSnapshot } from "../../sources/index.js";
import { InMemoryStorageProvider } from "../../storage/index.js";
import { IndexBuildEngine } from "../build-engine.js";
import type {
    DocumentProcessingRuntime,
} from "../contracts/document-processing-runtime.js";
import type { IndexingPolicy } from "../contracts/policy.js";

const castPolicy: IndexingPolicy = {
    evaluate: () => ({ action: "index", strategy: "cast" }),
};
const slidingWindowPolicy: IndexingPolicy = {
    evaluate: () => ({ action: "index", strategy: "sliding-window" }),
};

describe("IndexBuildEngine", () => {
    it("builds an in-memory prepared source without filesystem or Git context", async () => {
        const bytes = new TextEncoder().encode(
            "export function answer() { return 42; }\n",
        );
        const storage = new InMemoryStorageProvider();
        const result = await new IndexBuildEngine(
            storage,
            new DeterministicFakeEmbeddingProvider(8),
            createTestRuntime(),
        ).build({
            source: snapshot("memory.ts", bytes),
            plan: {
                policy: castPolicy,
                policyIdentity: "code-only:test",
                strategies: ["cast"],
            },
        });

        assert.equal(result.discoveredFiles, 1);
        assert.equal(result.indexedDocuments, 1);
        assert.ok(result.indexedChunks > 0);
        assert.equal(result.generatedEmbeddings, result.indexedChunks);
        assert.deepEqual(
            (await storage.getBuild(result.indexBuildId))?.sourceProvenance,
            { kind: "directory", root: "/virtual" },
        );
    });

    it("uses an injected text policy and sliding-window strategy", async () => {
        const bytes = new TextEncoder().encode(
            "A plain document with enough material to produce several windows.",
        );
        const storage = new InMemoryStorageProvider();
        const result = await new IndexBuildEngine(
            storage,
            new DeterministicFakeEmbeddingProvider(8),
            createTestRuntime(),
        ).build({
            source: snapshot("notes.txt", bytes),
            plan: {
                policy: slidingWindowPolicy,
                policyIdentity: "text-and-code:test",
                strategies: ["cast", "sliding-window"],
                maximumChunkSize: 24,
                slidingWindowOverlap: 4,
            },
        });

        assert.equal(result.indexedDocuments, 1);
        assert.ok(result.indexedChunks > 1);
    });

    it("indexes project Markdown with an injected cAST runtime", async () => {
        const bytes = new TextEncoder().encode(
            "# Project\n\nUseful setup and architecture documentation.\n",
        );
        const storage = new InMemoryStorageProvider();
        const result = await new IndexBuildEngine(
            storage,
            new DeterministicFakeEmbeddingProvider(8),
            createTestRuntime(),
        ).build({
            source: snapshot("README.md", bytes),
            plan: {
                policy: castPolicy,
                policyIdentity: "code-and-markdown:test",
                strategies: ["cast"],
            },
        });

        assert.equal(result.indexedDocuments, 1);
        assert.ok(result.indexedChunks > 0);
    });
});

function createTestRuntime(): DocumentProcessingRuntime {
    const parserRegistry = createInitialParserRegistry();

    return {
        identity: "test:document-processing-v1",
        classifier: new DefaultFileClassifier(),
        decoder: new DefaultDocumentDecoder(),
        parserRegistry,
        createChunkingStrategies: ({ slidingWindowOverlap }) => [
            new CastChunkingStrategy(parserRegistry),
            new SlidingWindowChunkingStrategy({
                overlapSize: slidingWindowOverlap,
            }),
        ],
    };
}

function snapshot(
    path: string,
    bytes: Uint8Array,
): PreparedSourceSnapshot {
    const byteContentHash = hashBytes(bytes);
    return {
        scopeId: createRepositoryId("in-memory-fixture"),
        rootIdentity: ".",
        sourceIdentity: `memory:${byteContentHash}`,
        sourceSelectionHash: hashText(path),
        provenance: { kind: "directory", root: "/virtual" },
        documents: [{
            path,
            bytes,
            byteContentHash,
            revisionIdentity: byteContentHash,
        }],
        diagnostics: [],
    };
}
