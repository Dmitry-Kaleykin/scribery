import { isDeepStrictEqual } from "node:util";
import { formatError } from "../services/error-formatter.js";
import type { FeatureUi } from "./contracts.js";

export interface Setting<T> {
    value: string;
    label: string;
    description: string;
    edit(current: T): Promise<T | undefined>;
}

/** Each edit is saved independently; cancelled/invalid edits leave the menu open. */
export async function editSettings<T>(options: {
    ui: Pick<FeatureUi, "pick" | "append">;
    title: string;
    read(): Promise<T>;
    save(value: T): Promise<unknown>;
    settings(current: T): readonly Setting<T>[];
}): Promise<void> {
    while (true) {
        const current = await options.read();
        const settings = options.settings(current);
        const selection = await options.ui.pick(options.title, [
            ...settings.map(({ value, label, description }) => ({ value, label, description })),
            { value: "__done", label: "Done", description: "Changes are saved as you make them" },
        ]);
        if (selection === undefined || selection.value === "__done") return;
        const setting = settings.find(({ value }) => value === selection.value);
        if (setting === undefined) continue;
        try {
            const updated = await setting.edit(current);
            if (updated === undefined || isDeepStrictEqual(updated, current)) continue;
            await options.save(updated);
            options.ui.append(`Updated ${setting.label.toLowerCase()}.`, "success");
        } catch (error: unknown) {
            options.ui.append(formatError(error), "warning");
        }
    }
}
