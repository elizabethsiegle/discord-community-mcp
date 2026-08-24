import {
  ChannelType,
  Client,
  DiscordAPIError,
  GatewayIntentBits,
  Routes,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import {
  MessageSearchSortMode,
  type APIMessage,
  type RESTGetAPIGuildMessagesSearchQuery,
  type RESTGetAPIGuildMessagesSearchResult,
} from "discord-api-types/v10";
import type { APIGuildMember } from "discord-api-types/v10";

const DISCORD_MESSAGE_LIMIT = 2_000;

export type GuildSummary = {
  id: string;
  name: string;
  memberCount: number;
};

export type MemberSummary = {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  joinedAt: string | null;
  accountCreatedAt: string;
  roles: Array<{ id: string; name: string }>;
};

export type MembershipSnapshot = {
  guildId: string;
  guildName: string;
  capturedAt: string;
  reportedMemberCount: number;
  fetchedMemberCount: number;
  members: MemberSummary[];
};

export type ChannelSummary = {
  id: string;
  guildId: string;
  name: string;
  type: string;
  parentId: string | null;
  position: number;
};

export type MessageSummary = {
  id: string;
  channelId: string;
  guildId: string | null;
  author: {
    id: string;
    username: string;
    displayName: string;
    bot: boolean;
  };
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Array<{ name: string; url: string; contentType: string | null }>;
  embeds: number;
  reactions: Array<{ emoji: string; count: number }>;
  replyToMessageId: string | null;
};

export type MessageContext = {
  targetMessageId: string;
  messages: MessageSummary[];
};

export type FindMessagesOptions = {
  guildId: string;
  memory: string;
  searchPhrases?: string[];
  channelIds?: string[];
  authorIds?: string[];
  after?: string;
  before?: string;
  slop: number;
  limit: number;
};

export type FoundMessage = MessageSummary & {
  channelName: string | null;
  url: string;
  matchedPhrases: string[];
  relevanceScore: number;
};

export type FindMessagesResult = {
  memory: string;
  searchedPhrases: string[];
  totalResultsByPhrase: Array<{ phrase: string; totalResults: number }>;
  indexStillBuilding: boolean;
  matches: FoundMessage[];
};

export class DiscordService {
  readonly client: Client;

  constructor() {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  async connect(token: string): Promise<void> {
    await this.client.login(token);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  async listGuilds(): Promise<GuildSummary[]> {
    const guilds = await this.client.guilds.fetch();
    const details = await Promise.all(guilds.map((guild) => guild.fetch()));

    return details
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listChannels(guildId: string): Promise<ChannelSummary[]> {
    const guild = await this.fetchGuild(guildId);
    const channels = await guild.channels.fetch();

    return [...channels.values()]
      .flatMap((channel) =>
        channel
          ? [
              {
        id: channel.id,
        guildId: guild.id,
        name: channel.name,
                type: ChannelType[channel.type] ?? String(channel.type),
                parentId: channel.parentId,
                position: channel.position,
              },
            ]
          : [],
      )
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  async fetchMembershipSnapshot(guildId: string): Promise<MembershipSnapshot> {
    const guild = await this.fetchGuild(guildId);
    const roles = await guild.roles.fetch();
    const roleNames = new Map([...roles.values()].map((role) => [role.id, role.name]));
    const members: APIGuildMember[] = [];
    let after = "0";

    while (true) {
      const page = (await this.client.rest.get(Routes.guildMembers(guildId), {
        query: new URLSearchParams({ limit: "1000", after }),
      })) as APIGuildMember[];
      members.push(...page);
      if (page.length < 1_000) break;
      const lastMember = page.at(-1);
      if (!lastMember) break;
      after = lastMember.user.id;
    }

    return {
      guildId: guild.id,
      guildName: guild.name,
      capturedAt: new Date().toISOString(),
      reportedMemberCount: guild.memberCount,
      fetchedMemberCount: members.length,
      members: members
        .map((member) => ({
          id: member.user.id,
          username: member.user.username,
          displayName: member.nick ?? member.user.global_name ?? member.user.username,
          bot: member.user.bot ?? false,
          joinedAt: member.joined_at,
          accountCreatedAt: snowflakeToTimestamp(member.user.id),
          roles: member.roles
            .flatMap((roleId) => {
              const name = roleNames.get(roleId);
              return name ? [{ id: roleId, name }] : [];
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "")),
    };
  }

  async listReadableChannels(guildId: string): Promise<ChannelSummary[]> {
    const guild = await this.fetchGuild(guildId);
    const channels = await guild.channels.fetch();

    return [...channels.values()]
      .flatMap((channel) =>
        channel && channel.isTextBased()
          ? [
              {
                id: channel.id,
                guildId: channel.guildId,
                name: channel.name,
                type: ChannelType[channel.type] ?? String(channel.type),
                parentId: channel.parentId,
                position: channel.position,
              },
            ]
          : [],
      )
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  async getReadableChannel(channelId: string): Promise<ChannelSummary> {
    const channel = await this.fetchTextChannel(channelId);
    return {
      id: channel.id,
      guildId: channel.guildId,
      name: channel.name,
      type: ChannelType[channel.type] ?? String(channel.type),
      parentId: channel.parentId,
      position: channel.isThread() ? 0 : channel.position,
    };
  }

  async readMessages(
    channelId: string,
    limit: number,
    before?: string,
  ): Promise<MessageSummary[]> {
    const channel = await this.fetchTextChannel(channelId);
    const messages = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });

    return [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(summarizeMessage);
  }

  async getMessageContext(
    channelId: string,
    messageId: string,
    radius: number,
  ): Promise<MessageContext> {
    const channel = await this.fetchTextChannel(channelId);
    const messages = await channel.messages.fetch({
      around: messageId,
      limit: Math.min(100, radius * 2 + 1),
    });

    return {
      targetMessageId: messageId,
      messages: [...messages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(summarizeMessage),
    };
  }

  async findMessages(options: FindMessagesOptions): Promise<FindMessagesResult> {
    const requestedPhrases = uniquePhrases(options.searchPhrases ?? []);
    const phrases = requestedPhrases.length > 0 ? requestedPhrases : uniquePhrases([options.memory]);
    const guild = await this.fetchGuild(options.guildId);
    const channels = await guild.channels.fetch();
    const channelNames = new Map(
      [...channels.values()]
        .filter((channel) => channel !== null)
        .map((channel) => [channel.id, channel.name]),
    );
    const candidates = new Map<
      string,
      {
        message: Omit<APIMessage, "reactions">;
        matchedPhrases: Set<string>;
        relevanceScore: number;
      }
    >();
    const totalResultsByPhrase: Array<{ phrase: string; totalResults: number }> = [];
    let indexStillBuilding = false;

    for (const phrase of phrases) {
      const query: RESTGetAPIGuildMessagesSearchQuery = {
        content: phrase,
        limit: Math.min(25, Math.max(options.limit, 10)),
        slop: options.slop,
        sort_by: MessageSearchSortMode.Relevance,
        ...(options.channelIds?.length ? { channel_id: options.channelIds } : {}),
        ...(options.authorIds?.length ? { author_id: options.authorIds } : {}),
        ...(options.after ? { min_id: timestampToSnowflake(options.after) } : {}),
        ...(options.before ? { max_id: timestampToSnowflake(options.before) } : {}),
      };
      const search = await this.searchGuildMessages(options.guildId, query);

      if ("retry_after" in search) {
        indexStillBuilding = true;
        totalResultsByPhrase.push({ phrase, totalResults: 0 });
        continue;
      }

      totalResultsByPhrase.push({ phrase, totalResults: search.total_results });
      search.messages.flat().forEach((message, rank) => {
        const existing = candidates.get(message.id);
        if (existing) {
          existing.matchedPhrases.add(phrase);
          existing.relevanceScore += reciprocalRank(rank);
          return;
        }

        candidates.set(message.id, {
          message,
          matchedPhrases: new Set([phrase]),
          relevanceScore: reciprocalRank(rank),
        });
      });

      for (const thread of search.threads ?? []) {
        channelNames.set(thread.id, thread.name ?? "thread");
      }
    }

    const matches = [...candidates.values()]
      .sort(
        (a, b) =>
          b.matchedPhrases.size - a.matchedPhrases.size ||
          b.relevanceScore - a.relevanceScore ||
          Date.parse(b.message.timestamp) - Date.parse(a.message.timestamp),
      )
      .slice(0, options.limit)
      .map(({ message, matchedPhrases, relevanceScore }) => ({
        ...summarizeApiMessage(message, options.guildId),
        channelName: channelNames.get(message.channel_id) ?? null,
        url: `https://discord.com/channels/${options.guildId}/${message.channel_id}/${message.id}`,
        matchedPhrases: [...matchedPhrases],
        relevanceScore: Number(relevanceScore.toFixed(4)),
      }));

    return {
      memory: options.memory,
      searchedPhrases: phrases,
      totalResultsByPhrase,
      indexStillBuilding,
      matches,
    };
  }

  async sendMessage(channelId: string, content: string): Promise<MessageSummary> {
    assertMessageLength(content);
    const channel = await this.fetchTextChannel(channelId);
    return summarizeMessage(await channel.send({ content }));
  }

  async replyToMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<MessageSummary> {
    assertMessageLength(content);
    const channel = await this.fetchTextChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    return summarizeMessage(await message.reply({ content }));
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
  }

  private async fetchGuild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }

  private async fetchTextChannel(channelId: string): Promise<GuildTextBasedChannel> {
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`Channel ${channelId} is not a supported guild text channel`);
    }

    return channel;
  }

  private async searchGuildMessages(
    guildId: string,
    query: RESTGetAPIGuildMessagesSearchQuery,
  ): Promise<RESTGetAPIGuildMessagesSearchResult> {
    const route = Routes.guildMessagesSearch(guildId);
    let result = (await this.client.rest.get(route, {
      query: toSearchParams(query),
    })) as RESTGetAPIGuildMessagesSearchResult;

    if ("retry_after" in result) {
      const retryMs = Math.min(5_000, Math.max(250, result.retry_after * 1_000));
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      result = (await this.client.rest.get(route, {
        query: toSearchParams(query),
      })) as RESTGetAPIGuildMessagesSearchResult;
    }

    return result;
  }
}

export function summarizeMessage(message: Message): MessageSummary {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.displayName,
      bot: message.author.bot,
    },
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    attachments: message.attachments.map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
    })),
    embeds: message.embeds.length,
    reactions: message.reactions.cache.map((reaction) => ({
      emoji: reaction.emoji.toString(),
      count: reaction.count,
    })),
    replyToMessageId: message.reference?.messageId ?? null,
  };
}

export function summarizeApiMessage(
  message: Omit<APIMessage, "reactions">,
  guildId: string,
): MessageSummary {
  return {
    id: message.id,
    channelId: message.channel_id,
    guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.global_name ?? message.author.username,
      bot: message.author.bot ?? false,
    },
    content: message.content,
    createdAt: message.timestamp,
    editedAt: message.edited_timestamp,
    attachments: message.attachments.map((attachment) => ({
      name: attachment.filename,
      url: attachment.url,
      contentType: attachment.content_type ?? null,
    })),
    embeds: message.embeds.length,
    reactions: [],
    replyToMessageId: message.message_reference?.message_id ?? null,
  };
}

export function timestampToSnowflake(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid ISO timestamp: ${timestamp}`);
  }

  return ((BigInt(milliseconds) - 1_420_070_400_000n) << 22n).toString();
}

function snowflakeToTimestamp(snowflake: string): string {
  const milliseconds = (BigInt(snowflake) >> 22n) + 1_420_070_400_000n;
  return new Date(Number(milliseconds)).toISOString();
}

function uniquePhrases(phrases: string[]): string[] {
  return [...new Set(phrases.map((phrase) => phrase.trim().slice(0, 1_024)).filter(Boolean))].slice(0, 5);
}

function reciprocalRank(rank: number): number {
  return 1 / (rank + 1);
}

function toSearchParams(query: RESTGetAPIGuildMessagesSearchQuery): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
    } else {
      params.set(key, String(value));
    }
  }

  return params;
}

export function assertMessageLength(content: string): void {
  if (content.length > DISCORD_MESSAGE_LIMIT) {
    throw new Error(
      `Discord messages must be ${DISCORD_MESSAGE_LIMIT} characters or fewer; received ${content.length}`,
    );
  }
}

export function describeDiscordError(error: unknown): string {
  if (error instanceof DiscordAPIError) {
    return `Discord API error ${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
