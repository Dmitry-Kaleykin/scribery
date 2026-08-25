import ts from "@typescript/typescript6";

import {
    type CodeSymbolReference,
    SourcePositionIndex,
    type SyntaxImport,
    type SyntaxSymbol,
} from "../../../metadata/index.js";
import { throwIfChunkingAborted } from "../../utils/throw-if-aborted.js";

interface PendingNode {
    node: ts.Node;
    scope: readonly CodeSymbolReference[];
}

interface SymbolDescription extends CodeSymbolReference {
    startOffset: number;
    endOffset: number;
}

export function extractTypeScriptSemantics(
    sourceFile: ts.SourceFile,
    content: string,
    signal?: AbortSignal,
): { symbols: readonly SyntaxSymbol[]; imports: readonly SyntaxImport[] } {
    const sourcePositions = new SourcePositionIndex(content);
    const symbols: SyntaxSymbol[] = [];
    const imports: SyntaxImport[] = [];
    const pending: PendingNode[] = [{ node: sourceFile, scope: [] }];

    while (pending.length > 0) {
        throwIfChunkingAborted(signal, sourceFile.fileName);
        const current = pending.pop();

        if (current === undefined) break;

        const description = describeSymbol(current.node, sourceFile, content);
        const childScope = description === undefined
            ? current.scope
            : [...current.scope, symbolReference(description)];

        if (description !== undefined) {
            symbols.push({
                ...symbolReference(description),
                range: sourcePositions.createRange(
                    description.startOffset,
                    description.endOffset,
                ),
                scope: current.scope,
            });
        }

        const syntaxImport = extractImport(
            current.node,
            sourceFile,
            sourcePositions,
        );

        if (syntaxImport !== undefined) imports.push(syntaxImport);

        const children: ts.Node[] = [];
        ts.forEachChild(current.node, (child) => {
            children.push(child);
        });

        for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];

            if (child !== undefined) {
                pending.push({ node: child, scope: childScope });
            }
        }
    }

    return { symbols, imports };
}

function describeSymbol(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    content: string,
): SymbolDescription | undefined {
    const kind = symbolKind(node);
    const name = symbolName(node, sourceFile);

    if (kind === undefined || name === undefined) return undefined;

    const startOffset = node.pos;
    const endOffset = node.end;

    return {
        name,
        kind,
        signature: signatureFor(node, sourceFile, content),
        startOffset,
        endOffset,
    };
}

function symbolKind(node: ts.Node): string | undefined {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (ts.isGetAccessorDeclaration(node)) return "getter";
    if (ts.isSetAccessorDeclaration(node)) return "setter";
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
    if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))
    ) {
        return "function";
    }
    return undefined;
}

function symbolName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    if (ts.isConstructorDeclaration(node)) return "constructor";

    if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isVariableDeclaration(node)
    ) {
        return node.name?.getText(sourceFile).trim() || undefined;
    }

    return undefined;
}

function signatureFor(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    content: string,
): string {
    const startOffset = node.getStart(sourceFile);
    let endOffset = node.end;

    if (isFunctionLikeWithBody(node) && node.body !== undefined) {
        endOffset = node.body.getStart(sourceFile);
    } else if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node)
    ) {
        const openingBrace = content.indexOf("{", startOffset);

        if (openingBrace >= 0 && openingBrace < node.end) {
            endOffset = openingBrace;
        }
    } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))
    ) {
        const body = node.initializer.body;
        endOffset = body.getStart(sourceFile);
    }

    const signature = content.slice(startOffset, endOffset)
        .replace(/\s+/gu, " ")
        .trim();
    return signature.length <= 400
        ? signature
        : `${signature.slice(0, 397)}...`;
}

function isFunctionLikeWithBody(
    node: ts.Node,
): node is ts.FunctionLikeDeclaration & { body?: ts.ConciseBody } {
    return ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node);
}

function extractImport(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    sourcePositions: SourcePositionIndex,
): SyntaxImport | undefined {
    if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier)
    ) {
        return undefined;
    }

    const bindings: string[] = [];
    const clause = node.importClause;

    if (clause?.name !== undefined) bindings.push(clause.name.text);

    if (clause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.push(clause.namedBindings.name.text);
        } else {
            for (const element of clause.namedBindings.elements) {
                bindings.push(element.name.text);
            }
        }
    }

    return {
        source: node.moduleSpecifier.text,
        bindings,
        range: sourcePositions.createRange(node.pos, node.end),
    };
}

function symbolReference(
    symbol: CodeSymbolReference,
): CodeSymbolReference {
    return {
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
    };
}
