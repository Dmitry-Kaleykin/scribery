import type { SupportedEncoding } from "../contracts/encoding.js";

export const ENCODING = {
    UTF_8: "utf-8",
    WINDOWS_1251: "windows-1251",
} as const satisfies Record<string, SupportedEncoding>;

export const UTF_8_BYTE_ORDER_MARK = Uint8Array.of(0xef, 0xbb, 0xbf);
