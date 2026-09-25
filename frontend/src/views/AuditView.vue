<template>
  <div class="audit">
    <h2>智能合约安全审计</h2>
    <div class="upload-section">
      <textarea v-model="contractCode" class="code-editor" placeholder="// 粘贴 Solidity 合约代码..."></textarea>
      <div class="toolbar">
        <input v-model="filename" placeholder="文件名.sol" class="filename-input" />
        <button @click="runAudit" class="btn-primary" :disabled="!contractCode.trim()">
          {{ isAuditing ? "审计中..." : "开始审计" }}
        </button>
      </div>
    </div>

    <div v-if="result" class="result-section">
      <div class="score-card" :class="scoreClass">
        <div class="score-label">安全评分</div>
        <div class="score-value">{{ result.score }}</div>
        <div class="score-grade">{{ scoreGrade }}</div>
      </div>

      <div class="vulnerabilities">
        <h3>发现漏洞 ({{ result.vulnerabilities.length }})</h3>
        <div v-for="(v, i) in result.vulnerabilities" :key="i" class="vuln-card" :class="v.severity">
          <div class="vuln-header">
            <span class="vuln-type">{{ v.type }}</span>
            <span class="vuln-severity">{{ v.severity }}</span>
          </div>
          <div class="vuln-desc">{{ v.description }}</div>
          <div class="vuln-suggest">建议: {{ v.suggestion }}</div>
        </div>
      </div>

      <!-- Gas 预算总览（结果页） -->
      <div class="gas-budget-panel">
        <div class="budget-header">
          <h3>Gas 消耗预算</h3>
          <div class="budget-global">
            <label>项目统一上限</label>
            <input
              class="limit-input"
              type="number"
              :value="gasStore.budgetConfig.defaultLimit"
              @change="onDefaultLimitChange(($event.target as HTMLInputElement).value)"
            />
            <span class="gas-unit">Gas</span>
            <label class="warn-label">
              提醒线
              <input
                class="ratio-input"
                type="number"
                step="5"
                min="50"
                max="100"
                :value="Math.round(gasStore.budgetConfig.warnRatio * 100)"
                @change="onWarnRatioChange(($event.target as HTMLInputElement).value)"
              />%
            </label>
          </div>
        </div>
        <div v-if="budgetError" class="budget-error">⚠ {{ budgetError }}（已保留原配置，合法条目不受影响）</div>

        <div class="budget-summary">
          <span class="tag tag-over">超标 {{ gasStore.overItems.length }}</span>
          <span class="tag tag-near">接近阈值 {{ gasStore.nearItems.length }}</span>
          <span class="tag tag-normal">正常 {{ gasStore.normalItems.length }}</span>
          <span class="tag tag-nodata">无数据 {{ gasStore.noDataItems.length }}</span>
        </div>

        <!-- 超标条目：单独列出，标明超出比例与原因 -->
        <div v-if="gasStore.overItems.length" class="over-list">
          <h4>超标函数（{{ gasStore.overItems.length }}）</h4>
          <div v-for="item in gasStore.overItems" :key="item.report.name" class="over-card">
            <div class="over-top">
              <span class="over-fn">{{ item.report.name }}</span>
              <span class="over-pct">超出预算 {{ item.overPercent }}%</span>
              <span class="over-nums">
                {{ item.report.currentGas!.toLocaleString() }} /
                {{ item.limit!.toLocaleString() }} Gas
              </span>
              <span class="threshold-source">{{ item.usePerFunction ? "单独阈值" : "统一上限" }}</span>
            </div>
            <ul class="reason-list">
              <li v-for="(r, idx) in item.reasons" :key="idx">{{ r }}</li>
            </ul>
          </div>
        </div>

        <!-- 接近阈值提醒 -->
        <div v-if="gasStore.nearItems.length" class="near-list">
          <h4>接近阈值提醒（{{ gasStore.nearItems.length }}）</h4>
          <div v-for="item in gasStore.nearItems" :key="item.report.name" class="near-card">
            <span class="near-fn">{{ item.report.name }}</span>
            <span>
              已用预算 {{ Math.round(item.usageRatio! * 100) }}%，
              剩余空间仅 {{ item.remainingPercent }}%
              （{{ item.report.currentGas!.toLocaleString() }} / {{ item.limit!.toLocaleString() }} Gas）
            </span>
          </div>
        </div>

        <!-- 全量函数列表：消耗、阈值、判定、逐函数阈值编辑 -->
        <h4 class="table-title">函数预算明细</h4>
        <div class="budget-table">
          <div class="budget-row budget-row-head">
            <span>函数</span>
            <span>当前 Gas</span>
            <span>阈值</span>
            <span>阈值类型</span>
            <span>判定</span>
            <span>单独设置</span>
          </div>
          <div
            v-for="item in gasStore.budgetResults"
            :key="item.report.name"
            class="budget-row"
            :class="'row-' + item.status"
          >
            <span class="cell-fn" :title="`源码第 ${item.report.line} 行`">{{ item.report.name }}</span>
            <span>
              <template v-if="item.report.currentGas !== null">
                {{ item.report.currentGas.toLocaleString() }}
                <div class="breakdown-hint">
                  写{{ item.report.metrics.storageWrites }} ·
                  读{{ item.report.metrics.storageReads }} ·
                  循环读{{ item.report.metrics.loopStorageReads }} ·
                  转账{{ item.report.metrics.transfers }} ·
                  事件{{ item.report.metrics.events }}
                </div>
              </template>
              <span v-else class="nodata-text">{{ noDataText(item.report.noDataReason) }}</span>
            </span>
            <span>{{ item.limit !== null ? item.limit.toLocaleString() : "—" }}</span>
            <span>{{ item.usePerFunction ? "单独阈值" : "统一上限" }}</span>
            <span class="status-cell">
              <span class="tag" :class="'tag-' + item.status">{{ statusText(item.status) }}</span>
              <div v-if="item.status === 'over'" class="cell-extra">超 {{ item.overPercent }}%</div>
            </span>
            <span class="per-fn-cell">
              <input
                class="per-limit-input"
                type="number"
                placeholder="沿用统一上限"
                :value="item.usePerFunction ? item.limit! : ''"
                @change="onPerLimitChange(item, ($event.target as HTMLInputElement).value)"
              />
              <button
                v-if="item.usePerFunction"
                class="btn-clear"
                @click="gasStore.setPerFunctionLimit(item.report.shortName, null)"
              >清除</button>
            </span>
          </div>
        </div>
      </div>

      <!-- 原有 Gas 优化建议（字段与逻辑保持不变） -->
      <div v-if="gasSuggestions.length" class="gas-section">
        <h3>Gas优化建议</h3>
        <div v-for="(g, i) in gasSuggestions" :key="i" class="gas-card">
          <div class="gas-fn">{{ g.functionName }}</div>
          <div class="gas-info">
            <template v-if="g.currentGas !== null">
              当前: {{ g.currentGas.toLocaleString() }} → 优化后: {{ g.optimizedGas!.toLocaleString() }}
              ({{ Math.round((1 - g.optimizedGas! / g.currentGas) * 100) }}%节省)
            </template>
            <template v-else>无消耗数据（不参与节省比例计算）</template>
          </div>
          <div class="gas-suggest">{{ g.suggestion }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import { useGasStore } from "@/store/gas"
import { NO_DATA_REASON_TEXT, type FunctionGasReport, type NoDataReason } from "@/gas/analyzer"
import type { BudgetStatus, FunctionBudgetResult } from "@/gas/budget"
import { STATUS_TEXT } from "@/gas/budget"

const contractCode = ref(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract SimpleBank {
    mapping(address => uint) public balances;

    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint amount) public {
        require(balances[msg.sender] >= amount);
        (bool success,) = msg.sender.call{value: amount}("");
        require(success);
        balances[msg.sender] -= amount;
    }

    function balanceOf(address owner) public view returns (uint) {
        return balances[owner];
    }

    function version() public pure returns (uint) {
        return 1;
    }
}`)
const filename = ref("SimpleBank.sol")
const isAuditing = ref(false)
const result = ref<any>(null)
const budgetError = ref("")

const gasStore = useGasStore()

const scoreClass = computed(() => {
  if (!result.value) return ""
  if (result.value.score >= 80) return "score-high"
  if (result.value.score >= 50) return "score-medium"
  return "score-low"
})

const scoreGrade = computed(() => {
  if (!result.value) return ""
  if (result.value.score >= 90) return "Excellent"
  if (result.value.score >= 70) return "Good"
  if (result.value.score >= 50) return "Fair"
  return "Poor"
})

// 优化建议保持原有数据结构：functionName / currentGas / optimizedGas / suggestion
const gasSuggestions = computed(() =>
  gasStore.reports
    .filter(r => r.suggestions.length > 0)
    .map(r => ({
      functionName: r.name,
      currentGas: r.currentGas,
      optimizedGas: r.optimizedGas,
      suggestion: r.suggestionText,
    })),
)

function statusText(s: BudgetStatus) {
  return STATUS_TEXT[s]
}
function noDataText(reason: NoDataReason | null) {
  return reason ? NO_DATA_REASON_TEXT[reason] : "未采集到 Gas 消耗数据"
}

function onDefaultLimitChange(raw: string) {
  const err = gasStore.setDefaultLimit(Number(raw))
  budgetError.value = err ? `统一上限取值不合法：${err}` : ""
}

function onWarnRatioChange(raw: string) {
  const err = gasStore.setWarnRatio(Number(raw) / 100)
  budgetError.value = err ? `提醒线取值不合法：${err}` : ""
}

function onPerLimitChange(item: FunctionBudgetResult, raw: string) {
  if (raw.trim() === "") {
    gasStore.setPerFunctionLimit(item.report.shortName, null)
    budgetError.value = ""
    return
  }
  const err = gasStore.setPerFunctionLimit(item.report.shortName, Number(raw))
  budgetError.value = err
    ? `「${item.report.shortName}」单独阈值不合法：${err}；该条目已被拦截，其它合法阈值不受影响`
    : ""
}

async function runAudit() {
  isAuditing.value = true
  budgetError.value = ""
  await new Promise(r => setTimeout(r, 600))

  // 漏洞检测逻辑保持原样
  const vulns = []
  if (contractCode.value.includes("msg.sender.call")) {
    vulns.push({
      type: "重入攻击 (Reentrancy)",
      severity: "critical",
      line: contractCode.value.split("\n").findIndex(l => l.includes("msg.sender.call")) + 1,
      description: "使用了低级的 call() 接收ETH，存在重入攻击风险。攻击者可通过恶意合约反复调用提款函数。",
      suggestion: "使用 Checks-Effects-Interactions 模式，或使用 ReentrancyGuard 修饰符。"
    })
  }
  if (contractCode.value.includes("require(balances")) {
    vulns.push({
      type: "整数溢出 (Integer Overflow)",
      severity: "high",
      line: 1,
      description: "Solidity 0.8以下版本未启用溢出检查，需注意。",
      suggestion: "使用 SafeMath 库或在 Solidity 0.8+ 环境中编译。"
    })
  }

  // Gas 分析改为确定性的结构化分析，结果页与分析页共用同一份数据
  gasStore.analyze(contractCode.value, filename.value)

  result.value = {
    score: vulns.length === 0 ? 95 : Math.max(20, 85 - vulns.length * 25),
    vulnerabilities: vulns,
  }
  isAuditing.value = false
}
</script>

<style scoped>
.audit { max-width: 1100px; }
.code-editor { width: 100%; height: 300px; font-family: "Fira Code", monospace; font-size: 0.875rem; padding: 1rem; border: 1px solid #d1d5db; border-radius: 8px; background: #1e1e1e; color: #d4d4d4; resize: vertical; }
.toolbar { display: flex; gap: 1rem; margin: 1rem 0; align-items: center; }
.filename-input { padding: 0.5rem 1rem; border: 1px solid #d1d5db; border-radius: 8px; flex: 1; }
.btn-primary { background: #8b5cf6; color: white; border: none; padding: 0.625rem 1.5rem; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.result-section { margin-top: 2rem; }
.score-card { border-radius: 16px; padding: 2rem; text-align: center; color: white; margin-bottom: 2rem; }
.score-high { background: linear-gradient(135deg, #10b981, #059669); }
.score-medium { background: linear-gradient(135deg, #f59e0b, #d97706); }
.score-low { background: linear-gradient(135deg, #ef4444, #dc2626); }
.score-label { font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem; }
.score-value { font-size: 4rem; font-weight: 800; }
.score-grade { font-size: 1.25rem; opacity: 0.9; }
.vulnerabilities h3 { margin-bottom: 1rem; font-size: 1.125rem; }
.vuln-card { background: white; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; border-left: 4px solid; }
.vuln-card.critical { border-color: #dc2626; }
.vuln-card.high { border-color: #f59e0b; }
.vuln-card.medium { border-color: #3b82f6; }
.vuln-card.low { border-color: #6b7280; }
.vuln-header { display: flex; justify-content: space-between; margin-bottom: 0.75rem; }
.vuln-type { font-weight: 600; }
.vuln-severity { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; background: #fee2e2; color: #dc2626; }
.vuln-desc { color: #374151; margin-bottom: 0.5rem; }
.vuln-suggest { font-size: 0.875rem; color: #6b6b7b; }

.gas-budget-panel { background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 2rem; }
.budget-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
.budget-header h3 { margin: 0; font-size: 1.125rem; }
.budget-global { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; color: #374151; flex-wrap: wrap; }
.limit-input, .ratio-input { width: 110px; padding: 0.375rem 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; }
.ratio-input { width: 64px; }
.gas-unit { color: #6b7280; }
.warn-label { display: flex; align-items: center; gap: 0.375rem; margin-left: 0.5rem; }
.budget-error { margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: #fef2f2; color: #dc2626; border-radius: 8px; font-size: 0.875rem; }
.budget-summary { display: flex; gap: 0.75rem; margin: 1rem 0; flex-wrap: wrap; }
.tag { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 500; }
.tag-over { background: #fee2e2; color: #dc2626; }
.tag-near { background: #fef3c7; color: #b45309; }
.tag-normal { background: #d1fae5; color: #047857; }
.tag-nodata { background: #e5e7eb; color: #4b5563; }

.over-list { margin-bottom: 1.25rem; }
.over-list h4, .near-list h4, .table-title { margin: 0 0 0.75rem; font-size: 1rem; }
.over-card { background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 1rem; margin-bottom: 0.75rem; }
.over-top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.over-fn { font-weight: 700; color: #991b1b; font-family: monospace; }
.over-pct { background: #dc2626; color: white; padding: 0.125rem 0.625rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
.over-nums { font-size: 0.875rem; color: #7f1d1d; }
.threshold-source { font-size: 0.75rem; color: #9ca3af; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.0625rem 0.5rem; }
.reason-list { margin: 0; padding-left: 1.25rem; font-size: 0.85rem; color: #7f1d1d; }
.reason-list li { margin: 0.2rem 0; }

.near-list { margin-bottom: 1.25rem; }
.near-card { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 0.625rem; font-size: 0.875rem; color: #92400e; display: flex; gap: 0.75rem; flex-wrap: wrap; }
.near-fn { font-weight: 700; font-family: monospace; }

.budget-table { border: 1px solid #eef0f3; border-radius: 10px; overflow: hidden; }
.budget-row { display: grid; grid-template-columns: 1.4fr 1.6fr 0.9fr 0.8fr 0.9fr 1.4fr; gap: 0.5rem; padding: 0.625rem 0.75rem; font-size: 0.83rem; align-items: center; border-top: 1px solid #f3f4f6; }
.budget-row:first-child { border-top: none; }
.budget-row-head { background: #f9fafb; font-weight: 600; color: #6b7280; }
.row-over { background: #fffafa; }
.row-near { background: #fffdf5; }
.cell-fn { font-family: monospace; font-weight: 600; color: #374151; }
.breakdown-hint { font-size: 0.7rem; color: #9ca3af; margin-top: 0.15rem; }
.nodata-text { color: #9ca3af; font-size: 0.75rem; }
.cell-extra { font-size: 0.72rem; color: #dc2626; margin-top: 0.15rem; }
.per-fn-cell { display: flex; gap: 0.375rem; align-items: center; }
.per-limit-input { width: 100px; padding: 0.3rem 0.45rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.8rem; }
.btn-clear { border: none; background: #f3f4f6; color: #6b7280; border-radius: 6px; padding: 0.3rem 0.55rem; cursor: pointer; font-size: 0.75rem; }

.gas-section h3 { margin-bottom: 1rem; font-size: 1.125rem; }
.gas-card { background: white; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
.gas-fn { font-weight: 600; color: #7c3aed; margin-bottom: 0.5rem; font-family: monospace; }
.gas-info { color: #059669; font-size: 0.875rem; margin-bottom: 0.5rem; }
.gas-suggest { font-size: 0.875rem; color: #6b7280; }
</style>
