<script setup lang="ts">
/**
 * 能力页（v0.15，设计见 `docs/Agent-工作区与能力层设计-v0.1.md` §6）。
 *
 * 一页两栏，答的是同一个问题的两半——**这个 Agent 会什么**：
 *
 * - **技能**：写在磁盘上的 `SKILL.md`（流程）。目录进系统提示词、正文按需展开，
 *   所以这里要能看正文——用户有权知道"它到底教了模型什么"。
 * - **插件**（协议上是 MCP 服务，界面上叫插件）：外部工具（能力）。
 *   这里能登记、探活、看它有哪些工具、配策略闸。
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
import IconEdit from '@/components/icons/IconEdit.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'

const { notifyError, notifySuccess } = useToast()

/**
 * 当前看的是哪一页（v0.19）。
 *
 * 用户指定：技能与插件**做成两个菜单**，而不是并排两栏。
 * 并排的代价是两栏各只剩一半宽——技能描述是整句文本，折行折得很碎；
 * MCP 那边每条又带着策略与工具清单。而且这两件事本来就不需要同时看。
 */
const tab = ref<'skills' | 'mcp'>('skills')

const CAP_TABS = [
  { key: 'skills' as const, label: '技能' },
  // **用户面前叫「插件」**（v0.22，用户指定）：MCP 是协议的名字，不是用户的事。
  // 代码、接口与文档里仍是 MCP（那是它真实的东西），只改界面上这两个字。
  { key: 'mcp' as const, label: '插件' },
]

/**
 * 搜索与筛选（v0.22 重排）。
 *
 * **筛选按"用户会怎么找"来分**，不是按数据结构分：技能那边他分得清
 * "哪些是我们随代码带的、哪些是他自己放的、哪个被拦下了"；插件那边只有
 * "开着没开着"。数在标签上，省得点进去才发现是空的。
 */
const skillQuery = ref('')
const skillFilter = ref<'all' | 'builtin' | 'user' | 'blocked'>('all')
const serverQuery = ref('')
const serverFilter = ref<'all' | 'enabled' | 'disabled'>('all')

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

/** 当前这一屏显示的技能：搜索词 + 筛选。搜索只看**名字与描述**——
    技能正文不进列表（它有几百行，搜它是另一件事）。 */
const visibleSkills = computed(() => {
  const word = skillQuery.value.trim().toLowerCase()
  return skills.value.filter((item) => {
    if (skillFilter.value === 'builtin' && item.source !== 'builtin') return false
    if (skillFilter.value === 'user' && item.source === 'builtin') return false
    if (skillFilter.value === 'blocked' && item.used_by_prompt) return false
    if (!word) return true
    return `${item.name} ${item.description}`.toLowerCase().includes(word)
  })
})

const SKILL_FILTERS = computed(() => [
  { key: 'all' as const, label: '全部', count: skills.value.length },
  {
    key: 'builtin' as const,
    label: '随代码发布',
    count: skills.value.filter((item) => item.source === 'builtin').length,
  },
  {
    key: 'user' as const,
    label: '用户放入',
    count: skills.value.filter((item) => item.source !== 'builtin').length,
  },
  {
    key: 'blocked' as const,
    label: '未进提示词',
    count: skills.value.filter((item) => !item.used_by_prompt).length,
  },
])

/** 插件同理：开着 / 停着。停用的插件不参与对话的工具表（见 services/skills 的说明）。 */
const visibleServers = computed(() => {
  const word = serverQuery.value.trim().toLowerCase()
  return servers.value.filter((item) => {
    if (serverFilter.value === 'enabled' && !item.enabled) return false
    if (serverFilter.value === 'disabled' && item.enabled) return false
    if (!word) return true
    return `${item.name} ${item.target}`.toLowerCase().includes(word)
  })
})

const SERVER_FILTERS = computed(() => [
  { key: 'all' as const, label: '全部', count: servers.value.length },
  {
    key: 'enabled' as const,
    label: '已启用',
    count: servers.value.filter((item) => item.enabled).length,
  },
  {
    key: 'disabled' as const,
    label: '已停用',
    count: servers.value.filter((item) => !item.enabled).length,
  },
])

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
    notifyError(error instanceof Error ? error.message : '插件列表读取失败')
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
  <!-- **没有页标题**（用户指定）：左侧菜单已经写着「能力」，页内再写一遍是重复；
       而那句"技能是流程、插件是工具"的解释又是在把两个标签换个说法。
       于是这一页直接从标签开始——上面一行放标签与状态，下面就是内容。 -->
  <PageShell title="">
    <!-- 两个入口（用户指定，照 Kimi 的能力页）：一次只看一页。
         状态与标签同一行：它们回答的是同一个问题（"这里现在有什么、能用几个"） -->
    <div class="cap-head">
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
      <div class="cap-head-status">
        <StatusTag
          :label="`技能 ${usableSkills}/${skills.length} 可用`"
          :tone="skills.length && !usableSkills ? 'warning' : 'neutral'"
        />
        <StatusTag :label="`插件 ${servers.length} 个`" tone="neutral" />
      </div>
    </div>

    <div class="cap-layout">
      <!-- ------------------------------------------------------------ 技能 -->
      <section v-if="tab === 'skills'" class="cap-col" role="tabpanel" aria-label="技能">
        <header class="panel-head">
          <div class="panel-head-main">
            <h2 class="panel-title">技能</h2>
            <InfoTip
              text="技能只有「名字 + 什么时候用」会进系统提示词，正文在模型决定用它时才读进来。所以装得多不等于上下文变长。点一张卡片看它的正文。"
            />
            <p class="panel-desc">
              流程与 SOP：告诉
              Agent「这类事该怎么做」。装得多不等于上下文变长——只有名字与描述会进提示词。
            </p>
          </div>
          <div class="panel-head-actions">
            <label class="panel-search">
              <IconSearch :size="15" />
              <input
                v-model="skillQuery"
                type="search"
                placeholder="搜索技能"
                aria-label="搜索技能"
              />
            </label>
            <AppButton variant="primary" size="sm" @click="loadSkills">
              <template #icon><IconRefresh :size="14" /></template>
              重新扫描
            </AppButton>
          </div>
        </header>

        <div class="panel-filters" role="tablist" aria-label="技能筛选">
          <button
            v-for="item in SKILL_FILTERS"
            :key="item.key"
            type="button"
            role="tab"
            class="filter"
            :class="{ 'filter-on': skillFilter === item.key }"
            :aria-selected="skillFilter === item.key"
            @click="skillFilter = item.key"
          >
            {{ item.label }}
            <span class="filter-count tabular">{{ item.count }}</span>
          </button>
        </div>

        <SkeletonBlock v-if="skillsLoading" variant="list" :rows="3" />
        <EmptyState
          v-else-if="!visibleSkills.length"
          :title="skills.length ? '没有匹配的技能' : '还没有技能'"
          :hint="
            skills.length
              ? '换个关键词，或者把筛选切回「全部」。'
              : '把带 SKILL.md 的目录放进仓库的 skills/ 或数据目录的 skills/，这里就会列出来。'
          "
        />
        <ul v-else class="card-grid">
          <li v-for="skill in visibleSkills" :key="skill.name" class="card">
            <span class="card-icon"><IconRobot :size="18" /></span>
            <div class="card-body">
              <button type="button" class="card-title skill-main" @click="openSkill(skill)">
                {{ skill.name }}
              </button>
              <p class="card-desc">{{ skill.description || '（没有描述）' }}</p>
              <div class="card-meta">
                <span class="chip">{{
                  skill.source === 'builtin' ? '随代码发布' : '用户放入'
                }}</span>
                <span v-if="!skill.used_by_prompt" class="chip chip-warn">
                  <IconAlert :size="12" />
                  未进提示词
                </span>
              </div>
              <!-- 被拦下的技能**要显示理由**：静默藏掉会让人以为技能没装上 -->
              <ul v-if="skill.flagged.length" class="flags">
                <li v-for="(reason, at) in skill.flagged" :key="at">{{ reason }}</li>
              </ul>
            </div>
          </li>
        </ul>
      </section>

      <!-- ------------------------------------------------------------ 插件 -->
      <section v-else class="cap-col" role="tabpanel" aria-label="插件">
        <header class="panel-head">
          <div class="panel-head-main">
            <h2 class="panel-title">插件</h2>
            <InfoTip
              text="插件会以你的名义执行动作，所以每个都有一个准入策略。默认「需要确认」：它不会静默执行，而是把「需要先确认」回给模型并说明怎么放开。"
            />
            <p class="panel-desc">
              外部服务：接进来的工具会被 Agent
              当成能力使用。默认「需要确认」——它不会静默以你的名义调用。
            </p>
          </div>
          <div class="panel-head-actions">
            <label class="panel-search">
              <IconSearch :size="15" />
              <input
                v-model="serverQuery"
                type="search"
                placeholder="搜索插件"
                aria-label="搜索插件"
              />
            </label>
            <AppButton variant="primary" size="sm" @click="startCreate">
              <template #icon><IconPlus :size="14" /></template>
              新建插件
            </AppButton>
          </div>
        </header>

        <div class="panel-filters" role="tablist" aria-label="插件筛选">
          <button
            v-for="item in SERVER_FILTERS"
            :key="item.key"
            type="button"
            role="tab"
            class="filter"
            :class="{ 'filter-on': serverFilter === item.key }"
            :aria-selected="serverFilter === item.key"
            @click="serverFilter = item.key"
          >
            {{ item.label }}
            <span class="filter-count tabular">{{ item.count }}</span>
          </button>
        </div>

        <SkeletonBlock v-if="serversLoading" variant="list" :rows="3" />
        <EmptyState
          v-else-if="!visibleServers.length"
          :title="servers.length ? '没有匹配的插件' : '还没有插件'"
          :hint="
            servers.length
              ? '换个关键词，或者把筛选切回「全部」。'
              : '登记之后，它的工具会被 Agent 当成能力使用（工具名一律带 mcp__ 前缀，避免与内置工具撞名）。'
          "
        />
        <ul v-else class="card-grid">
          <li v-for="server in visibleServers" :key="server.id" class="card">
            <span class="card-icon"><IconServer :size="18" /></span>
            <div class="card-body">
              <span class="card-title">{{ server.name }}</span>
              <p class="card-desc">
                <span class="chip">{{ server.transport }}</span>
                <code class="card-target">{{ server.target }}</code>
              </p>
              <div class="card-meta">
                <StatusTag :label="policyLabel(server.policy)" :tone="policyTone(server.policy)" />
                <StatusTag v-if="server.reachable === true" label="连接正常" tone="success" />
                <StatusTag v-else-if="server.reachable === false" label="连不上" tone="warning" />
                <span v-if="server.has_secrets" class="chip" title="凭据已配置（值不会回显）">
                  <IconCheck :size="12" />
                  凭据已配置
                </span>
                <span v-if="!server.enabled" class="chip">已停用</span>
                <!-- 探活的结论写在卡片里（它是"这个插件现在什么状态"，不是一次操作的结果） -->
                <button
                  v-if="server.tools.length"
                  type="button"
                  class="chip chip-button"
                  @click="expandedTools = expandedTools === server.id ? '' : server.id"
                >
                  {{ expandedTools === server.id ? '收起工具' : `工具 ${server.tools.length} 个` }}
                </button>
              </div>

              <p v-if="server.detail" class="card-detail">{{ server.detail }}</p>

              <ul v-if="expandedTools === server.id" class="tool-list">
                <li v-for="tool in server.tools" :key="tool.qualified">
                  <code>{{ tool.qualified }}</code>
                  <span>{{ tool.description }}</span>
                </li>
              </ul>
            </div>

            <!-- 动作收进「⋯」（照 Kimi 的卡片）：卡片本身回答"这是什么"，
                 动作是次要的；摊在卡片上会让每一张都像一个小表单 -->
            <RowMenu class="card-menu" :label="`${server.name} 的操作`" align="right">
              <template #default="{ close }">
                <button
                  type="button"
                  :disabled="probing === server.id"
                  @click="(probe(server), close())"
                >
                  <IconRefresh :size="14" />
                  {{ probing === server.id ? '连接中…' : '测试连接' }}
                </button>
                <button type="button" @click="(startEdit(server), close())">
                  <IconEdit :size="14" /> 编辑
                </button>
                <button
                  class="menu-item-danger"
                  type="button"
                  @click="((confirmTarget = server), close())"
                >
                  <IconTrash :size="14" /> 删除
                </button>
              </template>
            </RowMenu>
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
    <AppModal v-model:open="formOpen" :title="editing ? `编辑「${editing.name}」` : '登记插件'">
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
      title="删除这个插件？"
      :lead="`将删除登记信息「${confirmTarget?.name ?? ''}」。`"
      note="只删登记信息，不会去动那个服务本身，也不会删它的任何数据。"
      confirm-label="删除"
      @confirm="removeServer"
    />
  </PageShell>
</template>

<style scoped>
/* 首行：标签（左）+ 状态（右）——页头去掉了，这一行就是页面的开头。
   标签与状态同处一行是因为它们回答同一个问题："这里现在有什么、能用几个"。 */
.cap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
}

.cap-head-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
}

/* 标签栏：文字 + 选中态一条墨色下划线（Kimi 的能力页如此）。
   **不用胶囊/填充底**：那与侧栏"当前在哪"的中性填充是两套语言，
   而这里是"同一页里的两页"，下划线更轻，也更像分页。 */
.cap-tabs {
  display: flex;
  gap: var(--space-5);
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

/* 一次只显示一页（并排两栏时每栏只剩一半宽，技能描述那种整句文本折行折得很碎） */
.cap-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.cap-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

/* 内容头（照 Kimi 的插件页）：左边标题 + 一句说明，右边搜索与主操作。
   这一节原先只有一个 `h2 技能` 加一个按钮——标题重复了标签，而"这是什么"
   那句话没人说。 */
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.panel-head-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.panel-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
}

/* 说明占满一行：它是给这一节定性的那句话，不该挤在标题旁边 */
.panel-desc {
  flex-basis: 100%;
  margin: 0;
  max-width: 76ch;
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  line-height: var(--line-ui);
}

.panel-head-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
}

/* 搜索：图标嵌在框里。**不做成"点开才出现"**——它是这一屏唯一的检索入口，
   藏起来就没人知道能搜 */
.panel-search {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--control-height);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-tertiary);
}

.panel-search:focus-within {
  border-color: var(--text-primary);
  box-shadow: inset 0 0 0 1px var(--text-primary);
}

.panel-search input {
  width: 11rem;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  outline: none;
}

.panel-search input::placeholder {
  color: var(--text-tertiary);
}

/* 去掉 type=search 的原生叉（与自绘的图标是两套样子） */
.panel-search input::-webkit-search-cancel-button {
  display: none;
}

/* 筛选胶囊（照 Kimi）：选中态是**深色填充**，其余是浅底。
   计数放在标签后面——"点进去才发现是空的"是最没必要的一次点击 */
.panel-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.filter {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--hit-target);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: var(--bg-group);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  transition: var(--transition-ui);
}

.filter:hover {
  color: var(--text-primary);
}

/* 选中态：墨色底 + 纸白字。**用 `--bg-surface` 而不是 `--bg-primary`**——
   那个 token 不存在（第一版写的它，于是 `color` 整条失效、标签变成隐形；
   浏览器不会为此报错，只有真看一眼才发现）。 */
.filter-on {
  background: var(--text-primary);
  color: var(--bg-surface);
}

.filter-count {
  color: var(--text-tertiary);
  font-size: var(--text-c2-size);
}

.filter-on .filter-count {
  color: var(--bg-surface);
  opacity: 0.7;
}

/* 卡片两栏（照 Kimi 的插件页）：一栏在窄屏下会拉成一条很长的横带，
   而每个技能/插件的描述本来就两三行，两栏正好 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  transition: var(--transition-ui);
}

.card:hover {
  border-color: var(--border-strong);
}

/* 图标方块：技能的来源与插件的类型都靠它一眼分开 */
.card-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: var(--radius-control);
  background: var(--bg-group);
  color: var(--text-secondary);
}

.card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.card-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--text-body-size);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

/* 描述**最多两行**：技能的描述是"什么时候该用它"的整句话，往往很长——
   全铺出来会把卡片拉成一条，而它本来只是"这张卡是干什么的" */
.card-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
  line-height: var(--line-ui);
  word-break: break-word;
}

.card-target {
  font-family: var(--font-mono);
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
  word-break: break-all;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex-wrap: wrap;
}

.card-detail {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-c2-size);
  line-height: var(--line-ui);
}

/* 可点的胶囊（"工具 N 个"）：它是**展开**而不是动作，所以做成胶囊而不是按钮 */
.chip-button {
  border: none;
  cursor: pointer;
  transition: var(--transition-ui);
}

.chip-button:hover {
  color: var(--text-primary);
}

/* 卡片右上角的「⋯」：默认不显形，悬停或键盘聚焦时出现
   （与侧栏节标题那条同一处置：`opacity` 不挤动布局，且始终可 Tab） */
.card-menu {
  flex: 0 0 auto;
  margin-left: auto;
}

.card-menu :deep(.menu-trigger) {
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.card:hover .card-menu :deep(.menu-trigger),
.card-menu :deep(.menu-trigger:focus-visible) {
  opacity: 1;
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
