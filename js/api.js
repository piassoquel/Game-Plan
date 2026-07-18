export class GamePlanApi {
  constructor(config) {
    this.config = config || {};
    this.googleIdToken = "";
  }

  get isConfigured() {
    return Boolean(this.config.apiBaseUrl);
  }

  setGoogleIdToken(token) {
    this.googleIdToken = String(token || "");
  }

  clearGoogleIdToken() {
    this.googleIdToken = "";
  }

  async post(action, data = {}) {
    if (!this.isConfigured) throw new Error("API URL is not configured.");
    if (!this.googleIdToken) throw new Error("Google sign-in is required.");
    const response = await fetch(this.config.apiBaseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action,
        googleIdToken: this.googleIdToken,
        data: { ...data, googleIdToken: this.googleIdToken }
      })
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API error");
    return payload.data;
  }

  authenticate() { return this.post("authCheck"); }
  getBootstrap() { return this.post("bootstrap"); }
  verifyPin(pin, requiredPermission = "") {
    return this.post("verifyPin", { pin, requiredPermission });
  }
  createJob(jobData, pinToken = "", approvalToken = "") {
    return this.post("createJob", { ...jobData, pinToken, approvalToken });
  }
  updateJobStatus(jobId, newStatus, statusNote = "", pinToken = "", approvalToken = "") {
    return this.post("updateJobStatus", { jobId, newStatus, statusNote, pinToken, approvalToken });
  }
  updateEquipmentBuildStatus(jobId, jobEquipmentId, buildComplete = true, pinToken = "", approvalToken = "") {
    return this.post("updateEquipmentBuildStatus", { jobId, jobEquipmentId, buildComplete, pinToken, approvalToken });
  }
  getJob(jobId) { return this.post("job", { jobId }); }
}
