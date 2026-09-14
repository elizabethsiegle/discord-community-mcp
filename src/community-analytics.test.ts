import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsRepository } from "./analytics-repository.js";
import { CommunityAnalyticsService } from "./community-analytics.js";
import type { ChannelSummary, DiscordService, MessageSummary } from "./discord-service.js";

const GUILD_ID = "guild-1";

function channel(id: string, name: string): ChannelSummary {
  return { id, guildId: GUILD_ID, name, type: "GuildText", parentId: null, position: 0 };
}

function message(id: string, createdAt: string): MessageSummary {
  return {
    id,
    guildId: GUILD_ID,
    channelId: "readable",
    author: { id: "user-1", username: "ada", displayName: "Ada", bot: false },
    content: "hello",
    createdAt,
    editedAt: null,
    attachments: [],
    embeds: 0,
    reactions: [],
    replyToMessageId: null,
  };
}

/** Stub that denies every channel listed in `denied`, as Discord does with error 50001. */
function stubDiscord(denied: Set<string>, readable: ChannelSummary[]): DiscordService {
  return {
    listReadableChannels: async () => readable,
    getReadableChannel: async (channelId: string) => {
      if (denied.has(channelId)) throw new Error("Discord API error 50001: Missing Access");
      const found = readable.find((entry) => entry.id === channelId);
      return found ?? channel(channelId, channelId);
    },
    readMessages: async (channelId: string) => {
      if (denied.has(channelId)) throw new Error("Discord API error 50001: Missing Access");
      return [message(`${channelId}-m1`, "2026-09-09T12:00:00.000Z")];
    },
  } as unknown as DiscordService;
}

function service(discord: DiscordService): {
  analytics: CommunityAnalyticsService;
  repository: AnalyticsRepository;
} {
  const repository = new AnalyticsRepository(":memory:");
  return { analytics: new CommunityAnalyticsService(discord, repository), repository };
}

test("one inaccessible channel does not abort a whole-guild sync", async () => {
  const readable = [channel("readable", "general"), channel("denied", "moderator-only")];
  const { analytics, repository } = service(stubDiscord(new Set(["denied"]), readable));

  try {
    const result = (await analytics.syncHistory({
      guildId: GUILD_ID,
      maxChannels: 20,
      maxMessagesPerChannel: 100,
    })) as Record<string, unknown>;

    assert.equal(result.indexedMessages, 1, "the readable channel should still be indexed");
    assert.equal(result.skippedChannelCount, 1);
    const skipped = result.skippedChannels as Array<Record<string, unknown>>;
    assert.equal(skipped[0]?.channelId, "denied");
    assert.match(String(skipped[0]?.reason), /50001/);
  } finally {
    repository.close();
  }
});

test("an inaccessible channel in an explicit channel_ids list is skipped, not fatal", async () => {
  const readable = [channel("readable", "general")];
  const { analytics, repository } = service(stubDiscord(new Set(["denied"]), readable));

  try {
    const result = (await analytics.syncHistory({
      guildId: GUILD_ID,
      channelIds: ["readable", "denied"],
      maxChannels: 20,
      maxMessagesPerChannel: 100,
    })) as Record<string, unknown>;

    assert.equal(result.indexedMessages, 1);
    assert.equal(result.skippedChannelCount, 1);
    assert.equal((result.skippedChannels as Array<Record<string, unknown>>)[0]?.channelId, "denied");
  } finally {
    repository.close();
  }
});

test("a skipped channel does not overwrite its existing coverage row", async () => {
  const readable = [channel("denied", "moderator-only")];
  const { analytics, repository } = service(stubDiscord(new Set(["denied"]), readable));

  try {
    repository.recordChannelSync({
      guildId: GUILD_ID,
      channelId: "denied",
      channelName: "moderator-only",
      oldestMessageAt: "2026-09-01T00:00:00.000Z",
      newestMessageAt: "2026-09-05T00:00:00.000Z",
      truncated: false,
    });

    await analytics.syncHistory({
      guildId: GUILD_ID,
      maxChannels: 20,
      maxMessagesPerChannel: 100,
    });

    const coverage = analytics.getCoverage({ guildId: GUILD_ID });
    const syncs = coverage.channelSyncs as Array<Record<string, unknown>>;
    const row = syncs.find((entry) => entry.channel_id === "denied");
    assert.equal(row?.newest_message_at, "2026-09-05T00:00:00.000Z", "prior coverage must survive");
  } finally {
    repository.close();
  }
});
