// Worker entry: the web page (worker.js) plus the private entrypoint Nexus binds to.
import { WorkerEntrypoint } from "cloudflare:workers";
import web, { buildBoard, loadRepos, cachedDeploys } from "./worker.js";

export default web;

export class NexusIntegration extends WorkerEntrypoint {
  async getBoard() {
    try {
      const repos = await loadRepos(this.env.GITHUB_TOKEN);
      const deploys = await cachedDeploys(this.env, this.ctx); // never throws; null means no badges
      return buildBoard(repos, Date.now(), deploys);
    } catch (e) {
      // Stable code as the message, same convention as the other Nexus integrations.
      throw new Error(e.message.includes("GITHUB_TOKEN") ? "not_configured" : "upstream_unavailable");
    }
  }
}
