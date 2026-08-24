export interface ProjectRetrievalTarget {
    name: string;
    indexBuildId: string;
    createdAt: string;
    updatedAt: string;
    retainedBuildIds?: readonly string[];
}

export type ProjectRetrievalSelection =
    | {
        type: "target";
        target: string;
    }
    | {
        type: "build";
        indexBuildId: string;
    };

export interface ProjectRetrievalTargets {
    schemaVersion: 1;
    projectIdentifier: string;
    updatedAt: string;
    targets: readonly ProjectRetrievalTarget[];
    active?: ProjectRetrievalSelection;
}

export type ResolvedProjectRetrievalSelection =
    | {
        type: "target";
        target: string;
        indexBuildId: string;
    }
    | {
        type: "build";
        indexBuildId: string;
    }
    | {
        type: "latest-ready";
        indexBuildId: string;
    };
