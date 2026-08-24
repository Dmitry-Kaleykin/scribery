import { basename } from "node:path";

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { colors } from "../theme.js";

export class PromptLabelComponent implements Component {
    #root: string | undefined;
    #busy = false;

    setState(root: string | undefined, busy: boolean): void {
        this.#root = root;
        this.#busy = busy;
    }

    render(width: number): string[] {
        const scope = this.#root ? basename(this.#root) : "current directory";
        const suffix = this.#busy ? colors.warning(" · working") : "";
        return [truncateToWidth(`${colors.muted("Search")} ${colors.accent(scope)}${suffix}`, width)];
    }

    invalidate(): void {}
}
