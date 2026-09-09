import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CommunityAnalyticsService } from "./community-analytics.js";
import type { Config } from "./config.js";
import { describeDiscordError, DiscordService } from "./discord-service.js";

const snowflake = z.string().regex(/^\d{17,20}$/, "Expected a Discord snowflake ID");
const messageContent = z.string().min(1).max(2_000);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: describeDiscordError(error) }],
  };
}

function requireWrite(config: Config): ToolResult | undefined {
  if (config.writeEnabled) return undefined;

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Discord write operations are disabled. Set DISCORD_ENABLE_WRITE=true to enable them.",
      },
    ],
  };
}

function requireRoleManagement(config: Config): ToolResult | undefined {
  if (config.roleManagementEnabled) return undefined;

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Discord role management is disabled. Set DISCORD_ENABLE_ROLE_MANAGEMENT=true to enable it.",
      },
    ],
  };
}

export function createServer(
  service: DiscordService,
  config: Config,
  analytics: CommunityAnalyticsService,
): McpServer {
  const server = new McpServer({ name: "discord-community-mcp", version: "0.1.0" });

  server.registerTool(
    "discord_list_guilds",
    {
      title: "List Discord servers",
      description: "List the Discord servers (guilds) that the configured bot can access.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await service.listGuilds());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_list_channels",
    {
      title: "List Discord channels",
      description: "List channels in a Discord server that the bot can access.",
      inputSchema: { guild_id: snowflake.describe("Discord server/guild ID") },
    },
    async ({ guild_id }) => {
      try {
        return jsonResult(await service.listChannels(guild_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_sync_member_snapshot",
    {
      title: "Save a Discord membership snapshot",
      description:
        "Fetch the complete current server roster and save a private local snapshot with member totals, join dates, and roles. Requires Server Members Intent; Presence Intent is not needed. Run periodically to measure exact membership changes and detect departures between snapshots.",
      inputSchema: {
        guild_id: snowflake.describe("Discord server/guild ID to snapshot"),
      },
    },
    async ({ guild_id }) => {
      try {
        return jsonResult(await analytics.syncMembership(guild_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_read_messages",
    {
      title: "Read Discord messages",
      description: "Read recent messages from a guild text channel, oldest first.",
      inputSchema: {
        channel_id: snowflake.describe("Discord channel ID"),
        limit: z.number().int().min(1).max(100).default(25),
        before: snowflake.optional().describe("Return messages before this message ID"),
      },
    },
    async ({ channel_id, limit, before }) => {
      try {
        return jsonResult(await service.readMessages(channel_id, limit, before));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_find_messages",
    {
      title: "Find a remembered Discord conversation",
      description:
        "Find messages from a vague memory using Discord's relevance index. Translate the memory into 1-5 short, distinctive search_phrases; include synonyms or likely wording when the exact words are uncertain. Results include direct Discord links. Requires Message Content Intent and Read Message History.",
      inputSchema: {
        guild_id: snowflake.describe("Discord server/guild ID to search"),
        memory: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .describe("The user's vague memory, preserved in the result"),
        search_phrases: z
          .array(z.string().trim().min(1).max(1_024))
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Short likely phrases derived from the memory. Try distinctive terms and alternate wording; defaults to the memory itself.",
          ),
        channel_ids: z
          .array(snowflake)
          .max(50)
          .optional()
          .describe("Only search these channel IDs"),
        author_ids: z
          .array(snowflake)
          .max(25)
          .optional()
          .describe("Only search messages from these user IDs"),
        after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only messages after this ISO 8601 timestamp"),
        before: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only messages before this ISO 8601 timestamp"),
        slop: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(10)
          .describe("Words allowed between matched terms; higher is fuzzier"),
        limit: z.number().int().min(1).max(25).default(10),
      },
    },
    async ({
      guild_id,
      memory,
      search_phrases,
      channel_ids,
      author_ids,
      after,
      before,
      slop,
      limit,
    }) => {
      try {
        if (after && before && Date.parse(after) >= Date.parse(before)) {
          throw new Error("after must be earlier than before");
        }

        return jsonResult(
          await service.findMessages({
            guildId: guild_id,
            memory,
            slop,
            limit,
            ...(search_phrases ? { searchPhrases: search_phrases } : {}),
            ...(channel_ids ? { channelIds: channel_ids } : {}),
            ...(author_ids ? { authorIds: author_ids } : {}),
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_get_message_context",
    {
      title: "Get context around a Discord message",
      description:
        "Fetch surrounding messages after finding a likely match, so the remembered conversation can be reconstructed.",
      inputSchema: {
        channel_id: snowflake.describe("Discord channel ID"),
        message_id: snowflake.describe("Matched Discord message ID"),
        radius: z.number().int().min(1).max(20).default(5).describe("Messages before and after"),
      },
    },
    async ({ channel_id, message_id, radius }) => {
      try {
        return jsonResult(await service.getMessageContext(channel_id, message_id, radius));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_sync_community_history",
    {
      title: "Synchronize Discord community history",
      description:
        "Index accessible Discord messages in a private local SQLite database for aggregate and qualitative community research. Run this before research, and again to refresh the data. Sync is bounded per channel and reports incomplete coverage.",
      inputSchema: {
        guild_id: snowflake.describe("Discord server/guild ID to index"),
        channel_ids: z
          .array(snowflake)
          .min(1)
          .max(50)
          .optional()
          .describe("Specific channels or threads to index; omit for readable text channels"),
        after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only index messages at or after this ISO 8601 timestamp"),
        before: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only index messages before this ISO 8601 timestamp"),
        max_channels: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Safety cap when channel_ids is omitted"),
        max_messages_per_channel: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .default(2_000)
          .describe("History cap per channel; increase deliberately for deeper studies"),
      },
    },
    async ({
      guild_id,
      channel_ids,
      after,
      before,
      max_channels,
      max_messages_per_channel,
    }) => {
      try {
        validateDateRange(after, before);
        return jsonResult(
          await analytics.syncHistory({
            guildId: guild_id,
            maxChannels: max_channels,
            maxMessagesPerChannel: max_messages_per_channel,
            ...(channel_ids ? { channelIds: channel_ids } : {}),
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_research_community",
    {
      title: "Research a Discord community question",
      description:
        "Build an evidence packet for any question about an indexed Discord community. Returns coverage, activity, response-time, participation, concentration, reciprocity, channel/timing metrics, and relevant message evidence. Interpret behavior and causality as hypotheses unless directly supported.",
      inputSchema: {
        guild_id: snowflake.describe("Indexed Discord server/guild ID"),
        question: z.string().trim().min(1).max(4_000).describe("The user's research question"),
        search_phrases: z
          .array(z.string().trim().min(1).max(500))
          .max(8)
          .default([])
          .describe(
            "Distinctive terms and alternate wording for qualitative evidence; derive these from the question",
          ),
        channel_ids: z.array(snowflake).min(1).max(50).optional(),
        author_ids: z
          .array(snowflake)
          .min(1)
          .max(100)
          .optional()
          .describe("Limit analysis to a known participant cohort"),
        after: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        evidence_limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({
      guild_id,
      question,
      search_phrases,
      channel_ids,
      author_ids,
      after,
      before,
      evidence_limit,
    }) => {
      try {
        validateDateRange(after, before);
        return jsonResult(
          analytics.research({
            guildId: guild_id,
            question,
            searchPhrases: search_phrases,
            evidenceLimit: evidence_limit,
            ...(channel_ids ? { channelIds: channel_ids } : {}),
            ...(author_ids ? { authorIds: author_ids } : {}),
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_get_community_index_status",
    {
      title: "Inspect Discord community index coverage",
      description:
        "Check which channels and time ranges are present in the local analytics index before drawing conclusions.",
      inputSchema: {
        guild_id: snowflake.describe("Indexed Discord server/guild ID"),
        channel_ids: z.array(snowflake).min(1).max(50).optional(),
        after: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ guild_id, channel_ids, after, before }) => {
      try {
        validateDateRange(after, before);
        return jsonResult(
          analytics.getCoverage({
            guildId: guild_id,
            ...(channel_ids ? { channelIds: channel_ids } : {}),
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_analyze_growth",
    {
      title: "Analyze Discord community growth",
      description:
        "Analyze growth over time using exact saved membership snapshots, observed Discord join dates, and indexed message participation. Can focus on a role or channels. By default it refreshes the current roster first. Requires Server Members Intent for refreshes; Presence Intent is not needed.",
      inputSchema: {
        guild_id: snowflake.describe("Discord server/guild ID"),
        interval: z
          .enum(["day", "week", "month"])
          .default("month")
          .describe("Time bucket for join and participation trends"),
        after: z.string().datetime({ offset: true }).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        channel_ids: z
          .array(snowflake)
          .min(1)
          .max(50)
          .optional()
          .describe("Limit message-participation growth to these indexed channels"),
        role_id: snowflake
          .optional()
          .describe(
            "Focus on members with this role in the latest snapshot; historical role assignment is not reconstructed",
          ),
        include_bots: z.boolean().default(false),
        refresh_current: z
          .boolean()
          .default(true)
          .describe("Fetch and save a current membership snapshot before analysis"),
      },
    },
    async ({
      guild_id,
      interval,
      after,
      before,
      channel_ids,
      role_id,
      include_bots,
      refresh_current,
    }) => {
      try {
        validateDateRange(after, before);
        return jsonResult(
          await analytics.analyzeGrowth({
            guildId: guild_id,
            interval,
            includeBots: include_bots,
            refreshCurrent: refresh_current,
            ...(channel_ids ? { channelIds: channel_ids } : {}),
            ...(role_id ? { roleId: role_id } : {}),
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_send_message",
    {
      title: "Send a Discord message",
      description: "Send a message to a guild text channel. Requires DISCORD_ENABLE_WRITE=true.",
      inputSchema: {
        channel_id: snowflake.describe("Discord channel ID"),
        content: messageContent.describe("Message content, up to 2,000 characters"),
      },
    },
    async ({ channel_id, content }) => {
      const disabled = requireWrite(config);
      if (disabled) return disabled;

      try {
        return jsonResult(await service.sendMessage(channel_id, content));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_reply_to_message",
    {
      title: "Reply to a Discord message",
      description: "Reply to an existing message. Requires DISCORD_ENABLE_WRITE=true.",
      inputSchema: {
        channel_id: snowflake.describe("Discord channel ID"),
        message_id: snowflake.describe("Discord message ID"),
        content: messageContent.describe("Reply content, up to 2,000 characters"),
      },
    },
    async ({ channel_id, message_id, content }) => {
      const disabled = requireWrite(config);
      if (disabled) return disabled;

      try {
        return jsonResult(await service.replyToMessage(channel_id, message_id, content));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_add_reaction",
    {
      title: "React to a Discord message",
      description: "Add a Unicode or custom Discord emoji reaction. Requires DISCORD_ENABLE_WRITE=true.",
      inputSchema: {
        channel_id: snowflake.describe("Discord channel ID"),
        message_id: snowflake.describe("Discord message ID"),
        emoji: z.string().min(1).max(100).describe("Unicode emoji or custom emoji identifier"),
      },
    },
    async ({ channel_id, message_id, emoji }) => {
      const disabled = requireWrite(config);
      if (disabled) return disabled;

      try {
        await service.addReaction(channel_id, message_id, emoji);
        return jsonResult({ success: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discord_add_member_role",
    {
      title: "Assign a Discord role to a member",
      description:
        "Assign an existing server role to a member, which can grant access to role-restricted channels. Requires DISCORD_ENABLE_ROLE_MANAGEMENT=true, the bot's Manage Roles permission, and the bot role to be above the assigned role.",
      inputSchema: {
        guild_id: snowflake.describe("Discord server/guild ID"),
        member_id: snowflake.describe("Discord user ID for the server member"),
        role_id: snowflake.describe("Existing Discord role ID to assign"),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe("Optional reason recorded in the Discord audit log"),
      },
    },
    async ({ guild_id, member_id, role_id, reason }) => {
      const disabled = requireRoleManagement(config);
      if (disabled) return disabled;

      try {
        return jsonResult(
          await service.addMemberRole(guild_id, member_id, role_id, reason),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function validateDateRange(after?: string, before?: string): void {
  if (after && before && Date.parse(after) >= Date.parse(before)) {
    throw new Error("after must be earlier than before");
  }
}
