import { describe, expect, it } from "vitest";
import { IssueStore } from "../../src/main/analysis/IssueStore";
import {
  SUPPRESSION_REASON,
  analyzeWindow,
  initialRuleState,
  type AnalysisContext,
  type IssueCandidate,
  type RuleState,
} from "../../src/main/analysis/RuleEngine";
import { normalizeText } from "../../src/main/transcript/normalize";
import { customRuleItems, effectiveFramework } from "../../src/main/analysis/effectiveRules";
import { defaultIssueRuleProfile } from "../../src/shared/contracts/issueRules";
import type { FrameworkDocument } from "../../src/shared/contracts/framework";
import type { TranscriptSegment, WindowSnapshot } from "../../src/shared/contracts/transcript";

const framework: FrameworkDocument = {
  id: "fw",
  title: "测试框架",
  pace: { min: 180, max: 280, unit: "chars_per_minute" },
  must_say: [
    { id: "ms-1", text: "今天活动价", keywords: ["活动价"] },
    { id: "ms-2", text: "核心卖点", keywords: ["卖点"] },
    { id: "ms-3", text: "促单", keywords: ["拍下"] },
  ],
  avoid: [{ id: "av-1", text: "绝对化疗效", keywords: ["一定能"] }],
};

const context: AnalysisContext = {
  nominalWindowMs: 60_000,
  intervalMs: 60_000,
  finalFlush: false,
  frameworkRevision: "rev",
};

function textOfLength(count: number): string {
  let out = "";
  for (let index = 0; index < count; index += 1) out += String.fromCodePoint(0x4e00 + (index % 40));
  return out;
}

function segment(partial: Partial<TranscriptSegment> & Pick<TranscriptSegment, "text">): TranscriptSegment {
  const text = partial.text;
  return {
    id: partial.id ?? "seg",
    sessionId: "s",
    sourceResultId: partial.sourceResultId ?? partial.id ?? "seg",
    startMs: partial.startMs ?? 0,
    endMs: partial.endMs ?? 60_000,
    text,
    normalizedText: partial.normalizedText ?? normalizeText(text),
    isFinal: true,
  };
}

function snapshot(partial: Partial<WindowSnapshot> = {}): WindowSnapshot {
  const segments = partial.segments ?? [];
  return {
    id: "w",
    sessionId: "s",
    windowStartMs: partial.windowStartMs ?? 0,
    windowEndMs: partial.windowEndMs ?? 60_000,
    triggeredAtMs: partial.triggeredAtMs ?? partial.windowEndMs ?? 60_000,
    frameworkRevision: "rev",
    segments,
    speechIntervals: partial.speechIntervals ?? [{ startMs: 0, endMs: 60_000 }],
    silenceIntervals: partial.silenceIntervals ?? [],
    gapIntervals: partial.gapIntervals ?? [],
    audioCoverageMs: partial.audioCoverageMs ?? 60_000,
    finalTextCoverageMs: partial.finalTextCoverageMs ?? 60_000,
  };
}

function run(window: WindowSnapshot, state: RuleState = initialRuleState(framework), ctx: AnalysisContext = context) {
  return analyzeWindow(window, framework, state, ctx);
}

function alternate(
  speechMs: number,
  silenceMs: number,
  speechCount: number,
  silenceCount: number,
  lead: "speech" | "silence",
) {
  const speech: Array<{ startMs: number; endMs: number }> = [];
  const silence: Array<{ startMs: number; endMs: number }> = [];
  let cursor = 0;
  while (speech.length < speechCount || silence.length < silenceCount) {
    const order = lead === "speech" ? (["speech", "silence"] as const) : (["silence", "speech"] as const);
    for (const kind of order) {
      if (kind === "speech" && speech.length < speechCount) {
        speech.push({ startMs: cursor, endMs: cursor + speechMs });
        cursor += speechMs;
      }
      if (kind === "silence" && silence.length < silenceCount) {
        silence.push({ startMs: cursor, endMs: cursor + silenceMs });
        cursor += silenceMs;
      }
    }
  }
  return { speech, silence, end: cursor };
}

function rule(candidates: IssueCandidate[], ruleId: string) {
  return candidates.find((item) => item.ruleId === ruleId);
}

describe("内容规则", () => {
  it("首个完整窗口不报漏讲，第二个窗口把未覆盖条目合成一条", () => {
    const first = run(snapshot({ segments: [segment({ id: "a", text: "大家好" })] }));
    expect(rule(first.candidates, "content.must_say_missing")).toBeUndefined();
    expect(first.state.completeWindows).toBe(1);
    expect(first.state.coverage.every((item) => !item.covered)).toBe(true);

    const second = run(
      snapshot({
        windowStartMs: 60_000,
        windowEndMs: 120_000,
        segments: [
          segment({ id: "b", text: "还是没有价格", startMs: 60_000, endMs: 90_000 }),
          segment({ id: "c", text: "继续闲聊", startMs: 90_000, endMs: 110_000 }),
          segment({ id: "d", text: "第三句", startMs: 110_000, endMs: 115_000 }),
          segment({ id: "e", text: "第四句", startMs: 115_000, endMs: 120_000 }),
        ],
      }),
      first.state,
    );
    const missing = rule(second.candidates, "content.must_say_missing");
    expect(missing?.title).toBe("近窗有 3 个必讲点未覆盖");
    expect(missing?.fingerprint).toBe("content:must_say_missing");
    expect(missing?.evidence.frameworkItemIds).toEqual(["ms-1", "ms-2", "ms-3"]);
    expect(missing?.evidence.excerpts).toHaveLength(3);
    expect(missing?.suggestion).toContain("补充：今天活动价");
    expect(missing?.evidence.windowStartMs).toBe(60_000);
  });

  it("本场勾选保留已讲点，近窗连续两窗没再提到仍算漏讲", () => {
    const said = run(snapshot({ segments: [segment({ text: "先讲卖点" })] }));
    expect(said.state.coverage.find((item) => item.frameworkItemId === "ms-2")?.covered).toBe(true);
    expect(said.state.coverage.find((item) => item.frameworkItemId === "ms-1")?.covered).toBe(false);
    const missedOnce = run(
      snapshot({ windowStartMs: 60_000, windowEndMs: 120_000, segments: [segment({ text: "空窗", startMs: 60_000, endMs: 120_000 })] }),
      said.state,
    );
    const once = rule(missedOnce.candidates, "content.must_say_missing");
    expect(once?.evidence.frameworkItemIds).toEqual(["ms-1", "ms-3"]);
    const missedTwice = run(
      snapshot({ windowStartMs: 120_000, windowEndMs: 180_000, segments: [segment({ text: "还是空的", startMs: 120_000, endMs: 180_000 })] }),
      missedOnce.state,
    );
    const missing = rule(missedTwice.candidates, "content.must_say_missing");
    expect(missing?.evidence.frameworkItemIds).toEqual(["ms-1", "ms-2", "ms-3"]);
    expect(missedTwice.state.coverage.find((item) => item.frameworkItemId === "ms-2")?.covered).toBe(true);
    expect(missedTwice.state.coverage.find((item) => item.frameworkItemId === "ms-2")?.firstCoveredAtMs).toBe(60_000);
  });

  it("识别覆盖不足不推进漏讲计数，但触雷仍然报告", () => {
    const poor = snapshot({
      finalTextCoverageMs: 1_000,
      segments: [segment({ id: "hit", text: "这个一定能见效", startMs: 0, endMs: 20_000 })],
      speechIntervals: [{ startMs: 0, endMs: 20_000 }],
    });
    const first = run(poor);
    const second = run({ ...poor, windowStartMs: 60_000, windowEndMs: 120_000 }, first.state);
    expect(rule(second.candidates, "content.must_say_missing")).toBeUndefined();
    expect(second.state.completeWindows).toBe(0);
    expect(first.suppressions.map((item) => item.reason)).toContain(SUPPRESSION_REASON.finalText);
    const avoid = rule(first.candidates, "content.avoid_hit");
    expect(avoid?.severity).toBe("critical");
    expect(avoid?.suggestion).toContain("合规");
    expect(avoid?.evidence.excerpts[0]?.text).toContain("一定能");
    expect(avoid?.evidence.frameworkItemIds).toEqual(["av-1"]);
    expect(avoid?.evidence.metrics.matchedKeywords).toBe("一定能");
  });

  it("相邻短 final 拼成一句后，跨段的多字关键词仍能命中", () => {
    const hit = run(
      snapshot({
        segments: [
          segment({ id: "a", text: "今天的活", startMs: 0, endMs: 600 }),
          segment({ id: "b", text: "动价已经公布", startMs: 600, endMs: 1_200 }),
        ],
      }),
    );
    expect(hit.state.coverage.find((item) => item.frameworkItemId === "ms-1")?.covered).toBe(true);

    const split = run(
      snapshot({
        segments: [
          segment({ id: "a", text: "今天的活", startMs: 0, endMs: 600 }),
          segment({ id: "b", text: "动价已经公布", startMs: 1_600, endMs: 2_200 }),
        ],
      }),
    );
    expect(split.state.coverage.find((item) => item.frameworkItemId === "ms-1")?.covered).toBe(false);
  });

  it("字幕软切的字数边界不拆开跨段关键词", () => {
    const hit = run(
      snapshot({
        segments: [
          segment({ id: "a", text: `${textOfLength(47)}活`, startMs: 0, endMs: 600 }),
          segment({ id: "b", text: "动价", startMs: 600, endMs: 1_200 }),
        ],
      }),
    );
    expect(hit.state.coverage.find((item) => item.frameworkItemId === "ms-1")?.covered).toBe(true);
  });

  it("单字关键词不命中词中间，独立出现才算", () => {
    const single: FrameworkDocument = {
      ...framework,
      avoid: [{ id: "av-char", text: "单字价", keywords: ["价"] }],
    };
    const buried = analyzeWindow(
      snapshot({ segments: [segment({ text: "今天活动价" })] }),
      single,
      initialRuleState(single),
      context,
    );
    expect(buried.candidates.filter((item) => item.ruleId === "content.avoid_hit")).toHaveLength(0);
    const alone = analyzeWindow(
      snapshot({ segments: [segment({ text: "价" })] }),
      single,
      initialRuleState(single),
      context,
    );
    expect(rule(alone.candidates, "content.avoid_hit")?.evidence.excerpts[0]?.text).toBe("价");
  });
});

describe("语速规则", () => {
  function paceWindow(chars: number, speechMs = 60_000, audioCoverageMs = 60_000): WindowSnapshot {
    return snapshot({
      audioCoverageMs,
      finalTextCoverageMs: speechMs,
      speechIntervals: [{ startMs: 0, endMs: speechMs }],
      segments: [segment({ text: textOfLength(chars), endMs: speechMs })],
    });
  }

  it("相对阈值 10% 以内是 info，超过是 warning", () => {
    expect(rule(run(paceWindow(162)).candidates, "pace.too_slow")?.severity).toBe("info");
    expect(rule(run(paceWindow(161)).candidates, "pace.too_slow")?.severity).toBe("warning");
    expect(rule(run(paceWindow(308)).candidates, "pace.too_fast")?.severity).toBe("info");
    expect(rule(run(paceWindow(309)).candidates, "pace.too_fast")?.severity).toBe("warning");
    expect(run(paceWindow(200)).candidates.filter((item) => item.type === "pace")).toHaveLength(0);
    const slow = rule(run(paceWindow(100)).candidates, "pace.too_slow");
    expect(slow?.suggestion).toBe("适当加快，减少无效重复。");
  });

  it("音频覆盖刚好 80% 才判语速，有效语音不足 15 秒不判", () => {
    const slow = paceWindow(10, 20_000, 48_000);
    slow.finalTextCoverageMs = 20_000;
    expect(rule(run(slow).candidates, "pace.too_slow")).toBeTruthy();
    const shortAudio = paceWindow(10, 20_000, 47_999);
    shortAudio.finalTextCoverageMs = 20_000;
    const suppressed = run(shortAudio);
    expect(rule(suppressed.candidates, "pace.too_slow")).toBeUndefined();
    expect(suppressed.suppressions).toContainEqual({ ruleId: "pace", reason: SUPPRESSION_REASON.audio });

    const brief = paceWindow(400, 10_000, 60_000);
    brief.windowEndMs = 60_000;
    brief.finalTextCoverageMs = 10_000;
    const quiet = run(brief);
    expect(quiet.candidates.filter((item) => item.type === "pace" || item.type === "rhythm")).toHaveLength(0);
    expect(quiet.suppressions.map((item) => item.reason)).toContain(SUPPRESSION_REASON.speech);
  });

  it("时间重叠的片段不把字数算两次", () => {
    const text = textOfLength(200);
    const window = snapshot({
      segments: [
        segment({ id: "a", text, startMs: 0, endMs: 60_000 }),
        segment({ id: "b", text, startMs: 0, endMs: 60_000 }),
      ],
    });
    expect(run(window).candidates.filter((item) => item.type === "pace")).toHaveLength(0);
  });
});

describe("节奏规则", () => {
  it("超长停顿成立，和缺口重叠的静音不算，静音占比要严格大于 0.45", () => {
    const pause = run(
      snapshot({
        speechIntervals: [{ startMs: 5_000, endMs: 25_000 }],
        silenceIntervals: [{ startMs: 0, endMs: 5_000 }],
        finalTextCoverageMs: 20_000,
        segments: [segment({ text: "停顿前后", startMs: 5_000, endMs: 25_000 })],
      }),
    );
    const longPause = rule(pause.candidates, "rhythm.long_pause");
    expect(longPause?.evidence.metrics.longestSilenceMs).toBe(5_000);
    expect(longPause?.suggestion).toContain("超长停顿");
    expect(pause.candidates.filter((item) => item.type === "rhythm")).toHaveLength(1);

    const gap = run(
      snapshot({
        audioCoverageMs: 50_000,
        finalTextCoverageMs: 48_000,
        speechIntervals: [
          { startMs: 10_000, endMs: 30_000 },
          { startMs: 32_000, endMs: 60_000 },
        ],
        silenceIntervals: [
          { startMs: 0, endMs: 10_000 },
          { startMs: 30_000, endMs: 32_000 },
        ],
        gapIntervals: [{ startMs: 0, endMs: 10_000 }],
        segments: [segment({ text: textOfLength(80), startMs: 10_000, endMs: 60_000 })],
      }),
    );
    expect(gap.candidates.filter((item) => item.type === "rhythm")).toHaveLength(0);

    const exactParts = alternate(4_125, 3_000, 8, 9, "silence");
    const exact = run(
      snapshot({
        speechIntervals: exactParts.speech,
        silenceIntervals: exactParts.silence,
        finalTextCoverageMs: 33_000,
        segments: [segment({ text: "正常讲", endMs: exactParts.end })],
      }),
    );
    expect(exactParts.end).toBe(60_000);
    expect(exact.candidates.filter((item) => item.type === "rhythm")).toHaveLength(0);

    const denseParts = alternate(4_050, 3_450, 8, 8, "speech");
    const denseSilence = run(
      snapshot({
        speechIntervals: denseParts.speech,
        silenceIntervals: denseParts.silence,
        finalTextCoverageMs: 32_400,
        segments: [segment({ text: "空场偏多", endMs: denseParts.end })],
      }),
    );
    expect(rule(denseSilence.candidates, "rhythm.low_density")).toBeTruthy();
    expect(rule(denseSilence.candidates, "rhythm.long_pause")).toBeUndefined();
  });

  it("长停顿优先于静音占比，同一窗口只留一条节奏问题", () => {
    const both = run(
      snapshot({
        windowEndMs: 50_000,
        audioCoverageMs: 50_000,
        finalTextCoverageMs: 20_000,
        speechIntervals: [{ startMs: 30_000, endMs: 50_000 }],
        silenceIntervals: [{ startMs: 0, endMs: 30_000 }],
        segments: [segment({ text: "后半段才开口", startMs: 30_000, endMs: 50_000 })],
      }),
    );
    expect(both.candidates.filter((item) => item.type === "rhythm").map((item) => item.ruleId)).toEqual(["rhythm.long_pause"]);
  });

  it("连珠炮要同时满足语音占比、60 秒和句间缺口，慢语速或缺口都不报", () => {
    const speech = [
      { startMs: 0, endMs: 16_000 },
      { startMs: 17_000, endMs: 34_000 },
      { startMs: 35_000, endMs: 52_000 },
      { startMs: 53_000, endMs: 70_000 },
    ];
    const rapid = snapshot({
      windowEndMs: 70_000,
      audioCoverageMs: 70_000,
      finalTextCoverageMs: 67_000,
      speechIntervals: speech,
      silenceIntervals: [
        { startMs: 16_000, endMs: 17_000 },
        { startMs: 34_000, endMs: 35_000 },
        { startMs: 52_000, endMs: 53_000 },
      ],
      segments: [segment({ text: textOfLength(220), endMs: 70_000 })],
    });
    expect(rule(run(rapid).candidates, "rhythm.no_pause")?.suggestion).toContain("1–2 秒");

    const gapped = snapshot({
      ...rapid,
      speechIntervals: [
        { startMs: 0, endMs: 16_000 },
        { startMs: 17_200, endMs: 34_000 },
        { startMs: 35_000, endMs: 52_000 },
        { startMs: 53_000, endMs: 70_000 },
      ],
      silenceIntervals: [
        { startMs: 16_000, endMs: 17_200 },
        { startMs: 34_000, endMs: 35_000 },
        { startMs: 52_000, endMs: 53_000 },
      ],
    });
    expect(run(gapped).candidates.filter((item) => item.type === "rhythm")).toHaveLength(0);

    const slow = snapshot({ ...rapid, segments: [segment({ text: textOfLength(50), endMs: 70_000 })] });
    const slowResult = run(slow);
    expect(rule(slowResult.candidates, "rhythm.no_pause")).toBeUndefined();
    expect(rule(slowResult.candidates, "pace.too_slow")).toBeTruthy();

    const short = snapshot({
      windowEndMs: 58_000,
      audioCoverageMs: 58_000,
      finalTextCoverageMs: 55_000,
      speechIntervals: [{ startMs: 0, endMs: 55_000 }],
      silenceIntervals: [{ startMs: 55_000, endMs: 58_000 }],
      segments: [segment({ text: textOfLength(220), endMs: 55_000 })],
    });
    expect(run(short).candidates.filter((item) => item.type === "rhythm")).toHaveLength(0);
  });
});

describe("去重与重复提醒", () => {
  it("同一指纹只保留一条，重复命中都会重新未读并累加次数", () => {
    const store = new IssueStore();
    store.reset("s");
    const avoid = run(snapshot({ segments: [segment({ text: "这个一定能好" })] })).candidates.find(
      (item) => item.ruleId === "content.avoid_hit",
    );
    const slow = run(snapshot({
      finalTextCoverageMs: 60_000,
      segments: [segment({ text: textOfLength(100) })],
    })).candidates.find((item) => item.ruleId === "pace.too_slow");
    expect(avoid && slow).toBeTruthy();
    if (!avoid || !slow) return;
    const first = store.upsert(avoid, 0, "rev");
    expect(first.isNew).toBe(true);
    expect(first.recurrence).toBeNull();
    expect(store.unreadCount()).toBe(1);

    const second = store.upsert(avoid, 60_000, "rev");
    expect(store.list()).toHaveLength(1);
    expect(second.isNew).toBe(false);
    expect(second.issue.occurrenceCount).toBe(2);
    expect(second.issue.status).toBe("unread");
    expect(second.recurrence?.occurrenceCount).toBe(2);
    expect(second.recurrence?.gapMs).toBe(60_000);
    expect(store.unreadCount()).toBe(1);

    store.markRead(store.list()[0]!.id);
    expect(store.unreadCount()).toBe(0);
    const third = store.upsert(avoid, 240_000, "rev");
    expect(third.issue.occurrenceCount).toBe(3);
    expect(third.issue.status).toBe("unread");
    expect(third.recurrence?.gapMs).toBe(180_000);
    expect(store.unreadCount()).toBe(1);

    store.upsert(slow, 1_000, "rev");
    expect(store.list().map((item) => item.ruleId)).toEqual(["content.avoid_hit", "pace.too_slow"]);
    store.markAllRead();
    expect(store.unreadCount()).toBe(0);
  });
});

describe("警告方案生效", () => {
  const profile = () =>
    defaultIssueRuleProfile("自定义方案", "profile-test", new Date(0).toISOString());

  it("自定义关键词规则命中后产生带判定标准的问题", () => {
    const ruleProfile = profile();
    ruleProfile.customRules = [
      {
        id: "r1",
        name: "禁止承诺发货时效",
        keywords: ["当天发货"],
        severity: "warning",
        suggestion: "改成 48 小时内发出",
        enabled: true,
      },
    ];
    const output = analyzeWindow(
      snapshot({ segments: [segment({ text: "我们今天一定当天发货" })] }),
      framework,
      initialRuleState(framework),
      context,
      ruleProfile,
      customRuleItems(ruleProfile),
    );
    const custom = output.candidates.find((item) => item.ruleId === "custom:r1");
    expect(custom?.fingerprint).toBe("content:custom:r1");
    expect(custom?.criterion?.keywords).toContain("当天发货");
    expect(custom?.criterion?.summary).toContain("当天发货");
    expect(custom?.suggestion).toContain("48 小时");
  });

  it("关闭的必讲点不再产生漏讲问题", () => {
    const ruleProfile = profile();
    ruleProfile.mustSay.disabledItemIds = ["ms-1", "ms-3"];
    const active = effectiveFramework(framework, ruleProfile);
    const first = analyzeWindow(
      snapshot({ segments: [segment({ text: "大家好" })] }),
      active,
      initialRuleState(active),
      context,
      ruleProfile,
    );
    const second = analyzeWindow(
      snapshot({
        windowStartMs: 60_000,
        windowEndMs: 120_000,
        segments: [segment({ text: "还是没有价格", startMs: 60_000, endMs: 120_000 })],
      }),
      active,
      first.state,
      context,
      ruleProfile,
    );
    const missing = second.candidates.find((item) => item.ruleId === "content.must_say_missing");
    expect(missing?.evidence.frameworkItemIds).toEqual(["ms-2"]);
    expect(missing?.criterion?.summary).toContain("卖点");
    expect(missing?.criterion?.summary).not.toContain("活动价");
  });

  it("语速阈值覆盖后不再按框架默认范围报警", () => {
    const ruleProfile = profile();
    ruleProfile.pace.min = 100;
    ruleProfile.pace.max = 400;
    const active = effectiveFramework(framework, ruleProfile);
    expect(active.pace.min).toBe(100);
    expect(active.pace.max).toBe(400);
    const output = analyzeWindow(
      snapshot({
        finalTextCoverageMs: 60_000,
        segments: [segment({ text: textOfLength(100) })],
      }),
      active,
      initialRuleState(active),
      context,
      ruleProfile,
    );
    expect(output.candidates.some((item) => item.type === "pace")).toBe(false);
  });

  it("关键词覆盖后按新关键词判定", () => {
    const ruleProfile = profile();
    ruleProfile.keywordOverrides = { "av-1": ["保证"] };
    const active = effectiveFramework(framework, ruleProfile);
    expect(active.avoid[0]?.keywords).toEqual(["保证"]);
    const hit = analyzeWindow(
      snapshot({ segments: [segment({ text: "我保证这个有效" })] }),
      active,
      initialRuleState(active),
      context,
      ruleProfile,
    );
    expect(hit.candidates.some((item) => item.ruleId === "content.avoid_hit")).toBe(true);
  });
});
