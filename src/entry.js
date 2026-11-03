// Worker entry: the web page (worker.js) plus the private entrypoint Nexus binds to.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import web, { buildBoard, loadRepos } from "./worker.js";
import { T3AuthStore as T3AuthStoreCore } from "./t3-live.js";

export default web;

export class T3AuthStore extends DurableObject {
  async fetch(request) {
    return new T3AuthStoreCore(this.ctx).fetch(request);
  }
}

export class NexusIntegration extends WorkerEntrypoint {
  async getBoard() {
    try {
      return buildBoard(await loadRepos(this.env.GITHUB_TOKEN), Date.now());
    } catch (e) {
      // Stable code as the message, same convention as the other Nexus integrations.
      throw new Error(e.message.includes("GITHUB_TOKEN") ? "not_configured" : "upstream_unavailable");
    }
  }
}
