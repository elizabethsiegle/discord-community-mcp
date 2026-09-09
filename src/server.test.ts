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
      roleManagementEnabled: false,
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
        "discord_add_member_role",
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
      roleManagementEnabled: false,
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

test("blocks role assignment when only ordinary writes are enabled", async () => {
  const server = createServer(
    unusedService,
    {
      discordBotToken: "test-token",
      writeEnabled: true,
      roleManagementEnabled: false,
      analyticsDbPath: ":memory:",
    },
    unusedAnalytics,
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "discord_add_member_role",
      arguments: {
        guild_id: "12345678901234567",
        member_id: "22345678901234567",
        role_id: "32345678901234567",
      },
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("assigns a member role when role management is enabled independently", async () => {
  const calls: unknown[][] = [];
  const service = {
    addMemberRole: async (...args: unknown[]) => {
      calls.push(args);
      return { changed: true };
    },
  } as unknown as DiscordService;
  const server = createServer(
    service,
    {
      discordBotToken: "test-token",
      writeEnabled: false,
      roleManagementEnabled: true,
      analyticsDbPath: ":memory:",
    },
    unusedAnalytics,
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "discord_add_member_role",
      arguments: {
        guild_id: "12345678901234567",
        member_id: "22345678901234567",
        role_id: "32345678901234567",
        reason: "Added to the beta group",
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      [
        "12345678901234567",
        "22345678901234567",
        "32345678901234567",
        "Added to the beta group",
      ],
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
