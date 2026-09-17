<script setup lang="ts">
/**
 * 「新建项目」用的图标：一个文件夹加一个小加号。
 *
 * 为什么不直接用 `IconPlus`：这一行右边出现的动作**光看加号猜不出建的是什么**
 * （同栏里还有"新建会话"）。Kimi Work 这里是文件夹带加号，抄它一次到位。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <!-- 文件夹（右侧让出一小块给加号） -->
    <path
      d="M3 4a1 1 0 0 1 1-1h5.414a1 1 0 0 1 .707.293L11.828 5H14a1 1 0 0 1 1 1v1h-2V7h-2.414l-1.293-1.293A1 1 0 0 0 8.586 5H5v12h7v2H4a1 1 0 0 1-1-1z"
    />
    <!-- 加号 -->
    <path d="M17 12h2v3h3v2h-3v3h-2v-3h-3v-2h3z" />
  </svg>
</template>
