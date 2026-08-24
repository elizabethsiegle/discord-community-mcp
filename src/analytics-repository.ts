import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MembershipSnapshot, MessageSummary } from "./discord-service.js";

export type IndexedMessage = MessageSummary & {
  channelName: string;
};

export type AnalyticsFilters = {
  guildId: string;
  channelIds?: string[];
  authorIds?: string[];
  after?: string;
  before?: string;
};

export type GrowthInterval = "day" | "week" | "month";

export type GrowthFilters = {
  guildId: string;
  channelIds?: string[];
  after?: string;
  before?: string;
  interval: GrowthInterval;
  roleId?: string;
  includeBots: boolean;
};

export type EvidenceMessage = {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  replyToMessageId: string | null;
  url: string;
  matchedPhrases: string[];
  relevanceScore: number;
};

type MessageRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  author_id: string;
  author_name: string;
  author_bot: number;
  content: string;
  created_at: string;
  edited_at: string | null;
  reply_to_message_id: string | null;
  attachment_count: number;
  embed_count: number;
  reaction_count: number;
};

type CountRow = { count: number };

export class AnalyticsRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertMessages(messages: IndexedMessage[]): number {
    if (messages.length === 0) return 0;

    const upsert = this.db.prepare(`
      INSERT INTO messages (
        id, guild_id, channel_id, channel_name, author_id, author_name, author_bot,
        content, created_at, edited_at, reply_to_message_id, attachment_count,
        embed_count, reaction_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_name = excluded.channel_name,
        author_name = excluded.author_name,
        content = excluded.content,
        edited_at = excluded.edited_at,
        reply_to_message_id = excluded.reply_to_message_id,
        attachment_count = excluded.attachment_count,
        embed_count = excluded.embed_count,
        reaction_count = excluded.reaction_count
    `);
    const deleteFts = this.db.prepare("DELETE FROM messages_fts WHERE message_id = ?");
    const insertFts = this.db.prepare(
      "INSERT INTO messages_fts (message_id, content, author_name, channel_name) VALUES (?, ?, ?, ?)",
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of messages) {
        upsert.run(
          message.id,
          message.guildId ?? "",
          message.channelId,
          message.channelName,
          message.author.id,
          message.author.displayName,
          message.author.bot ? 1 : 0,
          message.content,
          message.createdAt,
          message.editedAt,
          message.replyToMessageId,
          message.attachments.length,
          message.embeds,
          message.reactions.reduce((sum, reaction) => sum + reaction.count, 0),
        );
        deleteFts.run(message.id);
        insertFts.run(message.id, message.content, message.author.displayName, message.channelName);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return messages.length;
  }

  recordChannelSync(input: {
    guildId: string;
    channelId: string;
    channelName: string;
    oldestMessageAt: string | null;
    newestMessageAt: string | null;
    truncated: boolean;
  }): void {
    const totalIndexed = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?")
      .get(input.channelId) as CountRow;
    this.db
      .prepare(`
        INSERT INTO channel_syncs (
          channel_id, guild_id, channel_name, last_synced_at, indexed_messages,
          oldest_message_at, newest_message_at, truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          channel_name = excluded.channel_name,
          last_synced_at = excluded.last_synced_at,
          indexed_messages = excluded.indexed_messages,
          oldest_message_at = CASE
            WHEN channel_syncs.oldest_message_at IS NULL THEN excluded.oldest_message_at
            WHEN excluded.oldest_message_at IS NULL THEN channel_syncs.oldest_message_at
            ELSE MIN(channel_syncs.oldest_message_at, excluded.oldest_message_at)
          END,
          newest_message_at = CASE
            WHEN channel_syncs.newest_message_at IS NULL THEN excluded.newest_message_at
            WHEN excluded.newest_message_at IS NULL THEN channel_syncs.newest_message_at
            ELSE MAX(channel_syncs.newest_message_at, excluded.newest_message_at)
          END,
          truncated = excluded.truncated
      `)
      .run(
        input.channelId,
        input.guildId,
        input.channelName,
        new Date().toISOString(),
        totalIndexed.count,
        input.oldestMessageAt,
        input.newestMessageAt,
        input.truncated ? 1 : 0,
      );
  }

  recordMembershipSnapshot(snapshot: MembershipSnapshot): Record<string, unknown> {
    const previousRows = this.db
      .prepare("SELECT user_id, present FROM guild_members WHERE guild_id = ?")
      .all(snapshot.guildId) as Array<{ user_id: string; present: number }>;
    const knownIds = new Set(previousRows.map((row) => row.user_id));
    const previouslyPresentIds = new Set(
      previousRows.filter((row) => row.present === 1).map((row) => row.user_id),
    );
    const currentIds = new Set(snapshot.members.map((member) => member.id));
    const roleCounts = new Map<
      string,
      { name: string; total: number; humans: number; bots: number }
    >();

    for (const member of snapshot.members) {
      for (const role of member.roles) {
        const count = roleCounts.get(role.id) ?? {
          name: role.name,
          total: 0,
          humans: 0,
          bots: 0,
        };
        count.total += 1;
        if (member.bot) count.bots += 1;
        else count.humans += 1;
        roleCounts.set(role.id, count);
      }
    }

    const insertSnapshot = this.db.prepare(`
      INSERT INTO membership_snapshots (
        guild_id, guild_name, captured_at, reported_member_count,
        fetched_member_count, human_members, bot_members
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const markAbsent = this.db.prepare(`
      UPDATE guild_members
      SET present = 0, left_observed_at = COALESCE(left_observed_at, ?)
      WHERE guild_id = ? AND present = 1
    `);
    const upsertMember = this.db.prepare(`
      INSERT INTO guild_members (
        guild_id, user_id, username, display_name, bot, joined_at,
        account_created_at, first_observed_at, last_observed_at, present,
        left_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        bot = excluded.bot,
        joined_at = excluded.joined_at,
        account_created_at = excluded.account_created_at,
        last_observed_at = excluded.last_observed_at,
        present = 1,
        left_observed_at = NULL
    `);
    const deleteMemberRoles = this.db.prepare(
      "DELETE FROM guild_member_roles WHERE guild_id = ? AND user_id = ?",
    );
    const insertMemberRole = this.db.prepare(`
      INSERT INTO guild_member_roles (guild_id, user_id, role_id, role_name)
      VALUES (?, ?, ?, ?)
    `);
    const insertRoleCount = this.db.prepare(`
      INSERT INTO membership_snapshot_roles (
        snapshot_id, role_id, role_name, total_members, human_members, bot_members
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const humanMembers = snapshot.members.filter((member) => !member.bot).length;
      const snapshotResult = insertSnapshot.run(
        snapshot.guildId,
        snapshot.guildName,
        snapshot.capturedAt,
        snapshot.reportedMemberCount,
        snapshot.fetchedMemberCount,
        humanMembers,
        snapshot.members.length - humanMembers,
      );
      const snapshotId = Number(snapshotResult.lastInsertRowid);

      markAbsent.run(snapshot.capturedAt, snapshot.guildId);
      for (const member of snapshot.members) {
        upsertMember.run(
          snapshot.guildId,
          member.id,
          member.username,
          member.displayName,
          member.bot ? 1 : 0,
          member.joinedAt,
          member.accountCreatedAt,
          snapshot.capturedAt,
          snapshot.capturedAt,
        );
        deleteMemberRoles.run(snapshot.guildId, member.id);
        for (const role of member.roles) {
          insertMemberRole.run(snapshot.guildId, member.id, role.id, role.name);
        }
      }
      for (const [roleId, count] of roleCounts) {
        insertRoleCount.run(
          snapshotId,
          roleId,
          count.name,
          count.total,
          count.humans,
          count.bots,
        );
      }

      this.db.exec("COMMIT");
      return {
        snapshotId,
        guildId: snapshot.guildId,
        guildName: snapshot.guildName,
        capturedAt: snapshot.capturedAt,
        reportedMemberCount: snapshot.reportedMemberCount,
        fetchedMemberCount: snapshot.fetchedMemberCount,
        humanMembers,
        botMembers: snapshot.members.length - humanMembers,
        rolesCaptured: roleCounts.size,
        newlyObservedMembers: snapshot.members.filter((member) => !knownIds.has(member.id)).length,
        rejoinedSincePreviousSnapshot: snapshot.members.filter(
          (member) => knownIds.has(member.id) && !previouslyPresentIds.has(member.id),
        ).length,
        departuresSincePreviousSnapshot: [...previouslyPresentIds].filter(
          (memberId) => !currentIds.has(memberId),
        ).length,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  buildGrowthReport(filters: GrowthFilters): Record<string, unknown> {
    const periodExpression = periodSql(filters.interval);
    const snapshotParams: SQLInputValue[] = [filters.guildId];
    const snapshotDateClauses = ["s.guild_id = ?"];
    if (filters.after) {
      snapshotDateClauses.push("s.captured_at >= ?");
      snapshotParams.push(filters.after);
    }
    if (filters.before) {
      snapshotDateClauses.push("s.captured_at < ?");
      snapshotParams.push(filters.before);
    }

    const snapshotMetric = filters.roleId
      ? filters.includeBots
        ? "COALESCE(sr.total_members, 0)"
        : "COALESCE(sr.human_members, 0)"
      : filters.includeBots
        ? "s.fetched_member_count"
        : "s.human_members";
    const snapshotJoin = filters.roleId
      ? "LEFT JOIN membership_snapshot_roles sr ON sr.snapshot_id = s.id AND sr.role_id = ?"
      : "";
    const effectiveSnapshotParams = filters.roleId
      ? [filters.roleId, ...snapshotParams]
      : snapshotParams;
    const snapshots = this.db
      .prepare(`
        SELECT s.captured_at, ${snapshotMetric} AS members,
               s.fetched_member_count, s.human_members, s.bot_members
        FROM membership_snapshots s
        ${snapshotJoin}
        WHERE ${snapshotDateClauses.join(" AND ")}
        ORDER BY s.captured_at
      `)
      .all(...effectiveSnapshotParams) as Array<Record<string, unknown>>;

    const memberParams: SQLInputValue[] = [filters.guildId];
    const memberClauses = ["gm.guild_id = ?", "gm.joined_at IS NOT NULL"];
    if (!filters.includeBots) memberClauses.push("gm.bot = 0");
    if (filters.after) {
      memberClauses.push("gm.joined_at >= ?");
      memberParams.push(filters.after);
    }
    if (filters.before) {
      memberClauses.push("gm.joined_at < ?");
      memberParams.push(filters.before);
    }
    if (filters.roleId) {
      memberClauses.push(
        "EXISTS (SELECT 1 FROM guild_member_roles gmr WHERE gmr.guild_id = gm.guild_id AND gmr.user_id = gm.user_id AND gmr.role_id = ?)",
      );
      memberParams.push(filters.roleId);
    }
    const joinsByPeriod = this.db
      .prepare(`
        SELECT ${periodExpression.replaceAll("event_time", "gm.joined_at")} AS period,
               COUNT(*) AS joined_members
        FROM guild_members gm
        WHERE ${memberClauses.join(" AND ")}
        GROUP BY period
        ORDER BY period
      `)
      .all(...memberParams) as Array<{ period: string; joined_members: number }>;

    const activityParams: SQLInputValue[] = [filters.guildId];
    const activityClauses = ["m.guild_id = ?"];
    if (!filters.includeBots) activityClauses.push("m.author_bot = 0");
    if (filters.channelIds?.length) {
      activityClauses.push(`m.channel_id IN (${filters.channelIds.map(() => "?").join(", ")})`);
      activityParams.push(...filters.channelIds);
    }
    if (filters.after) {
      activityClauses.push("m.created_at >= ?");
      activityParams.push(filters.after);
    }
    if (filters.before) {
      activityClauses.push("m.created_at < ?");
      activityParams.push(filters.before);
    }
    if (filters.roleId) {
      activityClauses.push(
        "EXISTS (SELECT 1 FROM guild_member_roles gmr WHERE gmr.guild_id = m.guild_id AND gmr.user_id = m.author_id AND gmr.role_id = ?)",
      );
      activityParams.push(filters.roleId);
    }
    const activityByPeriod = this.db
      .prepare(`
        SELECT ${periodExpression.replaceAll("event_time", "m.created_at")} AS period,
               COUNT(*) AS messages,
               COUNT(DISTINCT m.author_id) AS active_contributors
        FROM messages m
        WHERE ${activityClauses.join(" AND ")}
        GROUP BY period
        ORDER BY period
      `)
      .all(...activityParams) as Array<{
        period: string;
        messages: number;
        active_contributors: number;
      }>;

    const firstContributorParams: SQLInputValue[] = [filters.guildId];
    const firstContributorClauses = ["m.guild_id = ?"];
    if (!filters.includeBots) firstContributorClauses.push("m.author_bot = 0");
    if (filters.channelIds?.length) {
      firstContributorClauses.push(
        `m.channel_id IN (${filters.channelIds.map(() => "?").join(", ")})`,
      );
      firstContributorParams.push(...filters.channelIds);
    }
    if (filters.roleId) {
      firstContributorClauses.push(
        "EXISTS (SELECT 1 FROM guild_member_roles gmr WHERE gmr.guild_id = m.guild_id AND gmr.user_id = m.author_id AND gmr.role_id = ?)",
      );
      firstContributorParams.push(filters.roleId);
    }
    const firstSeenOuterClauses: string[] = [];
    if (filters.after) {
      firstSeenOuterClauses.push("first_message_at >= ?");
      firstContributorParams.push(filters.after);
    }
    if (filters.before) {
      firstSeenOuterClauses.push("first_message_at < ?");
      firstContributorParams.push(filters.before);
    }
    const firstContributorsByPeriod = this.db
      .prepare(`
        WITH first_seen AS (
          SELECT m.author_id, MIN(m.created_at) AS first_message_at
          FROM messages m
          WHERE ${firstContributorClauses.join(" AND ")}
          GROUP BY m.author_id
        )
        SELECT ${periodExpression.replaceAll("event_time", "first_message_at")} AS period,
               COUNT(*) AS first_time_contributors
        FROM first_seen
        ${firstSeenOuterClauses.length ? `WHERE ${firstSeenOuterClauses.join(" AND ")}` : ""}
        GROUP BY period
        ORDER BY period
      `)
      .all(...firstContributorParams) as Array<{
        period: string;
        first_time_contributors: number;
      }>;

    const periods = new Map<
      string,
      {
        period: string;
        joinedMembers: number;
        messages: number;
        activeContributors: number;
        firstTimeContributors: number;
      }
    >();
    const ensurePeriod = (period: string) => {
      const existing = periods.get(period);
      if (existing) return existing;
      const created = {
        period,
        joinedMembers: 0,
        messages: 0,
        activeContributors: 0,
        firstTimeContributors: 0,
      };
      periods.set(period, created);
      return created;
    };
    for (const row of joinsByPeriod) ensurePeriod(row.period).joinedMembers = row.joined_members;
    for (const row of activityByPeriod) {
      const period = ensurePeriod(row.period);
      period.messages = row.messages;
      period.activeContributors = row.active_contributors;
    }
    for (const row of firstContributorsByPeriod) {
      ensurePeriod(row.period).firstTimeContributors = row.first_time_contributors;
    }

    const firstSnapshot = snapshots[0];
    const lastSnapshot = snapshots.at(-1);
    const firstSnapshotMembers = Number(firstSnapshot?.members ?? 0);
    const lastSnapshotMembers = Number(lastSnapshot?.members ?? 0);
    const snapshotChange =
      snapshots.length >= 2 ? lastSnapshotMembers - firstSnapshotMembers : null;

    const rosterCoverageParams: SQLInputValue[] = [filters.guildId];
    const rosterCoverageClauses = ["gm.guild_id = ?"];
    if (!filters.includeBots) rosterCoverageClauses.push("gm.bot = 0");
    if (filters.roleId) {
      rosterCoverageClauses.push(
        "EXISTS (SELECT 1 FROM guild_member_roles gmr WHERE gmr.guild_id = gm.guild_id AND gmr.user_id = gm.user_id AND gmr.role_id = ?)",
      );
      rosterCoverageParams.push(filters.roleId);
    }
    const rosterCoverage = this.db
      .prepare(`
        SELECT COUNT(*) AS observed_members,
               COALESCE(SUM(CASE WHEN gm.joined_at IS NOT NULL THEN 1 ELSE 0 END), 0)
                 AS members_with_join_date,
               COALESCE(SUM(CASE WHEN gm.present = 1 THEN 1 ELSE 0 END), 0)
                 AS currently_present
        FROM guild_members gm
        WHERE ${rosterCoverageClauses.join(" AND ")}
      `)
      .get(...rosterCoverageParams) as Record<string, unknown>;

    return {
      guildId: filters.guildId,
      filters: {
        interval: filters.interval,
        includeBots: filters.includeBots,
        ...(filters.roleId ? { roleId: filters.roleId } : {}),
        ...(filters.channelIds ? { channelIds: filters.channelIds } : {}),
        ...(filters.after ? { after: filters.after } : {}),
        ...(filters.before ? { before: filters.before } : {}),
      },
      currentRosterCoverage: rosterCoverage,
      exactMembershipSnapshots: {
        count: snapshots.length,
        first: firstSnapshot ?? null,
        latest: lastSnapshot ?? null,
        absoluteChange: snapshotChange,
        percentChange:
          snapshotChange === null || firstSnapshotMembers === 0
            ? null
            : Number((snapshotChange / firstSnapshotMembers).toFixed(4)),
        timeline: snapshots,
      },
      timeline: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)),
      metricDefinitions: {
        joinedMembers:
          "Members currently or previously observed by a full roster snapshot, grouped by their Discord joined_at timestamp.",
        activeContributors: "Distinct indexed message authors in the period.",
        firstTimeContributors:
          "Authors whose first indexed message in the selected channel scope occurred in the period.",
      },
      limitations: [
        "Exact total membership is available only at saved snapshot times.",
        "Join-date history excludes people who left before the first roster snapshot and were never observed.",
        "Departures are detected between full snapshots, so the exact departure time is not known.",
        "Message participation depends on indexed channel and date coverage.",
        ...(filters.roleId
          ? [
              "Role-filtered join and message history uses each observed member's latest captured role, not their historical role at the time.",
            ]
          : []),
      ],
    };
  }

  getCoverage(filters: AnalyticsFilters): Record<string, unknown> {
    const { sql, params } = buildWhere(filters);
    const overall = this.db
      .prepare(`
        SELECT
          COUNT(*) AS messages,
          COUNT(DISTINCT channel_id) AS channels,
          COUNT(DISTINCT CASE WHEN author_bot = 0 THEN author_id END) AS human_authors,
          MIN(created_at) AS oldest_message_at,
          MAX(created_at) AS newest_message_at,
          SUM(CASE WHEN content = '' THEN 1 ELSE 0 END) AS empty_content_messages
        FROM messages m ${sql}
      `)
      .get(...params) as Record<string, unknown>;
    const syncs = this.db
      .prepare(`
        SELECT channel_id, channel_name, last_synced_at, indexed_messages,
               oldest_message_at, newest_message_at, truncated
        FROM channel_syncs
        WHERE guild_id = ?
        ORDER BY channel_name
      `)
      .all(filters.guildId);

    return { ...overall, channelSyncs: syncs };
  }

  buildEvidencePacket(
    question: string,
    filters: AnalyticsFilters,
    searchPhrases: string[],
    evidenceLimit: number,
  ): Record<string, unknown> {
    const { sql, params } = buildWhere(filters);
    const overview = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total_messages,
          SUM(CASE WHEN author_bot = 0 THEN 1 ELSE 0 END) AS human_messages,
          SUM(CASE WHEN author_bot = 1 THEN 1 ELSE 0 END) AS bot_messages,
          COUNT(DISTINCT CASE WHEN author_bot = 0 THEN author_id END) AS active_human_authors,
          COUNT(DISTINCT channel_id) AS active_channels,
          COUNT(DISTINCT DATE(created_at)) AS active_days,
          MIN(created_at) AS first_message_at,
          MAX(created_at) AS last_message_at
        FROM messages m ${sql}
      `)
      .get(...params) as Record<string, unknown>;

    const responseRows = this.db
      .prepare(`
        SELECT (julianday(r.created_at) - julianday(p.created_at)) * 86400.0 AS seconds
        FROM messages r
        JOIN messages p ON p.id = r.reply_to_message_id
        ${sql.replaceAll("m.", "r.")}
          AND r.created_at >= p.created_at
          AND r.author_id <> p.author_id
          AND r.author_bot = 0 AND p.author_bot = 0
        ORDER BY seconds
      `)
      .all(...params) as Array<{ seconds: number }>;
    const responseSeconds = responseRows.map((row) => row.seconds).filter((value) => value >= 0);

    const repliedTo = this.db
      .prepare(`
        SELECT COUNT(DISTINCT p.id) AS count
        FROM messages p
        JOIN messages r ON r.reply_to_message_id = p.id AND r.author_id <> p.author_id
        ${sql.replaceAll("m.", "p.")}
          AND p.author_bot = 0 AND r.author_bot = 0
      `)
      .get(...params) as CountRow;

    const topAuthors = this.db
      .prepare(`
        SELECT author_id, author_name, COUNT(*) AS messages,
               SUM(CASE WHEN reply_to_message_id IS NOT NULL THEN 1 ELSE 0 END) AS explicit_replies
        FROM messages m ${sql} AND author_bot = 0
        GROUP BY author_id, author_name
        ORDER BY messages DESC
        LIMIT 20
      `)
      .all(...params) as Array<Record<string, unknown>>;

    const channelActivity = this.db
      .prepare(`
        SELECT channel_id, channel_name, COUNT(*) AS messages,
               COUNT(DISTINCT CASE WHEN author_bot = 0 THEN author_id END) AS human_authors
        FROM messages m ${sql}
        GROUP BY channel_id, channel_name
        ORDER BY messages DESC
        LIMIT 25
      `)
      .all(...params);

    const weekdayActivity = this.db
      .prepare(`
        SELECT CASE strftime('%w', created_at)
          WHEN '0' THEN 'Sunday' WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday'
          WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday'
          ELSE 'Saturday' END AS weekday,
          COUNT(*) AS messages
        FROM messages m ${sql}
        GROUP BY strftime('%w', created_at)
        ORDER BY CAST(strftime('%w', created_at) AS INTEGER)
      `)
      .all(...params);

    const authorCounts = topAuthors.map((row) => Number(row.messages));
    const totalHumanMessages = Number(overview.human_messages ?? 0);
    const edgeRows = this.db
      .prepare(`
        SELECT DISTINCT r.author_id AS source, p.author_id AS target
        FROM messages r
        JOIN messages p ON p.id = r.reply_to_message_id
        ${sql.replaceAll("m.", "r.")}
          AND r.author_id <> p.author_id
          AND r.author_bot = 0 AND p.author_bot = 0
      `)
      .all(...params) as Array<{ source: string; target: string }>;
    const edgeKeys = new Set(edgeRows.map((edge) => `${edge.source}:${edge.target}`));
    const reciprocalEdges = edgeRows.filter((edge) => edgeKeys.has(`${edge.target}:${edge.source}`)).length;
    const activeAuthors = Number(overview.active_human_authors ?? 0);
    const repeatAuthors = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT author_id
          FROM messages m ${sql} AND author_bot = 0
          GROUP BY author_id
          HAVING COUNT(DISTINCT strftime('%Y-%W', created_at)) >= 2
        )
      `)
      .get(...params) as CountRow;

    return {
      researchQuestion: question,
      filters,
      coverage: this.getCoverage(filters),
      overview,
      responsiveness: {
        measurement: "Explicit replies by a different author to an indexed message",
        observedReplyPairs: responseSeconds.length,
        medianSeconds: percentile(responseSeconds, 0.5),
        p75Seconds: percentile(responseSeconds, 0.75),
        p90Seconds: percentile(responseSeconds, 0.9),
        messagesReceivingExplicitReply: repliedTo.count,
        messagesWithoutObservedExplicitReply: Math.max(0, totalHumanMessages - repliedTo.count),
      },
      participation: {
        activeHumanAuthors: activeAuthors,
        repeatAuthorRate: ratio(repeatAuthors.count, activeAuthors),
        topAuthorMessageShare: ratio(authorCounts[0] ?? 0, totalHumanMessages),
        topFiveAuthorMessageShare: ratio(
          authorCounts.slice(0, 5).reduce((sum, count) => sum + count, 0),
          totalHumanMessages,
        ),
        topAuthors,
      },
      reciprocity: {
        measurement: "Direction of explicit replies between human authors",
        directedRelationships: edgeRows.length,
        reciprocalRelationshipRate: ratio(reciprocalEdges, edgeRows.length),
      },
      channelActivity,
      weekdayActivity,
      relevantEvidence: this.searchEvidence(
        filters,
        searchPhrases.length > 0 ? searchPhrases : [question],
        evidenceLimit,
      ),
      representativeSample: this.sampleEvidence(filters, Math.min(evidenceLimit, 25)),
      interpretationGuidance: [
        "Use the metrics and message evidence that are relevant to the research question; do not force every metric into the answer.",
        "Treat explanations of why people behave a certain way as hypotheses unless message evidence directly supports them.",
        "Use the representative sample to test for patterns that keyword search might miss or bias.",
        "Explicit Discord replies undercount conversational responses that do not use the Reply action.",
        "Check coverage and date/channel filters before generalizing to the whole community.",
        "Quote sparingly, link to representative messages, and avoid exposing unnecessary personal information.",
      ],
    };
  }

  private searchEvidence(
    filters: AnalyticsFilters,
    phrases: string[],
    limit: number,
  ): EvidenceMessage[] {
    const effectivePhrases = phrases.length > 0 ? phrases : [];
    const candidates = new Map<string, EvidenceMessage>();

    for (const phrase of effectivePhrases.slice(0, 8)) {
      const matchQuery = toFtsQuery(phrase);
      if (!matchQuery) continue;
      const { sql, params } = buildWhere(filters);
      const rows = this.db
        .prepare(`
          SELECT m.*, bm25(messages_fts) AS rank
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.message_id
          ${sql} AND messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(...params, matchQuery, Math.max(limit, 10)) as Array<MessageRow & { rank: number }>;

      rows.forEach((row, rank) => {
        const existing = candidates.get(row.id);
        if (existing) {
          existing.matchedPhrases.push(phrase);
          existing.relevanceScore += 1 / (rank + 1);
        } else {
          candidates.set(row.id, {
            id: row.id,
            channelId: row.channel_id,
            channelName: row.channel_name,
            authorId: row.author_id,
            authorName: row.author_name,
            content: row.content,
            createdAt: row.created_at,
            replyToMessageId: row.reply_to_message_id,
            url: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.id}`,
            matchedPhrases: [phrase],
            relevanceScore: 1 / (rank + 1),
          });
        }
      });
    }

    return [...candidates.values()]
      .sort(
        (a, b) =>
          b.matchedPhrases.length - a.matchedPhrases.length ||
          b.relevanceScore - a.relevanceScore,
      )
      .slice(0, limit)
      .map((message) => ({
        ...message,
        relevanceScore: Number(message.relevanceScore.toFixed(4)),
      }));
  }

  private sampleEvidence(filters: AnalyticsFilters, limit: number): EvidenceMessage[] {
    const { sql, params } = buildWhere(filters);
    const rows = this.db
      .prepare(`
        SELECT m.*
        FROM messages m ${sql}
        ORDER BY random()
        LIMIT ?
      `)
      .all(...params, limit) as MessageRow[];

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
      replyToMessageId: row.reply_to_message_id,
      url: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.id}`,
      matchedPhrases: [],
      relevanceScore: 0,
    }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_bot INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        reply_to_message_id TEXT,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        embed_count INTEGER NOT NULL DEFAULT 0,
        reaction_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_message_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        content,
        author_name,
        channel_name,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS channel_syncs (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        indexed_messages INTEGER NOT NULL,
        oldest_message_at TEXT,
        newest_message_at TEXT,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_channel_syncs_guild ON channel_syncs(guild_id);
      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        bot INTEGER NOT NULL,
        joined_at TEXT,
        account_created_at TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        present INTEGER NOT NULL DEFAULT 1,
        left_observed_at TEXT,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guild_members_joined
        ON guild_members(guild_id, joined_at);
      CREATE INDEX IF NOT EXISTS idx_guild_members_present
        ON guild_members(guild_id, present);
      CREATE TABLE IF NOT EXISTS guild_member_roles (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id, role_id),
        FOREIGN KEY (guild_id, user_id)
          REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_guild_member_roles_role
        ON guild_member_roles(guild_id, role_id);
      CREATE TABLE IF NOT EXISTS membership_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        reported_member_count INTEGER NOT NULL,
        fetched_member_count INTEGER NOT NULL,
        human_members INTEGER NOT NULL,
        bot_members INTEGER NOT NULL,
        UNIQUE (guild_id, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_membership_snapshots_guild_time
        ON membership_snapshots(guild_id, captured_at);
      CREATE TABLE IF NOT EXISTS membership_snapshot_roles (
        snapshot_id INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        total_members INTEGER NOT NULL,
        human_members INTEGER NOT NULL,
        bot_members INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, role_id),
        FOREIGN KEY (snapshot_id) REFERENCES membership_snapshots(id) ON DELETE CASCADE
      );
    `);
  }
}

function periodSql(interval: GrowthInterval): string {
  switch (interval) {
    case "day":
      return "strftime('%Y-%m-%d', event_time)";
    case "week":
      return "strftime('%Y-W%W', event_time)";
    case "month":
      return "strftime('%Y-%m', event_time)";
  }
}

function buildWhere(filters: AnalyticsFilters): { sql: string; params: SQLInputValue[] } {
  const clauses = ["m.guild_id = ?"];
  const params: SQLInputValue[] = [filters.guildId];

  if (filters.channelIds?.length) {
    clauses.push(`m.channel_id IN (${filters.channelIds.map(() => "?").join(", ")})`);
    params.push(...filters.channelIds);
  }
  if (filters.authorIds?.length) {
    clauses.push(`m.author_id IN (${filters.authorIds.map(() => "?").join(", ")})`);
    params.push(...filters.authorIds);
  }
  if (filters.after) {
    clauses.push("m.created_at >= ?");
    params.push(filters.after);
  }
  if (filters.before) {
    clauses.push("m.created_at < ?");
    params.push(filters.before);
  }

  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function percentile(sortedValues: number[], quantile: number): number | null {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] ?? 0;
  const upper = sortedValues[upperIndex] ?? lower;
  return Math.round(lower + (upper - lower) * (position - lowerIndex));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function toFtsQuery(input: string): string {
  const stopWords = new Set([
    "about", "after", "again", "also", "could", "from", "have", "into", "like",
    "that", "their", "there", "these", "they", "this", "what", "when", "where",
    "which", "with", "would", "your",
  ]);
  const tokens = input
    .normalize("NFKD")
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{3,}/gu)
    ?.filter((token) => !stopWords.has(token))
    .slice(0, 12);
  return [...new Set(tokens ?? [])].map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
}
