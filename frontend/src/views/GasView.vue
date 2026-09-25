<template>
  <div class="gas">
    <h2>Gas 消耗分析</h2>

    <div v-if="!result" class="empty-state">
      尚未有审计数据，请先在 <router-link to="/">合约审计</router-link> 页运行一次审计。
    </div>

    <template v-else>
      <div class="budget-editor">
        <h3>Gas 预算设置</h3>
        <div class="rule-desc">{{ ruleDescription }}</div>
        <div class="editor-row">
          <label>项目默认上限 (gas)</label>
          <input v-model.number="form.defaultLimit" type="number" class="num-input" placeholder="未设置" />
          <label>预警比例</label>
          <input v-model.number="form.warningRatio" type="number" step="0.05" min="0" max="1" class="num-input small" />
        </div>
        <div class="editor-sub">函数单独阈值（优先于默认上限）：</div>
        <div v-for="(row, i) in form.functionRows" :key="i" class="editor-row fn-row">
          <select v-model="row.name" class="fn-select">
            <option value="" disabled>选择函数</option>
            <option v-for="n in availableFunctions" :key="n" :value="n">{{ n }}()</option>
          </select>
          <input v-model.number="row.limit" type="number" class="num-input" placeholder="阈值 (gas)" />
          <button class="btn-sm danger" @click="form.functionRows.splice(i, 1)">删除</button>
        </div>
        <div class="editor-actions">
          <button class="btn-sm" @click="addRow" :disabled="!availableFunctions.length">添加单独阈值</button>
          <button class="btn-primary" @click="applyBudget">应用预算</button>
        </div>
        <div v-if="rejectedLimits.length" class="rejected-card">
          <div class="rejected-title">已拦截 {{ rejectedLimits.length }} 条非法阈值（其余合法条目仍生效）：</div>
          <div v-for="r in rejectedLimits" :key="r.target" class="rejected-item">
            <code>{{ r.target }}</code> = {{ r.value }} — {{ r.reason }}
          </div>
        </div>
        <div class="applied-config">
          当前生效：默认上限 {{ configText.defaultLimit }}，预警比例 {{ configText.warningRatio }}，单独阈值 {{ configText.functionCount }} 项
        </div>
      </div>

      <div ref="gasChart" class="chart-container"></div>

      <div class="gas-list">
        <h3>函数消耗明细</h3>
        <div v-for="e in evaluation?.entries ?? []" :key="e.functionName" class="gas-row">
          <div class="gas-row-head">
            <span class="gas-fn">{{ e.functionName }}</span>
            <span class="gas-tag" :class="`tag-${e.status}`">{{ statusText[e.status] }}</span>
          </div>
          <div class="gas-row-body">
            <span>估算 {{ e.estimatedGas.toLocaleString() }} gas</span>
            <span v-if="e.limit !== null">
              / 上限 {{ e.limit.toLocaleString() }}（{{ e.limitSource === 'function' ? '单独阈值' : '默认上限' }}）
              / 占比 {{ Math.round((e.ratio ?? 0) * 100) }}%
            </span>
            <span v-else>/ 未设限</span>
          </div>
          <div v-if="e.reason" class="gas-row-reason">{{ e.reason }}</div>
          <div class="gas-row-drivers">
            <span v-for="d in e.drivers" :key="d.label" class="driver-chip">{{ d.label }}×{{ d.count }} ≈{{ d.gas.toLocaleString() }}</span>
            <span v-if="!e.drivers.length" class="driver-chip muted">仅基础交易成本</span>
          </div>
        </div>
        <div v-for="n in evaluation?.noData ?? []" :key="n.functionName + n.line" class="gas-row nodata">
          <div class="gas-row-head">
            <span class="gas-fn">{{ n.functionName }}</span>
            <span class="gas-tag tag-nodata">无数据</span>
          </div>
          <div class="gas-row-body">消耗：—（{{ n.reason }}）</div>
        </div>
      </div>
    </template>

    <div class="gas-tips">
      <h3>Gas优化技巧</h3>
      <ul>
        <li>使用 <code>calldata</code> 代替 <code>memory</code> 存储函数参数</li>
        <li>使用 <code>short-circuit</code> 逻辑减少不必要的计算</li>
        <li>避免在循环中读取存储变量，缓存到内存</li>
        <li>使用事件而非存储来记录历史数据</li>
        <li>合理使用 <code>unchecked</code> 块跳过溢出检查</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted, nextTick } from "vue"
import * as echarts from "echarts"
import { useAuditStore } from "@/store"
import { BUDGET_RULE_DESCRIPTION, normalizeFnName } from "@/utils/gasBudget"
import type { GasBudgetStatus } from "@/types"

const store = useAuditStore()
const result = computed(() => store.currentResult)
const evaluation = computed(() => store.budgetEvaluation)
const rejectedLimits = computed(() => store.budgetRejected)
const ruleDescription = BUDGET_RULE_DESCRIPTION

const gasChart = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const statusText: Record<GasBudgetStatus, string> = {
  exceeded: "超标",
  warning: "接近阈值",
  ok: "正常",
  unlimited: "未设限",
}
const statusColor: Record<GasBudgetStatus, string> = {
  exceeded: "#dc2626",
  warning: "#d97706",
  ok: "#059669",
  unlimited: "#6b7280",
}

// ---------- 预算编辑表单 ----------
interface FnLimitRow { name: string; limit: number | null }
const form = reactive({
  defaultLimit: store.budgetConfig.defaultLimit as number | null,
  warningRatio: store.budgetConfig.warningRatio,
  functionRows: [] as FnLimitRow[],
})

const availableFunctions = computed(() =>
  (result.value?.gasMeasurements ?? []).map((m) => m.name),
)

function addRow() {
  const unused = availableFunctions.value.find((n) => !form.functionRows.some((r) => r.name === n))
  form.functionRows.push({ name: unused ?? "", limit: null })
}

function applyBudget() {
  const functionLimits: Record<string, number | null> = {}
  for (const row of form.functionRows) {
    if (row.name) functionLimits[normalizeFnName(row.name)] = row.limit
  }
  store.applyBudgetConfig({
    defaultLimit: form.defaultLimit,
    warningRatio: form.warningRatio,
    functionLimits: functionLimits as Record<string, number>,
  })
}

const configText = computed(() => ({
  defaultLimit: store.budgetConfig.defaultLimit?.toLocaleString() ?? "未设置",
  warningRatio: store.budgetConfig.warningRatio,
  functionCount: Object.keys(store.budgetConfig.functionLimits).length,
}))

// ---------- 图表 ----------
function renderChart() {
  if (!gasChart.value || !evaluation.value) return
  if (!chart) chart = echarts.init(gasChart.value)
  const entries = evaluation.value.entries
  chart.setOption({
    title: { text: "各函数 Gas 消耗 vs 预算上限", left: "center" },
    tooltip: {
      trigger: "axis",
      formatter: (params: any) => {
        const idx = params[0]?.dataIndex ?? 0
        const e = entries[idx]
        if (!e) return ""
        const lines = [
          `<b>${e.functionName}</b>`,
          `估算消耗: ${e.estimatedGas.toLocaleString()} gas`,
          e.limit !== null
            ? `预算上限: ${e.limit.toLocaleString()} gas（${e.limitSource === "function" ? "单独阈值" : "默认上限"}），占比 ${Math.round((e.ratio ?? 0) * 100)}%`
            : "预算上限: 未设限",
          `状态: ${statusText[e.status]}`,
        ]
        if (e.drivers.length) {
          lines.push("主要消耗: " + e.drivers.map((d) => `${d.label}×${d.count}`).join("、"))
        }
        return lines.join("<br/>")
      },
    },
    legend: { bottom: 0 },
    xAxis: { type: "category", data: entries.map((e) => e.functionName) },
    yAxis: { type: "value", name: "Gas" },
    series: [
      {
        name: "估算消耗",
        type: "bar",
        data: entries.map((e) => ({
          value: e.estimatedGas,
          itemStyle: { color: statusColor[e.status] },
        })),
      },
      {
        name: "优化后估算",
        type: "bar",
        itemStyle: { color: "#a7c4f7" },
        data: (result.value?.gasMeasurements ?? []).map((m) => m.optimizedGas),
      },
      {
        name: "预算上限",
        type: "line",
        step: "middle",
        symbol: "none",
        lineStyle: { color: "#374151", type: "dashed", width: 2 },
        data: entries.map((e) => e.limit),
      },
    ],
  }, true)
}

watch(evaluation, () => nextTick(renderChart), { deep: true })

onMounted(() => {
  renderChart()
  window.addEventListener("resize", resizeChart)
})
function resizeChart() { chart?.resize() }
onUnmounted(() => {
  window.removeEventListener("resize", resizeChart)
  chart?.dispose()
  chart = null
})
</script>

<style scoped>
.gas { max-width: 1000px; }
.empty-state { background: white; border-radius: 12px; padding: 2rem; color: #6b7280; margin-bottom: 1rem; }
.empty-state a { color: #7c3aed; }
.budget-editor { background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
.budget-editor h3 { margin-bottom: 0.75rem; }
.rule-desc { font-size: 0.8125rem; color: #6b7280; background: #f9fafb; border-radius: 8px; padding: 0.75rem; margin-bottom: 1rem; line-height: 1.6; }
.editor-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.editor-row label { font-size: 0.875rem; color: #374151; }
.editor-sub { font-size: 0.875rem; color: #374151; margin: 0.5rem 0; }
.num-input { padding: 0.375rem 0.75rem; border: 1px solid #d1d5db; border-radius: 8px; width: 160px; }
.num-input.small { width: 90px; }
.fn-select { padding: 0.375rem 0.75rem; border: 1px solid #d1d5db; border-radius: 8px; min-width: 160px; }
.editor-actions { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
.btn-primary { background: #8b5cf6; color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 8px; cursor: pointer; }
.btn-sm { background: #e5e7eb; border: none; padding: 0.375rem 0.875rem; border-radius: 6px; cursor: pointer; font-size: 0.875rem; }
.btn-sm.danger { background: #fee2e2; color: #dc2626; }
.rejected-card { background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 0.75rem 1rem; margin-top: 0.75rem; }
.rejected-title { font-weight: 600; color: #c2410c; font-size: 0.8125rem; margin-bottom: 0.375rem; }
.rejected-item { font-size: 0.8125rem; color: #7c2d12; margin-bottom: 0.25rem; }
.rejected-item code { background: #ffedd5; padding: 0.0625rem 0.375rem; border-radius: 4px; }
.applied-config { font-size: 0.8125rem; color: #6b7280; margin-top: 0.75rem; }
.chart-container { height: 400px; background: white; border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; }
.gas-list { margin-bottom: 2rem; }
.gas-list h3 { margin-bottom: 1rem; font-size: 1.125rem; }
.gas-row { background: white; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }
.gas-row.nodata { opacity: 0.85; }
.gas-row-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.375rem; }
.gas-fn { font-weight: 600; color: #7c3aed; }
.gas-tag { padding: 0.125rem 0.625rem; border-radius: 9999px; font-size: 0.75rem; }
.tag-exceeded { background: #fee2e2; color: #dc2626; }
.tag-warning { background: #fef3c7; color: #d97706; }
.tag-ok { background: #d1fae5; color: #065f46; }
.tag-unlimited, .tag-nodata { background: #f3f4f6; color: #6b7280; }
.gas-row-body { font-size: 0.875rem; color: #374151; margin-bottom: 0.375rem; }
.gas-row-reason { font-size: 0.8125rem; color: #6b7280; margin-bottom: 0.375rem; }
.gas-row-drivers { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.driver-chip { background: #eef2ff; color: #4338ca; font-size: 0.75rem; padding: 0.125rem 0.625rem; border-radius: 9999px; }
.driver-chip.muted { background: #f3f4f6; color: #6b7280; }
.gas-tips { background: white; border-radius: 12px; padding: 1.5rem; }
.gas-tips h3 { margin-bottom: 1rem; }
.gas-tips ul { list-style: none; padding: 0; }
.gas-tips li { padding: 0.5rem 0; color: #374151; border-bottom: 1px solid #f3f4f6; }
.gas-tips li:last-child { border-bottom: none; }
.gas-tips code { background: #f3f4f6; padding: 0.125rem 0.375rem; border-radius: 4px; font-family: monospace; color: #7c3aed; }
</style>
