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
    const response = await fetch(url.toString(), { method: "GET" });
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
