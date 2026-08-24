import {
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
} from "@earendil-works/pi-tui";
import type { RetrievalResult } from "scribery";

import { colors } from "../theme.js";

export interface SearchResultsOptions {
    query: string;
    results: readonly RetrievalResult[];
    onDone: () => void;
    onOpen?: (result: RetrievalResult) => void;
    requestRender: () => void;
}

export class SearchResultsComponent implements Component {
    readonly #query: string;
    readonly #results: readonly RetrievalResult[];
    readonly #onDone: () => void;
    readonly #onOpen: ((result: RetrievalResult) => void) | undefined;
    readonly #requestRender: () => void;
    #selected = 0;
    #expanded = false;

    constructor(options: SearchResultsOptions) {
        this.#query = options.query;
        this.#results = options.results;
        this.#onDone = options.onDone;
        this.#onOpen = options.onOpen;
        this.#requestRender = options.requestRender;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.up) && this.#selected > 0) {
            this.#selected -= 1;
            this.#expanded = false;
        } else if (matchesKey(data, Key.down) && this.#selected < this.#results.length - 1) {
            this.#selected += 1;
            this.#expanded = false;
        } else if (matchesKey(data, Key.enter)) {
            this.#expanded = !this.#expanded;
        } else if (data === "e" || data === "E") {
            const result = this.#results[this.#selected];
            if (result) this.#onOpen?.(result);
        } else if (matchesKey(data, Key.escape)) {
            this.#onDone();
            return;
        }
        this.#requestRender();
    }

    render(width: number): string[] {
        const lines = [
            truncateToWidth(`${colors.muted("Search")} ${this.#query}`, width),
            "",
        ];
        if (this.#results.length === 0) {
            lines.push(colors.warning("No matches"));
            return lines;
        }
        for (const [index, result] of this.#results.entries()) {
            const selected = index === this.#selected;
            const location = `${result.path}:${result.range.startLine}–${result.range.endLine}`;
            const score = result.score.toFixed(3);
            const prefix = selected ? colors.accent("›") : " ";
            const text = `${prefix} ${String(index + 1).padStart(2)}  ${location}  ${score}`;
            lines.push(truncateToWidth(selected ? colors.bold(text) : text, width));
            if (selected && this.#expanded) {
                lines.push(colors.muted("  " + "─".repeat(Math.max(0, width - 2))));
                for (const contentLine of result.content.split("\n").slice(0, 18)) {
                    lines.push(truncateToWidth(`  ${colors.dim("│")} ${contentLine}`, width));
                }
                if (result.content.split("\n").length > 18) {
                    lines.push(colors.muted("  … more content omitted"));
                }
            }
        }
        lines.push("", colors.muted(
            this.#onOpen
                ? "↑↓ select · Enter expand · E open in editor · Esc return"
                : "↑↓ select · Enter expand · Esc return",
        ));
        return lines;
    }

    invalidate(): void {}
}
