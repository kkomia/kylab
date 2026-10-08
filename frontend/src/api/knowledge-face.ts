/**
 * 知识库那一侧（远端）的契约类型。
 *
 * **为什么单独一份文件**：本地后端不再提供这些端点（服务端随知识库产品搬去了
 * kybase），所以类型也不在生成的 `schema.d.ts` 里了；而前端这几页仍然读远端，
 * 它们要把这几个形状声明在某个地方。内容是从那一侧的 OpenAPI 抄下来的，
 * **同步责任也跟着搬走了**——以前 `schema.d.ts` 是生成的，后端加一个文档阶段
 * 这里会自动多一个可选值，现在不会。
 *
 * 前端整体改走本机 `/local/*`（或跟着知识库产品一起搬）时，这份文件应当整体删掉。
 */

export type DataSourceKind = 'upload' | 'html' | 'rss' | 'webdav'

export type DocumentOut = {
  /** Id */
  id: string
  /** Knowledge Base Id */
  knowledge_base_id: string
  /** Name */
  name: string
  source_kind: DataSourceKind
  stage: DocumentStage
  /** Size Bytes */
  size_bytes: number
  /** Mime Type */
  mime_type?: string | null
  /** Page Count */
  page_count?: number | null
  /**
   * Is Split
   * @default false
   */
  is_split: boolean
  /** Error */
  error?: string | null
  /**
   * Chunk Count
   * @default 0
   */
  chunk_count: number
  /**
   * Uploaded By
   * @description 上传者的使用者 id（G6）。``None`` = 未记录，界面显示"未记录"而不是编一个名字。
   */
  uploaded_by?: string | null
  /**
   * Uploaded By Name
   * @description 解析后的名字。**由后端解析**：前端拿 id 还得再查一次名册，
   *     列表里就会有 N 次多余请求。
   * @default
   */
  uploaded_by_name: string
  /**
   * Folder Id
   * @description 所在目录（v13）。``None`` = 未归档（根目录）。
   */
  folder_id?: string | null
  /**
   * Disabled
   * @description 停用（v14）。停用后不参与检索（两条通道都过滤），其余一切保留。
   * @default false
   */
  disabled: boolean
  /**
   * Original Kind
   * @description 原件能不能在这页里渲染出来（``pdf`` / ``image`` / ``docx`` / ``pptx`` / ``excel``）。
   *
   *     界面据此决定首页要不要给「原文版式 / 解析文本」这个切换、以及**先取哪一个**——
   *     判在后端是为了不让前端去猜文件后缀（同 ``content_kind`` 的理由）。
   * @default binary
   */
  original_kind: string
  /** Created At */
  created_at?: string | null
  /** Updated At */
  updated_at?: string | null
  /**
   * Question Count
   * @description 该文档各分段已生成问题的**总条数**（v24）。0 = 还没出过题。
   * @default 0
   */
  question_count: number
  /**
   * Questioned Chunk Count
   * @description 有题的分段数。配合 ``chunk_count`` 显示"几段里有几段出了题"。
   * @default 0
   */
  questioned_chunk_count: number
  /**
   * Questions Pending
   * @description 是否还有出题任务在队列里/在跑（v24）。
   *
   *     列表据此显示"生成中…"，也据此决定继续轮询——出题**不改变文档阶段**，
   *     只看 ``stage`` 的话前端永远等不到它完成。
   * @default false
   */
  questions_pending: boolean
  /**
   * Summary
   * @description 入库时生成的文档摘要（v25）。**问答上下文靠它省 token**，
   *     界面也把它当一句话说明（抽屉里显示、列表行悬浮显示）。空串 = 还没生成。
   * @default
   */
  summary: string
  /**
   * @description 分段进度的摘要（§12.115）。列表行的进度条吃它；完整那棵树在
   *     ``GET /documents/{id}/timeline``。``None`` = 这条路径没算（老调用点）。
   */
  progress?: DocumentProgressOut | null
}

export type DocumentProgressOut = {
  /**
   * Status
   * @default running
   */
  status: string
  /**
   * Step Index
   * @default 1
   */
  step_index: number
  /**
   * Step Total
   * @default 0
   */
  step_total: number
  /**
   * Step Label
   * @default
   */
  step_label: string
  /**
   * Elapsed Ms
   * @default 0
   */
  elapsed_ms: number
  /**
   * Total Ms
   * @default 0
   */
  total_ms: number
  /**
   * Retries
   * @default 0
   */
  retries: number
  /**
   * Stalled
   * @default false
   */
  stalled: boolean
}

export type DocumentStage =
  | 'uploaded'
  | 'probing'
  | 'parsing'
  | 'parsed'
  | 'chunking'
  | 'chunked'
  | 'embedding'
  | 'indexed'
  | 'enriching'
  | 'enriched'
  | 'failed'
  | 'canceled'

export type KnowledgeBaseOut = {
  /** Id */
  id: string
  /** Name */
  name: string
  /**
   * Description
   * @description 库简介（v15）。空串 = 未填写，卡片上显示"暂无简介"。
   * @default
   */
  description: string
  /** Embedding Model Id */
  embedding_model_id: string
  /** Embedding Dim */
  embedding_dim: number
  /** Chunk Strategy */
  chunk_strategy: string
  /** Chunk Size */
  chunk_size: number
  /** Chunk Overlap */
  chunk_overlap: number
  /**
   * Suggested Enabled
   * @description 是否为每个分段生成推荐问题（v23）。界面据此回显。
   * @default false
   */
  suggested_enabled: boolean
  /**
   * Suggested Count
   * @default 3
   */
  suggested_count: number
  /**
   * Suggested Model Pk
   * @description 出题模型。``None`` = 跟随对话页当前选的模型。
   */
  suggested_model_pk?: string | null
  /**
   * Suggested Prompt
   * @description 自定义出题提示词；空串 = 用内置提示词。
   * @default
   */
  suggested_prompt: string
  /**
   * System Prompt
   * @description 库级提示词；空串 = 只用内置提示词。界面在库设置里回显与编辑。
   * @default
   */
  system_prompt: string
  /**
   * Wiki Enabled
   * @description 库形态（v24）：``False`` = 仅向量检索；``True`` = 向量检索 + Wiki 页面。
   *
   *     界面据此决定要不要给「Wiki」入口、以及在设置里回显勾选态。
   * @default false
   */
  wiki_enabled: boolean
  /** Created At */
  created_at?: string | null
  /**
   * Can Manage
   * @description 当前调用主体能否管理这个库的分享（owner / 管理员）。
   *
   *     **由后端算而不是前端推**：判定规则在 `services/share.py`（"看得见"与"管得动"
   *     是两次判定），前端再实现一遍必然与它漂。界面据此决定要不要显示「分享」入口。
   * @default false
   */
  can_manage: boolean
  /**
   * Can Write
   * @description 能否写入这个库（上传/删除）。只读分享的成员看得见但写不动，界面据此收起写入口。
   * @default false
   */
  can_write: boolean
  /**
   * Document Count
   * @description 库内文档数。**由列表接口一并算出**（一条 GROUP BY），
   *     前端不必再"逐库拉一次文档列表只为了数数"——那会随库数量线性放大请求数。
   * @default 0
   */
  document_count: number
  /**
   * Last Activity
   * @description 库内文档的最近更新时间；没有文档时为 None（界面显示占位符，而不是一个含糊的 0）。
   */
  last_activity?: string | null
}

export type StorageOverviewOut = {
  /** File Bytes */
  file_bytes: number
  /** Data Bytes */
  data_bytes: number
  /** Free Bytes */
  free_bytes: number
  /**
   * Partitions
   * @description 向量分区数。每个分区写入第一个向量就占一个 4MB 块，所以它值得单独看。
   */
  partitions: number
  /**
   * Orphans
   * @description 无主的向量分区（知识库已删、表还留在库里）。「整理存储」会丢掉它们。
   */
  orphans?: string[]
}
