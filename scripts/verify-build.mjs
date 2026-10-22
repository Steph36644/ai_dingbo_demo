import { existsSync } from "node:fs";

const required = ["out/main/index.js", "out/preload/index.js", "out/renderer/index.html"];
const missing = required.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`缺少构建产物：${missing.join(", ")}`);
  process.exit(1);
}

console.log("electron-vite 构建产物齐全（main / preload / renderer）。");
console.log("本环境不制作可分发安装包：未接入 electron-builder，也不在这里打 Windows NSIS 或 macOS dmg。");
