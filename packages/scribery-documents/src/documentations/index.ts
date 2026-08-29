export { DocumentationService, type DocumentationServiceOptions } from "./documentation-service.js";
export type {
    ActiveDocumentationBuild,
    DirectoryDocumentationSource,
    DocumentationAttributeValue,
    DocumentationDirectoryInput,
    DocumentationInput,
    DocumentationIndexDiagnostic,
    DocumentationIndexOptions,
    DocumentationIndexProgress,
    DocumentationIndexResult,
    DocumentationManifest,
    DocumentationRetrievalRequest,
    DocumentationRetrievalScope,
    DocumentationSourceDefinition,
    DocumentationSummary,
    DeletedDocumentation,
    IndexedDocumentationSource,
    ManagedDocumentationSource,
    ResolvedDocumentationBuild,
    SourceTagMutation,
} from "./contracts/documentation.js";
export {
    DocumentationError,
    type DocumentationErrorCode,
} from "./errors/documentation-error.js";
export { DocumentationIndexer } from "./indexing/documentation-indexer.js";
export {
    DocumentationSourceProvider,
    type DocumentationSourceRequest,
    type PreparedDocumentationSnapshot,
} from "./sources/documentation-source.js";
export { DocumentationCatalog } from "./managed/catalog.js";
export {
    documentationDatabasePath,
    documentationDirectory,
    documentationManifestPath,
    documentationSourcePath,
    managedDocumentationsDirectory,
} from "./managed/paths.js";
