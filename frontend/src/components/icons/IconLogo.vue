<script setup lang="ts">
/**
 * 产品标识（品牌标，刻意**不属于** UI 图标集合）。
 *
 * UI 图标统一取 Remix 集合（见《界面评审与改进计划》§5），但品牌标是另一回事：
 * 它要能被认出来，混进通用图标里反而失去标识性。保持自制线稿，
 * 但尺寸与 `currentColor` 口径与图标一致。
 */
</script>

<template>
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 19.5V5.5A1.5 1.5 0 0 1 5.5 4H17a3 3 0 0 1 3 3v12.5" />
    <path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20" />
    <path d="M8 8h8M8 12h5" />
  </svg>
</template>
