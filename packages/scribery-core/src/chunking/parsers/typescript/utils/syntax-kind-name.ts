import ts from "@typescript/typescript6";

const SYNTAX_KIND_NAME_BY_VALUE = createSyntaxKindNameMap();

export function syntaxKindName(kind: ts.SyntaxKind): string {
    return SYNTAX_KIND_NAME_BY_VALUE.get(kind) ?? `SyntaxKind${kind}`;
}

function createSyntaxKindNameMap(): ReadonlyMap<number, string> {
    const names = new Map<number, string>();

    for (const [name, value] of Object.entries(ts.SyntaxKind)) {
        if (
            typeof value !== "number" ||
            name.startsWith("First") ||
            name.startsWith("Last") ||
            name.endsWith("Count")
        ) {
            continue;
        }

        if (!names.has(value)) {
            names.set(value, name);
        }
    }

    return names;
}
