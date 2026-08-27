import type { McpToolSelection } from "../constants/tools.js";

export interface ScriberyMcpServerOptions {
    version: string;
    defaultProjectReference?: string;
    baseUrl?: string;
    apiKey?: string | undefined;
    rerankingModel?: string;
    rerankingProtocol?: "completions" | "rerank";
    rerankingInstruction?: string;
    indexesDirectory?: string;
    documentationsDirectory?: string;
    toolAllowlist?: readonly McpToolSelection[];
}

export interface ProjectSearchInput {
    query: string;
    projectReference?: string;
    indexBuildId?: string;
    limit?: number;
    language?: string;
    includeContext?: boolean;
    contextBefore?: number;
    contextAfter?: number;
    contextCharacters?: number;
    rerank?: boolean;
    rerankCandidates?: number;
}

export interface ProjectChunksInput {
    path: string;
    projectReference?: string;
    indexBuildId?: string;
    start?: number;
    limit?: number;
}

export interface DocumentationSearchInput {
    query: string;
    documentationReference: string;
    sourceIds?: readonly string[];
    tags?: readonly string[];
    limit?: number;
    includeContext?: boolean;
    contextBefore?: number;
    contextAfter?: number;
    contextCharacters?: number;
    rerank?: boolean;
    rerankCandidates?: number;
}
