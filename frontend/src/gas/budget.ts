// Gas 预算口径（结果页 / 分析页共用的唯一判定来源）。
// - 支持"项目统一上限"与"逐函数阈值"两种方式，逐函数阈值优先
// - 超标 / 接近阈值 / 正常 / 无数据 四类判定规则集中在此
// - 阈值取值有合法范围，超出范围的输入会被拦住并给出标准说明
import type { FunctionGasReport, GasBreakdown } from "./analyzer"
import { LOOP_STORAGE_MULTIPLIER } from "./analyzer"

export type BudgetStatus = "over" | "near" | "normal" | "nodata"

export interface BudgetConfig {
  /** 项目统一 Gas 上限（对未单独设置的函数生效） */
  defaultLimit: number
  /** 接近阈值提醒线：实际消耗达到上限的该比例即提醒（默认 80%） */
  warnRatio: number
  /** 逐函数阈值：key 为函数裸名，例如 withdraw */
  perFunction: Record<string, number>
}

export interface FunctionBudgetResult {
  report: FunctionGasReport
  /** 该函数生效的阈值；无数据函数为 null */
  limit: number | null
  /** true 表示命中逐函数阈值，false 表示用项目统一上限 */
  usePerFunction: boolean
  status: BudgetStatus
  /** 实际/上限，0~1+；无数据为 null */
  usageRatio: number | null
  /** 超出比例（百分比数值，如 20 表示超 20%）；未超标为 null */
  overPercent: number | null
  /** 接近阈值时的剩余空间百分比；非接近状态为 null */
  remainingPercent: number | null
  /** 超标/接近时的结构化原因（按贡献从大到小） */
  reasons: string[]
}

// ---- 阈值合法范围（标准口径） ---------------------------------------------
export const MIN_LIMIT = 1
export const MAX_LIMIT = 30_000_000 // 以太坊区块 Gas 上限量级，超过即视为不合理
export const MIN_WARN_RATIO = 0.5
export const MAX_WARN_RATIO = 1

export const DEFAULT_BUDGET: BudgetConfig = {
  defaultLimit: 30000,
  warnRatio: 0.8,
  perFunction: {},
}

export function invalidLimitMessage(value: number | string): string | null {
  if (typeof value === "string" && value.trim() === "") return "阈值不能为空，请输入 1 ~ 30,000,000 之间的整数"
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || Number.isNaN(n)) return "阈值必须是数字，请输入 1 ~ 30,000,000 之间的整数"
  if (!Number.isInteger(n)) return "阈值必须是整数（Gas 以整数计），请重新输入"
  if (n < MIN_LIMIT) return `阈值不能小于 ${MIN_LIMIT}（最小合法值）`
  if (n > MAX_LIMIT) return `阈值不能大于 ${MAX_LIMIT.toLocaleString()}（超过区块 Gas 上限量级，属不合理取值）`
  return null
}

export function invalidWarnRatioMessage(value: number): string | null {
  if (!Number.isFinite(value) || Number.isNaN(value)) return "提醒比例必须是 0.5 ~ 1 之间的数字"
  if (value < MIN_WARN_RATIO || value > MAX_WARN_RATIO) {
    return `提醒比例必须在 ${MIN_WARN_RATIO} ~ ${MAX_WARN_RATIO} 之间`
  }
  return null
}

/** 取函数生效阈值：逐函数阈值优先，否则用项目统一上限 */
export function resolveLimit(report: FunctionGasReport, config: BudgetConfig): { limit: number | null; usePerFunction: boolean } {
  const per = config.perFunction[report.shortName]
  if (typeof per === "number" && Number.isFinite(per)) return { limit: per, usePerFunction: true }
  return { limit: config.defaultLimit, usePerFunction: false }
}

const BREAKDOWN_LABELS: { key: keyof GasBreakdown; label: string }[] = [
  { key: "sstore", label: "storage 写入（SSTORE）" },
  { key: "transfer", label: "内部转账（call/transfer/send）" },
  { key: "loopStorage", label: "循环内重复读取 storage" },
  { key: "sload", label: "storage 读取（SLOAD）" },
  { key: "event", label: "事件 emit" },
  { key: "check", label: "require/assert 校验" },
  { key: "base", label: "函数基础开销" },
]

/** 从消耗构成中归纳原因（取占比最大的若干项） */
function buildReasons(report: FunctionGasReport, gas: number, limit: number, over: boolean): string[] {
  const reasons: string[] = []
  const ranked = BREAKDOWN_LABELS.map(({ key, label }) => ({
    label,
    value: report.breakdown[key],
  }))
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value)

  for (const item of ranked.slice(0, 3)) {
    const pct = Math.round((item.value / gas) * 100)
    reasons.push(`${item.label}约 ${item.value.toLocaleString()} Gas，占该函数消耗 ${pct}%`)
  }

  // 与具体写法挂钩的补充说明
  const m = report.metrics
  if (m.loopStorageReads > 0) {
    reasons.push(`循环内有 ${m.loopStorageReads} 次 storage 读取（按 ${LOOP_STORAGE_MULTIPLIER} 倍计入），是拉高消耗的直接写法`)
  }
  if (m.storageWrites > 0) {
    reasons.push(`函数内有 ${m.storageWrites} 次 storage 写入，单次 SSTORE 成本很高`)
  }
  if (m.transfers > 0) {
    reasons.push(`函数内有 ${m.transfers} 次内部转账`)
  }
  if (over) {
    reasons.push(`当前消耗 ${gas.toLocaleString()} 高于阈值 ${limit.toLocaleString()}，需先优化上述写法或调高阈值`)
  }
  return reasons
}

/**
 * 按当前配置对全部函数做预算判定。
 * 关键规则：每次都根据"实际消耗 vs 当前阈值"重新计算。
 * 调高阈值后，实际消耗未变，原本正常的函数 status 只会保持/变松，
 * 不会因为阈值调整本身被算成超标。
 */
export function evaluateBudgets(
  reports: FunctionGasReport[],
  config: BudgetConfig,
): FunctionBudgetResult[] {
  return reports.map(report => {
    const { limit, usePerFunction } = resolveLimit(report, config)

    if (report.currentGas === null || limit === null) {
      return {
        report,
        limit,
        usePerFunction,
        status: "nodata",
        usageRatio: null,
        overPercent: null,
        remainingPercent: null,
        reasons: [],
      }
    }

    const gas = report.currentGas
    const usageRatio = gas / limit

    if (gas > limit) {
      const overPercent = Math.round(((gas - limit) / limit) * 100)
      return {
        report,
        limit,
        usePerFunction,
        status: "over",
        usageRatio,
        overPercent,
        remainingPercent: null,
        reasons: buildReasons(report, gas, limit, true),
      }
    }

    if (usageRatio >= config.warnRatio) {
      const remainingPercent = Math.round(((limit - gas) / limit) * 100)
      return {
        report,
        limit,
        usePerFunction,
        status: "near",
        usageRatio,
        overPercent: null,
        remainingPercent,
        reasons: buildReasons(report, gas, limit, false),
      }
    }

    return {
      report,
      limit,
      usePerFunction,
      status: "normal",
      usageRatio,
      overPercent: null,
      remainingPercent: null,
      reasons: [],
    }
  })
}

export const STATUS_TEXT: Record<BudgetStatus, string> = {
  over: "超标",
  near: "接近阈值",
  normal: "正常",
  nodata: "无消耗数据",
}
