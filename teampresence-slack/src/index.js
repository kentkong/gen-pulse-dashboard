import "dotenv/config";
import crypto from "node:crypto";
import { App } from "@slack/bolt";
import {
  openDb,
  upsertPresence,
  getPresence,
  createRollcall,
  setRollcallMessageTs,
  recordRollcallResponse,
  getRollcall,
  listRollcallResponses,
  upsertCheckin,
} from "./db.js";
import { parseUntil, tokenizeCommandText } from "./parse.js";
import { registerWebRoutes } from "./web.js";
import { jiraFromEnv } from "./jira.js";
import { buildWeeklyThroughput, formatThroughputForSlack } from "./reports.js";
import { scheduleWeekly } from "./schedule.js";

const databasePath = process.env.DATABASE_PATH ?? "./data/teampresence.db";
const db = openDb(databasePath);

const BRAND_NAME = process.env.BRAND_NAME ?? "EMAIL NORTON";
const TEAM_TIMEZONE = process.env.TEAM_TIMEZONE ?? "Europe/Prague";
const BOSS_CHANNEL_ID = (process.env.BOSS_CHANNEL_ID ?? "").trim();
const REPORTS_CHANNEL_ID = (process.env.REPORTS_CHANNEL_ID ?? "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").trim();
const THROUGHPUT_JQL = (process.env.JIRA_THROUGHPUT_JQL ?? "").trim();

const adminIds = new Set(
  (process.env.TEAMPRESENCE_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAdmin(userId) {
  if (adminIds.size === 0) return true;
  return adminIds.has(userId);
}

function fmtTs(ts) {
  if (!ts) return "no end time";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function todayInTz(tz = TEAM_TIMEZONE, when = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

const CHECKIN_STATES = new Set(["in", "wfh", "sick", "pto", "late"]);
const CHECKIN_LABELS = {
  in: "In office",
  wfh: "Working from home",
  sick: "Sick",
  pto: "PTO / annual leave",
  late: "Running late",
};
const EXCEPTION_CHECKIN_STATES = new Set(["sick", "pto", "late"]);
const EXCEPTION_PRESENCE_STATES = new Set(["away", "ooo"]);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SLACK_SOCKET_MODE === "true",
  appToken: process.env.SLACK_APP_TOKEN,
  port: Number(process.env.PORT ?? 3000),
});

async function postBossAlert(client, text) {
  if (!BOSS_CHANNEL_ID) return;
  try {
    await client.chat.postMessage({
      channel: BOSS_CHANNEL_ID,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (err) {
    console.error("[boss-alert] failed:", err?.data?.error ?? err?.message ?? err);
  }
}

async function displayName(client, userId) {
  try {
    const u = await client.users.info({ user: userId });
    const p = u.user?.profile;
    const real = p?.real_name || u.user?.name || userId;
    return real;
  } catch {
    return userId;
  }
}

app.command("/teampresence", async ({ command, ack, respond, client }) => {
  await ack();
  const parts = tokenizeCommandText(command.text ?? "");
  const sub = (parts[0] ?? "help").toLowerCase();

  /* ------------------------------------------------------------------ *
   * Deprecation guard.
   *
   * When PRESENCE_MODEL is anything other than "bot", the dashboard
   * reads presence from Slack status (+ Workday) via src/presence/*.
   * In that world, the bot's check-in / rollcall commands are no
   * longer the source of truth — running them would silently diverge
   * from what the dashboard shows and undermine the "accuracy is the
   * most important thing" promise we made to CSM teams.
   *
   * Rather than delete the handlers (which would break rollback),
   * we short-circuit them here with a helpful message that points
   * users at the new, simpler workflow. Flipping the env var back to
   * `bot` restores the original behaviour instantly.
   * ------------------------------------------------------------------ */
  const presenceModel = (process.env.PRESENCE_MODEL ?? "bot")
    .trim()
    .toLowerCase();
  if (presenceModel !== "bot") {
    await respond({
      response_type: "ephemeral",
      text:
        `*Team Presence is now driven by your Slack status* (model: \`${presenceModel}\`).\n` +
        "You no longer need `/teampresence` commands — just set a Slack status and the dashboard picks it up within ~2 minutes:\n" +
        "• 🏖️ *On vacation* — shows Vacation (confirmed by Workday when available)\n" +
        "• 🏠 *Working from home* — shows WFH\n" +
        "• 📅 *In a meeting* — shows Meeting\n" +
        "• ☕ *Lunch / BRB* — shows Away\n" +
        "• _no status + Slack active_ — shows Available\n" +
        "_Admins: flip `PRESENCE_MODEL=bot` in the environment to restore the old commands._",
    });
    return;
  }

  if (sub === "help" || sub === "") {
    await respond({
      response_type: "ephemeral",
      text:
        `*${BRAND_NAME} — Team Presence*\n` +
        "• `/teampresence checkin in|wfh|sick|pto|late [note]` — set today's attendance.\n" +
        "• `/teampresence away <note> [until <time>]` — meeting, travel, focus, etc.\n" +
        "  _Times:_ `16:30`, `4pm`, `2026-04-16 17:00`, or ISO.\n" +
        "• `/teampresence here` — back and available.\n" +
        "• `/teampresence status` — your current entry.\n" +
        "• `/teampresence roster` — run *in a channel* to list members’ last updates (from DB).\n" +
        "• `/teampresence rollcall \"Meeting name\"` — (admins) posts attendance buttons in this channel.\n" +
        "• `/teampresence missed <rollcall-id>` — who has not answered that roll call.\n" +
        "_Tip:_ Ask everyone to enable calendar → Slack status sync for automatic “In a meeting.”",
    });
    return;
  }

  if (sub === "checkin" || sub === "check-in") {
    const rest = parts.slice(1);
    const stateRaw = (rest[0] ?? "").toLowerCase();
    if (!CHECKIN_STATES.has(stateRaw)) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/teampresence checkin in|wfh|sick|pto|late [note]`",
      });
      return;
    }
    const note = rest.slice(1).join(" ").trim() || null;
    const date = todayInTz();
    upsertCheckin(db, {
      userId: command.user_id,
      date,
      state: stateRaw,
      note,
    });

    if (stateRaw === "sick" || stateRaw === "pto") {
      upsertPresence(db, {
        userId: command.user_id,
        state: "ooo",
        note: note ?? CHECKIN_LABELS[stateRaw],
        untilTs: null,
      });
    } else if (stateRaw === "late") {
      upsertPresence(db, {
        userId: command.user_id,
        state: "away",
        note: note ? `Running late — ${note}` : "Running late",
        untilTs: null,
      });
    } else if (stateRaw === "in" || stateRaw === "wfh") {
      upsertPresence(db, {
        userId: command.user_id,
        state: "available",
        note: stateRaw === "wfh" ? (note ? `WFH — ${note}` : "WFH") : note,
        untilTs: null,
      });
    }

    await respond({
      response_type: "ephemeral",
      text: `Checked in for *${date}*: *${CHECKIN_LABELS[stateRaw]}*${
        note ? ` — ${note}` : ""
      }`,
    });

    if (EXCEPTION_CHECKIN_STATES.has(stateRaw)) {
      const name = await displayName(client, command.user_id);
      await postBossAlert(
        client,
        `:warning: *${name}* checked in as *${CHECKIN_LABELS[stateRaw]}* for ${date}${
          note ? ` — ${note}` : ""
        }`
      );
    }
    return;
  }

  if (sub === "here" || sub === "back") {
    upsertPresence(db, {
      userId: command.user_id,
      state: "available",
      note: null,
      untilTs: null,
    });
    await respond({
      response_type: "ephemeral",
      text: "Marked you as *available*.",
    });
    return;
  }

  if (sub === "status") {
    const row = getPresence(db, command.user_id);
    if (!row) {
      await respond({
        response_type: "ephemeral",
        text: "No presence record yet. Use `/teampresence away ...` or `/teampresence here`.",
      });
      return;
    }
    await respond({
      response_type: "ephemeral",
      text: `*${row.state}*${row.note ? ` — ${row.note}` : ""}${
        row.until_ts ? ` _until ${fmtTs(row.until_ts)}_` : ""
      }\n_Last update:_ ${new Date(row.updated_at).toLocaleString()}`,
    });
    return;
  }

  if (sub === "away" || sub === "busy" || sub === "ooo") {
    const rest = parts.slice(1);
    let untilTs = null;
    let noteParts = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].toLowerCase() === "until" && rest[i + 1]) {
        untilTs = parseUntil(rest.slice(i + 1).join(" "));
        break;
      }
      noteParts.push(rest[i]);
    }
    const note = noteParts.join(" ").trim() || "(no details)";
    const state = sub === "ooo" ? "ooo" : "away";
    upsertPresence(db, {
      userId: command.user_id,
      state,
      note,
      untilTs,
    });
    await respond({
      response_type: "ephemeral",
      text: `Saved: *${sub === "ooo" ? "Out of office" : "Away"}* — ${note}${
        untilTs ? ` _until ${fmtTs(untilTs)}_` : ""
      }`,
    });

    if (EXCEPTION_PRESENCE_STATES.has(state)) {
      const name = await displayName(client, command.user_id);
      await postBossAlert(
        client,
        `:information_source: *${name}* is *${
          state === "ooo" ? "out of office" : "away"
        }* — ${note}${untilTs ? ` (until ${fmtTs(untilTs)})` : ""}`
      );
    }
    return;
  }

  if (sub === "roster") {
    if (command.channel_id?.startsWith("D")) {
      await respond({
        response_type: "ephemeral",
        text: "Run `/teampresence roster` in a *channel* so the app can list channel members.",
      });
      return;
    }
    let cursor;
    const members = [];
    do {
      const res = await client.conversations.members({
        channel: command.channel_id,
        cursor,
        limit: 200,
      });
      members.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    const lines = [];
    for (const uid of members) {
      if (uid === "USLACKBOT") continue;
      const row = getPresence(db, uid);
      const name = await displayName(client, uid);
      if (!row) {
        lines.push(`• *${name}* — _no update yet_`);
        continue;
      }
      const until = row.until_ts ? ` _until ${fmtTs(row.until_ts)}_` : "";
      lines.push(
        `• *${name}* — ${row.state}${row.note ? `: ${row.note}` : ""}${until}`
      );
    }
    await respond({
      response_type: "ephemeral",
      text: `*Channel roster (saved updates)*\n${lines.join("\n")}`,
    });
    return;
  }

  if (sub === "rollcall") {
    if (!isAdmin(command.user_id)) {
      await respond({
        response_type: "ephemeral",
        text: "You are not allowed to start a roll call. Ask an admin to add your user ID to `TEAMPRESENCE_ADMIN_USER_IDS`.",
      });
      return;
    }
    const title = parts.slice(1).join(" ").trim() || "Meeting";
    const id = crypto.randomBytes(6).toString("hex");
    createRollcall(db, {
      id,
      channelId: command.channel_id,
      title,
      createdBy: command.user_id,
      messageTs: null,
    });

    const posted = await client.chat.postMessage({
      channel: command.channel_id,
      text: `Roll call: ${title}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Roll call:* ${title}\nTap your status (updates your saved presence).`,
          },
        },
        {
          type: "actions",
          block_id: `rc_${id}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Attending" },
              style: "primary",
              action_id: "rollcall_attend",
              value: id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Running late" },
              action_id: "rollcall_late",
              value: id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Absent / skip" },
              style: "danger",
              action_id: "rollcall_absent",
              value: id,
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `_Roll call id:_ \`${id}\` — use \`/teampresence missed ${id}\` for no-response list.`,
            },
          ],
        },
      ],
    });

    if (posted.ts) {
      setRollcallMessageTs(db, id, posted.ts);
    }

    await respond({
      response_type: "ephemeral",
      text: `Posted roll call \`${id}\` in this channel.`,
    });
    return;
  }

  if (sub === "missed") {
    if (!isAdmin(command.user_id)) {
      await respond({
        response_type: "ephemeral",
        text: "Not authorized for missed report.",
      });
      return;
    }
    const rollcallId = parts[1];
    if (!rollcallId) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/teampresence missed <rollcall-id>`",
      });
      return;
    }
    const rc = getRollcall(db, rollcallId);
    if (!rc) {
      await respond({
        response_type: "ephemeral",
        text: "Unknown roll call id.",
      });
      return;
    }
    let cursor;
    const members = [];
    do {
      const res = await client.conversations.members({
        channel: rc.channel_id,
        cursor,
        limit: 200,
      });
      members.push(...(res.members ?? []));
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    const answered = new Set(
      listRollcallResponses(db, rollcallId).map((r) => r.userId)
    );
    const missing = [];
    for (const uid of members) {
      if (uid === "USLACKBOT") continue;
      if (!answered.has(uid)) {
        missing.push(await displayName(client, uid));
      }
    }
    await respond({
      response_type: "ephemeral",
      text:
        `*No button response yet* for roll call *${rc.title}* (\`${rollcallId}\`):\n` +
        (missing.length ? missing.map((m) => `• ${m}`).join("\n") : "_Everyone in the channel has responded._"),
    });
    return;
  }

  await respond({
    response_type: "ephemeral",
    text: `Unknown subcommand \`${sub}\`. Try \`/teampresence help\`.`,
  });
});

async function handleRollcallAction({ body, ack, action, client }) {
  await ack();
  const rollcallId = action.value;
  const userId = body.user.id;
  const statusMap = {
    rollcall_attend: "attending",
    rollcall_late: "late",
    rollcall_absent: "absent",
  };
  const status = statusMap[action.action_id];
  if (!status || !rollcallId) return;

  recordRollcallResponse(db, { rollcallId, userId, status });

  const rc = getRollcall(db, rollcallId);
  const meetingTitle = rc?.title ?? "Meeting";
  if (status === "attending") {
    upsertPresence(db, {
      userId,
      state: "away",
      note: `In meeting: ${meetingTitle}`,
      untilTs: null,
    });
  } else if (status === "late") {
    upsertPresence(db, {
      userId,
      state: "away",
      note: `Late for: ${meetingTitle}`,
      untilTs: null,
    });
  } else {
    upsertPresence(db, {
      userId,
      state: "away",
      note: `Not attending: ${meetingTitle}`,
      untilTs: null,
    });
  }

  const channelId = body.channel?.id;
  if (channelId) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Recorded: *${status}* for "${meetingTitle}".`,
    });
  }

  if (status === "late" || status === "absent") {
    const name = await displayName(client, userId);
    await postBossAlert(
      client,
      `:warning: *${name}* marked *${status}* for roll call "${meetingTitle}"`
    );
  }
}

app.action("rollcall_attend", handleRollcallAction);
app.action("rollcall_late", handleRollcallAction);
app.action("rollcall_absent", handleRollcallAction);

registerWebRoutes({
  app,
  db,
  displayName,
  brandName: BRAND_NAME,
  timezone: TEAM_TIMEZONE,
  todayInTz,
});

async function runWeeklyThroughputReport() {
  const jira = jiraFromEnv();
  if (!jira || !THROUGHPUT_JQL || !REPORTS_CHANNEL_ID) {
    console.log(
      "[reports] weekly throughput skipped — set JIRA_BASE_URL, JIRA_TOKEN, JIRA_THROUGHPUT_JQL and REPORTS_CHANNEL_ID to enable."
    );
    return;
  }
  const payload = await buildWeeklyThroughput({
    jira,
    jql: THROUGHPUT_JQL,
    timezone: TEAM_TIMEZONE,
  });
  const msg = formatThroughputForSlack(payload, { dashboardUrl: PUBLIC_URL });
  await app.client.chat.postMessage({
    channel: REPORTS_CHANNEL_ID,
    text: msg.text,
    blocks: msg.blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  console.log(
    `[reports] posted weekly throughput ${payload.weekLabel} (${payload.resolved} resolved) to ${REPORTS_CHANNEL_ID}`
  );
}

scheduleWeekly({
  timezone: TEAM_TIMEZONE,
  weekday: 1, // Monday
  hour: 8,
  minute: 0,
  label: "weekly-throughput",
  fn: runWeeklyThroughputReport,
});


(async () => {
  await app.start();
  // eslint-disable-next-line no-console
  console.log(
    `${BRAND_NAME} Team Presence running on port ${process.env.PORT ?? 3000} (tz ${TEAM_TIMEZONE})`
  );
})();
