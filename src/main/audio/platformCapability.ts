import type { DeviceListResult, WasapiProbe } from "@shared/contracts/audio";

export type PlatformAssessmentInput = {
  platform: NodeJS.Platform;
  screens: Array<{ id: string; name: string }>;
  wasapi: WasapiProbe;
  enumerateError?: string;
};

const MAC_GUIDANCE =
  "macOS 系统环回依赖 14.2+ 的系统音频录制权限，以及当前 Electron 进程能否创建 CoreAudio Tap。权限不足时音轨会直接结束，应用会报错，不会显示「盯播中」。不同系统版本表现不一致，首验平台是 Windows。";

const LINUX_GUIDANCE =
  "当前系统不是 Windows，M1 不把 Linux 的 PulseAudio/PipeWire monitor 当成可用环回。请改用「模拟音频」验证字幕，或在 Windows 上验收真实环回。模拟音频不会被记成环回成功。";

export function describeLoopback(input: PlatformAssessmentInput): DeviceListResult {
  const base = {
    platform: input.platform,
    wasapiBridge: input.wasapi,
  };

  if (input.platform === "win32") {
    if (input.enumerateError) {
      return {
        ...base,
        support: "unavailable",
        loopbackAvailable: false,
        loopbackAttemptAllowed: false,
        devices: [],
        captureStrategy: "none",
        guidance: `Windows 屏幕源枚举失败，无法建立桌面环回：${input.enumerateError}。${input.wasapi.reason}`,
      };
    }
    if (input.screens.length === 0) {
      return {
        ...base,
        support: "unavailable",
        loopbackAvailable: false,
        loopbackAttemptAllowed: false,
        devices: [],
        captureStrategy: "none",
        guidance: `没有枚举到屏幕源，无法锚定系统环回。${input.wasapi.reason}`,
      };
    }
    return {
      ...base,
      support: "available",
      loopbackAvailable: true,
      loopbackAttemptAllowed: true,
      captureStrategy: "electron-loopback",
      devices: input.screens.map((screen) => ({
        id: screen.id,
        label: `系统环回（屏幕源：${screen.name}）`,
        kind: "loopback" as const,
        loopbackCapable: true,
      })),
      guidance: `${input.wasapi.reason}真正进入盯播前必须收到音频回调；只有静音样本也算采到设备，但打不开流不算成功。`,
    };
  }

  if (input.platform === "darwin") {
    return {
      ...base,
      support: "conditional",
      loopbackAvailable: false,
      loopbackAttemptAllowed: true,
      captureStrategy: "electron-loopback",
      devices: [
        {
          id: "macos-system-audio",
          label: "系统音频环回（需系统音频录制权限）",
          kind: "loopback",
          loopbackCapable: false,
        },
      ],
      guidance: MAC_GUIDANCE,
    };
  }

  return {
    ...base,
    support: "unavailable",
    loopbackAvailable: false,
    loopbackAttemptAllowed: false,
    captureStrategy: "none",
    devices: [],
    guidance: LINUX_GUIDANCE,
  };
}
