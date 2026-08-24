import type {
    ChunkingDocument,
    CodeParserAdapter,
    NormalizedSyntaxTree,
    ParserOptions,
    ParserTarget,
} from "../index.js";

export type FakeParserImplementation = (
    document: ChunkingDocument,
    options: ParserOptions,
) => NormalizedSyntaxTree | Promise<NormalizedSyntaxTree>;

export class FakeParser implements CodeParserAdapter {
    readonly id: string;
    readonly targets: readonly ParserTarget[];
    readonly #implementation: FakeParserImplementation;
    parseCount = 0;

    constructor(
        id: string,
        targets: readonly ParserTarget[],
        implementation: FakeParserImplementation,
    ) {
        this.id = id;
        this.targets = targets;
        this.#implementation = implementation;
    }

    async parse(
        document: ChunkingDocument,
        options: ParserOptions = {},
    ): Promise<NormalizedSyntaxTree> {
        this.parseCount += 1;
        return this.#implementation(document, options);
    }
}
