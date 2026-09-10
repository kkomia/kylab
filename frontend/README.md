# frontend

KYLAB 知识库 Web 控制台（Vue 3 + Vite + Pinia），含检索调试台。
视觉与交互依据《前端设计规范 v0.1》；工程约束见《项目工程规范 v0.1》§4。

## 快速开始

```powershell
cd frontend
pnpm install
pnpm dev        # http://127.0.0.1:5173，/api 代理到 http://127.0.0.1:8000
```

后端未启动时，侧栏底部会显示「后端不可达」的服务状态（图标 + 文字双编码）。

## 常用命令

| 目的                      | 命令                                   |
| ------------------------- | -------------------------------------- |
| 开发服务                  | `pnpm dev`                             |
| 构建                      | `pnpm build`                           |
| 类型检查                  | `pnpm typecheck`                       |
| Lint（eslint + prettier） | `pnpm lint`                            |
| 单元测试                  | `pnpm test`                            |
| emoji 扫描                | `python ../scripts/scan_emoji.py src/` |

## 目录

```
src/
├── assets/themes/     主题 CSS 变量（light.css / dark.css）
├── components/        通用组件（PascalCase.vue）
│   └── icons/         内联 SVG 图标组件（Icon<名称>.vue）
├── views/             页面
├── composables/       use 前缀，camelCase
├── api/               后端接口封装（与 /api/v1 对齐）
├── stores/            Pinia
├── router/
└── main.ts
eslint-rules/          自定义 lint 规则（no-emoji）
tests/unit/            组件与组合式函数测试，与 src/ 镜像同构
```

## 风格纪律（工程规范 §4.3）

1. **禁止 emoji**：由 `kylab/no-emoji` 规则强制（`eslint-rules/no-emoji.js`），
   界面、空状态、通知、状态标记一律用内联 SVG + 文字；
2. **图标只能引 `components/icons/`**：禁止外链图标库、iconfont、图片图标；
   统一 Lucide 基准、1.5px 描边、`currentColor`、16/20/24 三档；
3. **颜色只能引用主题 CSS 变量**：禁止硬编码色值，语义色仅用于状态传达；
4. **测试不进源码目录**：测试一律放 `tests/`，由 `scripts/check_layering.py` 核查。

## 新增页面

`views/` 下建 PascalCase 页面，在 `router/index.ts` 注册 kebab-case 路径，
页面标题与 1px 分割线沿用外壳样式（《前端设计规范 v0.1》§5）。
