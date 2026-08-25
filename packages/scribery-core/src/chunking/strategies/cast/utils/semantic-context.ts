import type {
    ChunkSemanticContext,
    CodeImportReference,
    CodeSymbolReference,
    SyntaxImport,
    SyntaxSymbol,
} from "../../../../metadata/index.js";
import type { NormalizedSyntaxTree } from "../../../contracts/syntax-tree.js";
import type { SourceFragment } from "../contracts/fragment.js";

export function semanticContextFor(
    fragment: SourceFragment,
    tree: NormalizedSyntaxTree,
    content: string,
): ChunkSemanticContext | undefined {
    const symbols = tree.symbols ?? [];
    const imports = tree.imports ?? [];
    const chunkContent = content.slice(fragment.startOffset, fragment.endOffset);
    const scope = enclosingScope(fragment, symbols);
    const definedSymbols = symbols
        .filter((symbol) =>
            symbol.range.startOffset >= fragment.startOffset &&
            symbol.range.startOffset < fragment.endOffset
        )
        .map(toSymbolReference);
    const referencedImports = imports
        .filter((syntaxImport) => importIsRelevant(
            syntaxImport,
            fragment,
            chunkContent,
        ))
        .map(toImportReference);

    if (
        scope.length === 0 &&
        definedSymbols.length === 0 &&
        referencedImports.length === 0
    ) {
        return undefined;
    }

    return {
        scope: uniqueSymbols(scope),
        symbols: uniqueSymbols(definedSymbols),
        imports: uniqueImports(referencedImports),
    };
}

function enclosingScope(
    fragment: SourceFragment,
    symbols: readonly SyntaxSymbol[],
): readonly CodeSymbolReference[] {
    const containing = symbols
        .filter((symbol) =>
            symbol.range.startOffset <= fragment.startOffset &&
            symbol.range.endOffset >= fragment.endOffset
        )
        .sort((left, right) =>
            rangeSize(left) - rangeSize(right) ||
            left.range.startOffset - right.range.startOffset
        )[0];

    return containing === undefined
        ? []
        : [...containing.scope, toSymbolReference(containing)];
}

function importIsRelevant(
    syntaxImport: SyntaxImport,
    fragment: SourceFragment,
    chunkContent: string,
): boolean {
    if (
        syntaxImport.range.startOffset < fragment.endOffset &&
        syntaxImport.range.endOffset > fragment.startOffset
    ) {
        return true;
    }

    return syntaxImport.bindings.some((binding) => {
        const escapedBinding = escapeRegExp(binding);
        const pattern = `(?:^|[^\\p{ID_Continue}$])${escapedBinding}` +
            "(?:$|[^\\p{ID_Continue}$])";
        return new RegExp(pattern, "u").test(chunkContent);
    });
}

function toSymbolReference(symbol: SyntaxSymbol): CodeSymbolReference {
    return {
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
    };
}

function toImportReference(syntaxImport: SyntaxImport): CodeImportReference {
    return {
        source: syntaxImport.source,
        bindings: syntaxImport.bindings,
    };
}

function uniqueSymbols(
    symbols: readonly CodeSymbolReference[],
): readonly CodeSymbolReference[] {
    const seen = new Set<string>();

    return symbols.filter((symbol) => {
        const key = `${symbol.kind}\0${symbol.name}\0${symbol.signature}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function uniqueImports(
    imports: readonly CodeImportReference[],
): readonly CodeImportReference[] {
    const seen = new Set<string>();

    return imports.filter((syntaxImport) => {
        const key = `${syntaxImport.source}\0${syntaxImport.bindings.join("\0")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function rangeSize(symbol: SyntaxSymbol): number {
    return symbol.range.endOffset - symbol.range.startOffset;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
