export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

// ---------- 漏洞与优化建议 ----------

export interface Vulnerability {
  type: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  line: number
  description: string
  suggestion: string
}

export interface GasIssue {
  functionName: string
  currentGas: number
  optimizedGas: number
  suggestion: string
}

// ---------- Gas 测量 ----------

export interface GasFeatures {
  storageReads: number
  storageWrites: number
  loops: number
  maxLoopIters: number
  externalCalls: number
  emits: number
  keccak: number
  arithOps: number
}

export interface GasDriver {
  label: string
  count: number
  gas: number
}

export interface GasMeasurement {
  name: string
  functionName: string
  line: number
  estimatedGas: number
  optimizedGas: number
  features: GasFeatures
  drivers: GasDriver[]
}

export interface GasNoDataEntry {
  functionName: string
  name: string
  line: number
  reason: string
}

// ---------- Gas 预算 ----------

export interface GasBudgetConfig {
  /** 项目统一默认上限（gas），null 表示未设置 */
  defaultLimit: number | null
  /** 函数单独阈值，key 为函数名（可带或不带 "()"） */
  functionLimits: Record<string, number>
  /** 预警比例 (0,1)，达到上限的该比例时提醒 */
  warningRatio: number
}

export interface RejectedLimit {
  target: string
  value: unknown
  reason: string
}

export type GasBudgetStatus = 'exceeded' | 'warning' | 'ok' | 'unlimited'

export interface GasBudgetEntry {
  name: string
  functionName: string
  estimatedGas: number
  limit: number | null
  limitSource: 'function' | 'default' | null
  ratio: number | null
  status: GasBudgetStatus
  /** 超出比例（百分比，如 25.4 表示超出 25.4%），仅超标时有值 */
  exceedRatio: number | null
  /** 超标原因（含主要消耗来源），仅超标时有值 */
  reason: string | null
  drivers: GasDriver[]
}

export interface GasBudgetEvaluation {
  config: GasBudgetConfig
  rejected: RejectedLimit[]
  entries: GasBudgetEntry[]
  exceeded: GasBudgetEntry[]
  warnings: GasBudgetEntry[]
  noData: GasNoDataEntry[]
}

// ---------- 审计结果 ----------

export interface AuditResult {
  id: string
  filename: string
  score: number
  vulnerabilities: Vulnerability[]
  gasIssues: GasIssue[]
  gasMeasurements: GasMeasurement[]
  gasNoData: GasNoDataEntry[]
  gasBudget: GasBudgetEvaluation | null
  timestamp: string
}
