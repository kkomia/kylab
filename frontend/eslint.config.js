import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

import noEmojiRule from './eslint-rules/no-emoji.js'

export default tseslint.config(
  // schema.d.ts 是生成物（见 .prettierignore）：格式与命名都不由我们定
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.min.js', 'src/api/schema.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    files: ['**/*.{js,ts,vue}'],
    plugins: {
      kylab: {
        rules: {
          'no-emoji': noEmojiRule,
        },
      },
    },
    rules: {
      // 本项目硬性禁令（《前端设计规范 v0.3》§3、§8）
      'kylab/no-emoji': 'error',
    },
  },

  {
    files: ['tests/**/*.ts', 'eslint-rules/**/*.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
)
