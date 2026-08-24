export interface DiscoveredFile {
    absolutePath: string;
    relativePath: string;
    size: number;
    modifiedAt: Date;
}

export interface DiscoveryDiagnostic {
    path: string;
    code:
        | "entry-unreadable"
        | "file-too-large"
        | "symbolic-link-skipped"
        | "unsupported-entry";
    message: string;
    severity: "warning" | "error";
}

export type DiscoveryEvent =
    | { type: "file"; file: DiscoveredFile }
    | { type: "diagnostic"; diagnostic: DiscoveryDiagnostic };

export interface DiscoveryOptions {
    include?: readonly string[];
    exclude?: readonly string[];
    useGitignore?: boolean;
    includeHidden?: boolean;
    maxFileSize?: number;
    signal?: AbortSignal;
}

export interface FileDiscovery {
    discover(
        root: string,
        options?: DiscoveryOptions,
    ): AsyncIterable<DiscoveryEvent>;
}
