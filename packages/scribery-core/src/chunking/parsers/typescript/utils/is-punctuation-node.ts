import ts from "@typescript/typescript6";

export function isPunctuationNode(node: ts.Node): boolean {
    return node.kind >= ts.SyntaxKind.FirstPunctuation &&
        node.kind <= ts.SyntaxKind.LastPunctuation;
}
