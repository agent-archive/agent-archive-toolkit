import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
await copyFile(resolve(root, "src/index.ts"), resolve(root, "dist/index.js"));
await copyFile(resolve(root, "src/cli.ts"), resolve(root, "dist/cli.js"));
console.log("Built dist/ from src/.");
