import { realpath } from "node:fs/promises";

import { createRepositoryId } from "../../../metadata/index.js";
import type { DiscoveryOptions } from "../../../discovery/index.js";
import type {
    PreparedSourceSnapshot,
    SourcePreparationProgress,
    SourceSnapshotProvider,
} from "../../contracts/source.js";
import { FilesystemSnapshotProvider } from "../filesystem/filesystem-snapshot.js";

export interface DirectorySourceRequest {
    root: string;
    repositoryIdentity?: string;
    discoveryOptions?: Omit<DiscoveryOptions, "signal">;
    signal?: AbortSignal;
    onProgress?: (progress: SourcePreparationProgress) => void;
}

export class DirectorySourceProvider
    implements SourceSnapshotProvider<DirectorySourceRequest> {
    readonly #filesystem: FilesystemSnapshotProvider;

    constructor(filesystem = new FilesystemSnapshotProvider()) {
        this.#filesystem = filesystem;
    }

    async prepare(request: DirectorySourceRequest): Promise<PreparedSourceSnapshot> {
        const root = await realpath(request.root);
        const filesystem = await this.#filesystem.prepare({
            root,
            rootIdentity: ".",
            ...(request.discoveryOptions === undefined
                ? {}
                : { discoveryOptions: request.discoveryOptions }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.onProgress === undefined
                ? {}
                : { onProgress: request.onProgress }),
        });

        return {
            scopeId: createRepositoryId(request.repositoryIdentity ?? root),
            rootIdentity: ".",
            sourceIdentity: `directory:${filesystem.membershipHash}`,
            sourceSelectionHash: filesystem.sourceSelectionHash,
            provenance: { kind: "directory", root },
            documents: filesystem.documents,
            diagnostics: filesystem.diagnostics,
        };
    }
}
