import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextEncoder } from "node:util";

import {
    ClassificationError,
    CONTENT_KIND,
    DefaultFileClassifier,
    FILE_TRAIT,
} from "../index.js";
import type { ClassificationInput } from "../index.js";
import { ENCODING } from "../../shared/index.js";

const UTF_8_ENCODER = new TextEncoder();
const classifier = new DefaultFileClassifier();

function utf8(content: string): Uint8Array {
    return UTF_8_ENCODER.encode(content);
}

function windows1251Greeting(): Uint8Array {
    return Uint8Array.of(
        0xcf,
        0xf0,
        0xe8,
        0xe2,
        0xe5,
        0xf2,
        0x2c,
        0x20,
        0xec,
        0xe8,
        0xf0,
        0x21,
    );
}

function input(
    path: string,
    sample: Uint8Array,
    overrides: Partial<ClassificationInput> = {},
): ClassificationInput {
    return {
        path,
        sample,
        byteLength: sample.byteLength,
        ...overrides,
    };
}

function expectClassificationError(
    error: unknown,
    code: ClassificationError["code"],
): boolean {
    assert.ok(error instanceof ClassificationError);
    assert.equal(error.code, code);
    return true;
}

describe("DefaultFileClassifier", () => {
    it("classifies UTF-8 TypeScript with deterministic evidence", () => {
        const classification = classifier.classify(
            input("src/example.ts", utf8("export const answer = 42;\n")),
        );

        assert.equal(classification.contentKind, CONTENT_KIND.TEXT);
        assert.equal(classification.encoding, ENCODING.UTF_8);
        assert.equal(classification.language, "typescript");
        assert.equal(classification.format, "typescript");
        assert.equal(classification.confidence, 0.98);
        assert.deepEqual(classification.traits, []);
        assert.deepEqual(
            classification.evidence.map((item) => [
                item.signal,
                item.conclusion.kind,
            ]),
            [
                ["byte-sample", "encoding"],
                ["byte-sample", "content-kind"],
                ["extension", "language"],
                ["extension", "format"],
            ],
        );
    });

    it("detects and reports a UTF-8 byte-order mark", () => {
        const bytes = Uint8Array.from([
            0xef,
            0xbb,
            0xbf,
            ...utf8("const value = 1;"),
        ]);
        const classification = classifier.classify(input("value.ts", bytes));

        assert.equal(classification.encoding, ENCODING.UTF_8);
        assert.equal(classification.evidence[0]?.signal, "byte-order-mark");
    });

    it("uses a configured Windows-1251 fallback for invalid UTF-8", () => {
        const classification = classifier.classify(
            input("legacy/greeting.cs", windows1251Greeting(), {
                encodingSelection: { fallback: "windows-1251" },
            }),
        );

        assert.equal(classification.contentKind, CONTENT_KIND.TEXT);
        assert.equal(classification.encoding, ENCODING.WINDOWS_1251);
        assert.equal(classification.language, "c-sharp");
        assert.equal(classification.evidence[0]?.detail, "fallback");
    });

    it("honors an explicit Windows-1251 override", () => {
        const classification = classifier.classify(
            input("legacy/greeting.cs", windows1251Greeting(), {
                encodingSelection: { override: "cp1251" },
            }),
        );

        assert.equal(classification.encoding, ENCODING.WINDOWS_1251);
        assert.equal(classification.evidence[0]?.signal, "configuration");
        assert.equal(classification.evidence[0]?.detail, "override");
    });

    it("does not coerce invalid UTF-8 to text from its extension", () => {
        const classification = classifier.classify(
            input("looks-like-code.ts", Uint8Array.of(0xc3, 0x28)),
        );

        assert.equal(classification.contentKind, CONTENT_KIND.UNKNOWN);
        assert.equal(classification.encoding, undefined);
        assert.equal(classification.language, "typescript");
    });

    it("classifies NUL-containing and signature-matched samples as binary", () => {
        const nulClassification = classifier.classify(
            input("fake.ts", Uint8Array.of(0x63, 0x00, 0x64)),
        );
        const pngClassification = classifier.classify(
            input(
                "image.png",
                Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
            ),
        );

        assert.equal(nulClassification.contentKind, CONTENT_KIND.BINARY);
        assert.equal(nulClassification.language, undefined);
        assert.equal(pngClassification.contentKind, CONTENT_KIND.BINARY);
        assert.match(pngClassification.evidence[0]?.detail ?? "", /png/);
    });

    it("does not reject a partial UTF-8 sample ending inside a character", () => {
        const completeBytes = utf8("Ж");
        const classification = classifier.classify(
            input("partial.ts", completeBytes.subarray(0, 1), {
                byteLength: completeBytes.byteLength,
            }),
        );

        assert.equal(classification.encoding, ENCODING.UTF_8);
        assert.notEqual(classification.contentKind, CONTENT_KIND.BINARY);
    });

    it("lets shebang evidence take precedence over an unrelated extension", () => {
        const classification = classifier.classify(
            input("scripts/build.txt", utf8("#!/usr/bin/env python3\nprint('ok')\n")),
        );

        assert.equal(classification.language, "python");
        assert.equal(classification.format, "python");
        assert.equal(classification.evidence[2]?.signal, "shebang");
    });

    it("returns traits in canonical order", () => {
        const classification = classifier.classify(
            input(
                "dist/tests/client.generated.spec.min.js",
                utf8("// @generated - do not edit\nconst value=1;"),
            ),
        );

        assert.deepEqual(classification.traits, [
            FILE_TRAIT.GENERATED,
            FILE_TRAIT.MINIFIED,
            FILE_TRAIT.TEST,
        ]);
    });

    it("classifies lockfiles, configuration, documentation, and empty files", () => {
        const lockfile = classifier.classify(
            input("package-lock.json", utf8("{}")),
        );
        const readme = classifier.classify(input("README.md", new Uint8Array()));

        assert.deepEqual(lockfile.traits, [
            FILE_TRAIT.LOCKFILE,
            FILE_TRAIT.CONFIGURATION,
        ]);
        assert.deepEqual(readme.traits, [
            FILE_TRAIT.DOCUMENTATION,
            FILE_TRAIT.EMPTY,
        ]);
    });

    it("recognizes declaration files", () => {
        const classification = classifier.classify(
            input("src/public-api.d.ts", utf8("export interface Api {}\n")),
        );

        assert.deepEqual(classification.traits, [FILE_TRAIT.DECLARATION]);
    });

    it("classifies project code and template formats by extension", () => {
        const fixtures = [
            {
                path: "public/index.php",
                content: "<?php echo 'hello';\n",
                language: "php",
                format: "php",
                detail: ".php",
            },
            {
                path: "legacy/bootstrap.INC",
                content: "<?php require_once 'config.php';\n",
                language: "php",
                format: "php",
                detail: ".inc",
            },
            {
                path: "templates/page.html.twig",
                content: "<h1>{{ title }}</h1>\n",
                language: "twig",
                format: "twig",
                detail: ".twig",
            },
            {
                path: "src/components/App.vue",
                content: "<template><main>Hello</main></template>\n",
                language: "vue",
                format: "vue",
                detail: ".vue",
            },
            {
                path: "styles/app.css",
                content: ".app { color: blue; }\n",
                language: "css",
                format: "css",
                detail: ".css",
            },
            {
                path: "styles/theme.SCSS",
                content: "$brand: blue;\n.app { color: $brand; }\n",
                language: "scss",
                format: "scss",
                detail: ".scss",
            },
        ] as const;

        for (const fixture of fixtures) {
            const classification = classifier.classify(
                input(fixture.path, utf8(fixture.content)),
            );
            const languageEvidence = classification.evidence.find(
                ({ conclusion }) => conclusion.kind === "language",
            );
            const formatEvidence = classification.evidence.find(
                ({ conclusion }) => conclusion.kind === "format",
            );

            assert.equal(classification.contentKind, CONTENT_KIND.TEXT);
            assert.equal(classification.encoding, ENCODING.UTF_8);
            assert.equal(classification.language, fixture.language);
            assert.equal(classification.format, fixture.format);
            assert.deepEqual(languageEvidence, {
                signal: "extension",
                conclusion: {
                    kind: "language",
                    value: fixture.language,
                },
                confidence: 0.85,
                detail: fixture.detail,
            });
            assert.deepEqual(formatEvidence, {
                signal: "extension",
                conclusion: {
                    kind: "format",
                    value: fixture.format,
                },
                confidence: 0.85,
                detail: fixture.detail,
            });
        }
    });

    it("returns identical results for identical inputs", () => {
        const classificationInput = input(
            "src/repeatable.ts",
            utf8("export const value = 1;\n"),
        );

        assert.deepEqual(
            classifier.classify(classificationInput),
            classifier.classify(classificationInput),
        );
    });

    it("rejects invalid input and unsupported runtime encoding labels", () => {
        assert.throws(
            () => classifier.classify(input("", new Uint8Array())),
            (error: unknown) =>
                expectClassificationError(error, "invalid-input"),
        );
        assert.throws(
            () =>
                classifier.classify(
                    input("code.ts", utf8("content"), {
                        encodingSelection: {
                            override: "utf-16",
                        } as unknown as NonNullable<
                            ClassificationInput["encodingSelection"]
                        >,
                    }),
                ),
            (error: unknown) =>
                expectClassificationError(error, "unsupported-encoding"),
        );
    });
});
