export const FILTERABLE_METADATA_FIELDS = [
    "path",
    "language",
    "format",
    "extension",
    "traits",
    "chunkingStrategy",
    "chunkKind",
    "sourceId",
    "tags",
] as const;

const FILTERABLE_METADATA_FIELD_SET: ReadonlySet<string> = new Set(
    FILTERABLE_METADATA_FIELDS,
);

export type FilterableMetadataField =
    (typeof FILTERABLE_METADATA_FIELDS)[number];

export function isFilterableMetadataField(
    field: string,
): field is FilterableMetadataField {
    return FILTERABLE_METADATA_FIELD_SET.has(field);
}
