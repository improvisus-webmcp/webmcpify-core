import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

// Load only Core's own development settings. Never load the target project's
// .env: provider subprocesses inherit this process environment, so importing
// application secrets would unnecessarily expose them to the provider.
dotenv.config({ path: path.join(packageRoot, ".env"), quiet: true });
