export type BoundaryAffinity = "backward" | "either" | "forward";

export interface SourceFragment {
    startOffset: number;
    endOffset: number;
    kind?: string;
    boundaryAffinity?: BoundaryAffinity;
}
