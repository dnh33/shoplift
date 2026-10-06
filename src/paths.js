import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package root, resolved from this file's location — NOT process.cwd().
 * Makes the tool work when launched from any directory (npm link, shell
 * aliases, scheduled tasks): config/, .env, data/ and fixtures/ always
 * resolve relative to the installation, while explicit --config paths
 * still resolve relative to where the user is standing.
 */
export const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
