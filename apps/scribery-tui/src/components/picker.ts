import {
    Input,
    Key,
    matchesKey,
    SelectList,
    type SelectItem,
    truncateToWidth,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";

import { colors, selectTheme } from "../theme.js";

export interface PickerOptions {
    title: string;
    items: readonly SelectItem[];
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
    requestRender: () => void;
    maxVisible?: number;
    initialFilter?: string;
}

export class Picker implements Component, Focusable {
    readonly #title: string;
    readonly #input = new Input();
    readonly #list: SelectList;
    readonly #requestRender: () => void;
    #focused = false;

    constructor(options: PickerOptions) {
        this.#title = options.title;
        this.#requestRender = options.requestRender;
        this.#list = new SelectList(
            [...options.items],
            options.maxVisible ?? 10,
            selectTheme,
        );
        this.#list.onSelect = options.onSelect;
        this.#list.onCancel = options.onCancel;
        if (options.initialFilter) {
            this.#input.setValue(options.initialFilter);
            this.#list.setFilter(options.initialFilter);
        }
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        this.#input.focused = value;
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl("c"))
        ) {
            this.#list.handleInput(data);
        } else {
            this.#input.handleInput(data);
            this.#list.setFilter(this.#input.getValue());
        }
        this.#requestRender();
    }

    render(width: number): string[] {
        const innerWidth = Math.max(1, width - 4);
        const line = colors.muted("─".repeat(Math.max(0, width)));
        return [
            line,
            truncateToWidth(`  ${colors.bold(colors.accent(this.#title))}`, width),
            truncateToWidth(`  ${colors.muted("Filter")} ${this.#input.render(innerWidth - 9)[0] ?? ""}`, width),
            "",
            ...this.#list.render(innerWidth).map((item) => truncateToWidth(`  ${item}`, width)),
            "",
            truncateToWidth(`  ${colors.muted("↑↓ navigate · Enter select · Esc cancel")}`, width),
            line,
        ];
    }

    invalidate(): void {
        this.#input.invalidate();
        this.#list.invalidate();
    }
}
