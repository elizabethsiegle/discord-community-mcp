import assert from "node:assert/strict";
import test from "node:test";
import { GatewayIntentBits } from "discord.js";
import {
  assertMessageLength,
  DiscordService,
  timestampToSnowflake,
} from "./discord-service.js";

test("requests member data without requesting presence data", () => {
  const service = new DiscordService();

  assert.equal(service.client.options.intents.has(GatewayIntentBits.Guilds), true);
  assert.equal(service.client.options.intents.has(GatewayIntentBits.GuildMembers), false);
  assert.equal(service.client.options.intents.has(GatewayIntentBits.GuildPresences), false);
});

test("accepts a Discord message at the character limit", () => {
  assert.doesNotThrow(() => assertMessageLength("x".repeat(2_000)));
});

test("rejects a Discord message over the character limit", () => {
  assert.throws(() => assertMessageLength("x".repeat(2_001)), /2000 characters or fewer/);
});

test("converts the Discord epoch to snowflake zero", () => {
  assert.equal(timestampToSnowflake("2015-01-01T00:00:00.000Z"), "0");
});

test("rejects an invalid timestamp", () => {
  assert.throws(() => timestampToSnowflake("sometime last summer"), /Invalid ISO timestamp/);
});
