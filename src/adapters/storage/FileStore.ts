import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import path from "node:path";

import { KeyedLock } from "../../infra/locks/KeyedLock.js";

export interface FileSystemAdapter {
  access(filePath: string): Promise<void>;
  appendFile(
    filePath: string,
    data: string,
    encoding: BufferEncoding,
  ): Promise<void>;
  mkdir(
    dirPath: string,
    options?: {
      recursive?: boolean;
    },
  ): Promise<string | undefined>;
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  readdir?(dirPath: string): Promise<string[]>;
  rename(fromPath: string, toPath: string): Promise<void>;
  rm(
    targetPath: string,
    options?: {
      force?: boolean;
      recursive?: boolean;
    },
  ): Promise<void>;
  writeFile(
    filePath: string,
    data: string,
    encoding: BufferEncoding,
  ): Promise<void>;
}

export interface FileStoreOptions {
  fs?: FileSystemAdapter;
}

export class FileStore {
  private static readonly fileLock = new KeyedLock();
  private readonly fs: FileSystemAdapter;

  public constructor(options: FileStoreOptions = {}) {
    this.fs = options.fs ?? nodeFs;
  }

  public async exists(filePath: string): Promise<boolean> {
    try {
      await this.fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async readText(filePath: string): Promise<string | null> {
    return FileStore.fileLock.withLock(filePath, async () => {
      await this.recoverAtomicArtifacts(filePath);

      if (!(await this.exists(filePath))) {
        return null;
      }

      return this.fs.readFile(filePath, "utf8");
    });
  }

  public async writeTextAtomic(
    filePath: string,
    contents: string,
  ): Promise<void> {
    await FileStore.fileLock.withLock(filePath, async () => {
      await this.writeTextAtomicUnlocked(filePath, contents);
    });
  }

  public async updateTextAtomic(
    filePath: string,
    updater: (currentContents: string | null) => Promise<string> | string,
  ): Promise<void> {
    await FileStore.fileLock.withLock(filePath, async () => {
      await this.recoverAtomicArtifacts(filePath);
      const currentContents = (await this.exists(filePath))
        ? await this.fs.readFile(filePath, "utf8")
        : null;
      const nextContents = await updater(currentContents);
      await this.writeTextAtomicUnlocked(filePath, nextContents);
    });
  }

  public async appendLine(filePath: string, line: string): Promise<void> {
    await FileStore.fileLock.withLock(filePath, async () => {
      await this.recoverAtomicArtifacts(filePath);
      await this.ensureParentDirectory(filePath);
      await this.fs.appendFile(filePath, `${line}\n`, "utf8");
    });
  }

  public async remove(filePath: string): Promise<void> {
    await FileStore.fileLock.withLock(filePath, async () => {
      await this.safeCleanup(filePath);
      await this.safeCleanup(`${filePath}.tmp`);
      await this.safeCleanup(`${filePath}.bak`);
    });
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const parentDir = path.dirname(filePath);
    await this.fs.mkdir(parentDir, { recursive: true });
  }

  private async safeCleanup(targetPath: string): Promise<void> {
    try {
      await this.fs.rm(targetPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }

  private async safeRestoreBackup(
    backupPath: string,
    targetPath: string,
  ): Promise<void> {
    try {
      await this.fs.rename(backupPath, targetPath);
    } catch {
      // Restoration failure is worse than the original error, but we still
      // rethrow the original write error to keep the failure deterministic.
    }
  }

  private getAtomicPaths(filePath: string): {
    backupPath: string;
    tempPath: string;
  } {
    return {
      backupPath: `${filePath}.bak`,
      tempPath: `${filePath}.tmp`,
    };
  }

  private async writeTextAtomicUnlocked(
    filePath: string,
    contents: string,
  ): Promise<void> {
    await this.ensureParentDirectory(filePath);
    await this.recoverAtomicArtifacts(filePath);

    const targetExists = await this.exists(filePath);
    const { backupPath, tempPath } = this.getAtomicPaths(filePath);
    const uniqueTempPath = `${tempPath}.${randomUUID()}`;
    let originalMoved = false;

    await this.fs.writeFile(uniqueTempPath, contents, "utf8");

    try {
      if (targetExists) {
        await this.safeCleanup(backupPath);
        await this.fs.rename(filePath, backupPath);
        originalMoved = true;
      }

      await this.safeCleanup(tempPath);
      await this.fs.rename(uniqueTempPath, tempPath);
      await this.fs.rename(tempPath, filePath);

      if (originalMoved) {
        await this.safeCleanup(backupPath);
      }
    } catch (error) {
      await this.safeCleanup(uniqueTempPath);
      await this.safeCleanup(tempPath);

      if (originalMoved && (await this.exists(backupPath))) {
        await this.safeRestoreBackup(backupPath, filePath);
      }

      throw error;
    }
  }

  private async recoverAtomicArtifacts(filePath: string): Promise<void> {
    const { backupPath, tempPath } = this.getAtomicPaths(filePath);
    const targetExists = await this.exists(filePath);
    const tempExists = await this.exists(tempPath);
    const backupExists = await this.exists(backupPath);

    if (!targetExists) {
      if (tempExists) {
        await this.fs.rename(tempPath, filePath);
        if (backupExists) {
          await this.safeCleanup(backupPath);
        }
        await this.cleanupOrphanUniqueTempFiles(filePath);
        return;
      }

      if (backupExists) {
        await this.fs.rename(backupPath, filePath);
        await this.cleanupOrphanUniqueTempFiles(filePath);
        return;
      }
    }

    if (targetExists) {
      if (tempExists) {
        await this.safeCleanup(tempPath);
      }
      if (backupExists) {
        await this.safeCleanup(backupPath);
      }
      await this.cleanupOrphanUniqueTempFiles(filePath);
    }
  }

  private async cleanupOrphanUniqueTempFiles(filePath: string): Promise<void> {
    if (this.fs.readdir === undefined) {
      return;
    }

    const parentDir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const orphanPrefix = `${baseName}.tmp.`;

    let entries: string[];
    try {
      entries = await this.fs.readdir(parentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(orphanPrefix)) {
        await this.safeCleanup(path.join(parentDir, entry));
      }
    }
  }
}
