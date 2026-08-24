import { parseArgs } from "node:util";

import { ProjectRetrievalTargetService } from "scribery-code";
import { required } from "../arguments/values.js";

export async function runRetrievalCommand(
    args: readonly string[],
): Promise<void> {
    const [action, ...actionArguments] = args;
    const service = new ProjectRetrievalTargetService();

    if (action === "list" || action === "status") {
        const parsed = parseArgs({
            args: actionArguments,
            options: { project: { type: "string" } },
        });
        const result = action === "list"
            ? await service.list(parsed.values.project)
            : await service.status(parsed.values.project);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "set") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: {
                project: { type: "string" },
                build: { type: "string" },
                activate: { type: "boolean" },
            },
        });

        if (parsed.positionals.length !== 1) {
            throw new Error("retrieval set requires exactly one target name");
        }

        const project = await service.resolveProject(parsed.values.project);
        const result = await service.assignTarget(
            project.projectIdentifier,
            required(parsed.positionals[0], "target"),
            required(parsed.values.build, "--build"),
            parsed.values.activate === true,
        );
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "switch") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: {
                project: { type: "string" },
                build: { type: "string" },
            },
        });
        const target = parsed.positionals[0];

        if (
            parsed.positionals.length > 1 ||
            (target === undefined) === (parsed.values.build === undefined)
        ) {
            throw new Error(
                "retrieval switch requires either one target name or --build <indexBuildId>",
            );
        }

        const result = target === undefined
            ? await service.switchBuild(
                parsed.values.project,
                required(parsed.values.build, "--build"),
            )
            : await service.switchTarget(parsed.values.project, target);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "remove") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: { project: { type: "string" } },
        });

        if (parsed.positionals.length !== 1) {
            throw new Error("retrieval remove requires exactly one target name");
        }

        const result = await service.removeTarget(
            parsed.values.project,
            required(parsed.positionals[0], "target"),
        );
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "rename") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: { project: { type: "string" } },
        });

        if (parsed.positionals.length !== 2) {
            throw new Error(
                "retrieval rename requires the current and new target names",
            );
        }

        const result = await service.renameTarget(
            parsed.values.project,
            required(parsed.positionals[0], "current target"),
            required(parsed.positionals[1], "new target"),
        );
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    throw new Error(
        "retrieval requires one of: list, status, set, switch, rename, remove",
    );
}
