<script setup lang="ts">
/**
 * 能力页（v0.15，设计见 `docs/Agent-工作区与能力层设计-v0.1.md` §6）。
 *
 * 一页两栏，答的是同一个问题的两半——**这个 Agent 会什么**：
 *
 * - **技能**：写在磁盘上的 `SKILL.md`（流程）。目录进系统提示词、正文按需展开，
 *   所以这里要能看正文——用户有权知道"它到底教了模型什么"。
 * - **MCP 服务**：外部工具（能力）。这里能登记、探活、看它有哪些工具、配策略闸。
 *
 * 三处刻意的设计：
 *
 * 1. **被拦下的技能显示原因**（`flagged`）。静默藏掉会让人以为技能没装上；
 * 2. **凭据只显示"配过哪几个 key"**，不回显值。所以编辑时**不回填**凭据——
 *    回填就会把一把掩码串写回去，把真 key 覆盖掉；
 * 3. **策略默认「需要确认」**。外部工具会以用户的名义执行动作，默认静默执行
 *    是这一层最不该有的默认。
 */
import { computed, onMounted, ref } from 'vue'

import type { MCPServer, MCPPolicy, Skill, SkillDetail } from '@/api/capabilities'
import {
  createMCPServer,
  deleteMCPServer,
  getSkill,
  listMCPServers,
  listSkills,
  probeMCPServer,
  updateMCPServer,
} from '@/api/capabilities'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconServer from '@/components/icons/IconServer.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'

const { notifyError, notifySuccess } = useToast()

/**
 * 当前看的是哪一页（v0.19）。
 *
 * 用户指定：技能与 MCP 服务**做成两个菜单**，而不是并排两栏。
 * 并排的代价是两栏各只剩一半宽——技能描述是整句文本，折行折得很碎；
 * MCP 那边每条又带着策略与工具清单。而且这两件事本来就不需要同时看。
 */
const tab = ref<'skills' | 'mcp'>('skills')

const CAP_TABS = [
  { key: 'skills' as const, label: '技能' },
  { key: 'mcp' as const, label: 'MCP 服务' },
]

const skills = ref<Skill[]>([])
const skillsLoading = ref(true)
const skillDetail = ref<SkillDetail | null>(null)
const detailLoading = ref(false)
/** 技能正文弹窗的开合。用可写计算属性接 `v-model:open`——关掉时顺手清掉正文，
    下次打开不会先闪一眼上一个技能的正文。 */
const skillOpen = computed({
  get: () => skillDetail.value !== null || detailLoading.value,
  set: (value: boolean) => {
    if (!value) skillDetail.value = null
  },
})

const servers = ref<MCPServer[]>([])
const serversLoading = ref(true)
const probing = ref('')
const expandedTools = ref('')

const formOpen = ref(false)
const formSaving = ref(false)
const editing = ref<MCPServer | null>(null)
const form = ref({
  name: '',
  transport: 'stdio' as 'stdio' | 'http',
  target: '',
  args: '',
  envKeys: '',
  headers: '',
  policy: 'ask' as MCPPolicy,
})

const confirmTarget = ref<MCPServer | null>(null)
/** 确认框的开合。可写计算属性：`v-model` 需要一个能赋值的左值（`!!x` 不是）。 */
const confirmOpen = computed({
  get: () => confirmTarget.value !== null,
  set: (value: boolean) => {
    if (!value) confirmTarget.value = null
  },
})

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio（起一个本地进程）' },
  { value: 'http', label: 'http（连远端服务）' },
]
const POLICY_OPTIONS = [
  { value: 'ask', label: '需要确认（推荐）' },
  { value: 'allow', label: '允许直接调用' },
  { value: 'deny', label: '拒绝调用' },
]

const usableSkills = computed(() => skills.value.filter((item) => item.used_by_prompt).length)

onMounted(() => {
  void loadSkills()
  void loadServers()
})

async function loadSkills(): Promise<void> {
  skillsLoading.value = true
  try {
    const result = await listSkills()
    skills.value = result.items
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '技能列表读取失败')
  } finally {
    skillsLoading.value = false
  }
}

async function openSkill(skill: Skill): Promise<void> {
  detailLoading.value = true
  skillDetail.value = null
  try {
    skillDetail.value = await getSkill(skill.name)
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '技能读取失败')
  } finally {
    detailLoading.value = false
  }
}

async function loadServers(): Promise<void> {
  serversLoading.value = true
  try {
    const result = await listMCPServers()
    servers.value = result.items
  } catch (error) {
    notifyError(error instanceof Error ? error.message : 'MCP 服务列表读取失败')
  } finally {
    serversLoading.value = false
  }
}

function startCreate(): void {
  editing.value = null
  form.value = {
    name: '',
    transport: 'stdio',
    target: '',
    args: '',
    envKeys: '',
    headers: '',
    policy: 'ask',
  }
  formOpen.value = true
}

function startEdit(server: MCPServer): void {
  editing.value = server
  // **凭据不回填**：接口只回键名，回填会把掩码串写成真值（见文件头第 2 条）。
  // 这里把"已配过哪些 key"显示成占位提示，用户不动它就不改。
  form.value = {
    name: server.name,
    transport: server.transport,
    target: server.target,
    args: server.args.join(' '),
    envKeys: '',
    headers: '',
    policy: server.policy,
  }
  formOpen.value = true
}

function parseKeyValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const at = text.indexOf('=')
    if (at <= 0) continue
    out[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return out
}

async function saveServer(): Promise<void> {
  if (formSaving.value) return
  formSaving.value = true
  const env = parseKeyValues(form.value.envKeys)
  const headers = parseKeyValues(form.value.headers)
  try {
    if (editing.value) {
      await updateMCPServer(editing.value.id, {
        name: form.value.name,
        target: form.value.target,
        policy: form.value.policy,
        args: form.value.args.split(/\s+/).filter(Boolean),
        // 只有用户真填了凭据才提交——空字符串会让后端把已配的 key 清掉
        ...(Object.keys(env).length ? { env } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      })
      notifySuccess('已保存')
    } else {
      await createMCPServer({
        name: form.value.name,
        transport: form.value.transport,
        target: form.value.target,
        args: form.value.args.split(/\s+/).filter(Boolean),
        env,
        headers,
        policy: form.value.policy,
      })
      notifySuccess('已登记')
    }
    formOpen.value = false
    await loadServers()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '保存失败')
  } finally {
    formSaving.value = false
  }
}

async function probe(server: MCPServer): Promise<void> {
  probing.value = server.id
  try {
    const result = await probeMCPServer(server.id)
    const index = servers.value.findIndex((item) => item.id === server.id)
    if (index >= 0) servers.value[index] = result
    // 连不上不是错误，是这一次探活的结果：把后端那句话原样显示出来，
    // 它区分了"命令不存在 / 握手被拒 / 超时"，而那正是用户想知道的
    if (result.reachable) notifySuccess(result.detail || '连接正常')
    else notifyError(result.detail || '连不上')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '探活失败')
  } finally {
    probing.value = ''
  }
}

async function removeServer(): Promise<void> {
  const target = confirmTarget.value
  confirmTarget.value = null
  if (!target) return
  try {
    await deleteMCPServer(target.id)
    await loadServers()
    notifySuccess('已删除')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '删除失败')
  }
}

function policyTone(policy: MCPPolicy): 'success' | 'warning' | 'danger' {
  if (policy === 'allow') return 'success'
  if (policy === 'deny') return 'danger'
  return 'warning'
}

function policyLabel(policy: MCPPolicy): string {
  return { allow: '允许', ask: '需确认', deny: '拒绝' }[policy]
}
</script>

<template>
  <PageShell
    title="能力"
    description="技能是「这类事该怎么做」的流程（磁盘上的 SKILL.md），MCP 是「能用哪些工具」（外部服务）。两者一起决定这个 Agent 会什么。"
  >
    <template #actions>
      <StatusTag
        :label="`技能 ${usableSkills}/${skills.length} 可用`"
        :tone="skills.length && !usableSkills ? 'warning' : 'neutral'"
      />
      <StatusTag :label="`MCP ${servers.length} 个服务`" tone="neutral" />
    </template>

    <!-- 两个入口（用户指定，照 Kimi 的能力页）：上面开两个标签，一次只看一页 -->
    <div class="cap-tabs" role="tablist" aria-label="能力">
      <button
        v-for="item in CAP_TABS"
        :key="item.key"
        type="button"
        role="tab"
        class="cap-tab"
        :class="{ 'cap-tab-active': tab === item.key }"
        :aria-selected="tab === item.key"
        @click="tab = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="cap-layout">
      <!-- ------------------------------------------------------------ 技能 -->
      <section v-if="tab === 'skills'" class="cap-col" role="tabpanel" aria-label="技能">
        <header class="col-head">
          <h2>技能</h2>
          <InfoTip
            text="技能只有「名字 + 什么时候用」会进系统提示词，正文在模型决定用它时才读进来。所以装得多不等于上下文变长。"
          />
          <AppButton size="sm" @click="loadSkills">
            <template #icon><IconRefresh :size="14" /></template>
            重新扫描
          </AppButton>
        </header>

        <SkeletonBlock v-if="skillsLoading" variant="list" :rows="3" />
        <EmptyState
          v-else-if="!skills.length"
          title="还没有技能"
          hint="把带 SKILL.md 的目录放进仓库的 skills/ 或数据目录的 skills/，这里就会列出来。"
        />
        <ul v-else class="skill-list">
          <li v-for="skill in skills" :key="skill.name" class="skill">
            <button type="button" class="skill-main" @click="openSkill(skill)">
              <span class="skill-name">
                <IconRobot :size="14" />
                {{ skill.name }}
              </span>
              <span class="skill-desc">{{ skill.description || '（没有描述）' }}</span>
            </button>
            <div class="skill-meta">
              <span class="chip">{{ skill.source === 'builtin' ? '随代码发布' : '用户放入' }}</span>
              <span v-if="!skill.used_by_prompt" class="chip chip-warn">
                <IconAlert :size="12" />
                未进提示词
              </span>
            </div>
            <!-- 被拦下的技能**要显示理由**：静默藏掉会让人以为技能没装上 -->
            <ul v-if="skill.flagged.length" class="flags">
              <li v-for="(reason, at) in skill.flagged" :key="at">{{ reason }}</li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- --------------------------------------------------------- MCP 服务 -->
      <section v-else class="cap-col" role="tabpanel" aria-label="MCP 服务">
        <header class="col-head">
          <h2>MCP 服务</h2>
          <InfoTip
            text="外部服务会以你的名义执行动作，所以每条都有一个准入策略。默认「需要确认」：调用前会先弹一次确认，确认后才真的发出去。"
          />
          <AppButton size="sm" @click="startCreate">
            <template #icon><IconPlus :size="14" /></template>
            登记服务
          </AppButton>
        </header>

        <SkeletonBlock v-if="serversLoading" variant="list" :rows="3" />
        <EmptyState
          v-else-if="!servers.length"
          title="还没有登记 MCP 服务"
          hint="登记之后，它的工具会被 Agent 当成能力使用（工具名一律带 mcp__ 前缀，避免与内置工具撞名）。"
        >
          <AppButton variant="primary" @click="startCreate">登记一个</AppButton>
        </EmptyState>
        <ul v-else class="server-list">
          <li v-for="server in servers" :key="server.id" class="server">
            <div class="server-head">
              <span class="server-name">
                <IconServer :size="14" />
                {{ server.name }}
              </span>
              <StatusTag :label="policyLabel(server.policy)" :tone="policyTone(server.policy)" />
              <StatusTag v-if="server.reachable === true" label="连接正常" tone="success" />
              <StatusTag v-else-if="server.reachable === false" label="连不上" tone="warning" />
              <span v-if="server.has_secrets" class="chip" title="凭据已配置（值不会回显）">
                <IconCheck :size="12" />
                凭据已配置
              </span>
            </div>

            <p class="server-target">
              <span class="chip">{{ server.transport }}</span>
              <code>{{ server.target }}</code>
              <code v-if="server.args.length">{{ server.args.join(' ') }}</code>
            </p>

            <p v-if="server.detail" class="server-detail">{{ server.detail }}</p>

            <div class="server-actions">
              <AppButton size="sm" :disabled="probing === server.id" @click="probe(server)">
                <template #icon><IconRefresh :size="14" /></template>
                {{ probing === server.id ? '连接中…' : '测试连接' }}
              </AppButton>
              <AppButton
                v-if="server.tools.length"
                size="sm"
                @click="expandedTools = expandedTools === server.id ? '' : server.id"
              >
                {{ expandedTools === server.id ? '收起工具' : `工具 ${server.tools.length} 个` }}
              </AppButton>
              <AppButton size="sm" @click="startEdit(server)">编辑</AppButton>
              <AppButton size="sm" variant="danger" @click="confirmTarget = server">
                <template #icon><IconTrash :size="14" /></template>
                删除
              </AppButton>
            </div>

            <ul v-if="expandedTools === server.id" class="tool-list">
              <li v-for="tool in server.tools" :key="tool.qualified">
                <code>{{ tool.qualified }}</code>
                <span>{{ tool.description }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>
    </div>

    <!-- ------------------------------------------------------------ 技能正文 -->
    <AppModal
      v-model:open="skillOpen"
      :title="skillDetail?.name ?? '读取技能…'"
      size="wide"
      height="tall"
    >
      <p class="modal-lead text-meta">
        这就是模型按需读进来的**正文**。frontmatter（名字与描述）不在这里——
        那一行会进系统提示词，正文只在它决定用这个技能时才读。
      </p>
      <pre class="skill-body">{{ skillDetail?.body ?? '' }}</pre>
      <template #footer>
        <AppButton @click="skillOpen = false">关闭</AppButton>
      </template>
    </AppModal>

    <!-- ------------------------------------------------------------ 登记表单 -->
    <AppModal
      v-model:open="formOpen"
      :title="editing ? `编辑「${editing.name}」` : '登记 MCP 服务'"
    >
      <p class="modal-lead text-meta">
        <template v-if="editing">
          凭据**不会回显**：只显示"已配过哪几个 key"。要改就在下面重填，
          留空表示保持原样（不是清空）。
        </template>
        <template v-else>
          stdio 会**起一个本地进程**（填要执行的命令），http 连远端服务（填 URL）。
        </template>
      </p>

      <label class="field">
        <span class="field-label">名字</span>
        <AppInput v-model="form.name" placeholder="例如：filesystem" />
      </label>

      <label v-if="!editing" class="field">
        <span class="field-label">传输方式</span>
        <AppSelect v-model="form.transport" :options="TRANSPORT_OPTIONS" />
      </label>

      <label class="field">
        <span class="field-label">{{ form.transport === 'stdio' ? '命令' : 'URL' }}</span>
        <AppInput
          v-model="form.target"
          :placeholder="form.transport === 'stdio' ? '例如：npx' : '例如：https://example.com/mcp'"
        />
      </label>

      <label v-if="form.transport === 'stdio'" class="field">
        <span class="field-label">参数（空格分隔）</span>
        <AppInput
          v-model="form.args"
          placeholder="例如：-y @modelcontextprotocol/server-filesystem /data"
        />
      </label>

      <label v-if="form.transport === 'stdio'" class="field">
        <span class="field-label">环境变量（每行一个 KEY=VALUE）</span>
        <AppInput v-model="form.envKeys" multiline :rows="2" placeholder="TOKEN=..." />
      </label>

      <label v-else class="field">
        <span class="field-label">请求头（每行一个 KEY=VALUE）</span>
        <AppInput
          v-model="form.headers"
          multiline
          :rows="2"
          placeholder="Authorization=Bearer ..."
        />
      </label>

      <label class="field">
        <span class="field-label">准入策略</span>
        <AppSelect v-model="form.policy" :options="POLICY_OPTIONS" />
      </label>

      <template #footer>
        <AppButton @click="formOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="formSaving" @click="saveServer">
          {{ formSaving ? '保存中…' : '保存' }}
        </AppButton>
      </template>
    </AppModal>

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="删除这个 MCP 服务？"
      :lead="`将删除登记信息「${confirmTarget?.name ?? ''}」。`"
      note="只删登记信息，不会去动那个服务本身，也不会删它的任何数据。"
      confirm-label="删除"
      @confirm="removeServer"
    />
  </PageShell>
</template>

<style scoped>
/* 标签栏：文字 + 选中态一条墨色下划线（Kimi 的能力页如此）。
   **不用胶囊/填充底**：那与侧栏"当前在哪"的中性填充是两套语言，
   而这里是"同一页里的两页"，下划线更轻，也更像分页。 */
.cap-tabs {
  display: flex;
  gap: var(--space-5);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
}

.cap-tab {
  padding: var(--space-2) 0;
  margin-bottom: -1px;
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}

.cap-tab:hover {
  color: var(--text-primary);
}

.cap-tab-active {
  font-weight: 600;
  color: var(--text-primary);
  border-bottom-color: var(--text-primary);
}

/* 一次只显示一页，所以是单栏：并排两栏时每栏只剩一半宽，
   技能描述那种整句文本折行折得很碎 */
.cap-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.cap-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.col-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.col-head h2 {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
}

.skill-list,
.server-list,
.tool-list,
.flags {
  margin: 0;
  padding: 0;
  list-style: none;
}

.skill,
.server {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
}

.skill + .skill,
.server + .server {
  margin-top: var(--space-2);
}

.skill-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  padding: 0;
}

.skill-name,
.server-name {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.skill-desc {
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
  line-height: var(--line-ui);
}

.skill-meta,
.server-head,
.server-actions,
.server-target {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: 0;
}

.server-target code {
  font-family: var(--font-mono);
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
  word-break: break-all;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-badge);
  background: var(--bg-group);
  font-size: var(--text-c2-size);
  color: var(--text-secondary);
}

.chip-warn {
  background: var(--status-warning-soft);
  color: var(--text-primary);
}

.flags {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-radius: var(--radius-row);
  background: var(--status-warning-soft);
  color: var(--text-primary);
  font-size: var(--text-c2-size);
  line-height: var(--line-ui);
}

.server-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
}

.tool-list li {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  padding: var(--space-1-5) 0;
  border-top: 1px solid var(--border-hairline);
  font-size: var(--text-c2-size);
  color: var(--text-secondary);
}

.tool-list code {
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.modal-lead {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
}

.skill-body {
  margin: 0;
  padding: var(--space-3);
  max-height: 52vh;
  overflow: auto;
  background: var(--bg-subtle);
  border-radius: var(--radius-row);
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
  white-space: pre-wrap;
}
</style>
