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
    onDelete?: (item: SelectItem) => void;
    onCancel: () => void;
    requestRender: () => void;
    maxVisible?: number;
    initialFilter?: string;
    allowCustomValue?: boolean;
}

export class Picker implements Component, Focusable {
    readonly #title: string;
    readonly #input = new Input();
    #list: SelectList;
    readonly #options: PickerOptions;
    readonly #requestRender: () => void;
    readonly #onDelete: ((item: SelectItem) => void) | undefined;
    #focused = false;

    constructor(options: PickerOptions) {
        this.#options = options;
        this.#title = options.title;
        this.#requestRender = options.requestRender;
        this.#onDelete = options.onDelete;
        this.#list = this.#createList([...options.items]);
        if (options.initialFilter) {
            this.#input.setValue(options.initialFilter);
            this.#updateFilter();
        }
    }

    #createList(items: SelectItem[]): SelectList {
        const list = new SelectList(items, this.#options.maxVisible ?? 10, selectTheme);
        list.onSelect = this.#options.onSelect;
        list.onCancel = this.#options.onCancel;
        return list;
    }

    #updateFilter(): void {
        const value = this.#input.getValue().trim();
        if (!this.#options.allowCustomValue) {
            this.#list.setFilter(this.#input.getValue());
            return;
        }
        const filter = value.toLowerCase();
        const items = this.#options.items.filter((item) =>
            `${item.value} ${item.label}`.toLowerCase().includes(filter),
        );
        if (value && !items.some((item) => item.value === value)) {
            items.unshift({ value, label: `Use "${value}"`, description: "Use typed name" });
        }
        this.#list = this.#createList(items);
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        this.#input.focused = value;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("d")) && this.#onDelete !== undefined) {
            const selected = this.#list.getSelectedItem();

            if (selected !== null) this.#onDelete(selected);
            this.#requestRender();
            return;
        }

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
            this.#updateFilter();
        }
        this.#requestRender();
    }

    render(width: number): string[] {
        const innerWidth = Math.max(1, width - 4);
        const line = colors.muted("─".repeat(Math.max(0, width)));
        return [
            line,
            truncateToWidth(`  ${colors.bold(colors.accent(this.#title))}`, width),
            truncateToWidth(`  ${colors.muted(this.#options.allowCustomValue ? "Name" : "Filter")} ${this.#input.render(innerWidth - 9)[0] ?? ""}`, width),
            "",
            ...this.#list.render(innerWidth).map((item) => truncateToWidth(`  ${item}`, width)),
            "",
            truncateToWidth(
                `  ${colors.muted(
                    this.#options.allowCustomValue
                        ? "Type a name · ↑↓ suggestions · Enter use · Esc cancel"
                        : this.#onDelete === undefined
                        ? "↑↓ navigate · Enter select · Esc cancel"
                        : "↑↓ navigate · Enter select · Ctrl+D delete · Esc cancel",
                )}`,
                width,
            ),
            line,
        ];
    }

    invalidate(): void {
        this.#input.invalidate();
        this.#list.invalidate();
    }
}
