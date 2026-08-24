import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CommunityAnalyticsService } from "./community-analytics.js";
import type { DiscordService } from "./discord-service.js";
import { createServer } from "./server.js";

const unusedService = {} as DiscordService;
const unusedAnalytics = {} as CommunityAnalyticsService;

test("publishes the expected Discord tool surface", async () => {
  const server = createServer(
    unusedService,
    {
      discordBotToken: "test-token",
      writeEnabled: false,
      analyticsDbPath: ":memory:",
    },
    unusedAnalytics,
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [
        "discord_add_reaction",
        "discord_analyze_growth",
        "discord_find_messages",
        "discord_get_community_index_status",
        "discord_get_message_context",
        "discord_list_channels",
        "discord_list_guilds",
        "discord_read_messages",
        "discord_reply_to_message",
        "discord_research_community",
        "discord_send_message",
        "discord_sync_community_history",
        "discord_sync_member_snapshot",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("blocks write tools when write access is disabled", async () => {
  const server = createServer(
    unusedService,
    {
      discordBotToken: "test-token",
      writeEnabled: false,
      analyticsDbPath: ":memory:",
    },
    unusedAnalytics,
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "discord_send_message",
      arguments: {
        channel_id: "12345678901234567",
        content: "hello",
      },
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
