import { parseArgs } from "node:util";

import {
    IndexingPresetService,
    type IndexingPresetInput,
} from "scribery-core";
import {
    positiveInteger,
    required,
} from "../arguments/values.js";

export async function runPresetCommand(args: readonly string[]): Promise<void> {
    const [action, ...actionArguments] = args;
    const service = new IndexingPresetService();

    if (action === "list") {
        if (actionArguments.length > 0) {
            throw new Error("preset list does not accept arguments");
        }
        const presets = await service.list();
        console.log(JSON.stringify({ count: presets.length, presets }, null, 2));
        return;
    }

    if (action === "show" || action === "delete") {
        if (actionArguments.length !== 1) {
            throw new Error(`preset ${action} requires exactly one preset name`);
        }
        const name = required(actionArguments[0], "preset");
        const result = action === "show"
            ? await service.get(name)
            : await service.remove(name);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "rename") {
        if (actionArguments.length !== 2) {
            throw new Error(
                "preset rename requires the current and new preset names",
            );
        }
        console.log(JSON.stringify(
            await service.rename(
                required(actionArguments[0], "current preset"),
                required(actionArguments[1], "new preset"),
            ),
            null,
            2,
        ));
        return;
    }

    if (action === "set") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: {
                profile: { type: "string" },
                "chunk-size": { type: "string" },
                "windows-1251": { type: "boolean" },
                include: { type: "string", multiple: true },
                exclude: { type: "string", multiple: true },
            },
        });
        if (parsed.positionals.length !== 1) {
            throw new Error("preset set requires exactly one preset name");
        }
        const input: IndexingPresetInput = {
            name: required(parsed.positionals[0], "preset"),
            providerProfile: required(parsed.values.profile, "--profile"),
            ...(parsed.values["chunk-size"] === undefined
                ? {}
                : {
                    maximumChunkSize: positiveInteger(
                        parsed.values["chunk-size"],
                        "--chunk-size",
                    ),
                }),
            ...(parsed.values["windows-1251"] === true
                ? { windows1251: true }
                : {}),
            ...(parsed.values.include === undefined
                ? {}
                : { include: parsed.values.include }),
            ...(parsed.values.exclude === undefined
                ? {}
                : { exclude: parsed.values.exclude }),
        };
        console.log(JSON.stringify(await service.set(input), null, 2));
        return;
    }

    throw new Error(
        "preset requires one of: list, show, set, rename, delete",
    );
}
