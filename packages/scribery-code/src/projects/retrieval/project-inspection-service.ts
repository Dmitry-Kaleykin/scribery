import { normalizeRelativePath } from "scribery-core";
import { SqliteStorageProvider } from "scribery-core";
import type {
    ProjectChunkInspectionRequest,
    ProjectChunkInspectionResult,
} from "../contracts/project-inspection.js";
import { ProjectLiveIndexingStateCatalog } from "../live/live-state-catalog.js";
import { managedIndexesDirectory } from "../managed/paths.js";
import { ProjectRetrievalTargetService } from "./retrieval-target-service.js";

export interface ProjectInspectionServiceOptions {
    indexesDirectory?: string;
}

export class ProjectInspectionService {
    readonly #targets: ProjectRetrievalTargetService;
    readonly #liveStates: ProjectLiveIndexingStateCatalog;

    constructor(options: ProjectInspectionServiceOptions = {}) {
        const indexesDirectory = options.indexesDirectory ??
            managedIndexesDirectory();
        this.#targets = new ProjectRetrievalTargetService({ indexesDirectory });
        this.#liveStates = new ProjectLiveIndexingStateCatalog(indexesDirectory);
    }

    async chunks(
        request: ProjectChunkInspectionRequest,
        currentDirectory = process.cwd(),
    ): Promise<ProjectChunkInspectionResult> {
        const project = await this.#targets.resolveProject(
            request.projectReference,
            currentDirectory,
        );
        const selection = request.indexBuildId === undefined
            ? await this.#targets.activeSelection(project)
            : {
                type: "requested-build" as const,
                indexBuildId: request.indexBuildId,
            };
        if (selection === undefined) {
            throw new Error(
                `Indexed project ${project.projectIdentifier} has no ready build`,
            );
        }
        if (request.indexBuildId === undefined) {
            await this.#liveStates.assertReady(
                project.projectIdentifier,
                selection.indexBuildId,
            );
        }
        const storage = new SqliteStorageProvider(project.databasePath, {
            readOnly: true,
            immutable: true,
        });
        try {
            const build = await storage.getBuild(selection.indexBuildId);
            if (build === undefined) {
                throw new Error(
                    `Index build ${selection.indexBuildId} was not found`,
                );
            }
            if (build.status !== "ready") {
                throw new Error(
                    `Index build ${selection.indexBuildId} is ${build.status}; only ready builds can be inspected`,
                );
            }
            const path = normalizeRelativePath(request.path);
            const chunks = await storage.getDocumentChunks({
                indexBuildId: build.indexBuildId,
                path,
            });
            if (chunks === undefined) {
                throw new Error(
                    `Indexed file ${path} was not found in build ${build.indexBuildId}`,
                );
            }
            return {
                projectIdentifier: project.projectIdentifier,
                ...(project.root === undefined ? {} : { root: project.root }),
                databasePath: project.databasePath,
                indexBuildId: build.indexBuildId,
                retrievalSelection: selection,
                chunks,
            };
        } finally {
            await storage.close();
        }
    }
}
