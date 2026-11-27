import type { CompressionProfile } from "scribery-core";

export interface ScriberyMcpServerOptions {
    version: string;
    compression?: CompressionProfile;
    defaultProjectReference?: string;
    baseUrl?: string;
    apiKey?: string | undefined;
    rerankingModel?: string;
    rerankingProtocol?: "completions" | "rerank";
    rerankingInstruction?: string;
    indexesDirectory?: string;
    profilesPath?: string;
    fetch?: typeof globalThis.fetch;
}

export interface ProjectSearchInput {
    query: string;
    projectReference?: string;
    indexBuildId?: string;
    limit?: number;
    language?: string;
    compress?: boolean;
    includeContext?: boolean;
    contextBefore?: number;
    contextAfter?: number;
    contextCharacters?: number;
    rerank?: boolean;
    rerankCandidates?: number;
}
