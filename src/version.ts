import { createRequire } from "node:module";

// src/version.ts and dist/version.js both sit one level below package.json.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION: string = pkg.version;
