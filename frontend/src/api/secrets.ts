/**
 * 本机库里那几处凭据的读数与收编（M5 阶段 7 的「凭据」一节）。
 *
 * ## 这两个端点回答什么
 *
 * 方案 §4.2 把过渡态写死成一句可观测的话：**迁移完成前"库里有值、钥匙串没有"是唯一
 * 允许的中间态**，而它必须能被看见——`GET /local/secrets` 回
 * `{"store": "available|unavailable", "pending_migration": n}`，设置面板据此显示
 * "发现 N 处明文凭据"，并给一颗「迁进系统钥匙串」（`POST /local/secrets/migrate`）。
 * **不静默迁移**（改用户的存储位置要有意识），但必须有这个一键入口。
 *
 * ## 形状的出处（逐字段对拍 `backend/app/api/v1/local.py`）
 *
 * 与 `api/local.ts:1-25` 同一条纪律（`/local/*` 不进服务器档的 OpenAPI，所以类型手写）：
 * 下面两个类型逐字段对着 `SecretsStatusOut` 与 `SecretMigrationOut` 抄
 * （后者的形状由 `services/credentials.MigrationReport.as_dict()` 给）。改了后端就回来改这里。
 *
 * ## 三条纪律
 *
 * 1. **只报数，不回显任何秘密**：这一节认得的只有"几处"与"钥匙串能不能写"两个数。
 *    迁移报告里那几项带的是**位置名**（`setting:…` / `model_provider:…` 这类本机库里的
 *    键名），所以界面**只数个数、不摆名字**——那是实现语汇，不该上屏幕；
 * 2. **钥匙串不可用是一种结论**（`store: unavailable`，端点永远是 200），不是一次失败：
 *    界面上如实说"这台机器收不了凭据"（那时 `pending_migration` 恒为 0——
 *    这种机器上库就是凭据的家，没有"等着迁"这回事）；
 * 3. **读不到与"0 处"是两件事**：读失败（边车没起来 / 形状不认识）如实说"读不到"，
 *    **不许显示成"没有明文"**——那两句话的下一步完全不同。
 */
import { requestLocal } from './client'

/** `GET /local/secrets` 的读数（`SecretsStatusOut`）。 */
export interface LocalSecrets {
  /** `available` / `unavailable`——这台机器有没有可用的系统钥匙串。 */
  store?: string
  /** 库里还剩几处明文等着收编（钥匙串不可用时恒 0）。 */
  pending_migration: number
}

/** 迁移报告里的一项（`{"item": 位置名, "reason": 原因}`）——**只用来数个数**。 */
export interface SecretMigrationItem {
  item?: string
  reason?: string
}

/** `POST /local/secrets/migrate` 的报告（`SecretMigrationOut`）。 */
export interface SecretMigration {
  store?: string
  /** 这次搬进钥匙串的项。 */
  migrated?: SecretMigrationItem[]
  /** 跳过没搬的项（已经迁过 / 钥匙串里已有别的值）。 */
  skipped?: SecretMigrationItem[]
  /** 没搬成的项（**那几处的明文没动**，可以重跑）。 */
  failed?: SecretMigrationItem[]
  /** 跑完之后还剩几处明文。 */
  pending_migration: number
}

/**
 * 读一次的三种结论。
 *
 * 为什么不是"成功 / 失败"两种：**这一版还没有这一项**（404）与"读不到"（边车没起来、
 * 形状不认识）在界面上是两句不同的话，下一步也不同（一个什么都不用做，一个要去看本机
 * 后端）。合成一种，用户就没法判断该不该在意。
 */
export type SecretsRead =
  { kind: 'ok'; data: LocalSecrets } | { kind: 'unsupported' } | { kind: 'error'; message: string }

/** 读一次「库里还有几处明文凭据」。**从不抛**（三种结论都在返回值里）。 */
export async function getLocalSecrets(): Promise<SecretsRead> {
  try {
    const payload = await requestLocal<LocalSecrets>('/local/secrets')
    if (!payload || typeof payload !== 'object' || typeof payload.pending_migration !== 'number') {
      return { kind: 'error', message: '凭据读数不认识（没有 pending_migration 这一项）' }
    }
    return { kind: 'ok', data: payload }
  } catch (cause) {
    const error = cause as (Error & { status?: number }) | undefined
    if (error?.status === 404) return { kind: 'unsupported' }
    return {
      kind: 'error',
      message: error instanceof Error && error.message ? error.message : String(cause),
    }
  }
}

/**
 * 「迁进系统钥匙串」：把库里那几处明文凭据收进系统钥匙串（`POST /local/secrets/migrate`）。
 *
 * 这一条**失败要抛**（与 `clearKbCache` 同一条纪律）：它是用户明确点的动作，静默失败会让
 * 用户以为"已经迁完了"——而那正是这一节要盯的那件事。钥匙串整条不可用时后端回 **503**
 * （"这台机器没有这个能力"，不是"你请求写错了"），那句话由调用方原样转达。
 *
 * 回来的报告里那三个列表**只用来数个数**（不摆项名）：结论用 `pending_migration`
 * ——它是**跑完之后**还剩几处（成功是 0，失败的那几处还在，可以重跑）。
 */
export async function migrateLocalSecrets(): Promise<SecretMigration> {
  const payload = await requestLocal<SecretMigration>('/local/secrets/migrate', { method: 'POST' })
  if (!payload || typeof payload !== 'object' || typeof payload.pending_migration !== 'number') {
    throw new Error('迁移结论不认识（没有 pending_migration 这一项）')
  }
  return payload
}
