/**
 * 外观（本地偏好，不进后端）——与旧前端 `components/settings/AppearanceSection.vue` 对应。
 *
 * 主题与字号都是本地偏好，读的是本域的两个 store（`useTheme` / `useFontScale`）、
 * 不碰设置接口——所以这一节不需要任何 props/emits。
 * 两者都用**卡片式选择器**：三档主题、四档字号，选中那一档靠底色表达，
 * 而不是靠一个字面上的"当前"。
 */
import { InfoTip } from '../shared/composites'
import { FONT_SCALES, useFontScale } from './useFontScale'
import { setTheme, useThemeMode, type ThemeMode } from './useTheme'

/** 主题三档：与字号同样用卡片式选择器。 */
const THEME_OPTIONS: { name: ThemeMode; label: string; hint: string }[] = [
  { name: 'system', label: '跟随系统', hint: '随设备明暗自动切换' },
  { name: 'light', label: '浅色', hint: '始终使用纸白' },
  { name: 'dark', label: '深色', hint: '始终使用近黑' },
]

export function AppearanceSection() {
  const themeMode = useThemeMode()
  const { scale, setFontScale } = useFontScale()
  const currentScaleHint = FONT_SCALES.find((item) => item.name === scale)?.hint ?? ''

  return (
    <>
      <h3 className="m-section-title">
        外观
        <InfoTip text="主题与字号只影响这一台机器的浏览器，存在本地。" />
      </h3>

      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">主题</span>
          <span className="m-row-value">
            {THEME_OPTIONS.find((item) => item.name === themeMode)?.hint ?? ''}
          </span>
        </div>
      </div>

      <div className="m-scale-picker" role="group" aria-label="主题">
        {THEME_OPTIONS.map((item) => (
          <button
            key={item.name}
            type="button"
            className={
              themeMode === item.name ? 'm-scale-option m-scale-option-on' : 'm-scale-option'
            }
            aria-pressed={themeMode === item.name}
            onClick={() => setTheme(item.name)}
          >
            <span className="m-scale-label">{item.label}</span>
            <span className="m-scale-size">{item.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="m-section-title m-section-gap">正文字号</h3>
      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">字号档位</span>
          <span className="m-row-value">{currentScaleHint}</span>
        </div>
      </div>

      <div className="m-scale-picker" role="group" aria-label="正文字号">
        {FONT_SCALES.map((item) => (
          <button
            key={item.name}
            type="button"
            className={scale === item.name ? 'm-scale-option m-scale-option-on' : 'm-scale-option'}
            aria-pressed={scale === item.name}
            onClick={() => setFontScale(item.name)}
          >
            <span className="m-scale-label">{item.label}</span>
            <span className="m-scale-size tabular">{item.bodySize}px</span>
          </button>
        ))}
      </div>
    </>
  )
}
