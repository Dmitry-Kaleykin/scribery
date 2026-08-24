import { TextDecoder } from "node:util";

import { UTF_8_BYTE_ORDER_MARK } from "../../shared/constants/encoding.js";

const STRICT_UTF_8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function hasUtf8ByteOrderMark(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= UTF_8_BYTE_ORDER_MARK.byteLength &&
        bytes[0] === UTF_8_BYTE_ORDER_MARK[0] &&
        bytes[1] === UTF_8_BYTE_ORDER_MARK[1] &&
        bytes[2] === UTF_8_BYTE_ORDER_MARK[2]
    );
}

export function decodeUtf8(bytes: Uint8Array): string {
    const contentBytes = hasUtf8ByteOrderMark(bytes)
        ? bytes.subarray(UTF_8_BYTE_ORDER_MARK.byteLength)
        : bytes;

    return STRICT_UTF_8_DECODER.decode(contentBytes);
}
