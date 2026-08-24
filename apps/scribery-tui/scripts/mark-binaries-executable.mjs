import { chmod } from "node:fs/promises";

const binaries = process.argv.slice(2);

if (binaries.length === 0) {
    throw new Error("At least one compiled binary path is required");
}

await Promise.all(binaries.map((binary) => chmod(binary, 0o755)));
