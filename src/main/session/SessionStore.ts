/** 复盘写入在 session/replay.ts。这里只留停止前的提示文案。 */
export const PERSISTENCE_NOTE = "停止后写入应用数据目录的 session.jsonl。写失败会保留内存，并在界面上说明。";
export const PERSISTENCE_NOTE_FAILED = "复盘文件没有写成，本场数据仍留在内存里，关闭窗口后会丢失。";
