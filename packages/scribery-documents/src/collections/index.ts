export { CollectionService, type CollectionServiceOptions } from "./collection-service.js";
export type {
    ActiveCollectionBuild,
    CollectionBuildDiagnostic,
    CollectionBuildOptions,
    CollectionBuildProgress,
    CollectionBuildResult,
    CollectionDocumentInput,
    CollectionManifest,
    CollectionRetrievalRequest,
    CollectionRetrievalScope,
    CollectionSource,
    CollectionSummary,
    DeletedCollection,
    ResolvedCollectionBuild,
    SourceTagMutation,
} from "./contracts/collection.js";
export {
    CollectionError,
    type CollectionErrorCode,
} from "./errors/collection-error.js";
export { CollectionIndexer } from "./indexing/collection-indexer.js";
export {
    ManagedCollectionSourceProvider,
    type ManagedCollectionSourceRequest,
} from "./sources/managed-collection-source.js";
export { CollectionCatalog } from "./managed/catalog.js";
export {
    collectionDatabasePath,
    collectionDirectory,
    collectionManifestPath,
    collectionSourcePath,
    managedCollectionsDirectory,
} from "./managed/paths.js";
