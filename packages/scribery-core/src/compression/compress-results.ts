import type { StorageProvider, DocumentChunks } from "../storage/index.js";
import type { RetrievalRequest, RetrievalResult } from "../retrieval/contracts/retrieval.js";
import { RetrievalError } from "../retrieval/errors/retrieval-error.js";
import type { CompressionDiagnostic, CompressionExcerpt, CompressionOptions, CompressionProvider, CompressionSelection } from "./contracts.js";
import { COMPRESSION_INSTRUCTION, compressionUserPrompt } from "./provider.js";

// Shared across searches in this process, including time spent waiting for the GPU.
let busy = false;
const waiters = new Set<() => void>();

export async function compressResults(
    storage: StorageProvider,
    request: RetrievalRequest,
    results: readonly RetrievalResult[],
    provider: CompressionProvider,
    options: Required<CompressionOptions>,
): Promise<{ results: readonly RetrievalResult[]; diagnostics: CompressionDiagnostic[] }> {
    const deadline = new AbortController();
    const deadlineAt = performance.now() + options.timeoutMs;
    const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
    const signal = request.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, request.signal]);
    const groups = new Map<string, RetrievalResult[]>();
    for (const result of results) {
        const group = groups.get(result.documentId) ?? [];
        group.push(result);
        groups.set(result.documentId, group);
    }
    const diagnostics: CompressionDiagnostic[] = [];
    const selections = new Map<string, { diagnostic: CompressionDiagnostic; excerpts: CompressionExcerpt[] }>();
    let attemptedFiles = 0;
    try {
        for (const [documentId, matches] of groups) {
            throwIfCancelled(request.signal);
            const started = performance.now();
            const path = matches[0]!.path;
            let reason: CompressionDiagnostic["reason"];
            let inputTruncated = false;
            let excerpts: CompressionExcerpt[] = [];
            try {
                if (signal.aborted || performance.now() >= deadlineAt) throw new SelectionFailure("timeout");
                if (attemptedFiles++ >= options.maximumFiles) throw new SelectionFailure("file-limit");
                const document = await abortable(storage.getDocumentChunks({ indexBuildId: request.indexBuildId, path }), signal);
                if (document === undefined || document.document.metadata.documentId !== documentId ||
                    document.document.metadata.path !== path) {
                    throw new SelectionFailure("source-unavailable");
                }
                const prepared = prepareSource(document, matches, request.query, options.maximumInputTokens, deadlineAt);
                inputTruncated = prepared.truncated;
                if (prepared.ranges.length === 0) throw new SelectionFailure("input-budget");
                const selected = await selectSerially(provider, {
                    query: request.query, path, source: prepared.source,
                    maximumOutputTokens: options.maximumOutputTokens, signal,
                });
                excerpts = extractSelections(document, selected, prepared.ranges, options.maximumExcerptCharacters);
            } catch (error: unknown) {
                throwIfCancelled(request.signal);
                reason = signal.aborted ? "timeout" : error instanceof SelectionFailure ? error.reason : "provider-error";
            }
            const diagnostic: CompressionDiagnostic = {
                documentId, path, status: reason !== undefined ? "fallback" : excerpts.length ? "selected" : "empty",
                ...(reason === undefined ? {} : { reason }), inputTruncated,
                elapsedMs: Math.round(performance.now() - started),
            };
            diagnostics.push(diagnostic);
            selections.set(documentId, { diagnostic, excerpts });
        }
        throwIfCancelled(request.signal);
        return {
            results: results.flatMap((result) => {
                const selection = selections.get(result.documentId)!;
                if (selection.diagnostic.status === "empty") return [];
                return [{ ...result, compression: selection }];
            }),
            diagnostics,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function selectSerially(provider: CompressionProvider, request: Parameters<CompressionProvider["select"]>[0]) {
    while (busy) {
        let wake!: () => void;
        const waiting = new Promise<void>((resolve) => { wake = resolve; waiters.add(wake); });
        try { await abortable(waiting, request.signal); } finally { waiters.delete(wake); }
    }
    request.signal.throwIfAborted();
    busy = true;
    try { return await abortable(Promise.resolve().then(() => provider.select(request)), request.signal); }
    finally { busy = false; for (const wake of waiters) wake(); }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        // Attach even when already aborted, to consume any late rejection.
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
    });
}

function prepareSource(document: DocumentChunks, matches: readonly RetrievalResult[], query: string, budget: number, deadlineAt: number) {
    const content = document.document.content;
    const lines = content.split("\n");
    const render = (ranges: readonly CompressionSelection[]) => ranges.map(({ startLine, endLine }) =>
        lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n")
    ).join("\n[omitted source]\n");
    // UTF-8 bytes conservatively bound Qwen byte-token input; reserve template/schema overhead.
    const fits = (source: string) => Buffer.byteLength(COMPRESSION_INSTRUCTION + compressionUserPrompt({
        query, path: document.document.metadata.path, source,
    }), "utf8") + 1024 <= budget;
    const all = [{ startLine: 1, endLine: lines.length }];
    if (Buffer.byteLength(content, "utf8") <= budget) {
        const full = render(all);
        if (fits(full)) return { source: full, ranges: all, truncated: false };
    }
    const anchors = matches.map(({ range }) => range.startLine);
    const distance = (start: number) => Math.min(...anchors.map((anchor) => Math.abs(anchor - start)));
    const candidates = [
        ...matches.map(({ range }) => range),
        ...document.chunks.map(({ metadata }) => metadata).sort((a, b) => distance(a.startLine) - distance(b.startLine)),
    ];
    let ranges: CompressionSelection[] = [];
    for (const candidate of candidates) {
        if (performance.now() >= deadlineAt) throw new SelectionFailure("timeout");
        if (!validRange(candidate, lines.length)) continue;
        const next = mergeRanges([...ranges, { startLine: candidate.startLine, endLine: candidate.endLine }]);
        if (fits(render(next))) ranges = next;
    }
    return { source: render(ranges), ranges, truncated: true };
}

function extractSelections(document: DocumentChunks, value: readonly CompressionSelection[], allowed: readonly CompressionSelection[], budget: number): CompressionExcerpt[] {
    const content = document.document.content;
    const starts = [0];
    for (let index = 0; index < content.length; index++) if (content[index] === "\n") starts.push(index + 1);
    if (!Array.isArray(value) || value.length > 12 || value.some((range) =>
        !validRange(range, starts.length) || !allowed.some((region) => range.startLine >= region.startLine && range.endLine <= region.endLine)
    )) throw new SelectionFailure("invalid-selection");
    const excerpts = mergeRanges(value).map((range): CompressionExcerpt => {
        const startOffset = starts[range.startLine - 1]!;
        const endOffset = starts[range.endLine] ?? content.length;
        return {
            documentId: document.document.metadata.documentId,
            fileRevisionId: document.document.metadata.fileRevisionId,
            path: document.document.metadata.path,
            range: { ...range, startOffset, endOffset },
            content: content.slice(startOffset, endOffset),
        };
    });
    if (excerpts.reduce((sum, item) => sum + item.content.length, 0) > budget) throw new SelectionFailure("invalid-selection");
    return excerpts;
}

function validRange(value: unknown, maximum: number): value is CompressionSelection {
    if (typeof value !== "object" || value === null) return false;
    const range = value as CompressionSelection;
    return Number.isSafeInteger(range.startLine) && Number.isSafeInteger(range.endLine) &&
        range.startLine >= 1 && range.endLine >= range.startLine && range.endLine <= maximum;
}

function mergeRanges(ranges: readonly CompressionSelection[]): CompressionSelection[] {
    const merged: CompressionSelection[] = [];
    for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine)) {
        const last = merged[merged.length - 1];
        if (last !== undefined && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine);
        else merged.push({ ...range });
    }
    return merged;
}

class SelectionFailure extends Error {
    constructor(readonly reason: NonNullable<CompressionDiagnostic["reason"]>) { super(reason); }
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new RetrievalError("cancelled", "Retrieval was cancelled during compression", {}, signal.reason);
}
