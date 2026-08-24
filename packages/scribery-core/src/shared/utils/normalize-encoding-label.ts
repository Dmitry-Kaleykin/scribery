import { ENCODING } from "../constants/encoding.js";
import type { SupportedEncoding } from "../contracts/encoding.js";

const NORMALIZED_ENCODING_LABELS: Readonly<Record<string, SupportedEncoding>> = {
    "utf-8": ENCODING.UTF_8,
    utf8: ENCODING.UTF_8,
    "windows-1251": ENCODING.WINDOWS_1251,
    windows1251: ENCODING.WINDOWS_1251,
    cp1251: ENCODING.WINDOWS_1251,
    win1251: ENCODING.WINDOWS_1251,
};

export function normalizeEncodingLabel(
    label: string,
): SupportedEncoding | undefined {
    return NORMALIZED_ENCODING_LABELS[label.trim().toLowerCase()];
}
