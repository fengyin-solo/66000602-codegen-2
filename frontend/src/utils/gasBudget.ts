import type {
  GasBudgetConfig,
  GasBudgetEntry,
  GasBudgetEvaluation,
  GasMeasurement,
  GasNoDataEntry,
  RejectedLimit,
} from '@/types'

/**
 * Gas 预算判定规则（与后端 app/main.py 的 GAS_RULES / BUDGET_RULE_DESCRIPTION 保持一致）：
 *
 * 1. 每个函数的适用上限 = 该函数的单独阈值（优先） ?? 项目默认上限；两者都没有记为「未设限」。
 * 2. 估算消耗 > 适用上限           => 超标（exceeded），记录超出比例与原因；
 *    估算消耗 >= 适用上限 × 预警比例 => 接近阈值（warning），给出提醒；
 *    其余                          => 正常（ok）。
 * 3. 阈值合法范围为 [MIN_LIMIT, MAX_LIMIT] 的整数；预警比例必须在 (0, 1) 开区间。
 *    非法取值会被拦截并附上标准说明，其余合法条目仍然生效。
 * 4. 评估是纯函数：调整阈值只改变判定口径，不改变已采集的消耗数据，
 *    因此原本正常的函数只有在其适用上限被调到低于其消耗时才会变为超标。
 */
export const GAS_RULES = {
  TX_BASE: 21000,
  FUNC_BASE: 300,
  SLOAD: 800,
  SSTORE: 5000,
  CALL: 2600,
  EMIT: 1500,
  KECCAK: 200,
  ARITH: 20,
  DEFAULT_LOOP_ITERS: 10,
  MAX_LOOP_ITERS: 1000,
  MIN_LIMIT: 21000,
  MAX_LIMIT: 30000000,
  DEFAULT_WARNING_RATIO: 0.8,
} as const

export const BUDGET_RULE_DESCRIPTION =
  '判定规则：函数估算消耗 > 适用上限 判定为超标；' +
  '估算消耗 ≥ 适用上限 × 预警比例（默认 0.8）判定为接近阈值并提醒；其余为正常。' +
  '适用上限优先取该函数的单独阈值，未设置时使用项目默认上限；两者都未设置记为未设限。' +
  `阈值合法范围为 [${GAS_RULES.MIN_LIMIT}, ${GAS_RULES.MAX_LIMIT}] 的整数` +
  '（21000 为基础交易成本，30000000 约为区块 Gas Limit），超出范围的取值会被拦截并说明原因，其余合法条目仍然生效。' +
  '预警比例必须在 (0, 1) 开区间内。'

export const DEFAULT_BUDGET_CONFIG: GasBudgetConfig = {
  defaultLimit: 100000,
  functionLimits: {},
  warningRatio: GAS_RULES.DEFAULT_WARNING_RATIO,
}

export function normalizeFnName(name: string): string {
  return String(name).trim().replace(/\(\s*\)$/, '')
}

function checkLimitValue(value: unknown): { ok: boolean; reason: string } {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { ok: false, reason: '阈值必须是数字（单位：gas）' }
  }
  if (!Number.isInteger(value)) {
    return { ok: false, reason: '阈值必须是整数（单位：gas）' }
  }
  if (value < GAS_RULES.MIN_LIMIT) {
    return {
      ok: false,
      reason: `低于合理下限 ${GAS_RULES.MIN_LIMIT} gas：一笔基础转账交易即需 21000 gas，低于该值的预算没有实际意义`,
    }
  }
  if (value > GAS_RULES.MAX_LIMIT) {
    return {
      ok: false,
      reason: `高于合理上限 ${GAS_RULES.MAX_LIMIT} gas：约为以太坊区块 Gas Limit，单笔交易不可能超过该值`,
    }
  }
  return { ok: true, reason: '' }
}

/** 校验预算配置：非法条目被拦截并说明原因，合法条目保留生效。 */
export function validateGasBudgetConfig(config: Partial<GasBudgetConfig> | null | undefined): {
  valid: GasBudgetConfig
  rejected: RejectedLimit[]
} {
  const valid: GasBudgetConfig = {
    defaultLimit: null,
    functionLimits: {},
    warningRatio: GAS_RULES.DEFAULT_WARNING_RATIO,
  }
  const rejected: RejectedLimit[] = []
  const cfg = config ?? {}

  if (cfg.defaultLimit !== null && cfg.defaultLimit !== undefined) {
    const { ok, reason } = checkLimitValue(cfg.defaultLimit)
    if (ok) valid.defaultLimit = cfg.defaultLimit as number
    else rejected.push({ target: 'defaultLimit', value: cfg.defaultLimit, reason })
  }

  for (const [name, value] of Object.entries(cfg.functionLimits ?? {})) {
    const { ok, reason } = checkLimitValue(value)
    if (ok) valid.functionLimits[normalizeFnName(name)] = value
    else rejected.push({ target: `function:${name}`, value, reason })
  }

  if (cfg.warningRatio !== null && cfg.warningRatio !== undefined) {
    const r = cfg.warningRatio
    if (typeof r === 'number' && !Number.isNaN(r) && r > 0 && r < 1) {
      valid.warningRatio = r
    } else {
      rejected.push({
        target: 'warningRatio',
        value: r,
        reason: '预警比例必须在 (0, 1) 开区间内，例如 0.8 表示达到上限 80% 时提醒',
      })
    }
  }
  return { valid, rejected }
}

/** 纯函数评估：同一份测量数据 + 同一份配置 => 同一份结果。 */
export function evaluateGasBudget(
  measurements: GasMeasurement[],
  noData: GasNoDataEntry[],
  validConfig: GasBudgetConfig,
): GasBudgetEvaluation {
  const warningRatio = validConfig.warningRatio || GAS_RULES.DEFAULT_WARNING_RATIO
  const entries: GasBudgetEntry[] = measurements.map((m) => {
    const name = normalizeFnName(m.name || m.functionName)
    let limit: number | null = null
    let limitSource: GasBudgetEntry['limitSource'] = null
    if (name in validConfig.functionLimits) {
      limit = validConfig.functionLimits[name]
      limitSource = 'function'
    } else if (validConfig.defaultLimit !== null) {
      limit = validConfig.defaultLimit
      limitSource = 'default'
    }

    const entry: GasBudgetEntry = {
      name,
      functionName: m.functionName,
      estimatedGas: m.estimatedGas,
      limit,
      limitSource,
      ratio: null,
      status: 'unlimited',
      exceedRatio: null,
      reason: null,
      drivers: m.drivers ?? [],
    }

    if (limit !== null) {
      const ratio = m.estimatedGas / limit
      entry.ratio = Math.round(ratio * 10000) / 10000
      if (ratio > 1) {
        entry.status = 'exceeded'
        entry.exceedRatio = Math.round((ratio - 1) * 1000) / 10
        const detail =
          entry.drivers
            .slice(0, 2)
            .map((d) => `${d.label}×${d.count}(约${d.gas} gas)`)
            .join('、') || '基础交易成本高'
        const src = limitSource === 'function' ? '单独阈值' : '默认上限'
        entry.reason = `超出${src} ${limit} gas 的 ${entry.exceedRatio}%，主要消耗来自${detail}`
      } else if (ratio >= warningRatio) {
        entry.status = 'warning'
      } else {
        entry.status = 'ok'
      }
    }
    return entry
  })

  return {
    config: validConfig,
    rejected: [],
    entries,
    exceeded: entries
      .filter((e) => e.status === 'exceeded')
      .sort((a, b) => (b.exceedRatio ?? 0) - (a.exceedRatio ?? 0)),
    warnings: entries.filter((e) => e.status === 'warning'),
    noData,
  }
}
