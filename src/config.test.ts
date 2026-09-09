import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("write access is disabled by default", () => {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-token" });
  assert.equal(config.writeEnabled, false);
  assert.equal(config.roleManagementEnabled, false);
});

test("role management can be enabled independently", () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_ENABLE_ROLE_MANAGEMENT: "true",
  });
  assert.equal(config.roleManagementEnabled, true);
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
