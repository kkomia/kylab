/**
 * 「为每个分段生成推荐问题」的四个设置项（v23；旧 `SuggestedQuestionsFields.vue` 同一份）。
 *
 * 建库弹窗与知识库设置**共用同一份控件**：同一组设置出现两套控件，迟早会出现
 * "建库时能关、设置里关不掉"这种说不清的差别。四个值都由调用方持有
 * （建库时是提交用的草稿，设置里是脏检查用的草稿）。
 *
 * 它跟的是**分段**，不是"空状态的展示"：入库时为每一段让模型出几个问题，
 * 问题并进该段的检索文本，于是用户换个问法也能命中同一段。
 */
import { useEffect } from 'react'

import {
  SUGGESTED_COUNT_DEFAULT,
  SUGGESTED_COUNT_MAX,
  SUGGESTED_COUNT_MIN,
  SUGGESTED_PROMPT_MAX_CHARS,
} from '@/api/knowledgeBases'
import { InfoTip } from '@/features/knowledge/composites'
import { RangeField } from '@/features/knowledge/RangeField'
import { useModelRegistry } from '@/features/knowledge/store'
import { Checkbox } from '@/ui/checkbox'
import { Label } from '@/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Textarea } from '@/ui/textarea'

export interface SuggestedQuestionsValue {
  enabled: boolean
  count: number
  modelPk: string
  prompt: string
}

interface SuggestedQuestionsFieldsProps {
  value: SuggestedQuestionsValue
  onChange: (patch: Partial<SuggestedQuestionsValue>) => void
}

/**
 * 出题时的合并批大小（**与后端 `_CHUNKS_PER_CALL` 一致**）。
 * 只用于把这句代价说明写准确——真正合并发生在后端。
 */
const CHUNKS_PER_CALL_HINT = 8

/** 轨道上的常用值：1 条太薄、2 条兜底、3 条是默认、5 条是上限。 */
const COUNT_MARKS = [
  { value: 2 },
  { value: SUGGESTED_COUNT_DEFAULT, primary: true },
  { value: SUGGESTED_COUNT_MAX },
]

/**
 * 「跟随对话模型」那一项的取值。
 *
 * Radix 的 `<Select.Item>` **不接受空串**（空串被它留作"没有选择"），而这里的值域里
 * `''` 正是"跟随对话模型"。所以界面上用一个哨兵值，进出都换回 `''`——
 * 对外的契约（`SuggestedQuestionsValue.modelPk`）一点没变。
 */
const FOLLOW_CHAT_MODEL = '__follow__'

export function SuggestedQuestionsFields({ value, onChange }: SuggestedQuestionsFieldsProps) {
  const registry = useModelRegistry()

  useEffect(() => {
    // 注册表是缓存 + 后台刷新：拿不到就只显示"跟随对话模型"那一项，
    // 不把"没加载出来"演成一个错误
    void registry.prefetch()
    // 只在挂载时预取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modelOptions = [
    { value: FOLLOW_CHAT_MODEL, label: '跟随对话模型' },
    ...registry.chatModels.map((model) => ({
      value: model.id,
      label: model.label || model.model_id,
    })),
  ]

  return (
    <div className="kb-suggested">
      <div>
        <Label className="kb-switch">
          <Checkbox
            checked={value.enabled}
            aria-label="为每个切块生成推荐问题"
            onCheckedChange={(checked) => onChange({ enabled: checked === true })}
          />
          <span>为每个切块生成推荐问题</span>
        </Label>
        <p className="text-hint">
          入库时为每一段让模型出几个问题，问题会一起进检索索引；只影响<strong>以后上传</strong>
          的文档，已入库的可以在文档列表里选中后点「生成问题」补上。关掉则对话页空状态
          改用内置的静态示例问题。
        </p>
      </div>

      <div className="field">
        <span className="field-label">每个切块生成几条</span>
        <RangeField
          value={value.count}
          onChange={(count) => onChange({ count })}
          min={SUGGESTED_COUNT_MIN}
          max={SUGGESTED_COUNT_MAX}
          marks={COUNT_MARKS}
          ariaLabel="每个切块生成几条问题"
        />
        <p className="text-hint">
          每 {CHUNKS_PER_CALL_HINT} 段合并成一次模型调用；只对之后上传或重新摄入的文档生效。
        </p>
      </div>

      <div className="field">
        <span className="field-label">
          出题用的模型
          <InfoTip text="默认跟随对话页当前选的模型。换一个便宜的小模型可以省 token：出题只需判断这段在讲什么。" />
        </span>
        <Select
          value={value.modelPk || FOLLOW_CHAT_MODEL}
          onValueChange={(modelPk) =>
            onChange({ modelPk: modelPk === FOLLOW_CHAT_MODEL ? '' : modelPk })
          }
        >
          <SelectTrigger aria-label="出题用的模型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="field">
        <span className="field-label">
          自定义出题提示词 <span className="field-optional">可选</span>
        </span>
        <Textarea
          value={value.prompt}
          rows={4}
          maxLength={SUGGESTED_PROMPT_MAX_CHARS}
          placeholder="留空使用内置提示词"
          aria-label="自定义出题提示词"
          onChange={(event) => onChange({ prompt: event.target.value })}
        />
        <p className="text-hint">
          留空即用内置提示词。自定义时它会替换内置那句指令，资料片段照旧附在前面；用
          <code>{'{n}'}</code> 表示条数，并请要求模型<strong>每行输出一个问题</strong>。
        </p>
      </div>
    </div>
  )
}
