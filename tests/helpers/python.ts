import { spawnSync } from "node:child_process";
import path from "node:path";

let cached: { command: string; prefix: string[] } | null = null;

/** Windows 的 python3 可能只是 Store 占位符；选择真正可执行的解释器。 */
export function pythonCommand(): { command: string; prefix: string[] } {
  if (cached) return cached;
  const candidates = process.platform === "win32"
    ? [
        { command: "python", prefix: [] },
        { command: "py", prefix: ["-3"] },
        { command: "python3", prefix: [] },
      ]
    : [
        { command: "python3", prefix: [] },
        { command: "python", prefix: [] },
      ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "-X", "utf8", "-c", "import sys; print(sys.version_info[0])"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: pythonEnv(),
    });
    if (probe.status !== 0 || probe.stdout.trim() !== "3") continue;
    const bridgeProbe = spawnSync(candidate.command, [...candidate.prefix, "-X", "utf8", "-c", "import bridge"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: pythonEnv(),
    });
    if (bridgeProbe.status === 0) {
      cached = candidate;
      return candidate;
    }
  }
  throw new Error(`没有找到可用的 Python 3。请安装 Python 3 并加入 PATH（当前目录：${path.resolve(".")}）。`);
}

export function pythonArgs(args: string[]): { command: string; args: string[] } {
  const python = pythonCommand();
  return { command: python.command, args: [...python.prefix, "-X", "utf8", ...args] };
}

export function pythonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pythonPath = path.resolve("python/funasr_sidecar");
  return {
    ...env,
    PYTHONUTF8: "1",
    PYTHONPATH: env.PYTHONPATH ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}` : pythonPath,
  };
}
