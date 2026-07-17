export class GamePlanApi {
  constructor(config) {
    this.config = config || {};
  }

  get isConfigured() {
    return Boolean(this.config.apiBaseUrl);
  }

  async getBootstrap() {
    if (!this.isConfigured) throw new Error("API URL is not configured.");
    const url = new URL(this.config.apiBaseUrl);
    url.searchParams.set("action", "bootstrap");
    url.searchParams.set("_", Date.now().toString());
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API error");
    return payload.data;
  }

  async createJob(jobData) {
    if (!this.isConfigured) throw new Error("API URL is not configured.");
    const response = await fetch(this.config.apiBaseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "createJob", data: jobData })
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API error");
    return payload.data;
  }

  async updateJobStatus(jobId, newStatus, statusNote = "") {
    if (!this.isConfigured) throw new Error("API URL is not configured.");
    const response = await fetch(this.config.apiBaseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "updateJobStatus",
        data: { jobId, newStatus, statusNote }
      })
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API error");
    return payload.data;
  }

  async getJob(jobId) {
    if (!this.isConfigured) throw new Error("API URL is not configured.");
    const url = new URL(this.config.apiBaseUrl);
    url.searchParams.set("action", "job");
    url.searchParams.set("jobId", jobId);
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API error");
    return payload.data;
  }
}
