import type {
    SourceRange,
    SyntaxImport,
    SyntaxSymbol,
} from "../../metadata/index.js";

export interface SyntaxNode {
    type: string;
    range: SourceRange;
    children: readonly SyntaxNode[];
}

export interface NormalizedSyntaxTree {
    parserId: string;
    root: SyntaxNode;
    symbols?: readonly SyntaxSymbol[];
    imports?: readonly SyntaxImport[];
}
