import type {
  AnalyticsFilters,
  AnalyticsRepository,
  GrowthFilters,
} from "./analytics-repository.js";
import { DiscordAPIError } from "discord.js";
import { describeDiscordError } from "./discord-service.js";
import type { ChannelSummary, DiscordService } from "./discord-service.js";

export type SyncHistoryOptions = {
  guildId: string;
  channelIds?: string[];
  after?: string;
  before?: string;
  maxChannels: number;
  maxMessagesPerChannel: number;
};

export type ResearchOptions = AnalyticsFilters & {
  question: string;
  searchPhrases: string[];
  evidenceLimit: number;
};

export class CommunityAnalyticsService {
  constructor(
    private readonly discord: DiscordService,
    private readonly repository: AnalyticsRepository,
  ) {}

  close(): void {
    this.repository.close();
  }

  getCoverage(filters: AnalyticsFilters): Record<string, unknown> {
    return this.repository.getCoverage(filters);
  }

  research(options: ResearchOptions): Record<string, unknown> {
    return this.repository.buildEvidencePacket(
      options.question,
      options,
      options.searchPhrases,
      options.evidenceLimit,
    );
  }

  async syncMembership(guildId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.discord.fetchMembershipSnapshot(guildId).catch((error: unknown) => {
      if (error instanceof DiscordAPIError && error.code === 50_001) {
        throw new Error(
          "Discord denied access to the member list. Enable Server Members Intent in the Developer Portal, click Save Changes, and then retry. Presence Intent is not required.",
        );
      }
      throw error;
    });
    const result = this.repository.recordMembershipSnapshot(snapshot);

    return {
      ...result,
      memberCountMismatch:
        snapshot.reportedMemberCount === snapshot.fetchedMemberCount
          ? null
          : `Discord reported ${snapshot.reportedMemberCount} members, but the full fetch returned ${snapshot.fetchedMemberCount}. Treat this snapshot as incomplete.`,
      presenceIntentRequired: false,
      serverMembersIntentRequired: true,
    };
  }

  async analyzeGrowth(
    options: GrowthFilters & { refreshCurrent: boolean },
  ): Promise<Record<string, unknown>> {
    const refresh = options.refreshCurrent
      ? await this.syncMembership(options.guildId)
      : null;
    const report = this.repository.buildGrowthReport(options);

    return {
      refresh,
      ...report,
    };
  }

  async syncHistory(options: SyncHistoryOptions): Promise<Record<string, unknown>> {
    const skippedChannels: Array<Record<string, unknown>> = [];
    const availableChannels = options.channelIds?.length
      ? (
          await Promise.all(
            options.channelIds.map(async (channelId) => {
              try {
                return await this.discord.getReadableChannel(channelId);
              } catch (error) {
                skippedChannels.push({
                  channelId,
                  channelName: null,
                  reason: describeDiscordError(error),
                });
                return null;
              }
            }),
          )
        ).filter((channel): channel is ChannelSummary => channel !== null)
      : await this.discord.listReadableChannels(options.guildId);
    const wrongGuild = availableChannels.find((channel) => channel.guildId !== options.guildId);
    if (wrongGuild) {
      throw new Error(`Channel ${wrongGuild.id} does not belong to guild ${options.guildId}`);
    }

    const selectedChannels = availableChannels.slice(0, options.maxChannels);
    const channelResults: Array<Record<string, unknown>> = [];
    let totalIndexed = 0;
    let emptyContentMessages = 0;

    for (const channel of selectedChannels) {
      let beforeCursor = options.before ? timestampToSearchCursor(options.before) : undefined;
      let scanned = 0;
      let indexed = 0;
      let reachedBeginning = false;
      let reachedAfterBoundary = false;
      let oldestMessageAt: string | null = null;
      let newestMessageAt: string | null = null;

      try {
        while (scanned < options.maxMessagesPerChannel) {
          const pageLimit = Math.min(100, options.maxMessagesPerChannel - scanned);
          const page = await this.discord.readMessages(channel.id, pageLimit, beforeCursor);
          if (page.length === 0) {
            reachedBeginning = true;
            break;
          }

          scanned += page.length;
          const withinRange = page.filter((message) => {
            if (options.after && message.createdAt < options.after) return false;
            if (options.before && message.createdAt >= options.before) return false;
            return true;
          });
          emptyContentMessages += withinRange.filter((message) => message.content === "").length;
          indexed += this.repository.upsertMessages(
            withinRange.map((message) => ({ ...message, channelName: channel.name })),
          );

          for (const message of withinRange) {
            if (!oldestMessageAt || message.createdAt < oldestMessageAt) oldestMessageAt = message.createdAt;
            if (!newestMessageAt || message.createdAt > newestMessageAt) newestMessageAt = message.createdAt;
          }

          const oldest = page[0];
          if (!oldest) break;
          if (options.after && oldest.createdAt <= options.after) {
            reachedAfterBoundary = true;
            break;
          }
          if (page.length < pageLimit) {
            reachedBeginning = true;
            break;
          }
          beforeCursor = oldest.id;
        }
      } catch (error) {
        // One unreadable channel must not discard the rest of the sweep. Skip it and
        // leave its previous coverage row untouched rather than recording a partial sync.
        skippedChannels.push({
          channelId: channel.id,
          channelName: channel.name,
          reason: describeDiscordError(error),
        });
        continue;
      }

      const truncated = !reachedBeginning && !reachedAfterBoundary && scanned >= options.maxMessagesPerChannel;
      this.repository.recordChannelSync({
        guildId: options.guildId,
        channelId: channel.id,
        channelName: channel.name,
        oldestMessageAt,
        newestMessageAt,
        truncated,
      });
      totalIndexed += indexed;
      channelResults.push({
        channelId: channel.id,
        channelName: channel.name,
        scanned,
        indexed,
        oldestMessageAt,
        newestMessageAt,
        truncated,
      });
    }

    return {
      guildId: options.guildId,
      indexedMessages: totalIndexed,
      selectedChannels: selectedChannels.length,
      omittedReadableChannels: Math.max(0, availableChannels.length - selectedChannels.length),
      skippedChannelCount: skippedChannels.length,
      skippedChannels,
      emptyContentMessages,
      messageContentIntentWarning:
        emptyContentMessages > 0
          ? "Some indexed messages had empty content. Confirm Message Content Intent is enabled."
          : null,
      channels: channelResults,
    };
  }
}

function timestampToSearchCursor(timestamp: string): string {
  return ((BigInt(Date.parse(timestamp)) - 1_420_070_400_000n) << 22n).toString();
}
