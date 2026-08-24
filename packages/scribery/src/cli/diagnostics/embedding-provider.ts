import {
    diagnoseEmbeddingProvider,
    type EmbeddingProvider,
} from "scribery-core";

export async function runCliEmbeddingProviderDiagnostic(
    provider: EmbeddingProvider,
): Promise<void> {
    console.error(
        `[index] Checking embedding model: ${provider.identity.model} ` +
        `(${provider.identity.dimensions} dimensions)...`,
    );

    const result = await diagnoseEmbeddingProvider(provider);

    console.error(
        `[index] Embedding model ready: ${result.model} ` +
        `(${result.dimensions} dimensions)`,
    );
}
