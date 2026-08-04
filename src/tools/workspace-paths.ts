import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export interface ResolvedWorkspacePath {
  readonly authoredPath: string;
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly insideWorkspace: boolean;
}

export interface ResolveReadPathOptions {
  readonly readOutsideWorkspace?: boolean;
}

export interface ResolveWritePathOptions {
  readonly operation?: "write" | "delete";
}

/** Resolves relative paths against the workspace and canonicalizes authored absolute paths. */
export class WorkspacePaths {
  readonly root: string;

  constructor(workspace: string) {
    if (workspace.includes("\0"))
      throw new WorkspacePathError("Workspace path contains a NUL byte");
    try {
      this.root = realpathSync.native(path.resolve(workspace));
    } catch (error) {
      throw new WorkspacePathError(`Cannot resolve workspace ${JSON.stringify(workspace)}`, {
        cause: error,
      });
    }
    if (!lstatSync(this.root).isDirectory()) {
      throw new WorkspacePathError(`Workspace is not a directory: ${this.root}`);
    }
  }

  resolveRead(authoredPath: string, options: ResolveReadPathOptions = {}): ResolvedWorkspacePath {
    return this.resolve(authoredPath, options.readOutsideWorkspace === true);
  }

  resolveWrite(authoredPath: string, options: ResolveWritePathOptions = {}): ResolvedWorkspacePath {
    const resolved = this.resolve(authoredPath, false);
    if (resolved.canonicalPath === this.root) {
      const action = options.operation === "delete" ? "delete" : "overwrite";
      throw new WorkspacePathError(`Refusing to ${action} the workspace root`);
    }
    return resolved;
  }

  /** Re-resolves a previously canonical write path, detecting replaced symlink ancestors. */
  revalidateWrite(canonicalPath: string): ResolvedWorkspacePath {
    const resolved = this.resolveWrite(canonicalPath);
    if (resolved.canonicalPath !== canonicalPath) {
      throw new WorkspacePathError(
        `Path changed during operation: ${this.display(canonicalPath)} now resolves to ${resolved.displayPath}`,
      );
    }
    return resolved;
  }

  display(canonicalPath: string): string {
    const absolute = path.resolve(canonicalPath);
    if (!isWithin(this.root, absolute)) return normalizeSeparators(absolute);
    const relative = path.relative(this.root, absolute);
    return relative.length === 0 ? "." : normalizeSeparators(relative);
  }

  private resolve(authoredPath: string, allowOutside: boolean): ResolvedWorkspacePath {
    if (authoredPath.length === 0) throw new WorkspacePathError("Path cannot be empty");
    if (authoredPath.includes("\0")) throw new WorkspacePathError("Path contains a NUL byte");

    const authoredAbsolute = path.isAbsolute(authoredPath);
    const candidate = authoredAbsolute
      ? path.resolve(authoredPath)
      : path.resolve(this.root, authoredPath);
    const outsideAllowed = allowOutside || authoredAbsolute;
    if (!outsideAllowed && !isWithin(this.root, candidate)) {
      throw new WorkspacePathError(
        `Relative path escapes the workspace: ${JSON.stringify(authoredPath)}`,
      );
    }

    const canonicalPath = canonicalizeExistingAncestor(candidate);
    const insideWorkspace = isWithin(this.root, canonicalPath);
    if (!outsideAllowed && !insideWorkspace) {
      throw new WorkspacePathError(
        `Relative path escapes the workspace through a symlink: ${JSON.stringify(authoredPath)}`,
      );
    }

    return {
      authoredPath,
      canonicalPath,
      displayPath: insideWorkspace
        ? this.display(canonicalPath)
        : normalizeSeparators(canonicalPath),
      insideWorkspace,
    };
  }
}

export class WorkspacePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspacePathError";
  }
}

function canonicalizeExistingAncestor(candidate: string): string {
  let ancestor = candidate;
  while (true) {
    try {
      const realAncestor = realpathSync.native(ancestor);
      const remainder = path.relative(ancestor, candidate);
      return path.resolve(realAncestor, remainder);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        const metadata = lstatSync(ancestor);
        if (metadata.isSymbolicLink()) {
          throw new WorkspacePathError(`Cannot safely resolve dangling symlink: ${ancestor}`, {
            cause: error,
          });
        }
      } catch (metadataError) {
        if (!isMissingPathError(metadataError)) throw metadataError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function normalizeSeparators(value: string): string {
  return path.sep === "/" ? value : value.split(path.sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
