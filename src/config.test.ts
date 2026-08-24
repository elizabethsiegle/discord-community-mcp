import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("write access is disabled by default", () => {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-token" });
  assert.equal(config.writeEnabled, false);
});

test("write access can be enabled explicitly", () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_ENABLE_WRITE: "true",
  });
  assert.equal(config.writeEnabled, true);
});

test("a bot token is required", () => {
  assert.throws(() => loadConfig({}), /DISCORD_BOT_TOKEN/);
});
