import type { DiscoveryOptions } from "scribery-core";
import type {
    SourceControlContext,
    WorkingTreeState,
} from "../../../source-control/index.js";
import {
    FilesystemSnapshotProvider,
    type PreparedSourceSnapshot,
    type SourcePreparationProgress,
    type SourceSnapshotProvider,
} from "scribery-core";

export interface GitWorkingTreeSourceRequest {
    context: SourceControlContext;
    state: WorkingTreeState;
    discoveryOptions?: Omit<DiscoveryOptions, "signal">;
    signal?: AbortSignal;
    onProgress?: (progress: SourcePreparationProgress) => void;
}

export class GitWorkingTreeSourceProvider
    implements SourceSnapshotProvider<GitWorkingTreeSourceRequest> {
    readonly #filesystem: FilesystemSnapshotProvider;

    constructor(filesystem = new FilesystemSnapshotProvider()) {
        this.#filesystem = filesystem;
    }

    async prepare(
        request: GitWorkingTreeSourceRequest,
    ): Promise<PreparedSourceSnapshot> {
        const filesystem = await this.#filesystem.prepare({
            root: request.context.indexingRoot,
            rootIdentity: request.context.indexingRootRelativePath,
            ...(request.discoveryOptions === undefined
                ? {}
                : { discoveryOptions: request.discoveryOptions }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.onProgress === undefined
                ? {}
                : { onProgress: request.onProgress }),
        });
        const sourceIdentity = request.state.headCommit === undefined
            ? `git-working-tree:unborn:${filesystem.membershipHash}`
            : `git-working-tree:${request.state.headCommit}:${filesystem.membershipHash}`;

        return {
            scopeId: request.context.repositoryId,
            rootIdentity: request.context.indexingRootRelativePath,
            sourceIdentity,
            sourceSelectionHash: filesystem.sourceSelectionHash,
            provenance: {
                kind: "git-working-tree",
                root: request.context.indexingRoot,
                repositoryRoot: request.context.repositoryRoot,
                ...(request.state.headCommit === undefined
                    ? {}
                    : { headCommit: request.state.headCommit }),
                ...(request.state.refName === undefined
                    ? {}
                    : { refName: request.state.refName }),
                dirty: request.state.dirty,
            },
            documents: filesystem.documents,
            diagnostics: filesystem.diagnostics,
        };
    }
}
