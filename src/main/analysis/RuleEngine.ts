import { QUALITY_GATES, RHYTHM_DEFAULTS } from "@shared/config/defaults";
import { RULE_SUGGESTIONS } from "@shared/issues/suggestions";
import type { FrameworkDocument, FrameworkItem } from "@shared/contracts/framework";
import type { IssueCriterion, IssueEvidence, IssueSeverity, IssueType } from "@shared/contracts/issue";
import type { IssueRuleId, IssueRuleProfile } from "@shared/contracts/issueRules";
import { customRuleItemId, defaultIssueRuleProfile } from "@shared/contracts/issueRules";
import type { TranscriptSegment, WindowSnapshot } from "@shared/contracts/transcript";
import { intervalDuration } from "./intervals";
import {
  audibleSilence,
  audibleSpeech,
  dedupedEffectiveChars,
  effectiveSpeechMs,
  matchFrameworkItems,
  type ItemHit,
} from "./match";

export const SUPPRESSION_REASON = {
  audio: "音频覆盖不足",
  speech: "有效语音不足",
  finalText: "识别覆盖不足",
} as const;

export type IssueCandidate = {
  fingerprint: string;
  type: IssueType;
  ruleId: string;
  severity: IssueSeverity;
  title: string;
  suggestion?: string;
  criterion?: IssueCriterion;
  evidence: IssueEvidence;
};

export type CoverageState = {
  frameworkItemId: string;
  covered: boolean;
  firstCoveredAtMs?: number;
  matchedSegmentIds: string[];
};

export type RuleState = {
  completeWindows: number;
  lastCompleteEndMs: number | null;
  missStreak: Record<string, number>;
  coverage: CoverageState[];
};

export type AnalysisContext = {
  nominalWindowMs: number;
  intervalMs: number;
  finalFlush: boolean;
  frameworkRevision: string;
};

export type Suppression = {
  ruleId: string;
  reason: string;
};

export type AnalysisOutput = {
  candidates: IssueCandidate[];
  state: RuleState;
  suppressions: Suppression[];
  /** 是否命中禁讲点；不受 avoid 警告开关影响。 */
  avoidHit: boolean;
};

export function initialRuleState(document: FrameworkDocument): RuleState {
  return {
    completeWindows: 0,
    lastCompleteEndMs: null,
    missStreak: Object.fromEntries(document.must_say.map((item) => [item.id, 0])),
    coverage: document.must_say.map((item) => ({
      frameworkItemId: item.id,
      covered: false,
      matchedSegmentIds: [],
    })),
  };
}

export function analyzeWindow(
  snapshot: WindowSnapshot,
  framework: FrameworkDocument,
  previous: RuleState,
  context: AnalysisContext,
  profile: IssueRuleProfile = defaultIssueRuleProfile(),
  customItems: readonly FrameworkItem[] = [],
): AnalysisOutput {
  const state = cloneState(previous);
  const suppressions: Suppression[] = [];
  const candidates: IssueCandidate[] = [];
  const mustHits = matchFrameworkItems(snapshot.segments, framework.must_say);
  const avoidHits = matchFrameworkItems(snapshot.segments, framework.avoid);
  state.coverage = mergeCoverage(state.coverage, framework.must_say, mustHits, snapshot.windowEndMs);

  const gates = assessGates(snapshot);
  const duration = snapshot.windowEndMs - snapshot.windowStartMs;
  const complete = duration >= context.nominalWindowMs;
  const advanced =
    complete &&
    (state.lastCompleteEndMs == null || snapshot.windowEndMs >= state.lastCompleteEndMs + context.intervalMs - 20);

  if (advanced && !gates.mustSayReason) {
    state.completeWindows += 1;
    state.lastCompleteEndMs = snapshot.windowEndMs;
    for (const item of framework.must_say) {
      state.missStreak[item.id] = mustHits.has(item.id) ? 0 : (state.missStreak[item.id] ?? 0) + 1;
    }
  } else if (advanced && gates.mustSayReason) {
    suppressions.push({ ruleId: "content.must_say_missing", reason: gates.mustSayReason });
  }

  if (profile.avoid.enabled) {
    for (const item of framework.avoid) {
      if (profile.avoid.disabledItemIds.includes(item.id)) continue;
      const hit = avoidHits.get(item.id);
      if (!hit) continue;
      candidates.push(avoidCandidate(snapshot, item, hit, context.frameworkRevision, profile));
    }
  }

  if (profile.mustSay.enabled && !gates.mustSayReason) {
    const missing = framework.must_say.filter(
      (item) =>
        !profile.mustSay.disabledItemIds.includes(item.id) &&
        (state.missStreak[item.id] ?? 0) >= profile.mustSay.missWindows,
    );
    if (missing.length > 0 && advanced) {
      candidates.push(missingCandidate(snapshot, missing, context.frameworkRevision, profile));
    }
  }

  if (profile.pace.enabled) {
    const pace = evaluatePace(snapshot, framework, gates, profile);
    if (pace.suppression) suppressions.push(pace.suppression);
    if (pace.candidate) candidates.push(pace.candidate);
  }

  if (profile.rhythm.enabled) {
    const rhythm = evaluateRhythm(snapshot, framework, gates, profile);
    if (rhythm.suppression) suppressions.push(rhythm.suppression);
    if (rhythm.candidate) candidates.push(rhythm.candidate);
  }

  const customHits = customItems.length > 0 ? matchFrameworkItems(snapshot.segments, customItems) : new Map<string, ItemHit>();
  for (const rule of profile.customRules) {
    if (!rule.enabled) continue;
    const hit = customHits.get(customRuleItemId(rule.id));
    if (!hit) continue;
    candidates.push({
      fingerprint: `content:custom:${rule.id}`,
      type: "content",
      ruleId: `custom:${rule.id}`,
      severity: rule.severity,
      title: ruleTitle(profile, `custom:${rule.id}`, rule.name),
      suggestion: ruleSuggestion(profile, `custom:${rule.id}`, rule.suggestion),
      criterion: {
        ruleId: `custom:${rule.id}`,
        summary: `命中关键词「${hit.keywords.join("、")}」`,
        keywords: [...hit.keywords],
      },
      evidence: evidence(snapshot, hit.segments, [customRuleItemId(rule.id)], {
        frameworkRevision: context.frameworkRevision,
        matchedKeywords: hit.keywords.join("、"),
        itemLabels: rule.name,
      }),
    });
  }

  return { candidates, state, suppressions, avoidHit: avoidHits.size > 0 };
}

export function assessGates(snapshot: WindowSnapshot): {
  audioOk: boolean;
  speechMs: number;
  effectiveSpeechMs: number;
  mustSayReason: string | null;
  paceReason: string | null;
  rhythmReason: string | null;
} {
  const duration = Math.max(1, snapshot.windowEndMs - snapshot.windowStartMs);
  const audioOk = snapshot.audioCoverageMs / duration >= QUALITY_GATES.minAudioCoverageRatio;
  const speech = audibleSpeech(snapshot.speechIntervals, snapshot.gapIntervals);
  const speechMs = intervalDuration(speech);
  const coveredSpeechMs = effectiveSpeechMs(snapshot.speechIntervals, snapshot.gapIntervals, snapshot.segments);
  const textRatio = speechMs > 0 ? Math.min(snapshot.finalTextCoverageMs, speechMs) / speechMs : 0;
  const textOk = speechMs > 0 && textRatio >= QUALITY_GATES.minFinalTextCoverageRatio;

  let mustSayReason: string | null = null;
  if (!audioOk) mustSayReason = SUPPRESSION_REASON.audio;
  else if (speechMs < QUALITY_GATES.minSpeechMs) mustSayReason = SUPPRESSION_REASON.speech;
  else if (!textOk) mustSayReason = SUPPRESSION_REASON.finalText;

  let paceReason: string | null = null;
  if (!audioOk) paceReason = SUPPRESSION_REASON.audio;
  else if (coveredSpeechMs < QUALITY_GATES.minSpeechMs) paceReason = SUPPRESSION_REASON.speech;

  let rhythmReason: string | null = null;
  if (!audioOk) rhythmReason = SUPPRESSION_REASON.audio;
  else if (speechMs < QUALITY_GATES.minSpeechMs) rhythmReason = SUPPRESSION_REASON.speech;

  return { audioOk, speechMs, effectiveSpeechMs: coveredSpeechMs, mustSayReason, paceReason, rhythmReason };
}

function avoidCandidate(
  snapshot: WindowSnapshot,
  item: FrameworkItem,
  hit: ItemHit,
  revision: string,
  profile: IssueRuleProfile,
): IssueCandidate {
  const ruleId: IssueRuleId = "content.avoid_hit";
  const keywords = hit.segments.length === 0 ? [...item.keywords] : [...hit.keywords];
  return {
    fingerprint: `content:avoid:${item.id}`,
    type: "content",
    ruleId,
    severity: ruleSeverity(profile.avoid.severity, "critical"),
    title: ruleTitle(profile, ruleId, `触雷：${item.text}`),
    suggestion: ruleSuggestion(profile, ruleId, RULE_SUGGESTIONS.avoid),
    criterion: {
      ruleId,
      summary: `命中禁讲关键词「${keywords.join("、")}」`,
      keywords,
    },
    evidence: evidence(snapshot, hit.segments, [item.id], {
      frameworkRevision: revision,
      matchedKeywords: hit.keywords.join("、"),
      itemLabels: `${item.id} ${item.text}`,
    }),
  };
}

function missingCandidate(
  snapshot: WindowSnapshot,
  missing: FrameworkItem[],
  revision: string,
  profile: IssueRuleProfile,
): IssueCandidate {
  const ruleId: IssueRuleId = "content.must_say_missing";
  const shown = missing.slice(0, QUALITY_GATES.maxSuggestions).map((item) => `补充：${item.text}`);
  const suggestion = missing.length > QUALITY_GATES.maxSuggestions ? `${shown.join("；")}；其余见详情` : shown.join("；");
  const excerpts = representative(snapshot.segments);
  const labels = missing.slice(0, 3).map((item) => `${item.text}（${item.keywords.join("、")}）`).join("、");
  const suffix = missing.length > 3 ? ` 等 ${missing.length} 条` : "";
  return {
    fingerprint: "content:must_say_missing",
    type: "content",
    ruleId,
    severity: ruleSeverity(profile.mustSay.severity, "warning"),
    title: ruleTitle(profile, ruleId, `近窗有 ${missing.length} 个必讲点未覆盖`),
    suggestion: ruleSuggestion(profile, ruleId, suggestion),
    criterion: {
      ruleId,
      summary: `连续 ${profile.mustSay.missWindows} 个完整分析窗未命中：${labels}${suffix}`,
      thresholds: [{ label: "判定窗数", value: `${profile.mustSay.missWindows} 个完整分析窗` }],
    },
    evidence: evidence(snapshot, excerpts, missing.map((item) => item.id), {
      frameworkRevision: revision,
      missingCount: missing.length,
      itemLabels: missing.map((item) => `${item.id} ${item.text}`).join("；"),
    }),
  };
}

function evaluatePace(
  snapshot: WindowSnapshot,
  framework: FrameworkDocument,
  gates: ReturnType<typeof assessGates>,
  profile: IssueRuleProfile,
): { candidate?: IssueCandidate; suppression?: Suppression } {
  if (gates.paceReason) return { suppression: { ruleId: "pace", reason: gates.paceReason } };
  const speechMs = gates.effectiveSpeechMs;
  const chars = dedupedEffectiveChars(snapshot.segments);
  const charsPerMinute = chars / (speechMs / 60_000);
  const { min, max } = framework.pace;
  if (charsPerMinute >= min && charsPerMinute <= max) return {};
  const tooFast = charsPerMinute > max;
  const bound = tooFast ? max : min;
  const deviation = (tooFast ? charsPerMinute - max : min - charsPerMinute) / bound;
  const ruleId: IssueRuleId = tooFast ? "pace.too_fast" : "pace.too_slow";
  const autoSeverity: IssueSeverity = deviation > profile.pace.deviationInfoRatio ? "warning" : "info";
  const pacePercent = Math.round(deviation * 1000) / 10;
  const roundedRate = Math.round(charsPerMinute);
  return {
    candidate: {
      fingerprint: tooFast ? "pace:too_fast" : "pace:too_slow",
      type: "pace",
      ruleId,
      severity: ruleSeverity(profile.pace.severity, autoSeverity),
      title: ruleTitle(profile, ruleId, tooFast ? "语速偏快" : "语速偏慢"),
      suggestion: ruleSuggestion(profile, ruleId, tooFast ? RULE_SUGGESTIONS.paceFast : RULE_SUGGESTIONS.paceSlow),
      criterion: {
        ruleId,
        summary: `语速 ${roundedRate} 字/分，${tooFast ? "高于上限" : "低于下限"} ${bound} 字/分（偏差 ${pacePercent}%）`,
        thresholds: [
          { label: "语速范围", value: `${min}–${max} 字/分` },
          { label: "偏差阈值", value: `${Math.round(profile.pace.deviationInfoRatio * 100)}%` },
        ],
      },
      evidence: evidence(snapshot, representative(snapshot.segments), [], {
        effectiveChars: chars,
        effectiveSpeechMs: Math.round(speechMs),
        charsPerMinute: round(charsPerMinute, 1),
        paceMin: min,
        paceMax: max,
        deviationRatio: round(deviation, 3),
      }),
    },
  };
}

function evaluateRhythm(
  snapshot: WindowSnapshot,
  framework: FrameworkDocument,
  gates: ReturnType<typeof assessGates>,
  profile: IssueRuleProfile,
): { candidate?: IssueCandidate; suppression?: Suppression } {
  if (gates.rhythmReason) return { suppression: { ruleId: "rhythm", reason: gates.rhythmReason } };
  const config = profile.rhythm;
  const silence = audibleSilence(snapshot.silenceIntervals, snapshot.gapIntervals);
  const speech = audibleSpeech(snapshot.speechIntervals, snapshot.gapIntervals);
  const speechMs = intervalDuration(speech);
  const silenceMs = intervalDuration(silence);
  const audioMs = Math.max(1, snapshot.audioCoverageMs);
  const silenceRatio = silenceMs / audioMs;
  const speechRatio = speechMs / audioMs;
  const longest = silence.reduce<typeof silence[number] | null>((best, item) => {
    if (!best || item.endMs - item.startMs > best.endMs - best.startMs) return item;
    return best;
  }, null);
  const longestMs = longest ? longest.endMs - longest.startMs : 0;
  const sentenceGaps = sentenceGapCount(speech, config.maxSentenceGapMs);
  const charsPerMinute = gates.effectiveSpeechMs > 0 ? dedupedEffectiveChars(snapshot.segments) / (gates.effectiveSpeechMs / 60_000) : 0;
  const metrics = {
    speechMs: Math.round(speechMs),
    silenceMs: Math.round(silenceMs),
    silenceRatio: round(silenceRatio, 3),
    speechRatio: round(speechRatio, 3),
    longestSilenceMs: Math.round(longestMs),
    sentenceCount: countSentences(speech, snapshot.segments, config.maxSentenceGapMs),
    charsPerMinute: round(charsPerMinute, 1),
  };

  if (config.longPauseEnabled && longest && longestMs >= config.longSilenceMs) {
    const neighbors = around(longest, snapshot.segments);
    return {
      candidate: rhythmCandidate(
        profile,
        "rhythm.long_pause",
        "rhythm:long_pause",
        "超长停顿",
        RULE_SUGGESTIONS.longPause,
        snapshot,
        neighbors.length > 0 ? neighbors : representative(snapshot.segments),
        metrics,
        {
          ruleId: "rhythm.long_pause",
          summary: `最长停顿 ${round(longestMs / 1000, 1)} 秒，达到 ${round(config.longSilenceMs / 1000, 1)} 秒阈值`,
          thresholds: [{ label: "长停顿阈值", value: `${round(config.longSilenceMs / 1000, 1)} 秒` }],
        },
      ),
    };
  }
  if (config.lowDensityEnabled && silenceRatio > config.highSilenceRatio && speechMs >= QUALITY_GATES.minSpeechMs) {
    return {
      candidate: rhythmCandidate(
        profile,
        "rhythm.low_density",
        "rhythm:low_density",
        "静音占比偏高",
        RULE_SUGGESTIONS.lowDensity,
        snapshot,
        representative(snapshot.segments),
        metrics,
        {
          ruleId: "rhythm.low_density",
          summary: `静音占比 ${round(silenceRatio * 100, 1)}%，高于 ${round(config.highSilenceRatio * 100, 1)}%`,
          thresholds: [{ label: "静音占比阈值", value: `${round(config.highSilenceRatio * 100, 1)}%` }],
        },
      ),
    };
  }
  const dense =
    config.noPauseEnabled &&
    speechRatio > config.highSpeechRatio &&
    speechMs >= config.minDenseSpeechMs &&
    sentenceGaps === 0 &&
    charsPerMinute >= framework.pace.min;
  if (dense) {
    return {
      candidate: rhythmCandidate(
        profile,
        "rhythm.no_pause",
        "rhythm:no_pause",
        "连珠炮，缺少停顿",
        RULE_SUGGESTIONS.noPause,
        snapshot,
        representative(snapshot.segments),
        metrics,
        {
          ruleId: "rhythm.no_pause",
          summary: `语音占比 ${round(speechRatio * 100, 1)}%，高于 ${round(config.highSpeechRatio * 100, 1)}%，且 ${round(config.minDenseSpeechMs / 60_000, 1)} 分钟内无句间停顿`,
          thresholds: [{ label: "语音占比阈值", value: `${round(config.highSpeechRatio * 100, 1)}%` }],
        },
      ),
    };
  }
  return {};
}

function rhythmCandidate(
  profile: IssueRuleProfile,
  ruleId: IssueRuleId,
  fingerprint: string,
  title: string,
  suggestion: string,
  snapshot: WindowSnapshot,
  segments: TranscriptSegment[],
  metrics: Record<string, number>,
  criterion: IssueCriterion,
): IssueCandidate {
  return {
    fingerprint,
    type: "rhythm",
    ruleId,
    severity: ruleSeverity(profile.rhythm.severity, "warning"),
    title: ruleTitle(profile, ruleId, title),
    suggestion: ruleSuggestion(profile, ruleId, suggestion),
    criterion,
    evidence: evidence(snapshot, segments, [], metrics),
  };
}

function ruleSeverity(configured: IssueSeverity | null, fallback: IssueSeverity): IssueSeverity {
  return configured ?? fallback;
}

function ruleTitle(profile: IssueRuleProfile, ruleId: string, fallback: string): string {
  const override = profile.titles[ruleId]?.trim();
  return override ? override : fallback;
}

function ruleSuggestion(profile: IssueRuleProfile, ruleId: string, fallback: string): string {
  const override = profile.suggestions[ruleId]?.trim();
  return override ? override : fallback;
}

function sentenceGapCount(speech: ReturnType<typeof audibleSpeech>, maxGapMs: number): number {
  let gaps = 0;
  for (let index = 1; index < speech.length; index += 1) {
    const previous = speech[index - 1];
    const current = speech[index];
    if (!previous || !current) continue;
    if (current.startMs - previous.endMs >= maxGapMs) gaps += 1;
  }
  return gaps;
}

function countSentences(speech: ReturnType<typeof audibleSpeech>, segments: readonly TranscriptSegment[], maxGapMs: number): number {
  if (speech.length === 0) return 0;
  const groups: Array<{ startMs: number; endMs: number }> = [];
  for (const piece of speech) {
    const last = groups[groups.length - 1];
    if (last && piece.startMs - last.endMs < maxGapMs) last.endMs = piece.endMs;
    else groups.push({ startMs: piece.startMs, endMs: piece.endMs });
  }
  return groups.filter((group) => {
    const inside = segments.filter((segment) => segment.endMs > group.startMs && segment.startMs < group.endMs);
    return dedupedEffectiveChars(inside) >= RHYTHM_DEFAULTS.minSentenceLengthChars;
  }).length;
}

function around(silence: { startMs: number; endMs: number }, segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const before = [...segments].filter((segment) => segment.endMs <= silence.startMs).sort((a, b) => b.endMs - a.endMs)[0];
  const after = [...segments].filter((segment) => segment.startMs >= silence.endMs).sort((a, b) => a.startMs - b.startMs)[0];
  return [before, after].filter((segment): segment is TranscriptSegment => segment != null);
}

function representative(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments]
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, QUALITY_GATES.maxExcerpts)
    .sort((a, b) => a.startMs - b.startMs);
}

function evidence(
  snapshot: WindowSnapshot,
  segments: readonly TranscriptSegment[],
  frameworkItemIds: string[],
  metrics: Record<string, number | string | boolean>,
): IssueEvidence {
  const picked = segments.slice(0, QUALITY_GATES.maxExcerpts);
  return {
    windowStartMs: snapshot.windowStartMs,
    windowEndMs: snapshot.windowEndMs,
    segmentIds: picked.map((segment) => segment.id),
    excerpts: picked.map((segment) => ({
      segmentId: segment.id,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
    frameworkItemIds,
    metrics,
  };
}

function mergeCoverage(
  previous: CoverageState[],
  items: readonly FrameworkItem[],
  hits: Map<string, ItemHit>,
  atMs: number,
): CoverageState[] {
  const prior = new Map(previous.map((item) => [item.frameworkItemId, item]));
  return items.map((item) => {
    const existing = prior.get(item.id);
    const hit = hits.get(item.id);
    const base: CoverageState = existing ?? { frameworkItemId: item.id, covered: false, matchedSegmentIds: [] };
    if (!hit) return { ...base, matchedSegmentIds: [...base.matchedSegmentIds] };
    const matchedSegmentIds = [...new Set([...base.matchedSegmentIds, ...hit.segments.map((segment) => segment.id)])].slice(
      0,
      QUALITY_GATES.maxCoverageSegments,
    );
    return {
      frameworkItemId: item.id,
      covered: true,
      firstCoveredAtMs: base.firstCoveredAtMs ?? atMs,
      matchedSegmentIds,
    };
  });
}

function cloneState(state: RuleState): RuleState {
  return {
    completeWindows: state.completeWindows,
    lastCompleteEndMs: state.lastCompleteEndMs,
    missStreak: { ...state.missStreak },
    coverage: state.coverage.map((item) => ({ ...item, matchedSegmentIds: [...item.matchedSegmentIds] })),
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
