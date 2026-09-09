#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AnalyticsRepository } from "./analytics-repository.js";
import { CommunityAnalyticsService } from "./community-analytics.js";
import { loadConfig } from "./config.js";
import { DiscordService } from "./discord-service.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new DiscordService();
  await service.connect(config.discordBotToken);
  const repository = new AnalyticsRepository(config.analyticsDbPath);
  const analytics = new CommunityAnalyticsService(service, repository);

  const server = createServer(service, config, analytics);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    analytics.close();
    await service.disconnect();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(transport);
  console.error(
    `Discord MCP server connected as ${service.client.user?.tag ?? "unknown bot"} (writes ${
      config.writeEnabled ? "enabled" : "disabled"
    }, role management ${config.roleManagementEnabled ? "enabled" : "disabled"})`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start Discord MCP server: ${message}`);
  process.exit(1);
});
