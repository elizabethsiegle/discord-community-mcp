# Discord Community MCP

A local-first [Model Context Protocol](https://modelcontextprotocol.io/) server that gives AI agents read-only Discord search, conversation recall, community research, and growth analysis through a bot account. Sending messages and reactions is available only when explicitly enabled.

## What it can do

- Find conversations from a vague memory, even when the wording is uncertain
- Reconstruct context around a matching message
- Index selected Discord history in a local SQLite database
- Analyze activity, response times, participation, concentration, reciprocity, and themes
- Save member snapshots and analyze joins, departures, roles, and contributor growth
- Optionally send messages, replies, reactions, and assign existing roles

## Requirements

- Node.js 22.5 or newer
- A Discord application and bot token
- An MCP client that supports local stdio servers, such as Codex

## 1. Create a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot**, create the bot, and copy its token.
3. Under **Bot → Privileged Gateway Intents**, enable:
   - **Message Content Intent** for message text and search
   - **Server Members Intent** for member snapshots, join dates, roles, and growth
4. **Presence Intent is not required.**
5. Under **OAuth2 → URL Generator**, select the `bot` scope.
6. Give the bot **View Channels** and **Read Message History**. Add **Send Messages**, **Add Reactions**, or **Manage Roles** only for the write tools you plan to use.
7. Open the generated URL and invite the bot to your Discord server.

The bot can only access channels its Discord role is allowed to view.

For role assignment, place the bot's role above the roles it may assign in **Server Settings → Roles**.
Keep it below staff and administrator roles so Discord's hierarchy limits what the bot can grant.

## 2. Install

```bash
git clone https://github.com/blackgirlbytes/discord-community-mcp.git
cd discord-community-mcp
npm ci
npm run build
cp .env.example .env
```

Open `.env` and replace the placeholder token:

```dotenv
DISCORD_BOT_TOKEN=replace-with-your-bot-token
DISCORD_ENABLE_WRITE=false
DISCORD_ENABLE_ROLE_MANAGEMENT=false
```

Keep `.env` private. It is excluded from git.

## 3. Add it to an MCP client

### Codex CLI

Use absolute paths so the client can start the server from any directory:

```bash
codex mcp add discord-community -- \
  node \
  --env-file=/absolute/path/to/discord-community-mcp/.env \
  /absolute/path/to/discord-community-mcp/dist/index.js
```

Restart Codex after adding the server.

### Generic stdio configuration

Clients that use an `mcpServers` JSON object can use:

```json
{
  "mcpServers": {
    "discord-community": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/discord-community-mcp/.env",
        "/absolute/path/to/discord-community-mcp/dist/index.js"
      ]
    }
  }
}
```

Restart the MCP client after changing its configuration. You can then ask it to list the Discord servers and channels available to the bot.

## Example questions

- “Find the conversation where someone said onboarding felt like homework.”
- “What did we decide about renaming the SDK last spring?”
- “Why are beta testers responding slowly? Look for evidence across the last three months.”
- “How has the community grown by month, and how does growth compare with participation?”
- “Which support questions went unanswered last week?”

For broad analysis, the agent should first synchronize the relevant channels and date range, check index coverage, and then run community research. Behavioral explanations should be presented as hypotheses unless messages directly support them.

## Available tools

| Tool | Purpose |
| --- | --- |
| `discord_list_guilds` | List servers available to the bot |
| `discord_list_channels` | List channels in a server |
| `discord_read_messages` | Read recent messages with pagination |
| `discord_find_messages` | Search for a vaguely remembered conversation |
| `discord_get_message_context` | Read messages surrounding a match |
| `discord_sync_community_history` | Build or refresh the local message index |
| `discord_research_community` | Produce an evidence packet for a community question |
| `discord_get_community_index_status` | Check indexed channels, dates, and coverage |
| `discord_sync_member_snapshot` | Save current membership, join-date, and role data |
| `discord_analyze_growth` | Analyze membership and participation over time |
| `discord_send_message` | Send a message when writes are enabled |
| `discord_reply_to_message` | Reply when writes are enabled |
| `discord_add_reaction` | React when writes are enabled |
| `discord_add_member_role` | Assign an existing role when role management is enabled |

## Data and privacy

Message content and membership metadata are stored unencrypted in `data/discord-analytics.sqlite` by default. Override the location with `DISCORD_ANALYTICS_DB`.

```dotenv
DISCORD_ANALYTICS_DB=/absolute/private/path/discord-analytics.sqlite
```

- Index only channels and date ranges needed for the analysis.
- Protect and delete the database according to your community's privacy policy.
- Give the bot the minimum Discord permissions it needs.
- Keep `DISCORD_ENABLE_WRITE=false` unless sending content is intentional.
- Keep `DISCORD_ENABLE_ROLE_MANAGEMENT=false` unless assigning roles is intentional.
- Rotate the bot token immediately if it is exposed.

## Analysis limitations

- A message archive can show behavioral patterns but cannot prove why people behaved that way.
- Discord users may respond without using the Reply action, so reply metrics can undercount responses.
- Historical role membership is not reconstructed; older messages use the latest observed role.
- Exact departures are detected only between saved member snapshots.
- A first member snapshot cannot recover people who left before the bot observed them.
- Search and analytics cover only channels visible to the bot and history that was synchronized.
- Channels the bot cannot read are skipped rather than failing the sync. Check `skippedChannels` in the
  sync result to see what was left out and why, because coverage gaps there will silently understate
  every aggregate that follows.
- Forum channels are not indexed.
- Direct messages are not supported.

## Write access

Write tools are registered but blocked by default. Enable only the capability you need in `.env`:

```dotenv
DISCORD_ENABLE_WRITE=true
DISCORD_ENABLE_ROLE_MANAGEMENT=true
```

The bot must also have the corresponding Discord permissions. Keep writes disabled for research-only installations.

## Development

```bash
npm ci
npm run check
npm test
```

The server writes operational logs to stderr because stdout is reserved for the MCP stdio protocol.
