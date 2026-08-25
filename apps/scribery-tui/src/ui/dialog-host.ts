import {
    Editor,
    TuiMainScreen,
    type Component,
    type SelectItem,
} from "@earendil-works/pi-tui";

import { Picker } from "../components/picker.js";
import { TextPrompt } from "../components/text-prompt.js";

export class DialogHost {
    readonly #ui: TuiMainScreen;
    readonly #editor: Editor;
    readonly #editorArea: Component;
    #active = false;

    constructor(ui: TuiMainScreen, editor: Editor, editorArea: Component) {
        this.#ui = ui;
        this.#editor = editor;
        this.#editorArea = editorArea;
    }

    get active(): boolean {
        return this.#active;
    }

    async pick(
        title: string,
        items: readonly SelectItem[],
    ): Promise<SelectItem | undefined> {
        if (items.length === 0) return undefined;
        return new Promise((resolveSelection) => {
            this.#active = true;
            let settled = false;
            const finish = (item?: SelectItem): void => {
                if (settled) return;
                settled = true;
                this.#active = false;
                this.#ui.removeChild(picker);
                this.#ui.addChild(this.#editorArea);
                this.#ui.setFocus(this.#editor);
                this.#ui.requestRender(true);
                resolveSelection(item);
            };
            const picker = new Picker({
                title,
                items,
                onSelect: (item) => finish(item),
                onCancel: () => finish(),
                requestRender: () => this.#ui.requestRender(),
            });
            this.#ui.removeChild(this.#editorArea);
            this.#ui.addChild(picker);
            this.#ui.setFocus(picker);
            this.#ui.requestRender(true);
        });
    }

    input(
        title: string,
        label: string,
        initialValue?: string,
    ): Promise<string | undefined> {
        return this.#promptInput(title, label, initialValue, false);
    }

    secretInput(title: string, label: string): Promise<string | undefined> {
        return this.#promptInput(title, label, undefined, true);
    }

    async confirm(title: string, defaultYes = true): Promise<boolean> {
        const selected = await this.pick(title, defaultYes ? [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
        ] : [
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
        ]);
        return selected?.value === "yes";
    }

    #promptInput(
        title: string,
        label: string,
        initialValue: string | undefined,
        maskInput: boolean,
    ): Promise<string | undefined> {
        return new Promise((resolveInput) => {
            this.#active = true;
            let settled = false;
            const finish = (value?: string): void => {
                if (settled) return;
                settled = true;
                this.#active = false;
                this.#ui.removeChild(prompt);
                this.#ui.addChild(this.#editorArea);
                this.#ui.setFocus(this.#editor);
                this.#ui.requestRender(true);
                resolveInput(value);
            };
            const prompt = new TextPrompt({
                title,
                label,
                ...(initialValue === undefined ? {} : { initialValue }),
                ...(maskInput ? { maskInput: true } : {}),
                onSubmit: (value) => finish(value),
                onCancel: () => finish(),
                requestRender: () => this.#ui.requestRender(),
            });
            this.#ui.removeChild(this.#editorArea);
            this.#ui.addChild(prompt);
            this.#ui.setFocus(prompt);
            this.#ui.requestRender(true);
        });
    }
}
