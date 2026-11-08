import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LOG_FILE_PATH = process.env.LOG_FILE_PATH || path.join(projectRoot, "app.log");
