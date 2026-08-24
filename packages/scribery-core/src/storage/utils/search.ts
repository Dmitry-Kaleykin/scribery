import type {
    EmbeddingModelIdentity,
    FilterMetadata,
} from "../../metadata/index.js";
import type { StorageFilterCondition } from "../contracts/storage.js";

export function modelIdentityEquals(
    left: EmbeddingModelIdentity,
    right: EmbeddingModelIdentity,
): boolean {
    return left.provider === right.provider &&
        left.model === right.model &&
        left.dimensions === right.dimensions &&
        left.metric === right.metric &&
        left.revision === right.revision &&
        left.documentPrefix === right.documentPrefix &&
        left.queryPrefix === right.queryPrefix &&
        left.embeddingSuffix === right.embeddingSuffix;
}

export function scoreVectors(
    query: ArrayLike<number>,
    candidate: ArrayLike<number>,
    metric: EmbeddingModelIdentity["metric"],
): number {
    let dot = 0;
    let queryMagnitude = 0;
    let candidateMagnitude = 0;
    let squaredDistance = 0;

    for (let index = 0; index < query.length; index += 1) {
        const left = query[index] ?? 0;
        const right = candidate[index] ?? 0;
        dot += left * right;
        queryMagnitude += left * left;
        candidateMagnitude += right * right;
        const difference = left - right;
        squaredDistance += difference * difference;
    }

    if (metric === "dot-product") return dot;
    if (metric === "euclidean") return -Math.sqrt(squaredDistance);

    const denominator = Math.sqrt(queryMagnitude) * Math.sqrt(candidateMagnitude);
    return denominator === 0 ? 0 : dot / denominator;
}

export function matchesFilters(
    metadata: FilterMetadata,
    filters: readonly StorageFilterCondition[] = [],
): boolean {
    return filters.every((filter) => {
        const actual = metadata[filter.field];
        const actualValues = Array.isArray(actual) ? actual : [actual];
        const expectedValues = Array.isArray(filter.value)
            ? filter.value
            : [filter.value];

        if (filter.operator === "equals") {
            return expectedValues.length === 1 &&
                actualValues.some((value) => value === expectedValues[0]);
        }

        return actualValues.some((value) => expectedValues.includes(value));
    });
}
