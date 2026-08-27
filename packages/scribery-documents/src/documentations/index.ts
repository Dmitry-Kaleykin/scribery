export { DocumentationService, type DocumentationServiceOptions } from "./documentation-service.js";
export type {
    ActiveDocumentationBuild,
    DocumentationBuildDiagnostic,
    DocumentationBuildOptions,
    DocumentationBuildProgress,
    DocumentationBuildResult,
    DocumentationInput,
    DocumentationManifest,
    DocumentationRetrievalRequest,
    DocumentationRetrievalScope,
    DocumentationSource,
    DocumentationSummary,
    DeletedDocumentation,
    ResolvedDocumentationBuild,
    SourceTagMutation,
} from "./contracts/documentation.js";
export {
    DocumentationError,
    type DocumentationErrorCode,
} from "./errors/documentation-error.js";
export { DocumentationIndexer } from "./indexing/documentation-indexer.js";
export {
    ManagedDocumentationSourceProvider,
    type ManagedDocumentationSourceRequest,
} from "./sources/managed-documentation-source.js";
export { DocumentationCatalog } from "./managed/catalog.js";
export {
    documentationDatabasePath,
    documentationDirectory,
    documentationManifestPath,
    documentationSourcePath,
    managedDocumentationsDirectory,
} from "./managed/paths.js";
