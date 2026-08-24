import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextEncoder } from "node:util";

import {
    DecodingError,
    DefaultDocumentDecoder,
    ENCODING,
    normalizeEncodingLabel,
} from "../index.js";
import type { ByteSource } from "../index.js";
import type { EncodingSelection } from "../index.js";
import { FakeByteSource } from "./fake-byte-source.js";

const UTF_8_ENCODER = new TextEncoder();
const decoder = new DefaultDocumentDecoder();

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

async function decode(
    path: string,
    bytes: Uint8Array,
    encodingSelection: EncodingSelection = {},
) {
    return decoder.decode({
        path,
        bytes: FakeByteSource.fromBytes(bytes, 2),
        encodingSelection,
    });
}

function expectDecodingError(
    error: unknown,
    code: DecodingError["code"],
): boolean {
    assert.ok(error instanceof DecodingError);
    assert.equal(error.code, code);
    return true;
}

describe("DefaultDocumentDecoder", () => {
    it("strictly decodes UTF-8 and preserves CRLF and whitespace", async () => {
        const content = "const message = \"Привет 👋\";\r\n  \r\n";
        const result = await decode("src/message.ts", utf8(content));

        assert.equal(result.content, content);
        assert.equal(result.encoding, ENCODING.UTF_8);
        assert.equal(result.byteLength, utf8(content).byteLength);
        assert.deepEqual(result.diagnostics, [
            {
                code: "encoding-selected",
                encoding: ENCODING.UTF_8,
                source: "utf-8-validation",
            },
        ]);
    });

    it("removes a UTF-8 byte-order mark split across source chunks", async () => {
        const content = "export const value = 1;";
        const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(content)]);
        const result = await decode("src/value.ts", bytes);

        assert.equal(result.content, content);
        assert.equal(result.byteLength, bytes.byteLength);
        assert.equal(result.diagnostics[0]?.source, "byte-order-mark");
    });

    it("decodes an empty file as UTF-8", async () => {
        const result = await decode("src/empty.ts", new Uint8Array());

        assert.equal(result.content, "");
        assert.equal(result.encoding, ENCODING.UTF_8);
        assert.equal(result.byteLength, 0);
    });

    it("decodes Windows-1251 through the configured fallback", async () => {
        const result = await decode("legacy/greeting.ts", windows1251Greeting(), {
            fallback: "windows-1251",
        });

        assert.equal(result.content, "Привет, мир!");
        assert.equal(result.encoding, ENCODING.WINDOWS_1251);
        assert.equal(result.diagnostics[0]?.source, "fallback");
    });

    it("treats ASCII-only input as UTF-8 even when fallback is enabled", async () => {
        const result = await decode("legacy/ascii.ts", utf8("const value = 7;"), {
            fallback: "windows-1251",
        });

        assert.equal(result.encoding, ENCODING.UTF_8);
        assert.equal(result.diagnostics[0]?.source, "utf-8-validation");
    });

    it("honors an explicit Windows-1251 override", async () => {
        const result = await decode("legacy/greeting.ts", windows1251Greeting(), {
            override: "cp1251",
        });

        assert.equal(result.content, "Привет, мир!");
        assert.equal(result.encoding, ENCODING.WINDOWS_1251);
        assert.equal(result.diagnostics[0]?.source, "override");
    });

    it("supports UTF-8 and Windows-1251 files in the same run", async () => {
        const [modern, legacy] = await Promise.all([
            decode("modern/code.ts", utf8("const greeting = \"Привет\";"), {
                fallback: "windows-1251",
            }),
            decode("legacy/code.ts", windows1251Greeting(), {
                fallback: "windows-1251",
            }),
        ]);

        assert.equal(modern.encoding, ENCODING.UTF_8);
        assert.equal(legacy.encoding, ENCODING.WINDOWS_1251);
    });

    it("rejects malformed UTF-8 when no fallback is configured", async () => {
        await assert.rejects(
            decode("unknown/code.ts", Uint8Array.of(0xc3, 0x28)),
            (error: unknown) => expectDecodingError(error, "unsupported-encoding"),
        );
    });

    it("reports malformed input for an explicit UTF-8 override", async () => {
        await assert.rejects(
            decode("broken/code.ts", Uint8Array.of(0xc3, 0x28), {
                override: "utf8",
            }),
            (error: unknown) => expectDecodingError(error, "malformed-input"),
        );
    });

    it("rejects unsupported encoding labels before reading", async () => {
        let wasRead = false;
        const bytes: ByteSource = {
            async *read() {
                wasRead = true;
                yield utf8("content");
            },
        };

        await assert.rejects(
            decoder.decode({
                path: "code.ts",
                bytes,
                encodingSelection: {
                    override: "utf-16",
                } as unknown as EncodingSelection,
            }),
            (error: unknown) =>
                expectDecodingError(error, "unsupported-encoding"),
        );
        assert.equal(wasRead, false);
    });

    it("enforces the configured byte limit while reading", async () => {
        await assert.rejects(
            decoder.decode(
                {
                    path: "large.ts",
                    bytes: FakeByteSource.fromBytes(utf8("12345"), 2),
                    encodingSelection: {},
                },
                { maxByteLength: 4 },
            ),
            (error: unknown) =>
                expectDecodingError(error, "maximum-byte-length-exceeded"),
        );
    });

    it("copies chunks from byte sources that reuse their buffers", async () => {
        const bytes: ByteSource = {
            async *read() {
                const reusableBuffer = utf8("abc");
                yield reusableBuffer;
                reusableBuffer.set(utf8("def"));
                yield reusableBuffer;
            },
        };
        const result = await decoder.decode({
            path: "reused-buffer.ts",
            bytes,
            encodingSelection: {},
        });

        assert.equal(result.content, "abcdef");
    });

    it("rejects invalid byte limits before reading", async () => {
        let wasRead = false;
        const bytes: ByteSource = {
            async *read() {
                wasRead = true;
                yield utf8("content");
            },
        };

        await assert.rejects(
            decoder.decode(
                {
                    path: "code.ts",
                    bytes,
                    encodingSelection: {},
                },
                { maxByteLength: -1 },
            ),
            (error: unknown) => expectDecodingError(error, "invalid-options"),
        );
        assert.equal(wasRead, false);
    });

    it("wraps byte-source failures without exposing content", async () => {
        const cause = new Error("disk failure");

        await assert.rejects(
            decoder.decode({
                path: "unreadable.ts",
                bytes: new FakeByteSource([utf8("secret")], cause),
                encodingSelection: {},
            }),
            (error: unknown) => {
                assert.ok(error instanceof DecodingError);
                assert.equal(error.code, "io-error");
                assert.equal(error.cause, cause);
                assert.doesNotMatch(error.message, /secret/);
                return true;
            },
        );
    });

    it("returns a structured cancellation error", async () => {
        const controller = new AbortController();
        controller.abort("test cancellation");

        await assert.rejects(
            decoder.decode(
                {
                    path: "cancelled.ts",
                    bytes: FakeByteSource.fromBytes(utf8("content")),
                    encodingSelection: {},
                },
                { signal: controller.signal },
            ),
            (error: unknown) => expectDecodingError(error, "cancelled"),
        );
    });

    it("preserves cancellation when a byte source observes it mid-read", async () => {
        const controller = new AbortController();
        const bytes: ByteSource = {
            async *read(options) {
                yield utf8("first");
                controller.abort("cancelled during read");
                options.signal?.throwIfAborted();
            },
        };

        await assert.rejects(
            decoder.decode(
                {
                    path: "cancelled-during-read.ts",
                    bytes,
                    encodingSelection: {},
                },
                { signal: controller.signal },
            ),
            (error: unknown) => expectDecodingError(error, "cancelled"),
        );
    });
});

describe("normalizeEncodingLabel", () => {
    it("normalizes supported boundary aliases", () => {
        assert.equal(normalizeEncodingLabel(" UTF8 "), ENCODING.UTF_8);
        assert.equal(normalizeEncodingLabel("CP1251"), ENCODING.WINDOWS_1251);
        assert.equal(normalizeEncodingLabel("utf-16"), undefined);
    });
});
