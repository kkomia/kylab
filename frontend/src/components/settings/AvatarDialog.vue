<script setup lang="ts">
/**
 * 换头像（v0.29）：选一张图、看一眼、传上去。
 *
 * 两处值得说清楚：
 *
 * 1. **前端先缩到 256px**（canvas）。服务端不装成像库（这个项目到目前一张图都不处理），
 *    它只守"是不是图、有多大"；而"一张 4MB 的手机照片"是用户默认会选的东西——
 *    不缩的话每次换头像都要传几兆，还可能撞上上限被拒。缩完通常 10–40KB。
 *    **裁成正方形**（居中裁）而不是拉伸：拉伸会把脸压扁，而头像是圆的。
 * 2. **预览用的是本地对象 URL**，不落服务端：万一用户只是想看看效果、
 *    或者传之前改主意了，不该在桶里留一张别人不知道的图。
 */
import { ref, watch } from 'vue'

import AppAvatar from '@/components/ui/AppAvatar.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import { setAvatar, removeAvatar } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  name: string
  /** 当前头像链接（签名 URL）。空 = 用生成的那张。 */
  url: string
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()

const { notifyError, notifySuccess } = useToast()

/** 输出边长。256 在 2× 屏上看着也够，而文件通常只有几十 KB。 */
const OUTPUT_SIZE = 256

const fileInput = ref<HTMLInputElement | null>(null)
/** 预览用的本地对象 URL（只负责显示）。 */
const preview = ref('')
/** 缩好的那一份本体。**直接留着它，不从 URL 再 fetch 回来**：
 *  多一次 `fetch(blob:)` 就多一个（没必要的）失败点，而这份 blob 就在手里。 */
const picked = ref<Blob | null>(null)
const busy = ref(false)

watch(open, (value) => {
  if (!value) {
    // 关掉时把预览也丢掉：不丢的话下次打开会先闪一眼上一张
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = ''
    picked.value = null
  }
})

async function pick(event: Event): Promise<void> {
  const chosen = (event.target as HTMLInputElement).files?.[0]
  if (fileInput.value) fileInput.value.value = ''
  if (!chosen) return
  try {
    const blob = await shrink(chosen)
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = URL.createObjectURL(blob)
    picked.value = blob
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '这张图读不出来')
  }
}

/**
 * 居中裁成正方形并缩到 `OUTPUT_SIZE`。
 *
 * 解码失败（少数格式浏览器解不开、文件其实是坏的）就抛出去——调用方把原因
 * 说给用户听。不在这里兜一层 `<img>` 解码：那是第二条实现，而它同样会失败。
 */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('请选一张图片')
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('这个浏览器画不出来（canvas 不可用）')
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  )
  bitmap.close?.()
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('这张图转不成 PNG'))),
      'image/png',
    )
  })
}

async function save(): Promise<void> {
  const blob = picked.value
  if (!blob || busy.value) return
  busy.value = true
  try {
    // 名字带后缀是有意的：后端按**魔数**认格式，但文件名空着不像一次上传
    await setAvatar(new File([blob], 'avatar.png', { type: 'image/png' }))
    notifySuccess('头像已更新')
    emit('changed')
    open.value = false
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '上传失败')
  } finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await removeAvatar()
    notifySuccess('已去掉头像')
    emit('changed')
    open.value = false
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '操作失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="头像" size="md">
    <div class="avatar-stage">
      <!-- 预览优先用刚选的那张（还没上传），否则显示当前生效的那张 -->
      <AppAvatar v-if="!preview" :name="props.name" :url="props.url" :size="96" />
      <img v-else class="avatar-preview" :src="preview" alt="新头像预览" />
    </div>
    <p class="avatar-hint">一张方图最合适；会居中裁成正方形并缩到 {{ OUTPUT_SIZE }}px 再上传。</p>
    <input
      ref="fileInput"
      class="avatar-input"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      aria-label="选择头像图片"
      @change="pick"
    />

    <template #footer>
      <AppButton v-if="props.url" class="footer-left" :disabled="busy" @click="remove">
        <template #icon><IconTrash :size="14" /></template>
        去掉头像
      </AppButton>
      <AppButton :disabled="busy" @click="fileInput?.click()">
        <template #icon><IconUpload :size="14" /></template>
        {{ preview ? '重选' : '选择图片' }}
      </AppButton>
      <AppButton variant="primary" :disabled="!preview || busy" @click="save">
        {{ busy ? '上传中…' : '保存' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.avatar-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3) 0 var(--space-2);
}

/* 预览与头像同一个形状（圆、同样大小），"换完长什么样"当场就是答案 */
.avatar-preview {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-pill);
}

.avatar-hint {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
  text-align: center;
}

/* 选择器藏在按钮后面（浏览器只给 `<input type=file>` 这一个入口） */
.avatar-input {
  display: none;
}

.footer-left {
  margin-right: auto;
}
</style>
