模型权重不进仓库。F1 把 `paraformer-zh-streaming` 放到用户目录的 `~/.cache/modelscope`（或仓库外的 `FUNASR_CACHE_DIR`）。仓库内的 `.cache/`、`modelscope_cache/` 已在 `.gitignore` 里，sidecar 也会拒绝把缓存写进仓库。
