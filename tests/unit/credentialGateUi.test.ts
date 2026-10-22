import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AsrHealth, AsrId } from "../../src/shared/contracts/asr";
import type { SettingsSnapshot } from "../../src/shared/contracts/ipc";
import type { TranscriptSegment } from "../../src/shared/contracts/transcript";
import { XFYUN_CREDENTIALS_MISSING, startControlState } from "../../src/shared/session/credentialGate";
import { CaptionMonitor } from "../../src/renderer/features/monitor/CaptionMonitor";
import { AsrSection, WatchControlSection } from "../../src/renderer/features/sources/SourcesDock";
import { SettingsView } from "../../src/renderer/features/settings/SettingsView";

beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  });
});

const framework = {
  ok: true as const,
  revision: "abc123456789",
  sourcePath: null,
  document: {
    title: "示例框架",
    pace: { min: 180, max: 280, unit: "chars_per_minute" as const },
    must_say: [],
    avoid: [],
  },
};

function monitor(
  asrId: AsrId,
  xfyunConfigured: boolean | null,
  finals: TranscriptSegment[] = [],
  asrHealth: AsrHealth | null = { ok: true },
): string {
  const gate = startControlState({
    asrId,
    frameworkOk: true,
    busy: false,
    stopping: false,
    xfyunConfigured,
    asrHealth,
  });
  const asrProps: ComponentProps<typeof AsrSection> = {
    asrId,
    demoScript: "standard",
    source: "simulated",
    locked: false,
    asrHealth,
    healthChecking: false,
    onAsr: () => undefined,
    onDemoScript: () => undefined,
    onCheckHealth: () => undefined,
  };
  const controlProps: ComponentProps<typeof WatchControlSection> = {
    session: null,
    rms: 0,
    busy: false,
    startBlockReason: gate.reason,
    startDisabled: gate.disabled,
    onStart: () => undefined,
    onStop: () => undefined,
  };
  const captionsProps: ComponentProps<typeof CaptionMonitor> = {
    session: null,
    finals,
    partial: null,
    presentation: null,
    clockMs: 0,
    localError: null,
    framework,
    startBlockReason: gate.reason,
  };
  return renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(AsrSection, asrProps),
      createElement(WatchControlSection, controlProps),
      createElement(CaptionMonitor, captionsProps),
    ),
  );
}

function startButton(html: string): string {
  const match = html.match(/<button class="[^"]*\bstart\b[^"]*"[^>]*>[\s\S]*?<\/button>/);
  expect(match, html).not.toBeNull();
  return match?.[0] ?? "";
}

const settings: SettingsSnapshot = {
  windowMs: 300_000,
  intervalMs: 60_000,
  windowMsRange: [60_000, 900_000],
  intervalMsRange: [15_000, 300_000],
  windowEditable: true,
  intervalEditable: true,
  persisted: false,
  note: "测试设置",
  streamAudible: false,
  asrOptions: [],
  reconnect: { backoffMs: [1000], maxAttempts: 5, autoReconnect: true },
};

describe("凭据门禁界面", () => {
  it("选讯飞且未配凭据时，准备区禁用开始并写明原因", () => {
    const html = monitor("xfyun", false);
    expect(html).toContain(XFYUN_CREDENTIALS_MISSING);
    expect(html).toContain('id="start-block-reason"');
    expect(startButton(html)).toContain("disabled");
    expect(startButton(html)).toContain("开始盯播");
  });

  it("讯飞凭据已配置时可以开始，FunASR 不看讯飞凭据", () => {
    const ready = monitor("xfyun", true);
    expect(ready).not.toContain(XFYUN_CREDENTIALS_MISSING);
    expect(startButton(ready)).not.toContain("disabled");

    const local = monitor("funasr", false);
    expect(local).not.toContain(XFYUN_CREDENTIALS_MISSING);
    expect(startButton(local)).not.toContain("disabled");
    expect(startButton(local)).toContain("开始盯播");
  });

  it("预检失败时准备区展示原因并禁用开始", () => {
    const html = monitor("funasr", null, [], { ok: false, detail: "模型加载失败，请检查 Python 环境。" });
    expect(html).toContain("模型加载失败，请检查 Python 环境。");
    expect(html).toContain("开始前预检");
    expect(startButton(html)).toContain("disabled");
  });

  it("设置页只保留讯飞凭据输入，通用云密钥没有填写框", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        settings,
        xfyunSecret: {
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "还没有配置讯飞 APPID 和 APIKey。",
        },
        locked: false,
        onSave: async () => ({ ok: true, message: "ok", settings }),
        onStreamAudible: async () => ({ ok: true, message: "ok", settings }),
        onClearDeprecatedCloudKey: async () => ({
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: false,
          devFallback: false,
          message: "已清除",
        }),
        onSetXfyunCredentials: async () => ({
          configured: true,
          source: "os" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "已保存",
        }),
        onClearXfyunCredentials: async () => ({
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "已清除",
        }),
      }),
    );
    expect(html).toContain("讯飞 RTASR 凭据");
    expect(html).toContain("讯飞 APPID");
    expect(html).toContain("讯飞 APIKey");
    expect(html).toContain('type="password"');
    expect(html).toContain("通用云 ASR 密钥（已废弃）");
    expect(html).not.toContain("cloud-asr-key");
    expect(html).not.toContain("云 ASR 密钥\"");
    expect(html).not.toContain("DINGBO_CLOUD_ASR_KEY");
    expect(html).not.toContain("sk-");
    expect(html).toContain("直播流外放");
    expect(html).toContain("默认关闭");
    const audible = html.match(/<input[^>]*aria-label="直播流外放"[^>]*>/)?.[0] ?? "";
    expect(audible).toContain('type="checkbox"');
    expect(audible).not.toContain("checked");
    expect(audible).not.toContain("disabled");
  });

  it("盯播进行中仍可开关直播流外放", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        settings: { ...settings, streamAudible: true },
        xfyunSecret: {
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "还没有配置讯飞 APPID 和 APIKey。",
        },
        locked: true,
        onSave: async () => ({ ok: true, message: "ok", settings }),
        onStreamAudible: async () => ({ ok: true, message: "ok", settings }),
        onClearDeprecatedCloudKey: async () => ({
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: false,
          devFallback: false,
          message: "已清除",
        }),
        onSetXfyunCredentials: async () => ({
          configured: true,
          source: "os" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "已保存",
        }),
        onClearXfyunCredentials: async () => ({
          configured: false,
          source: "none" as const,
          backend: "os" as const,
          editable: true,
          devFallback: false,
          message: "已清除",
        }),
      }),
    );
    expect(html).toContain("盯播中不可改");
    const audible = html.match(/<input[^>]*aria-label="直播流外放"[^>]*>/)?.[0] ?? "";
    expect(audible).toContain("checked");
    expect(audible).not.toContain("disabled");
  });
});

function captionSegment(id: string, text: string, startMs: number, endMs: number): TranscriptSegment {
  return {
    id,
    sessionId: "s",
    sourceResultId: id,
    startMs,
    endMs,
    text,
    normalizedText: text,
    isFinal: true,
  };
}

describe("实时字幕成句", () => {
  it("连续短 final 渲染成一行生长句，而不是多条气泡", () => {
    const html = monitor("funasr", null, [
      captionSegment("final:a", "今天天气", 0, 600),
      captionSegment("final:b", "不错", 600, 1_200),
    ]);
    expect(html.match(/transcript-entry/g)).toHaveLength(1);
    expect(html).toContain("今天天气不错");
    expect(html).toContain("transcript-entry current partial");
    expect(html).not.toContain("transcript-entry history");
  });

  it("句号收束后，历史句和正在说的下一句分成两行", () => {
    const html = monitor("funasr", null, [
      captionSegment("final:a", "今天天气", 0, 600),
      captionSegment("final:b", "不错。", 600, 1_200),
      captionSegment("final:c", "我们继续", 1_200, 1_800),
    ]);
    expect(html.match(/transcript-entry/g)).toHaveLength(2);
    expect(html).toContain("今天天气不错。");
    expect(html).toContain("我们继续");
    expect(html).toContain("transcript-entry history");
    expect(html).toContain("transcript-entry current partial");
  });
});
