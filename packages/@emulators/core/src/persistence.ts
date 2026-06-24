import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PersistenceAdapter {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return await readFile(path, "utf-8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      }
    },
    async save(data: string) {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true });

      const temporaryPath = join(directory, `.emulate-${process.pid}-${randomUUID()}.tmp`);

      try {
        await writeFile(temporaryPath, data, { encoding: "utf-8", flag: "wx" });
        await rename(temporaryPath, path);
      } catch (error) {
        try {
          await rm(temporaryPath, { force: true });
        } catch {
          // Preserve the original write or rename failure.
        }
        throw error;
      }
    },
  };
}
