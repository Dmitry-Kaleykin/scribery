import { createHash } from "node:crypto";

import { CONTENT_HASH_ALGORITHM } from "../constants/schema.js";

export function hashBytes(bytes: Uint8Array): string {
    return prefixedHash(createHash(CONTENT_HASH_ALGORITHM).update(bytes).digest("hex"));
}

export function hashText(content: string): string {
    return prefixedHash(
        createHash(CONTENT_HASH_ALGORITHM).update(content, "utf8").digest("hex"),
    );
}

function prefixedHash(hex: string): string {
    return `${CONTENT_HASH_ALGORITHM}:${hex}`;
}
