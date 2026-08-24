import assert from "node:assert/strict";
import test from "node:test";
import { AnalyticsRepository, type IndexedMessage } from "./analytics-repository.js";
import type { MembershipSnapshot } from "./discord-service.js";

function message(input: {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  replyToMessageId?: string;
}): IndexedMessage {
  return {
    id: input.id,
    guildId: "guild-1",
    channelId: "channel-1",
    channelName: "beta-feedback",
    author: {
      id: input.authorId,
      username: input.authorName.toLowerCase(),
      displayName: input.authorName,
      bot: false,
    },
    content: input.content,
    createdAt: input.createdAt,
    editedAt: null,
    attachments: [],
    embeds: 0,
    reactions: [],
    replyToMessageId: input.replyToMessageId ?? null,
  };
}

function membershipSnapshot(input: {
  capturedAt: string;
  members: Array<{
    id: string;
    bot?: boolean;
    joinedAt: string;
    roles?: Array<{ id: string; name: string }>;
  }>;
}): MembershipSnapshot {
  return {
    guildId: "guild-1",
    guildName: "Community",
    capturedAt: input.capturedAt,
    reportedMemberCount: input.members.length,
    fetchedMemberCount: input.members.length,
    members: input.members.map((member) => ({
      id: member.id,
      username: member.id,
      displayName: member.id,
      bot: member.bot ?? false,
      joinedAt: member.joinedAt,
      accountCreatedAt: "2025-01-01T00:00:00.000Z",
      roles: member.roles ?? [],
    })),
  };
}

test("builds quantitative and qualitative community evidence", () => {
  const repository = new AnalyticsRepository(":memory:");

  try {
    repository.upsertMessages([
      message({
        id: "message-1",
        authorId: "author-1",
        authorName: "Maya",
        content: "The beta onboarding feels confusing and transactional.",
        createdAt: "2026-01-05T12:00:00.000Z",
      }),
      message({
        id: "message-2",
        authorId: "author-2",
        authorName: "Lee",
        content: "I agree, we should welcome people before asking for feedback.",
        createdAt: "2026-01-05T12:10:00.000Z",
        replyToMessageId: "message-1",
      }),
      message({
        id: "message-3",
        authorId: "author-1",
        authorName: "Maya",
        content: "A weekly social check-in could improve the community experience.",
        createdAt: "2026-01-12T12:00:00.000Z",
        replyToMessageId: "message-2",
      }),
    ]);

    const packet = repository.buildEvidencePacket(
      "Does beta onboarding feel transactional?",
      { guildId: "guild-1" },
      ["transactional onboarding", "welcome feedback"],
      10,
    ) as {
      overview: { total_messages: number; active_human_authors: number };
      responsiveness: { observedReplyPairs: number; medianSeconds: number };
      participation: { repeatAuthorRate: number };
      reciprocity: { reciprocalRelationshipRate: number };
      relevantEvidence: Array<{ id: string }>;
      representativeSample: Array<{ id: string }>;
    };

    assert.equal(packet.overview.total_messages, 3);
    assert.equal(packet.overview.active_human_authors, 2);
    assert.equal(packet.responsiveness.observedReplyPairs, 2);
    assert.equal(packet.responsiveness.medianSeconds, 302_400);
    assert.equal(packet.participation.repeatAuthorRate, 0.5);
    assert.equal(packet.reciprocity.reciprocalRelationshipRate, 1);
    assert.ok(packet.relevantEvidence.some((evidence) => evidence.id === "message-1"));
    assert.equal(packet.representativeSample.length, 3);
  } finally {
    repository.close();
  }
});

test("upserts messages without duplicating the full-text index", () => {
  const repository = new AnalyticsRepository(":memory:");

  try {
    const original = message({
      id: "message-1",
      authorId: "author-1",
      authorName: "Maya",
      content: "Original onboarding note",
      createdAt: "2026-01-05T12:00:00.000Z",
    });
    repository.upsertMessages([original]);
    repository.upsertMessages([{ ...original, content: "Updated community note" }]);

    const packet = repository.buildEvidencePacket(
      "What changed?",
      { guildId: "guild-1" },
      ["updated community"],
      10,
    ) as { overview: { total_messages: number }; relevantEvidence: Array<{ id: string }> };

    assert.equal(packet.overview.total_messages, 1);
    assert.deepEqual(packet.relevantEvidence.map((item) => item.id), ["message-1"]);
  } finally {
    repository.close();
  }
});

test("records exact snapshots and combines them with join and participation growth", () => {
  const repository = new AnalyticsRepository(":memory:");

  try {
    const launchCrew = { id: "role-1", name: "Launch Crew" };
    const first = repository.recordMembershipSnapshot(
      membershipSnapshot({
        capturedAt: "2026-07-01T12:00:00.000Z",
        members: [
          {
            id: "author-1",
            joinedAt: "2026-05-10T12:00:00.000Z",
            roles: [launchCrew],
          },
          {
            id: "author-2",
            joinedAt: "2026-06-15T12:00:00.000Z",
            roles: [launchCrew],
          },
          {
            id: "bot-1",
            bot: true,
            joinedAt: "2026-04-01T12:00:00.000Z",
          },
        ],
      }),
    ) as { newlyObservedMembers: number };
    assert.equal(first.newlyObservedMembers, 3);

    repository.upsertMessages([
      message({
        id: "message-1",
        authorId: "author-1",
        authorName: "Maya",
        content: "Hello from May",
        createdAt: "2026-05-12T12:00:00.000Z",
      }),
      message({
        id: "message-2",
        authorId: "author-2",
        authorName: "Lee",
        content: "Hello from June",
        createdAt: "2026-06-20T12:00:00.000Z",
      }),
    ]);

    const second = repository.recordMembershipSnapshot(
      membershipSnapshot({
        capturedAt: "2026-07-15T12:00:00.000Z",
        members: [
          {
            id: "author-1",
            joinedAt: "2026-05-10T12:00:00.000Z",
            roles: [launchCrew],
          },
          {
            id: "bot-1",
            bot: true,
            joinedAt: "2026-04-01T12:00:00.000Z",
          },
        ],
      }),
    ) as { departuresSincePreviousSnapshot: number };
    assert.equal(second.departuresSincePreviousSnapshot, 1);

    const report = repository.buildGrowthReport({
      guildId: "guild-1",
      interval: "month",
      includeBots: false,
    }) as {
      exactMembershipSnapshots: {
        count: number;
        absoluteChange: number;
        latest: { members: number };
      };
      timeline: Array<{
        period: string;
        joinedMembers: number;
        activeContributors: number;
        firstTimeContributors: number;
      }>;
    };

    assert.equal(report.exactMembershipSnapshots.count, 2);
    assert.equal(report.exactMembershipSnapshots.absoluteChange, -1);
    assert.equal(report.exactMembershipSnapshots.latest.members, 1);
    assert.deepEqual(
      report.timeline.map((period) => ({
        period: period.period,
        joinedMembers: period.joinedMembers,
        activeContributors: period.activeContributors,
        firstTimeContributors: period.firstTimeContributors,
      })),
      [
        {
          period: "2026-05",
          joinedMembers: 1,
          activeContributors: 1,
          firstTimeContributors: 1,
        },
        {
          period: "2026-06",
          joinedMembers: 1,
          activeContributors: 1,
          firstTimeContributors: 1,
        },
      ],
    );
  } finally {
    repository.close();
  }
});
