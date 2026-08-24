export interface SourceRange {
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
}

export interface SourceSlice {
    range: SourceRange;
    content: string;
}
