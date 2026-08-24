import type { DiscoveryOptions } from "scribery-core";
import {
    GitSourceControlProvider,
    type SourceControlProvider,
} from "../../../source-control/index.js";
import {
    DirectorySourceProvider,
    SourceError,
    type PreparedSourceSnapshot,
    type SourcePreparationProgress,
    type SourceSnapshotProvider,
} from "scribery-core";
import { GitWorkingTreeSourceProvider } from "../git/git-working-tree-source.js";

export interface ProjectSourceRequest {
    root: string;
    repositoryIdentity?: string;
    allowDirty?: boolean;
    discoveryOptions?: Omit<DiscoveryOptions, "signal">;
    signal?: AbortSignal;
    onInspection?: () => void;
    onDiscovery?: () => void;
    onProgress?: (progress: SourcePreparationProgress) => void;
}

export class ProjectSourceProvider
    implements SourceSnapshotProvider<ProjectSourceRequest> {
    readonly #git: SourceControlProvider;
    readonly #directory: DirectorySourceProvider;
    readonly #workingTree: GitWorkingTreeSourceProvider;

    constructor(
        git: SourceControlProvider = new GitSourceControlProvider(),
        directory = new DirectorySourceProvider(),
        workingTree = new GitWorkingTreeSourceProvider(),
    ) {
        this.#git = git;
        this.#directory = directory;
        this.#workingTree = workingTree;
    }

    async prepare(request: ProjectSourceRequest): Promise<PreparedSourceSnapshot> {
        request.onInspection?.();
        const sourceControlOptions = {
            ...(request.repositoryIdentity === undefined
                ? {}
                : { repositoryIdentity: request.repositoryIdentity }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        const context = await this.#git.detect(
            request.root,
            sourceControlOptions,
        );

        if (context === null) {
            request.onDiscovery?.();
            return this.#directory.prepare({
                root: request.root,
                ...(request.repositoryIdentity === undefined
                    ? {}
                    : { repositoryIdentity: request.repositoryIdentity }),
                ...(request.discoveryOptions === undefined
                    ? {}
                    : { discoveryOptions: request.discoveryOptions }),
                ...(request.signal === undefined
                    ? {}
                    : { signal: request.signal }),
                ...(request.onProgress === undefined
                    ? {}
                    : { onProgress: request.onProgress }),
            });
        }

        const state = await this.#git.resolveCurrentState(
            context,
            sourceControlOptions,
        );

        if (state.dirty && request.allowDirty !== true) {
            throw new SourceError(
                "dirty-working-tree",
                "Indexing a dirty Git working tree requires explicit permission",
                { changedPaths: state.changes.map(({ path }) => path) },
            );
        }

        request.onDiscovery?.();
        return this.#workingTree.prepare({
            context,
            state,
            ...(request.discoveryOptions === undefined
                ? {}
                : { discoveryOptions: request.discoveryOptions }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.onProgress === undefined
                ? {}
                : { onProgress: request.onProgress }),
        });
    }
}
