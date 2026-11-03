// Browser adapter for the optional panel. It is dependency-free so its state,
// storage, and transport behavior can be exercised in Node without a browser.
export function createT3Client() {
  return class T3Client {
    constructor({ transport, storage }) {
      this.transport = transport;
      this.storage = storage;
      this.repoId = null;
      this.generation = 0;
      this.connection = "disconnected";
      this.error = null;
    }

    key(repoId = this.repoId) { return `repo-board-t3-mock:${repoId}`; }
    read(repoId = this.repoId) {
      try {
        const value = JSON.parse(this.storage.getItem(this.key(repoId)) || "{}");
        const legacy = Array.isArray(value);
        const rawConversations = legacy ? value : Array.isArray(value.conversations) ? value.conversations : [];
        const conversations = rawConversations.filter((item) => item && typeof item.id === "string").map((item) => ({
          ...item,
          title: typeof item.title === "string" ? item.title : "Conversation",
          status: typeof item.status === "string" ? item.status : "waiting",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
          messages: Array.isArray(item.messages) ? item.messages.filter((message) => message && typeof message.text === "string") : [],
        }));
        let activity = Array.isArray(value.activity) ? value.activity : [];
        if (legacy) {
          try { activity = JSON.parse(this.storage.getItem(`${this.key(repoId)}:activity`) || "[]"); } catch { activity = []; }
        }
        activity = activity.filter((item) => item && typeof item.text === "string" && typeof item.at === "string");
        const selected = typeof value.selectedId === "string" ? value.selectedId : null;
        return { conversations, selectedId: conversations.some((item) => item.id === selected) ? selected : conversations[0]?.id || null, activity };
      } catch { return { conversations: [], selectedId: null, activity: [] }; }
    }
    write(repoId, data) { this.storage.setItem(this.key(repoId), JSON.stringify(data)); }
    select(repoId) { this.repoId = repoId; this.generation++; this.connection = "connecting"; this.error = null; return { repoId, generation: this.generation }; }
    current(context) { return context.generation === this.generation && context.repoId === this.repoId; }
    async request(context, body) {
      try {
        const result = await this.transport(context.repoId, body);
        if (!result?.mock) throw new Error("Mock service did not confirm the simulated response");
        if (this.current(context)) { this.connection = "mock"; this.error = null; }
        return result;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.stale = !this.current(context);
        if (this.current(context)) { this.connection = "disconnected"; this.error = error; }
        throw error;
      }
    }
    async list() {
      const context = { repoId: this.repoId, generation: this.generation };
      if (!context.repoId) throw new Error("Select a repository first");
      const result = await this.request(context, { action: "list" });
      const saved = this.read(context.repoId);
      const selectedId = saved.conversations.some((item) => item.id === saved.selectedId) ? saved.selectedId : saved.conversations[0]?.id || null;
      const activity = saved.activity.length || !Array.isArray(result.activity) ? saved.activity : result.activity;
      this.write(context.repoId, { ...saved, selectedId, activity });
      return this.current(context) ? { stale: false, result, ...saved, selectedId, activity, connection: this.connection } : { stale: true };
    }
    async create(prompt, requestId) {
      const context = { repoId: this.repoId, generation: this.generation };
      if (!context.repoId) throw new Error("Select a repository first");
      const result = await this.request(context, { action: "new", prompt, requestId });
      const saved = this.read(context.repoId);
      if (!saved.conversations.some((item) => item.id === result.thread.id)) saved.conversations.unshift(result.thread);
      saved.selectedId = result.thread.id;
      this.write(context.repoId, saved);
      return this.current(context) ? { stale: false, ...saved, connection: this.connection } : { stale: true };
    }
    async followup(text) { return this.operation("send", { text }); }
    async operation(action, fields = {}) {
      const context = { repoId: this.repoId, generation: this.generation };
      const saved = this.read(context.repoId);
      const conversation = saved.conversations.find((item) => item.id === saved.selectedId);
      if (!conversation) throw new Error("Select a conversation before continuing");
      let result;
      try { result = await this.request(context, { action, threadId: conversation.id, ...fields }); }
      catch (error) {
        const latest = this.read(context.repoId);
        const target = latest.conversations.find((item) => item.id === conversation.id);
        if (target) { target.status = "failed"; target.updatedAt = new Date().toISOString(); this.write(context.repoId, latest); }
        throw error;
      }
      const latest = this.read(context.repoId);
      const target = latest.conversations.find((item) => item.id === conversation.id);
      if (target) {
        target.status = result.thread.status;
        target.updatedAt = result.thread.updatedAt;
        if (fields.text) target.messages.push({ role: "user", text: fields.text });
        if (result.thread.message) target.messages.push({ role: "assistant", text: result.thread.message });
        latest.selectedId = target.id;
        latest.activity.unshift({ at: new Date().toISOString(), text: `Mock ${action} for ${context.repoId}` });
        this.write(context.repoId, latest);
      }
      return this.current(context) ? { stale: false, ...latest, connection: this.connection } : { stale: true };
    }
    advance() {
      const saved = this.read();
      const target = saved.conversations.find((item) => item.id === saved.selectedId);
      if (!target) throw new Error("Select a conversation before continuing");
      if (target.status === "waiting") target.status = "running";
      else if (target.status === "running") target.status = "completed";
      else throw new Error(`Cannot advance a ${target.status} conversation`);
      target.updatedAt = new Date().toISOString();
      saved.activity.unshift({ at: target.updatedAt, text: `Mock simulation advanced to ${target.status}` });
      this.write(this.repoId, saved);
      return { stale: false, ...saved, connection: this.connection };
    }
    retry() { return this.list(); }
  };
}
