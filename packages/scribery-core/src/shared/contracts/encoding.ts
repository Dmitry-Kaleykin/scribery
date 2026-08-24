export type SupportedEncoding = "utf-8" | "windows-1251";

export type Utf8EncodingLabel = "utf-8" | "utf8";

export type Windows1251EncodingLabel =
    | "windows-1251"
    | "windows1251"
    | "cp1251"
    | "win1251";

export type EncodingLabel = Utf8EncodingLabel | Windows1251EncodingLabel;

export interface EncodingSelection {
    override?: EncodingLabel;
    fallback?: Windows1251EncodingLabel;
}

export type EncodingSelectionSource =
    | "override"
    | "byte-order-mark"
    | "utf-8-validation"
    | "fallback";
