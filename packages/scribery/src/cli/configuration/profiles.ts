import { parseArgs } from "node:util";

import {
    ProviderProfileService,
    type ProviderProfileInput,
} from "scribery-core";
import {
    positiveInteger,
    required,
} from "../arguments/values.js";
import { ProviderProfileRenameService } from "scribery-code";

export async function runProfileCommand(args: readonly string[]): Promise<void> {
    const [action, ...actionArguments] = args;
    const service = new ProviderProfileService({
        ...((process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) === undefined
            ? {}
            : { apiKey: (process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY) }),
    });

    if (action === "list") {
        if (actionArguments.length > 0) {
            throw new Error("profile list does not accept arguments");
        }
        const profiles = await service.list();
        console.log(JSON.stringify({ count: profiles.length, profiles }, null, 2));
        return;
    }

    if (action === "models") {
        const parsed = parseArgs({
            args: actionArguments,
            options: { "base-url": { type: "string" } },
        });
        const models = await service.listProviderModels(
            parsed.values["base-url"],
        );
        console.log(JSON.stringify({ count: models.length, models }, null, 2));
        return;
    }

    if (action === "inspect") {
        const parsed = parseArgs({
            args: actionArguments,
            allowPositionals: true,
            options: {
                "base-url": { type: "string" },
                "embedding-suffix": { type: "string" },
            },
        });
        if (parsed.positionals.length !== 1) {
            throw new Error("profile inspect requires one embedding model ID");
        }
        console.log(JSON.stringify(
            await service.inspectEmbeddingModel(
                required(parsed.positionals[0], "model"),
                parsed.values["base-url"],
                parsed.values["embedding-suffix"],
            ),
            null,
            2,
        ));
        return;
    }

    if (action === "show" || action === "test" || action === "delete") {
        if (actionArguments.length !== 1) {
            throw new Error(`profile ${action} requires exactly one profile name`);
        }
        const name = required(actionArguments[0], "profile");
        const result = action === "show"
            ? await service.get(name)
            : action === "test"
                ? await service.diagnose(name)
                : await service.remove(name);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (action === "rename") {
        if (actionArguments.length !== 2) {
            throw new Error(
                "profile rename requires the current and new profile names",
            );
        }
        console.log(JSON.stringify(
            await new ProviderProfileRenameService().rename(
                required(actionArguments[0], "current profile"),
                required(actionArguments[1], "new profile"),
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
                model: { type: "string" },
                dimensions: { type: "string" },
                "detect-dimensions": { type: "boolean" },
                "base-url": { type: "string" },
                "embedding-suffix": { type: "string" },
                "embedding-batch-size": { type: "string" },
                "rerank-model": { type: "string" },
                "rerank-interface": { type: "string" },
                "rerank-instruction": { type: "string" },
            },
        });
        if (parsed.positionals.length !== 1) {
            throw new Error("profile set requires exactly one profile name");
        }
        if (
            (parsed.values["rerank-interface"] !== undefined ||
                parsed.values["rerank-instruction"] !== undefined) &&
            parsed.values["rerank-model"] === undefined
        ) {
            throw new Error(
                "--rerank-interface and --rerank-instruction require --rerank-model",
            );
        }
        const rerankingInterface = parseRerankingInterface(
            parsed.values["rerank-interface"],
        );
        if (
            rerankingInterface === "rerank" &&
            parsed.values["rerank-instruction"] !== undefined
        ) {
            throw new Error(
                "--rerank-instruction is only supported by the completions interface",
            );
        }
        if (
            parsed.values["detect-dimensions"] === true &&
            parsed.values.dimensions !== undefined
        ) {
            throw new Error(
                "--detect-dimensions cannot be combined with --dimensions",
            );
        }
        const baseUrl = parsed.values["base-url"];
        const model = required(parsed.values.model, "--model");
        const dimensions = parsed.values["detect-dimensions"] === true
            ? (await service.inspectEmbeddingModel(
                model,
                baseUrl,
                parsed.values["embedding-suffix"],
            )).dimensions
            : positiveInteger(parsed.values.dimensions, "--dimensions");
        const maximumInputs = parsed.values["embedding-batch-size"] === undefined
            ? undefined
            : positiveInteger(
                parsed.values["embedding-batch-size"],
                "--embedding-batch-size",
            );
        const input: ProviderProfileInput = {
            name: required(parsed.positionals[0], "profile"),
            embedding: {
                provider: "openai-compatible",
                model,
                dimensions,
                ...(baseUrl === undefined ? {} : { baseUrl }),
                ...(maximumInputs === undefined
                    ? {}
                    : { maximumInputs }),
                ...(parsed.values["embedding-suffix"] === undefined
                    ? {}
                    : {
                        embeddingSuffix:
                            parsed.values["embedding-suffix"],
                    }),
            },
            ...(parsed.values["rerank-model"] === undefined
                ? {}
                : rerankingInterface === "rerank"
                    ? {
                        reranking: {
                            provider: "openai-compatible-rerank" as const,
                            model: parsed.values["rerank-model"],
                            ...(baseUrl === undefined ? {} : { baseUrl }),
                        },
                    }
                    : {
                        reranking: {
                            provider: "openai-compatible-qwen3" as const,
                            model: parsed.values["rerank-model"],
                            ...(baseUrl === undefined ? {} : { baseUrl }),
                            ...(parsed.values["rerank-instruction"] === undefined
                                ? {}
                                : {
                                    instruction:
                                        parsed.values["rerank-instruction"],
                                }),
                        },
                    }),
        };
        console.log(JSON.stringify(await service.set(input), null, 2));
        return;
    }

    throw new Error(
        "profile requires one of: list, show, set, rename, test, models, inspect, delete",
    );
}

function parseRerankingInterface(
    value: string | undefined,
): "completions" | "rerank" {
    if (value === undefined || value === "completions") return "completions";
    if (value === "rerank") return "rerank";
    throw new Error("--rerank-interface must be completions or rerank");
}
