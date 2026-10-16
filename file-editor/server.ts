import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { monacoAssetDirectory } from "./lib/monaco-assets.js";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { editorRpcContract, sourceSchema } from "./contracts.js";
import { editorHostContract } from "./host-contract.js";

const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

const MAX_TREE_ENTRIES = 10_000;

const ASSET_LEASE_TTL_MS = 60 * 60 * 1000;

const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;


export function createFileEditorHandlers(bb: BbPluginApi): PluginRpcHandlers<typeof editorRpcContract> {
  const host = bb.hosts.experimental_client({ contract: editorHostContract });
  let assetLease: { baseUrl: string; expiresAtMs: number } | null = null;

  async function assets() {
    const now = Date.now();
    if (
      assetLease === null ||
      assetLease.expiresAtMs - now < ASSET_LEASE_REFRESH_MARGIN_MS
    ) {
      const bundleDir = monacoAssetDirectory(path.dirname(fileURLToPath(import.meta.url)));
      assetLease = await bb.sdk.files.createPreview({
        rootPath: bundleDir,
        ttlMs: ASSET_LEASE_TTL_MS,
      });
    }
    return assetLease;
  }

  async function resolveTarget(
    source: z.infer<typeof sourceSchema>,
    filePath: string,
  ): Promise<{ path: string; rootPath: string; hostId?: string }> {
    if (source.kind === "thread-storage") {
      if (source.threadId === null) {
        throw new Error("This thread-storage file has no thread");
      }
      const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({
        threadId: source.threadId,
      });
      return {
        path: joinTarget(storageRootPath, filePath),
        rootPath: storageRootPath,
        hostId,
      };
    }
    if (source.environmentId === null && source.kind === "workspace") {
      if (source.projectId === null) {
        throw new Error("This file has no environment or project");
      }
      const project = await bb.sdk.projects.get({
        projectId: source.projectId,
      });
      const sources = project.sources;
      const checkout =
        source.experimental_hostId === undefined
          ? (sources.find((entry) => entry.isDefault) ?? sources[0])
          : sources.find(
              (entry) => entry.hostId === source.experimental_hostId,
            );
      if (checkout === undefined) {
        throw new Error("This project has no matching source checkout");
      }
      return {
        path: joinTarget(checkout.path, filePath),
        rootPath: checkout.path,
        hostId: checkout.hostId,
      };
    }
    if (source.environmentId === null) {
      throw new Error("This file has no environment to resolve it against");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });

    if (source.kind === "host") {
      const api = pathApi(filePath);
      return {
        path: filePath,
        rootPath: api.dirname(filePath),
        ...(environment.hostId ? { hostId: environment.hostId } : {}),
      };
    }

    if (!environment.path) {
      throw new Error("This environment has no workspace path");
    }
    return {
      path: joinTarget(environment.path, filePath),
      rootPath: environment.path,
      ...(environment.hostId ? { hostId: environment.hostId } : {}),
    };
  }

  function pathApi(value: string) {
    return /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? path.win32 : path.posix;
  }

  function joinTarget(root: string, target: string): string {
    const api = pathApi(root);
    return api.join(root, target);
  }

  function relativeTo(root: string, target: string): string {
    const api = pathApi(root);
    return api.relative(root, target) || api.basename(target);
  }

  return {
    editorAssets: () => assets(),

    async editorRead({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      const file = await bb.sdk.files.read(target);

      if (file.contentEncoding !== "utf8") {
        return {
          kind: "unsupported" as const,
          reason: "This file is not text",
        };
      }
      if (file.sizeBytes > MAX_EDITABLE_BYTES) {
        return {
          kind: "unsupported" as const,
          reason: `This file is too large to edit (${Math.round(file.sizeBytes / 1024 / 1024)} MB)`,
        };
      }
      return {
        kind: "text" as const,
        content: file.content,
        sha256: file.sha256,
        absolutePath: target.path,
        relativePath: relativeTo(target.rootPath, target.path),
      };
    },

    async editorTree({ source }) {
      const target = await resolveTarget(source, ".");
      const result = await bb.sdk.files.listPaths({
        path: target.rootPath,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: true,
        limit: MAX_TREE_ENTRIES,
        ...(target.hostId !== undefined ? { hostId: target.hostId } : {}),
      });
      return {
        root: target.rootPath,
        entries: result.paths.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
        })),
        truncated: result.truncated,
      };
    },

    async editorReveal({ path: filePath, source }) {
      const target = await resolveTarget(source, filePath);
      if (!target.hostId) throw new Error("The file’s machine is unavailable. Reconnect it and try again.");
      return host.call("revealFile", { path: target.path, rootPath: target.rootPath }, { hostId: target.hostId });
    },

    async editorWrite({ path: filePath, source, content, expectedSha256 }) {
      const target = await resolveTarget(source, filePath);
      const result = await bb.sdk.files.write({
        ...target,
        content,
        contentEncoding: "utf8",
        ...(expectedSha256 === null ? {} : { expectedSha256 }),
      });
      if (
        result.outcome === "conflict" &&
        result.currentSha256 === createHash("sha256").update(content, "utf8").digest("hex")
      ) {
        return { outcome: "written" as const, sha256: result.currentSha256 };
      }
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const, currentSha256: result.currentSha256 };
    },
  };
}
