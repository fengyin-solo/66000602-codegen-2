import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'
import type {
  ApiResponse,
  AuditResult,
  GasBudgetConfig,
  GasBudgetEvaluation,
  RejectedLimit,
} from '@/types'
import { runLocalAudit } from '@/utils/localAudit'
import {
  DEFAULT_BUDGET_CONFIG,
  evaluateGasBudget,
  validateGasBudgetConfig,
} from '@/utils/gasBudget'

export const useAuditStore = defineStore('audit', () => {
  const results = ref<AuditResult[]>([])
  const currentResult = ref<AuditResult | null>(null)
  const patterns = ref<any[]>([])

  /** 当前生效的预算配置（只含校验通过的合法条目） */
  const budgetConfig = ref<GasBudgetConfig>({ ...DEFAULT_BUDGET_CONFIG, functionLimits: {} })
  /** 最近一次提交中被拦截的非法阈值（含原因说明） */
  const budgetRejected = ref<RejectedLimit[]>([])

  async function runAudit(code: string, filename: string) {
    let result: AuditResult
    try {
      const res = await axios.post<ApiResponse<AuditResult>>('/api/audit', {
        code,
        filename,
        gasBudget: budgetConfig.value,
      })
      result = res.data.data
    } catch {
      // 后端不可用时本地兜底，保证结果页与分析页仍基于同一份数据
      result = runLocalAudit(code, filename, budgetConfig.value)
    }
    currentResult.value = result
    results.value.unshift(result)
    return result
  }

  /**
   * 应用新的预算配置：非法取值被拦截并记录原因，合法条目保留生效。
   * 只改变判定口径，不重新采集消耗数据。
   */
  function applyBudgetConfig(config: Partial<GasBudgetConfig>) {
    const { valid, rejected } = validateGasBudgetConfig(config)
    budgetConfig.value = valid
    budgetRejected.value = rejected
    return rejected
  }

  /**
   * 预算评估结果：由 currentResult 的测量数据 + 当前预算配置实时算出。
   * 结果页与分析页都读取它，因此两个页面的判定必然一致。
   */
  const budgetEvaluation = computed<GasBudgetEvaluation | null>(() => {
    if (!currentResult.value) return null
    return evaluateGasBudget(
      currentResult.value.gasMeasurements ?? [],
      currentResult.value.gasNoData ?? [],
      budgetConfig.value,
    )
  })

  async function fetchPatterns() {
    const res = await axios.get<ApiResponse<any[]>>('/api/patterns')
    patterns.value = res.data.data
  }

  return {
    results,
    currentResult,
    patterns,
    budgetConfig,
    budgetRejected,
    budgetEvaluation,
    runAudit,
    applyBudgetConfig,
    fetchPatterns,
  }
})
