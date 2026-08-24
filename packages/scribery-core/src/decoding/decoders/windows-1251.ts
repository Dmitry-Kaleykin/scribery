import { TextDecoder } from "node:util";

const STRICT_WINDOWS_1251_DECODER = new TextDecoder("windows-1251", {
    fatal: true,
});

export function decodeWindows1251(bytes: Uint8Array): string {
    return STRICT_WINDOWS_1251_DECODER.decode(bytes);
}
