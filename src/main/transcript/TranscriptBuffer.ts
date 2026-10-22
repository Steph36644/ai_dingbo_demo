import { randomUUID } from "node:crypto";
import { AUDIO } from "@shared/config/defaults";
import type { AudioFrame } from "@shared/contracts/audio";
import type { AsrResult } from "@shared/contracts/asr";
import type { TranscriptSegment, TranscriptView, WindowSnapshot } from "@shared/contracts/transcript";
import { normalizeText } from "./normalize";

type Interval = { startMs: number; endMs: number };

function cloneSegment(segment: TranscriptSegment): TranscriptSegment {
  return { ...segment };
}

function mergeInterval(list: Interval[], next: Interval): void {
  const last = list[list.length - 1];
  if (last && next.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, next.endMs);
  else list.push({ ...next });
}

function overlapMs(list: Interval[], startMs: number, endMs: number): number {
  let total = 0;
  for (const item of list) {
    const start = Math.max(item.startMs, startMs);
    const end = Math.min(item.endMs, endMs);
    if (end > start) total += end - start;
  }
  return total;
}

function isSpeechFrame(frame: AudioFrame): boolean {
  if (typeof frame.speechProbability === "number") return frame.speechProbability >= 0.5;
  return frame.rms >= AUDIO.speechRmsThreshold;
}

export class TranscriptBuffer {
  private finals: TranscriptSegment[] = [];
  private partial: TranscriptSegment | null = null;
  private finalIds = new Set<string>();
  private audioRuns: Interval[] = [];
  private speech: Interval[] = [];
  private silence: Interval[] = [];
  private gaps: Interval[] = [];
  private lastAudioEnd: number | null = null;

  constructor(readonly sessionId: string) {}

  noteFrame(frame: AudioFrame): { startMs: number; endMs: number } | null {
    const startMs = frame.startMs;
    const endMs = frame.startMs + frame.durationMs;
    let gap: { startMs: number; endMs: number } | null = null;
    if (this.lastAudioEnd != null && startMs > this.lastAudioEnd + AUDIO.frameDurationMs) {
      gap = { startMs: this.lastAudioEnd, endMs: startMs };
      mergeInterval(this.gaps, gap);
    }
    mergeInterval(this.audioRuns, { startMs, endMs });
    if (isSpeechFrame(frame)) mergeInterval(this.speech, { startMs, endMs });
    else mergeInterval(this.silence, { startMs, endMs });
    this.lastAudioEnd = this.lastAudioEnd == null ? endMs : Math.max(this.lastAudioEnd, endMs);
    return gap;
  }

  apply(result: AsrResult): { kind: "partial" | "final" | "ignored"; segment: TranscriptSegment | null } {
    if (result.sessionId !== this.sessionId) return { kind: "ignored", segment: null };
    if (!result.isFinal) {
      const segment = this.toSegment(result, false);
      this.partial = segment;
      return { kind: "partial", segment: cloneSegment(segment) };
    }
    if (this.finalIds.has(result.providerResultId)) return { kind: "ignored", segment: null };
    this.finalIds.add(result.providerResultId);
    if (this.partial?.sourceResultId === result.providerResultId) this.partial = null;
    const segment = this.toSegment(result, true);
    this.finals.push(segment);
    this.finals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return { kind: "final", segment: cloneSegment(segment) };
  }

  view(): TranscriptView {
    return {
      sessionId: this.sessionId,
      finals: this.finals.map(cloneSegment),
      partial: this.partial ? cloneSegment(this.partial) : null,
    };
  }

  /**
   * 左闭右开窗口的不可变快照。没有词级时间戳时，跨边界片段按字符比例裁剪并标记 estimatedTiming。
   * M1 不跑规则；frameworkRevision 固定为空占位。
   */
  snapshot(endMs: number, windowMs: number, triggeredAtMs = endMs, frameworkRevision = ""): WindowSnapshot {
    const windowEndMs = endMs;
    const windowStartMs = Math.max(0, endMs - windowMs);
    const segments = this.finals
      .map((segment) => clipSegment(segment, windowStartMs, windowEndMs))
      .filter((segment): segment is TranscriptSegment => segment != null);
    const speechIntervals = clipIntervals(this.speech, windowStartMs, windowEndMs);
    const audioRuns = clipIntervals(this.audioRuns, windowStartMs, windowEndMs);
    return {
      id: randomUUID(),
      sessionId: this.sessionId,
      windowStartMs,
      windowEndMs,
      triggeredAtMs,
      frameworkRevision,
      segments,
      speechIntervals,
      silenceIntervals: clipIntervals(this.silence, windowStartMs, windowEndMs),
      gapIntervals: clipIntervals(this.gaps, windowStartMs, windowEndMs),
      audioCoverageMs: overlapMs(audioRuns, windowStartMs, windowEndMs),
      finalTextCoverageMs: coverageBetween(segments, speechIntervals),
    };
  }

  private toSegment(result: AsrResult, isFinal: boolean): TranscriptSegment {
    return {
      id: `${isFinal ? "final" : "partial"}:${result.providerResultId}`,
      sessionId: this.sessionId,
      sourceResultId: result.providerResultId,
      startMs: result.startMs,
      endMs: result.endMs,
      text: result.text,
      normalizedText: normalizeText(result.text),
      isFinal,
    };
  }
}

function clipIntervals(list: Interval[], startMs: number, endMs: number): Interval[] {
  return list
    .map((item) => ({
      startMs: Math.max(item.startMs, startMs),
      endMs: Math.min(item.endMs, endMs),
    }))
    .filter((item) => item.endMs > item.startMs);
}

function coverageBetween(segments: TranscriptSegment[], speech: Interval[]): number {
  return segments.reduce((total, segment) => total + overlapMs(speech, segment.startMs, segment.endMs), 0);
}

function clipSegment(segment: TranscriptSegment, windowStart: number, windowEnd: number): TranscriptSegment | null {
  if (segment.endMs <= windowStart || segment.startMs >= windowEnd) return null;
  const inside = segment.startMs >= windowStart && segment.endMs <= windowEnd;
  if (inside) return { ...segment, estimatedTiming: false };
  const startMs = Math.max(segment.startMs, windowStart);
  const endMs = Math.min(segment.endMs, windowEnd);
  const duration = Math.max(1, segment.endMs - segment.startMs);
  const chars = Array.from(segment.text);
  const from = Math.min(chars.length, Math.floor(((startMs - segment.startMs) / duration) * chars.length));
  const to = Math.min(chars.length, Math.ceil(((endMs - segment.startMs) / duration) * chars.length));
  const text = chars.slice(from, Math.max(from + 1, to)).join("");
  return {
    ...segment,
    startMs,
    endMs,
    text,
    normalizedText: normalizeText(text),
    estimatedTiming: true,
  };
}
