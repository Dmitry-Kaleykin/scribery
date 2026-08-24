import {
    DEFAULT_EMBEDDING_BATCH_CHARACTERS,
    DEFAULT_EMBEDDING_BATCH_INPUTS,
} from "./constants/defaults.js";
import type {
    EmbeddingBatch,
    EmbeddingInput,
    EmbeddingProvider,
    EmbeddingResult,
    EmbeddingServiceOptions,
} from "./contracts/embedding.js";
import { EmbeddingError } from "./errors/embedding-error.js";

export class EmbeddingService {
    readonly provider: EmbeddingProvider;

    constructor(provider: EmbeddingProvider) {
        this.provider = provider;
    }

    async embed(
        inputs: readonly EmbeddingInput[],
        options: EmbeddingServiceOptions = {},
    ): Promise<readonly EmbeddingResult[]> {
        const results: EmbeddingResult[] = [];

        for await (const batch of this.embedBatches(inputs, options)) {
            results.push(...batch.results);
        }

        return results;
    }

    async *embedBatches(
        inputs: readonly EmbeddingInput[],
        options: EmbeddingServiceOptions = {},
    ): AsyncGenerator<EmbeddingBatch> {
        validateInputs(inputs);
        throwIfAborted(options.signal);

        const maximumInputs = Math.min(
            options.maximumInputsPerBatch ?? DEFAULT_EMBEDDING_BATCH_INPUTS,
            this.provider.maximumInputs,
        );
        const maximumCharacters = Math.min(
            options.maximumCharactersPerBatch ?? DEFAULT_EMBEDDING_BATCH_CHARACTERS,
            this.provider.maximumCharacters,
        );
        const batches = createBatches(inputs, maximumInputs, maximumCharacters);
        let completedInputs = 0;

        emitProgress(options, {
            completedInputs,
            totalInputs: inputs.length,
            completedBatches: 0,
            totalBatches: batches.length,
        });

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            const batch = batches[batchIndex]!;
            throwIfAborted(options.signal);
            const batchResults = await this.provider.embed(batch, {
                ...(options.signal === undefined
                    ? {}
                    : { signal: options.signal }),
            });
            validateResults(batch, batchResults, this.provider.identity.dimensions);
            const orderedResults = orderResults(batch, batchResults);
            completedInputs += batch.length;
            const progress = {
                completedInputs,
                totalInputs: inputs.length,
                completedBatches: batchIndex + 1,
                totalBatches: batches.length,
            };
            emitProgress(options, progress);
            yield { results: orderedResults, progress };
        }
    }
}

function orderResults(
    inputs: readonly EmbeddingInput[],
    results: readonly EmbeddingResult[],
): readonly EmbeddingResult[] {
    const byId = new Map(results.map((result) => [result.id, result]));

    return inputs.map((input) => {
        const result = byId.get(input.id);

        if (result === undefined) {
            throw invalidResponse("Embedding provider omitted an input", [input.id]);
        }

        return result;
    });
}

function createBatches(
    inputs: readonly EmbeddingInput[],
    maximumInputs: number,
    maximumCharacters: number,
): readonly (readonly EmbeddingInput[])[] {
    if (
        !Number.isSafeInteger(maximumInputs) ||
        maximumInputs < 1 ||
        !Number.isSafeInteger(maximumCharacters) ||
        maximumCharacters < 1
    ) {
        throw new EmbeddingError("invalid-input", "Embedding batch limits are invalid");
    }

    const batches: EmbeddingInput[][] = [];
    let current: EmbeddingInput[] = [];
    let currentCharacters = 0;

    for (const input of inputs) {
        if (input.text.length > maximumCharacters) {
            throw new EmbeddingError(
                "input-too-large",
                `Embedding input ${input.id} exceeds the provider limit`,
                { inputId: input.id, characterLength: input.text.length },
            );
        }

        if (
            current.length > 0 &&
            (current.length >= maximumInputs ||
                currentCharacters + input.text.length > maximumCharacters)
        ) {
            batches.push(current);
            current = [];
            currentCharacters = 0;
        }

        current.push(input);
        currentCharacters += input.text.length;
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return batches;
}

function validateInputs(inputs: readonly EmbeddingInput[]): void {
    const ids = new Set<string>();

    for (const input of inputs) {
        if (input.id.trim().length === 0 || input.text.length === 0) {
            throw new EmbeddingError(
                "invalid-input",
                "Embedding inputs require non-empty IDs and text",
            );
        }

        if (ids.has(input.id)) {
            throw new EmbeddingError(
                "duplicate-input",
                `Embedding input ${input.id} is duplicated`,
                { inputId: input.id },
            );
        }

        ids.add(input.id);
    }
}

function validateResults(
    inputs: readonly EmbeddingInput[],
    results: readonly EmbeddingResult[],
    dimensions: number,
): void {
    const expectedIds = new Set(inputs.map(({ id }) => id));
    const resultIds = new Set<string>();

    for (const result of results) {
        if (!expectedIds.has(result.id) || resultIds.has(result.id)) {
            throw invalidResponse("Embedding provider returned an invalid vector", [result.id]);
        }

        if (
            !(result.vector instanceof Float32Array) ||
            result.vector.length !== dimensions ||
            result.vector.some((value) => !Number.isFinite(value))
        ) {
            const actualDimensions = result.vector instanceof Float32Array
                ? result.vector.length
                : undefined;
            throw new EmbeddingError(
                "invalid-provider-response",
                `Embedding vector dimensions do not match: expected ${dimensions}, received ${actualDimensions ?? "an invalid vector"}`,
                {
                    inputId: result.id,
                    expectedDimensions: dimensions,
                    ...(actualDimensions === undefined
                        ? {}
                        : { actualDimensions }),
                },
            );
        }

        resultIds.add(result.id);
    }

    if (resultIds.size !== expectedIds.size) {
        throw invalidResponse("Embedding provider returned an incomplete batch", [...expectedIds]);
    }
}

function invalidResponse(message: string, inputIds: readonly string[]): EmbeddingError {
    return new EmbeddingError(
        "invalid-provider-response",
        message,
        { inputIds },
    );
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
        throw new EmbeddingError(
            "cancelled",
            "Embedding operation was cancelled",
            {},
            signal.reason,
        );
    }
}

function emitProgress(
    options: EmbeddingServiceOptions,
    progress: Parameters<NonNullable<EmbeddingServiceOptions["onProgress"]>>[0],
): void {
    options.onProgress?.(progress);
}
