/**
 * Minimal Jira REST v2 client.
 * Uses built-in fetch (Node >= 18) so there is no extra dependency.
 *
 * Auth: Personal Access Token (Atlassian Data Center / Server) via
 *   Authorization: Bearer <token>
 * Works fine against jira.corp.nortonlifelock.com from any host that can
 * reach it (VPN or corp network).
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export class JiraClient {
  constructor({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) throw new Error("JiraClient: baseUrl required");
    if (!token) throw new Error("JiraClient: token required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async #request(pathAndQuery, init = {}) {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Jira ${res.status} ${res.statusText} for ${pathAndQuery}: ${body.slice(0, 500)}`
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Returns the total number of issues matching the JQL (count only, no issues). */
  async searchCount(jql) {
    const params = new URLSearchParams({
      jql,
      maxResults: "0",
      fields: "summary",
    });
    const data = await this.#request(`/rest/api/2/search?${params.toString()}`);
    return Number(data.total ?? 0);
  }

  /** Returns issues matching the JQL (fields configurable, capped). */
  async search(jql, { fields = ["summary", "status", "assignee"], maxResults = 50, startAt = 0 } = {}) {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      startAt: String(startAt),
      fields: fields.join(","),
    });
    const data = await this.#request(`/rest/api/2/search?${params.toString()}`);
    return {
      issues: data.issues ?? [],
      total: Number(data.total ?? 0),
      startAt: Number(data.startAt ?? startAt),
      maxResults: Number(data.maxResults ?? maxResults),
    };
  }

  /**
   * Paginates through all results for the JQL, with a hard cap to avoid
   * runaway calls on huge backlogs. Default cap = 500 issues.
   */
  async searchAll(jql, { fields, pageSize = 100, hardCap = 500 } = {}) {
    const out = [];
    let startAt = 0;
    while (out.length < hardCap) {
      const page = await this.search(jql, {
        fields,
        maxResults: Math.min(pageSize, hardCap - out.length),
        startAt,
      });
      out.push(...page.issues);
      if (out.length >= page.total) break;
      if (page.issues.length === 0) break;
      startAt += page.issues.length;
    }
    return out;
  }

  /** Dashboard + gadget introspection, useful to reverse-engineer an existing report. */
  async getDashboardGadgets(dashboardId) {
    return this.#request(`/rest/api/2/dashboard/${dashboardId}/gadget`);
  }

  async whoAmI() {
    return this.#request(`/rest/api/2/myself`);
  }
}

export function jiraFromEnv() {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const token = process.env.JIRA_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return new JiraClient({ baseUrl, token });
}
