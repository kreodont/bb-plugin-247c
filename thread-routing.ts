import type { BbPluginApi, NewThreadRequest } from "@get-bb/plugin-sdk";
import { PolicyError } from "./core/errors.js";

type Route = Pick<NewThreadRequest, "projectId" | "environment">;

/** Installation-specific project selection. No account IDs or paths are bundled. */
export class ThreadRouting {
  constructor(readonly bb: BbPluginApi, readonly projectId: () => Promise<string>) {}

  private async configured(): Promise<Route | null> {
    const id = (await this.projectId()).trim();
    if (!id) return null;
    let project;
    try { project = await this.bb.sdk.projects.get({ projectId: id }); }
    catch { throw new PolicyError("The configured 247C thread project is unavailable. Update Thread project in plugin settings."); }
    if (project.kind !== "standard") throw new PolicyError("The 247C thread project must be a standard project with a local folder.");
    const source = project.sources.find(source => source.isDefault) ?? project.sources[0];
    if (source?.type !== "local_path" || !source.hostId || !source.path) throw new PolicyError("The configured thread project has no default local folder.");
    return { projectId: project.id, environment: { type: "host", hostId: source.hostId, workspace: { type: "unmanaged", path: null } } };
  }

  async request<T extends Route>(request: T): Promise<T> {
    const route = await this.configured();
    return route ? { ...request, ...route } : request;
  }

  async review(hostId: string): Promise<Route> {
    const route = await this.configured();
    if (route) return route;
    const project = (await this.bb.sdk.projects.list({ includePersonal: true })).find(project => project.kind === "personal");
    if (!project) throw new PolicyError("BB did not provide the personal workspace.");
    return { projectId: project.id, environment: { type: "host", hostId, workspace: { type: "personal" } } };
  }
}
