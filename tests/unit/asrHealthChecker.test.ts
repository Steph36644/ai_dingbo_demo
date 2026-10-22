import { describe, expect, it } from "vitest";
import { createAsrHealthChecker } from "../../src/main/ipc";
import type { AsrHealth } from "../../src/shared/contracts/asr";

describe("ASR 健康预检协调", () => {
  it("同一 ASR 的并发请求只创建一个适配器，并共享带标识的结果", async () => {
    let creates = 0;
    let stops = 0;
    let finish: (health: AsrHealth) => void = () => undefined;
    const checker = createAsrHealthChecker(
      () => {
        creates += 1;
        return {
          checkHealth: () => new Promise<AsrHealth>((resolve) => { finish = resolve; }),
          stop: async () => { stops += 1; },
        };
      },
      () => false,
      () => ({ checkId: "check-1", checkedAt: "2026-10-19T00:00:00.000Z" }),
    );

    const first = checker.check("funasr");
    const second = checker.check("funasr");
    expect(first).toBe(second);
    expect(creates).toBe(1);
    expect(checker.pendingCount("funasr")).toBe(1);
    finish({ ok: true, detail: "模型已加载" });
    await expect(first).resolves.toEqual({
      ok: true,
      detail: "模型已加载",
      checkId: "check-1",
      checkedAt: "2026-10-19T00:00:00.000Z",
    });
    expect(stops).toBe(1);
    expect(checker.pendingCount("funasr")).toBe(0);
  });

  it("活动会话中不创建适配器，检查异常也转换为失败并清理", async () => {
    let creates = 0;
    const busy = createAsrHealthChecker(() => {
      creates += 1;
      throw new Error("不应创建");
    }, () => true);
    await expect(busy.check("xfyun")).resolves.toMatchObject({ ok: false });
    expect(creates).toBe(0);

    let stops = 0;
    const failing = createAsrHealthChecker(() => ({
      checkHealth: async () => { throw new Error("云端不可用"); },
      stop: async () => { stops += 1; },
    }), () => false);
    await expect(failing.check("xfyun")).resolves.toMatchObject({ ok: false, detail: "云端不可用" });
    expect(stops).toBe(1);
  });

  it("超长诊断换成一句可处理的提示，不把整段 FunASR 堆栈送进界面", async () => {
    const detail =
      "加载 paraformer-zh-streaming 失败：model: paraformer-zh-streaming, model is not registered. " +
      "Registered model keys (51): " + "BAT, ".repeat(500) +
      "\nModuleNotFoundError: No module named 'torch'";
    const checker = createAsrHealthChecker(
      () => ({ checkHealth: async () => ({ ok: false, detail }), stop: async () => undefined }),
      () => false,
      () => ({ checkId: "check-2", checkedAt: "2026-10-19T00:00:00.000Z" }),
    );
    const health = await checker.check("funasr");
    expect(health.detail).toBe("本地识别模型加载失败：缺少 torch 依赖，请修复 FunASR 环境后重试。");
    expect((health.detail ?? "").length).toBeLessThan(50);
  });

  it("模型下载失败与端口占用也只显示一句短提示", async () => {
    const checker = createAsrHealthChecker(
      () => ({
        checkHealth: async () => ({
          ok: false,
          detail: "Download: iic/speech_paraformer-large failed!: ConnectionError: Max retries exceeded",
        }),
        stop: async () => undefined,
      }),
      () => false,
    );
    await expect(checker.check("funasr")).resolves.toMatchObject({
      detail: "本地识别模型下载失败，请检查网络后重试。",
    });

    const busyPort = createAsrHealthChecker(
      () => ({
        checkHealth: async () => ({ ok: false, detail: "OSError: [Errno 98] Address already in use" }),
        stop: async () => undefined,
      }),
      () => false,
    );
    await expect(busyPort.check("funasr")).resolves.toMatchObject({
      detail: "本地识别端口被占用，请关闭占用进程后重试。",
    });
  });
});
