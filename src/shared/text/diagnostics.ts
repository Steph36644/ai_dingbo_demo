/**
 * 把任意诊断文本压成适合界面展示的一句短话。
 * 识别服务失败时常带上千字符的依赖/注册堆栈，完整文本由调用方写日志，
 * 界面只留一句能看懂、能照着处理的提示。
 */
const CORE_MODULES = [
  "torch",
  "torchaudio",
  "numpy",
  "typing_extensions",
  "modelscope",
  "omegaconf",
  "yaml",
  "scipy",
  "librosa",
  "soundfile",
];

const NO_MODULE = /No module named ['"]([\w.]+)['"]/gi;

function missingCoreModules(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(NO_MODULE)) {
    const root = (match[1] ?? "").split(".")[0];
    if (CORE_MODULES.includes(root)) found.add(root);
  }
  return [...found];
}

function firstMissingPlainModule(text: string): string | null {
  for (const match of text.matchAll(NO_MODULE)) {
    const name = match[1] ?? "";
    const root = name.split(".")[0];
    if (!root || root === "funasr") continue;
    return root;
  }
  return null;
}

function conciseFailure(text: string): string | null {
  if (/model(?:\s+'[^']+')?\s+is not registered/i.test(text)) {
    const missing = missingCoreModules(text);
    if (missing.length > 0) {
      const deps = missing.length === 1 ? `${missing[0]} 依赖` : `${missing.slice(0, 2).join("、")} 等依赖`;
      return `本地识别模型加载失败：缺少 ${deps}，请修复 FunASR 环境后重试。`;
    }
    return "本地识别模型加载失败，请检查 FunASR 环境或模型下载后重试。";
  }
  if (/download[^\n]*failed|下载[^\n]*失败/i.test(text)) {
    return "本地识别模型下载失败，请检查网络后重试。";
  }
  const missingModule = firstMissingPlainModule(text);
  if (missingModule) {
    return `缺少 Python 依赖 ${missingModule}，请安装后重试。`;
  }
  if (/EADDRINUSE|Address already in use|端口[^\n]*占用/i.test(text)) {
    return "本地识别端口被占用，请关闭占用进程后重试。";
  }
  if (/10105|10110|讯飞[^\n]*鉴权|xfyun[^\n]*(auth|invalid)|unauthori[sz]ed/i.test(text)) {
    return "讯飞识别鉴权失败，请检查 APPID/APIKey 与 IP 白名单。";
  }
  if (/\b40[13]\b[^\n]*(token|key|auth)|token[^\n]*(mismatch|invalid)/i.test(text)) {
    return "识别服务鉴权失败，请重启应用后重试。";
  }
  if (/timed? ?out|timeout|响应超时|连接超时/i.test(text)) {
    return "识别服务响应超时，请重试。";
  }
  if (/ECONNREFUSED|connection refused|连接被拒绝|尚未就绪|not ready/i.test(text)) {
    return "本地识别服务未就绪，请稍后重试。";
  }
  return null;
}

export function summarizeDiagnostic(text: string, maxLength = 200): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const concise = conciseFailure(normalized);
  if (concise) return concise;
  const firstLine = normalized.split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  const head = collapsed.slice(0, maxLength);
  const boundary = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf(". "),
  );
  if (boundary >= 12) return `${head.slice(0, boundary + 1).trimEnd()}…`;
  return `${head.trimEnd()}…`;
}
