// Worker entry: the web page (worker.js) plus the private entrypoint Nexus binds to.
import { WorkerEntrypoint } from "cloudflare:workers";
import web, { buildBoard, loadRepos } from "./worker.js";

export default web;

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
