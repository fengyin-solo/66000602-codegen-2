import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"
import { analyzeGas, type FunctionGasReport } from "@/gas/analyzer"
import {
  DEFAULT_BUDGET,
  evaluateBudgets,
  invalidLimitMessage,
  invalidWarnRatioMessage,
  type BudgetConfig,
  type FunctionBudgetResult,
} from "@/gas/budget"

const STORAGE_KEY = "gas-budget-config-v1"

function loadConfig(): BudgetConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BUDGET, perFunction: {} }
    const parsed = JSON.parse(raw)
    return {
      defaultLimit:
        typeof parsed.defaultLimit === "number" ? parsed.defaultLimit : DEFAULT_BUDGET.defaultLimit,
      warnRatio: typeof parsed.warnRatio === "number" ? parsed.warnRatio : DEFAULT_BUDGET.warnRatio,
      perFunction:
        parsed.perFunction && typeof parsed.perFunction === "object" ? parsed.perFunction : {},
    }
  } catch {
    return { ...DEFAULT_BUDGET, perFunction: {} }
  }
}

export const useGasStore = defineStore("gas", () => {
  const filename = ref("")
  const code = ref("")
  const reports = ref<FunctionGasReport[]>([])
  const analyzedAt = ref<string | null>(null)
  const hasAnalysis = ref(false)
  const budgetConfig = ref<BudgetConfig>(loadConfig())

  // 预算判定结果只由 reports + budgetConfig 推导，两个页面共用同一份
  const budgetResults = ref<FunctionBudgetResult[]>([])
  function refresh() {
    budgetResults.value = evaluateBudgets(reports.value, budgetConfig.value)
  }

  watch(budgetConfig, refresh, { deep: true })
  watch(
    budgetConfig,
    cfg => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
      } catch {
        /* 存储不可用时忽略持久化，不影响本次会话 */
      }
    },
    { deep: true },
  )

  const overItems = computed(() => budgetResults.value.filter(r => r.status === "over"))
  const nearItems = computed(() => budgetResults.value.filter(r => r.status === "near"))
  const normalItems = computed(() => budgetResults.value.filter(r => r.status === "normal"))
  const noDataItems = computed(() => budgetResults.value.filter(r => r.status === "nodata"))

  function analyze(source: string, name = "contract.sol") {
    code.value = source
    filename.value = name
    reports.value = analyzeGas(source)
    hasAnalysis.value = true
    analyzedAt.value = new Date().toISOString()
    refresh()
    return reports.value
  }

  /** 设置项目统一上限；非法取值返回标准错误说明且不改动配置（拦住） */
  function setDefaultLimit(value: number): string | null {
    const err = invalidLimitMessage(value)
    if (err) return err
    budgetConfig.value.defaultLimit = value
    return null
  }

  /** 设置/清除逐函数阈值；非法取值返回标准错误说明，已有合法条目不受影响 */
  function setPerFunctionLimit(name: string, value: number | null): string | null {
    if (value === null) {
      const next = { ...budgetConfig.value.perFunction }
      delete next[name]
      budgetConfig.value.perFunction = next
      return null
    }
    const err = invalidLimitMessage(value)
    if (err) return err
    budgetConfig.value.perFunction = { ...budgetConfig.value.perFunction, [name]: value }
    return null
  }

  function setWarnRatio(value: number): string | null {
    const err = invalidWarnRatioMessage(value)
    if (err) return err
    budgetConfig.value.warnRatio = value
    return null
  }

  return {
    filename,
    code,
    reports,
    analyzedAt,
    hasAnalysis,
    budgetConfig,
    budgetResults,
    overItems,
    nearItems,
    normalItems,
    noDataItems,
    analyze,
    refresh,
    setDefaultLimit,
    setPerFunctionLimit,
    setWarnRatio,
  }
})
