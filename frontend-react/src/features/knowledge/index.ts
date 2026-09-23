/**
 * 知识库域（C 域）的对外出口。
 *
 * 主控接线时按这份清单挂路由（`src/app/**` 归主控，本域不改它）：
 *
 * ```tsx
 * <Route path="/knowledge-bases" element={<KnowledgeBasesView />} />
 * <Route path="/kb/:kbId" element={<KnowledgeBaseView />} />
 * <Route path="/kb/:kbId/wiki" element={<WikiView />} />
 * <Route path="/documents/:documentId" element={<DocumentView />} />
 * ```
 *
 * 三个页面都**可选地**接受 id prop：不传就从路由参数取（`useParams`），
 * 所以在 Router 里直接挂即可；测试里也可以直接传 prop。
 *
 * 依赖（见最终报告的"需要主控做的事"）：
 * - Toast 容器（sonner 的 `<Toaster/>`）由应用壳挂载，本域只调 `toast.*`；
 * - 文档预览已走 `@/features/preview` 的 `<FilePreview/>`（已就绪）；
 * - `src/ui/**` 的原语落地后，替换掉 `primitives.tsx`（那是本域的临时实现）。
 */
export { KnowledgeBasesView } from './KnowledgeBasesView'
export { KnowledgeBaseView } from './KnowledgeBaseView'
export { WikiView } from './WikiView'
export { DocumentView } from './DocumentView'
export { DocumentDrawer } from './DocumentDrawer'
export { ProcessingTimeline } from './ProcessingTimeline'
export { ShareDialog } from './ShareDialog'
export { UploadDialog } from './UploadDialog'
export { SourcePanel } from './SourcePanel'
export { KbSearchPanel } from './KbSearchPanel'
export { KnowledgeBaseSettings } from './KnowledgeBaseSettings'
export { SuggestedQuestionsFields, type SuggestedQuestionsValue } from './SuggestedQuestionsFields'
export { RangeField, type RangeMark } from './RangeField'
export {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  InfoTip,
  Input,
  MenuItem,
  MeterBar,
  Modal,
  RowMenu,
  Select,
  Skeleton,
  StatusTag,
  Textarea,
  type MeterSegment,
  type MeterTone,
  type SelectOption,
  type StatusTone,
} from './primitives'
export { Markdown, decorate, type Citation } from './markdown'
export { documentStageView, FILTER_STAGE_KEYS, type StatusView } from './status'
export { chunkingErrorOf, numberOr, parseIntOrNull } from './chunking'
export {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_MB,
  UPLOAD_FORMAT_HINT,
} from './uploadLimits'
export {
  messageOf,
  notify,
  resetKnowledgeBaseCache,
  resetRegistryCache,
  useKnowledgeBases,
  useModelRegistry,
  usePolling,
  type KnowledgeBaseStore,
  type RegistryStore,
} from './store'
