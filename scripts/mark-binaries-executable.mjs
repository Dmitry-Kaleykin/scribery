import { chmod } from "node:fs/promises";

await Promise.all(process.argv.slice(2).map((path) => chmod(path, 0o755)));

