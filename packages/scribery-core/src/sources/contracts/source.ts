import type { SupportedEncoding } from "../../shared/index.js";

export type SourceAttributeValue = string | number | boolean;

export interface PreparedSourceDocument {
    path: string;
    bytes: Uint8Array;
    byteContentHash: string;
    revisionIdentity: string;
    modifiedAt?: Date;
    encoding?: SupportedEncoding;
    fallbackFormat?: string;
    sourceId?: string;
    title?: string;
    mediaType?: string;
    tags?: readonly string[];
    attributes?: Readonly<Record<string, SourceAttributeValue>>;
}

export interface SourceDiagnostic {
    path: string;
    code: string;
    message: string;
}

export type SourceProvenance =
    | {
        kind: "directory";
        root: string;
    }
    | {
        kind: "git-working-tree";
        root: string;
        repositoryRoot: string;
        headCommit?: string;
        refName?: string;
        dirty: boolean;
    }
    | {
        kind: "managed-documentation";
        documentationId: string;
    };

export interface PreparedSourceSnapshot {
    scopeId: string;
    rootIdentity: string;
    sourceIdentity: string;
    sourceSelectionHash: string;
    provenance: SourceProvenance;
    documents: readonly PreparedSourceDocument[];
    diagnostics: readonly SourceDiagnostic[];
}

export interface SourceSnapshotProvider<Request> {
    prepare(request: Request): Promise<PreparedSourceSnapshot>;
}

export interface SourcePreparationProgress {
    completed: number;
    discoveredBytes: number;
    currentPath: string;
}
