import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { IndexingResult } from "scribery-core";
import {
    INDEX_LOGS_DIRECTORY,
    INDEX_LOG_VERSION,
} from "scribery-core";

export interface ConciseIndexingResult {
    databasePath: string;
    indexBuildId: string;
    status: "ready";
    discoveredFiles: number;
    indexedDocuments: number;
    indexedChunks: number;
    reusedDocuments: number;
    reusedChunks: number;
    reusedEmbeddings: number;
    generatedEmbeddings: number;
    diagnosticCount: number;
    logPath: string;
}

export async function writeIndexingLog(
    root: string,
    databasePath: string,
    result: IndexingResult,
): Promise<ConciseIndexingResult> {
    const logDirectory = join(dirname(databasePath), INDEX_LOGS_DIRECTORY);
    const logPath = join(logDirectory, `${result.indexBuildId}.json`);
    const { diagnostics, ...indexingSummary } = result;

    await mkdir(logDirectory, { recursive: true });
    await writeFile(logPath, `${JSON.stringify({
        schemaVersion: INDEX_LOG_VERSION,
        generatedAt: new Date().toISOString(),
        root,
        databasePath,
        result: indexingSummary,
        diagnostics,
    }, null, 2)}\n`, "utf8");

    return {
        databasePath,
        indexBuildId: result.indexBuildId,
        status: "ready",
        discoveredFiles: result.discoveredFiles,
        indexedDocuments: result.indexedDocuments,
        indexedChunks: result.indexedChunks,
        reusedDocuments: result.reusedDocuments,
        reusedChunks: result.reusedChunks,
        reusedEmbeddings: result.reusedEmbeddings,
        generatedEmbeddings: result.generatedEmbeddings,
        diagnosticCount: diagnostics.length,
        logPath,
    };
}
