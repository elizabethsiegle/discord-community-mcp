import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultAnalyticsDb = fileURLToPath(
  new URL("../data/discord-analytics.sqlite", import.meta.url),
);

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_ENABLE_WRITE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DISCORD_ANALYTICS_DB: z.string().min(1).default(defaultAnalyticsDb),
});

export type Config = {
  discordBotToken: string;
  writeEnabled: boolean;
  analyticsDbPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  return {
    discordBotToken: parsed.data.DISCORD_BOT_TOKEN,
    writeEnabled: parsed.data.DISCORD_ENABLE_WRITE,
    analyticsDbPath: parsed.data.DISCORD_ANALYTICS_DB,
  };
}
