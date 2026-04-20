/**
 * Minimal role model: each team has a CSV env of Slack user IDs.
 * A user's roles = the set of teams they appear in, plus "any" for everyone.
 *
 * Upgrade path: swap for Slack usergroups or Okta groups later without
 * changing callers.
 */

const TEAMS = ["email", "csm", "manager", "dev", "targeting"];

export function loadRolesFromEnv(env = process.env) {
  const byRole = {};
  for (const team of TEAMS) {
    const key = `ROLE_${team.toUpperCase()}_USER_IDS`;
    byRole[team] = new Set(
      (env[key] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return byRole;
}

export function rolesForUser(userId, byRole) {
  const roles = new Set(["any"]);
  for (const [team, members] of Object.entries(byRole)) {
    if (members.has(userId)) roles.add(team);
  }
  return roles;
}

export function widgetVisibleTo(widget, userRoles) {
  const allowed = widget.rolesAllowed ?? ["any"];
  if (allowed.includes("any")) return true;
  for (const r of allowed) if (userRoles.has(r)) return true;
  return false;
}
