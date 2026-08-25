import {
    ProjectRetrievalTargetService,
    SqliteStorageProvider,
    type IndexedProjectSummary,
    type ResolvedProjectRetrievalSelection,
} from "scribery";

export interface ActiveIndexSummary {
    target: string;
    indexBuildId: string;
    completedAt?: string;
}

export class ActiveIndexResolver {
    readonly #targets: ProjectRetrievalTargetService;

    constructor(targets: ProjectRetrievalTargetService) {
        this.#targets = targets;
    }

    async resolve(
        project: IndexedProjectSummary,
    ): Promise<ActiveIndexSummary | undefined> {
        const selection = await this.#targets.activeSelection(project);
        if (selection === undefined) return undefined;

        const storage = new SqliteStorageProvider(project.databasePath, {
            readOnly: true,
            immutable: true,
        });
        try {
            const build = await storage.getBuild(selection.indexBuildId);
            return {
                target: selectionLabel(selection),
                indexBuildId: selection.indexBuildId,
                ...(build?.completedAt === undefined
                    ? {}
                    : { completedAt: build.completedAt }),
            };
        } finally {
            await storage.close();
        }
    }
}

function selectionLabel(selection: ResolvedProjectRetrievalSelection): string {
    if (selection.type === "target") return selection.target;
    if (selection.type === "build") return "pinned build";
    return "latest ready";
}
