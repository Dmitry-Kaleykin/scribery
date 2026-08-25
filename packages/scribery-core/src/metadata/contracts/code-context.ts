import type { SourceRange } from "./source-position.js";

export interface CodeSymbolReference {
    name: string;
    kind: string;
    signature: string;
}

export interface CodeImportReference {
    source: string;
    bindings: readonly string[];
}

export interface SyntaxSymbol extends CodeSymbolReference {
    range: SourceRange;
    scope: readonly CodeSymbolReference[];
}

export interface SyntaxImport extends CodeImportReference {
    range: SourceRange;
}

export interface ChunkSemanticContext {
    scope: readonly CodeSymbolReference[];
    symbols: readonly CodeSymbolReference[];
    imports: readonly CodeImportReference[];
}
