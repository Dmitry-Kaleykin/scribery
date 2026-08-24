import { readFile } from "node:fs/promises";

import {
    DefaultFileDiscovery,
    type DiscoveryOptions,
} from "../../../discovery/index.js";
import { hashBytes, hashText } from "../../../metadata/index.js";
import type {
    PreparedSourceDocument,
    SourceDiagnostic,
    SourcePreparationProgress,
} from "../../contracts/source.js";

export interface FilesystemSnapshotRequest {
    root: string;
    rootIdentity: string;
    discoveryOptions?: Omit<DiscoveryOptions, "signal">;
    signal?: AbortSignal;
    onProgress?: (progress: SourcePreparationProgress) => void;
}

export interface FilesystemSnapshot {
    root: string;
    membershipHash: string;
    sourceSelectionHash: string;
    documents: readonly PreparedSourceDocument[];
    diagnostics: readonly SourceDiagnostic[];
}

export class FilesystemSnapshotProvider {
    async prepare(request: FilesystemSnapshotRequest): Promise<FilesystemSnapshot> {
        const documents: PreparedSourceDocument[] = [];
        const diagnostics: SourceDiagnostic[] = [];
        let discoveredBytes = 0;
        const discoveryOptions: DiscoveryOptions = {
            ...request.discoveryOptions,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        };

        for await (
            const event of new DefaultFileDiscovery().discover(
                request.root,
                discoveryOptions,
            )
        ) {
            if (event.type === "diagnostic") {
                diagnostics.push({
                    path: event.diagnostic.path,
                    code: event.diagnostic.code,
                    message: event.diagnostic.message,
                });
                continue;
            }

            const bytes = new Uint8Array(await readFile(event.file.absolutePath));
            const byteContentHash = hashBytes(bytes);
            discoveredBytes += bytes.byteLength;
            documents.push({
                path: event.file.relativePath,
                bytes,
                byteContentHash,
                revisionIdentity: byteContentHash,
                modifiedAt: event.file.modifiedAt,
            });
            request.onProgress?.({
                completed: documents.length,
                discoveredBytes,
                currentPath: event.file.relativePath,
            });
        }

        return {
            root: request.root,
            membershipHash: hashText(
                documents.map(({ path, byteContentHash }) =>
                    `${path}\0${byteContentHash}`
                ).join("\n"),
            ),
            sourceSelectionHash: hashText(JSON.stringify({
                root: request.rootIdentity,
                include: discoveryOptions.include ?? [],
                exclude: discoveryOptions.exclude ?? [],
                useGitignore: discoveryOptions.useGitignore ?? true,
                includeHidden: discoveryOptions.includeHidden ?? false,
                maxFileSize: discoveryOptions.maxFileSize ?? null,
            })),
            documents,
            diagnostics,
        };
    }
}

