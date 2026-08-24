import {
    EMBEDDING_DIAGNOSTIC_CONTENT,
    EMBEDDING_DIAGNOSTIC_INPUT_ID,
    EMBEDDING_DIAGNOSTIC_LANGUAGE,
    EMBEDDING_DIAGNOSTIC_PATH,
} from "../constants/diagnostic.js";
import type {
    EmbeddingProviderDiagnosticOptions,
    EmbeddingProviderDiagnosticResult,
} from "../contracts/diagnostic.js";
import type { EmbeddingProvider } from "../contracts/embedding.js";
import { EmbeddingService } from "../embedding-service.js";
import { EmbeddingError } from "../errors/embedding-error.js";
import { formatDocumentEmbeddingInput } from "../formatting/format-input.js";

export async function diagnoseEmbeddingProvider(
    provider: EmbeddingProvider,
    options: EmbeddingProviderDiagnosticOptions = {},
): Promise<EmbeddingProviderDiagnosticResult> {
    const input = formatDocumentEmbeddingInput(
        EMBEDDING_DIAGNOSTIC_INPUT_ID,
        {
            path: EMBEDDING_DIAGNOSTIC_PATH,
            language: EMBEDDING_DIAGNOSTIC_LANGUAGE,
            kind: "diagnostic",
            content: EMBEDDING_DIAGNOSTIC_CONTENT,
        },
        provider.identity.documentPrefix,
        provider.identity.embeddingSuffix,
    );

    try {
        const [result] = await new EmbeddingService(provider).embed([input], {
            maximumInputsPerBatch: 1,
            ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
        });

        if (result === undefined) {
            throw new EmbeddingError(
                "invalid-provider-response",
                "Embedding provider diagnostic returned no vector",
            );
        }

        return {
            provider: provider.identity.provider,
            model: provider.identity.model,
            dimensions: result.vector.length,
        };
    } catch (error: unknown) {
        if (error instanceof EmbeddingError && error.code === "cancelled") {
            throw error;
        }

        throw new EmbeddingError(
            "diagnostic-failed",
            `Embedding provider diagnostic failed for ${provider.identity.model}`,
            {
                provider: provider.identity.provider,
                model: provider.identity.model,
                expectedDimensions: provider.identity.dimensions,
            },
            error,
        );
    }
}
