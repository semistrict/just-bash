import { fromBuffer, getEncoding, toBuffer } from "../encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  DirentEntry,
  FileContent,
  FileEntry,
  FileInit,
  FilePtr,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  LazyFileEntry,
  LazyFileProvider,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SyncFs,
  SymlinkEntry,
  WriteFileOptions,
} from "../interface.js";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  dirname,
  joinPath,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath,
  resolveSymlinkTarget,
  SYMLINK_MODE,
  validatePath,
} from "../path-utils.js";

// Re-export for backwards compatibility
export type {
  BufferEncoding,
  FileContent,
  FileEntry,
  LazyFileEntry,
  DirectoryEntry,
  SymlinkEntry,
  FsEntry,
  FsStat,
  IFileSystem,
};

export interface FsData {
  [path: string]: FsEntry;
}

// Text encoder for legacy string content conversion
const textEncoder = new TextEncoder();

/**
 * Type guard to check if a value is a FileInit object
 */
function isFileInit(
  value: FileContent | FileInit | LazyFileProvider,
): value is FileInit {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    "content" in value
  );
}

export class InMemoryFs implements IFileSystem, SyncFs {
  private data: Map<string, FsEntry> = new Map();

  // ── Inode infrastructure for FilePtr-based I/O ──
  private nextInode = 1;
  private inodeData = new Map<number, Uint8Array>();
  private pathToInode = new Map<string, number>();
  private ptrRefs = new Map<number, number>();
  private orphanedInodes = new Set<number>();

  constructor(initialFiles?: InitialFiles) {
    // Create root directory
    this.data.set("/", {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });

    if (initialFiles) {
      for (const [path, value] of Object.entries(initialFiles)) {
        if (typeof value === "function") {
          // Lazy file - store provider function, called on first read
          this.writeFileLazy(path, value);
        } else if (isFileInit(value)) {
          // Extended init with metadata
          this.writeFileSync(path, value.content, undefined, {
            mode: value.mode,
            mtime: value.mtime,
          });
        } else {
          // Simple content
          this.writeFileSync(path, value);
        }
      }
    }
  }

  private ensureParentDirs(path: string): void {
    const dir = dirname(path);
    if (dir === "/") return;

    if (!this.data.has(dir)) {
      this.ensureParentDirs(dir);
      this.data.set(dir, {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date(),
      });
    }
  }

  /** Allocate or reuse an inode for a path, store data in inodeData. */
  private assignInode(normalized: string, buffer: Uint8Array): void {
    const existing = this.pathToInode.get(normalized);
    if (existing !== undefined) {
      this.inodeData.set(existing, buffer);
    } else {
      const ino = this.nextInode++;
      this.pathToInode.set(normalized, ino);
      this.inodeData.set(ino, buffer);
    }
  }

  // Sync method for writing files
  writeFileSync(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    // Store content - convert to Uint8Array for internal storage
    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    this.assignInode(normalized, buffer);

    this.data.set(normalized, {
      type: "file",
      content: buffer,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date(),
    });
  }

  /**
   * Store a lazy file entry whose content is provided by a function on first read.
   * Writing to the path replaces the lazy entry, so the function is never called.
   */
  writeFileLazy(
    path: string,
    lazy: () => string | Uint8Array | Promise<string | Uint8Array>,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    validatePath(path, "write");
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    this.data.set(normalized, {
      type: "file",
      lazy,
      mode: metadata?.mode ?? DEFAULT_FILE_MODE,
      mtime: metadata?.mtime ?? new Date(),
    });
  }

  /**
   * Materialize a lazy file entry, replacing it with a concrete FileEntry.
   * Returns the materialized FileEntry.
   */
  private async materializeLazy(
    path: string,
    entry: LazyFileEntry,
  ): Promise<FileEntry> {
    const content = await entry.lazy();
    const buffer =
      typeof content === "string" ? textEncoder.encode(content) : content;
    const materialized: FileEntry = {
      type: "file",
      content: buffer,
      mode: entry.mode,
      mtime: entry.mtime,
    };
    this.data.set(path, materialized);
    return materialized;
  }

  // Async public API
  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    // Resolve all symlinks in the path (including intermediate components)
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }

    // Materialize lazy files on first read
    if ("lazy" in entry) {
      const materialized = await this.materializeLazy(resolvedPath, entry);
      return materialized.content instanceof Uint8Array
        ? materialized.content
        : textEncoder.encode(materialized.content);
    }

    // Return content as Uint8Array
    if (entry.content instanceof Uint8Array) {
      return entry.content;
    }
    // Legacy string content - convert to Uint8Array
    return textEncoder.encode(entry.content);
  }

  // createReadStream: yields file content as a single chunk (already in memory).
  // Real streaming benefit comes from disk-backed FS implementations.
  createReadStream(
    path: string,
    options?: { chunkSize?: number; encoding?: "binary" },
  ): AsyncIterable<string> {
    const self = this;
    const encoding = options?.encoding;
    return {
      async *[Symbol.asyncIterator]() {
        yield await self.readFile(path, encoding);
      },
    };
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.writeFileSync(path, content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    const normalized = normalizePath(path);
    const existing = this.data.get(normalized);

    if (existing && existing.type === "directory") {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);

    if (existing?.type === "file") {
      // Materialize lazy files before appending
      let materialized = existing;
      if ("lazy" in materialized) {
        materialized = await this.materializeLazy(normalized, materialized);
      }

      // Get existing content as buffer
      const existingBuffer =
        "content" in materialized && materialized.content instanceof Uint8Array
          ? materialized.content
          : textEncoder.encode(
              "content" in materialized ? (materialized.content as string) : "",
            );

      // Concatenate buffers
      const combined = new Uint8Array(existingBuffer.length + newBuffer.length);
      combined.set(existingBuffer);
      combined.set(newBuffer, existingBuffer.length);

      this.data.set(normalized, {
        type: "file",
        content: combined,
        mode: materialized.mode,
        mtime: new Date(),
      });
    } else {
      this.writeFileSync(path, content, options);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) {
      return false;
    }
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      // Path resolution failed (e.g., broken symlink in path)
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    // Resolve all symlinks in the path (including intermediate components)
    const resolvedPath = this.resolvePathWithSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    // Materialize lazy files to get accurate size
    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    // Calculate size: for files, it's the byte length; for directories, it's 0
    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        // Legacy string content - calculate byte length
        size = textEncoder.encode(entry.content).length;
      }
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false, // stat follows symlinks, so this is always false
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    // Resolve intermediate symlinks but NOT the final component
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    let entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    // For symlinks, return symlink info (don't follow)
    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime || new Date(),
      };
    }

    // Materialize lazy files to get accurate size
    if (entry.type === "file" && "lazy" in entry) {
      entry = await this.materializeLazy(resolvedPath, entry);
    }

    // Calculate size: for files, it's the byte length; for directories, it's 0
    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        // Legacy string content - calculate byte length
        size = textEncoder.encode(entry.content).length;
      }
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  /**
   * Resolve symlinks in intermediate path components only (not the final component).
   * Used by lstat which should not follow the final symlink.
   */
  private resolveIntermediateSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    if (parts.length <= 1) return normalized; // No intermediate components

    let resolvedPath = "";
    const seen = new Set<string>();

    // Process all but the last component
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      resolvedPath = `${resolvedPath}/${part}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = MAX_SYMLINK_DEPTH;

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, lstat '${path}'`,
          );
        }
        seen.add(resolvedPath);
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, lstat '${path}'`,
        );
      }
    }

    // Append the final component without resolving
    return `${resolvedPath}/${parts[parts.length - 1]}`;
  }

  /**
   * Resolve all symlinks in a path, including intermediate components.
   * For example: /home/user/linkdir/file.txt where linkdir is a symlink to "subdir"
   * would resolve to /home/user/subdir/file.txt
   */
  private resolvePathWithSymlinks(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    let resolvedPath = "";
    const seen = new Set<string>();

    for (const part of parts) {
      resolvedPath = `${resolvedPath}/${part}`;

      // Check if this path component is a symlink
      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = MAX_SYMLINK_DEPTH; // Prevent infinite loops

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, open '${path}'`,
          );
        }
        seen.add(resolvedPath);

        // Resolve the symlink
        resolvedPath = resolveSymlinkTarget(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, open '${path}'`,
        );
      }
    }

    return resolvedPath;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  /**
   * Synchronous version of mkdir
   */
  mkdirSync(path: string, options?: MkdirOptions): void {
    validatePath(path, "mkdir");
    const normalized = normalizePath(path);

    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === "file") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      // Directory already exists
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return; // With -p, silently succeed if directory exists
    }

    const parent = dirname(normalized);
    if (parent !== "/" && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.data.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    let normalized = normalizePath(path);
    let entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    // Follow symlinks to get to the actual directory
    const seen = new Set<string>();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, scandir '${path}'`,
        );
      }
      seen.add(normalized);
      normalized = resolveSymlinkTarget(normalized, entry.target);
      entry = this.data.get(normalized);
    }

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entriesMap = new Map<string, DirentEntry>();

    for (const [p, fsEntry] of this.data.entries()) {
      if (p === normalized) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        // Only add direct children (no nested paths)
        if (name && !rest.includes("/", name.length) && !entriesMap.has(name)) {
          entriesMap.set(name, {
            name,
            isFile: fsEntry.type === "file",
            isDirectory: fsEntry.type === "directory",
            isSymbolicLink: fsEntry.type === "symlink",
          });
        }
      }
    }

    // Sort using default string comparison (case-sensitive) to match readdir behavior
    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath = joinPath(normalized, child);
          await this.rm(childPath, options);
        }
      }
    }

    this.data.delete(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === "file") {
      this.ensureParentDirs(destNorm);
      // Deep copy: create a new Uint8Array to avoid sharing the buffer reference
      if ("content" in srcEntry) {
        const contentCopy =
          srcEntry.content instanceof Uint8Array
            ? new Uint8Array(srcEntry.content)
            : srcEntry.content;
        this.data.set(destNorm, { ...srcEntry, content: contentCopy });
      } else {
        // Lazy file - copy the lazy reference (will be materialized on read)
        this.data.set(destNorm, { ...srcEntry });
      }
    } else if (srcEntry.type === "symlink") {
      // Copy the symlink itself (not its target)
      this.ensureParentDirs(destNorm);
      this.data.set(destNorm, { ...srcEntry });
    } else if (srcEntry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = joinPath(srcNorm, child);
        const destChild = joinPath(destNorm, child);
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  // Get all paths (useful for debugging/glob)
  getAllPaths(): string[] {
    return Array.from(this.data.keys());
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  // Change file/directory permissions
  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
  }

  // Create a symbolic link
  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(linkPath, "symlink");
    const normalized = normalizePath(linkPath);

    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });
  }

  // Create a hard link
  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    const existingNorm = normalizePath(existingPath);
    const newNorm = normalizePath(newPath);

    const entry = this.data.get(existingNorm);
    if (!entry) {
      throw new Error(
        `ENOENT: no such file or directory, link '${existingPath}'`,
      );
    }

    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }

    if (this.data.has(newNorm)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    // Materialize lazy files before creating a hard link
    let resolved = entry;
    if ("lazy" in resolved) {
      resolved = await this.materializeLazy(existingNorm, resolved);
    }

    this.ensureParentDirs(newNorm);
    // For hard links, we create a copy (simulating inode sharing)
    // In a real fs, they'd share the same inode
    this.data.set(newNorm, {
      type: "file",
      content: (resolved as FileEntry).content,
      mode: resolved.mode,
      mtime: resolved.mtime,
    });
  }

  // Read the target of a symbolic link
  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    // resolvePathWithSymlinks already resolves all symlinks
    const resolved = this.resolvePathWithSymlinks(path);

    // Verify the path exists
    if (!this.data.has(resolved)) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }

    return resolved;
  }

  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param _atime - Access time (ignored, kept for API compatibility)
   * @param mtime - Modification time
   */
  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    const normalized = normalizePath(path);
    const resolved = this.resolvePathWithSymlinks(normalized);
    const entry = this.data.get(resolved);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    // Update mtime on the entry
    entry.mtime = mtime;
  }

  // --- SyncFs implementation ---

  existsSync(path: string): boolean {
    if (path.includes("\0")) return false;
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      return false;
    }
  }

  lstatSync(path: string): FsStat {
    validatePath(path, "lstat");
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime || new Date(),
      };
    }

    let size = 0;
    if (entry.type === "file" && "content" in entry && entry.content) {
      if (entry.content instanceof Uint8Array) {
        size = entry.content.length;
      } else {
        size = textEncoder.encode(entry.content).length;
      }
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  readFileBufferSync(path: string): Uint8Array {
    validatePath(path, "open");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    if ("lazy" in entry) {
      throw new Error(
        `Cannot read lazy file synchronously: '${path}'. Lazy files must be materialized before sync access.`,
      );
    }

    if (entry.content instanceof Uint8Array) {
      return entry.content;
    }
    return textEncoder.encode(entry.content);
  }

  rmSync(path: string, options?: RmOptions): void {
    validatePath(path, "rm");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = this.readdirSync(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath = joinPath(normalized, child);
          this.rmSync(childPath, options);
        }
      }
    }

    // Handle inode cleanup: orphan if open refs exist
    const ino = this.pathToInode.get(normalized);
    if (ino !== undefined) {
      this.pathToInode.delete(normalized);
      if ((this.ptrRefs.get(ino) ?? 0) > 0) {
        this.orphanedInodes.add(ino);
      } else {
        this.inodeData.delete(ino);
      }
    }

    this.data.delete(normalized);
  }

  readdirSync(path: string): string[] {
    validatePath(path, "scandir");
    let normalized = normalizePath(path);
    let entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const seen = new Set<string>();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(`ELOOP: too many levels of symbolic links, scandir '${path}'`);
      }
      seen.add(normalized);
      normalized = resolveSymlinkTarget(normalized, entry.target);
      entry = this.data.get(normalized);
    }

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const names = new Set<string>();

    for (const [p] of this.data.entries()) {
      if (p === normalized) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length)) {
          names.add(name);
        }
      }
    }

    return Array.from(names).sort();
  }

  chmodSync(path: string, mode: number): void {
    validatePath(path, "chmod");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
  }

  symlinkSync(target: string, linkPath: string): void {
    validatePath(linkPath, "symlink");
    const normalized = normalizePath(linkPath);

    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });
  }

  readlinkSync(path: string): string {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  mvSync(src: string, dest: string): void {
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);

    // For files, remap the inode (preserves open file handles)
    const ino = this.pathToInode.get(srcNorm);
    if (ino !== undefined) {
      this.pathToInode.delete(srcNorm);
      this.pathToInode.set(destNorm, ino);
    }

    this.cpSync(src, dest, { recursive: true });
    // Remove source entry from data map without cleaning up inodes (already remapped)
    const srcEntry = this.data.get(srcNorm);
    if (srcEntry?.type === "directory") {
      // For directories, cpSync deep-copies — just remove old data entries
      this.rmSyncDataOnly(srcNorm);
    } else {
      this.data.delete(srcNorm);
    }
  }

  /** Remove entries from the data map without touching inodes. */
  private rmSyncDataOnly(path: string): void {
    const normalized = normalizePath(path);
    const entry = this.data.get(normalized);
    if (!entry) return;
    if (entry.type === "directory") {
      const children = this.readdirSync(normalized);
      for (const child of children) {
        this.rmSyncDataOnly(joinPath(normalized, child));
      }
    }
    this.data.delete(normalized);
  }

  // ── FilePtr-based I/O (mirrors Emscripten stream_ops) ──

  open(path: string, flags: number): FilePtr {
    const resolved = this.resolvePathWithSymlinks(path);
    const O_CREAT = 64;
    const O_TRUNC = 512;

    let ino = this.pathToInode.get(resolved);
    if (ino === undefined) {
      if (!(flags & O_CREAT)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      // Create the file
      this.writeFileSync(path, new Uint8Array(0));
      ino = this.pathToInode.get(resolved)!;
    }

    if (flags & O_TRUNC) {
      this.inodeData.set(ino, new Uint8Array(0));
      // Update the data map entry too
      const entry = this.data.get(resolved);
      if (entry?.type === "file" && "content" in entry) {
        entry.content = new Uint8Array(0);
      }
    }

    this.ptrRefs.set(ino, (this.ptrRefs.get(ino) ?? 0) + 1);
    return ino;
  }

  close(ptr: FilePtr): void {
    const refs = (this.ptrRefs.get(ptr) ?? 1) - 1;
    if (refs <= 0) {
      this.ptrRefs.delete(ptr);
      if (this.orphanedInodes.has(ptr)) {
        this.orphanedInodes.delete(ptr);
        this.inodeData.delete(ptr);
      }
    } else {
      this.ptrRefs.set(ptr, refs);
    }
  }

  read(ptr: FilePtr, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const data = this.inodeData.get(ptr);
    if (!data) return 0;
    if (position >= data.length) return 0;
    const end = Math.min(position + length, data.length);
    const bytesRead = end - position;
    buffer.set(data.subarray(position, end), offset);
    return bytesRead;
  }

  write(ptr: FilePtr, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const existing = this.inodeData.get(ptr) ?? new Uint8Array(0);
    const end = position + length;
    if (end > existing.length) {
      const grown = new Uint8Array(end);
      grown.set(existing);
      this.inodeData.set(ptr, grown);
    }
    const target = this.inodeData.get(ptr)!;
    target.set(buffer.subarray(offset, offset + length), position);

    // Keep the data map entry in sync for readFileBufferSync
    this.syncDataEntry(ptr);
    return length;
  }

  fstat(ptr: FilePtr): { size: number } {
    const data = this.inodeData.get(ptr);
    return { size: data?.length ?? 0 };
  }

  ftruncate(ptr: FilePtr, size: number): void {
    const existing = this.inodeData.get(ptr) ?? new Uint8Array(0);
    if (size >= existing.length) {
      const grown = new Uint8Array(size);
      grown.set(existing);
      this.inodeData.set(ptr, grown);
    } else {
      this.inodeData.set(ptr, existing.slice(0, size));
    }
    this.syncDataEntry(ptr);
  }

  /** Keep the FsEntry in the data map in sync with inodeData after writes. */
  private syncDataEntry(ino: number): void {
    for (const [path, mappedIno] of this.pathToInode) {
      if (mappedIno === ino) {
        const entry = this.data.get(path);
        if (entry?.type === "file" && "content" in entry) {
          entry.content = this.inodeData.get(ino) ?? new Uint8Array(0);
          entry.mtime = new Date();
        }
        break;
      }
    }
  }

  private cpSync(src: string, dest: string, options?: CpOptions): void {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === "file") {
      this.ensureParentDirs(destNorm);
      if ("content" in srcEntry) {
        const contentCopy =
          srcEntry.content instanceof Uint8Array
            ? new Uint8Array(srcEntry.content)
            : srcEntry.content;
        this.data.set(destNorm, { ...srcEntry, content: contentCopy });
      } else {
        this.data.set(destNorm, { ...srcEntry });
      }
    } else if (srcEntry.type === "symlink") {
      this.ensureParentDirs(destNorm);
      this.data.set(destNorm, { ...srcEntry });
    } else if (srcEntry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      this.mkdirSync(destNorm, { recursive: true });
      const children = this.readdirSync(srcNorm);
      for (const child of children) {
        const srcChild = joinPath(srcNorm, child);
        const destChild = joinPath(destNorm, child);
        this.cpSync(srcChild, destChild, options);
      }
    }
  }
}
