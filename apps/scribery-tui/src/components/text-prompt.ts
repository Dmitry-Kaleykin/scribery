import {
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";

import { colors } from "../theme.js";

export interface TextPromptOptions {
    title: string;
    label?: string;
    initialValue?: string;
    maskInput?: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
    requestRender: () => void;
}

export class TextPrompt implements Component, Focusable {
    readonly #title: string;
    readonly #label: string;
    readonly #input = new Input();
    readonly #onSubmit: (value: string) => void;
    readonly #onCancel: () => void;
    readonly #requestRender: () => void;
    readonly #maskInput: boolean;
    #focused = false;

    constructor(options: TextPromptOptions) {
        this.#title = options.title;
        this.#label = options.label ?? ">";
        this.#onSubmit = options.onSubmit;
        this.#onCancel = options.onCancel;
        this.#requestRender = options.requestRender;
        this.#maskInput = options.maskInput ?? false;
        this.#input.setValue(options.initialValue ?? "");
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        this.#input.focused = value;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.#onCancel();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            this.#onSubmit(this.#input.getValue());
            return;
        }
        this.#input.handleInput(data);
        this.#requestRender();
    }

    render(width: number): string[] {
        const line = colors.muted("─".repeat(Math.max(0, width)));
        const label = `  ${colors.accent(this.#label)} `;
        const inputWidth = Math.max(1, width - 6 - this.#label.length);
        const renderedInput = this.#maskInput
            ? this.#renderMaskedInput(inputWidth)
            : this.#input.render(inputWidth)[0] ?? "";
        return [
            line,
            truncateToWidth(`  ${colors.bold(colors.accent(this.#title))}`, width),
            "",
            truncateToWidth(`${label}${renderedInput}`, width),
            "",
            truncateToWidth(`  ${colors.muted("Enter confirm · Esc cancel")}`, width),
            line,
        ];
    }

    invalidate(): void {
        this.#input.invalidate();
    }

    #renderMaskedInput(width: number): string {
        const value = this.#input.getValue();
        // Input keeps its cursor when setValue receives a string of the same
        // UTF-16 length, so navigation and horizontal scrolling still work.
        this.#input.setValue("•".repeat(value.length));
        try {
            return this.#input.render(width)[0] ?? "";
        } finally {
            this.#input.setValue(value);
        }
    }
}
